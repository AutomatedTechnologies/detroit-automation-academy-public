#!/usr/bin/env python3
"""transform.py — TRANSFORM stage of the Cincinnati pipeline (platform stage adapted from the PHL rebuild).

CINCINNATI BUILD (Board 51). Label: UNVERIFIED / legacy-unsigned.

Reads ONE raw bundle produced by collect.py (manifest required;
every leg payload sha256-verified against it), decodes it with
the shared wire code, and writes the full published file family
(LT-KAES-21) in the canonical schemas (LT-KAES-24):

  data/vehicles.json       canonical envelope, per-source state
                           (KAES-20), records trip-matching
                           classified before any surface (KAES-25)
  data/alerts.json         the alerts build (KAES-16/34, Finding A)
  data/trip-updates.json   full trip-updates envelope
  data/tu/index.json       per-route derivative index (KAES-45)
  data/tu/<family>/<route>.json[.N]
                           per-route derivatives, each <= 25,000 B

Cincinnati is a single-feed city: one family ("sorta"), three
separate legs (VP / TU / SA), collected and stored separately
and joined only in the flat canonical arrays the page renders
(LT-F5(b) / KAES-23 as adapted; the record's `family` field
carries the feed identity).

A leg whose bundle state is failed/missing contributes an
explicit sources.<family> error entry and an empty record set;
the transform of the remaining legs completes (KAES-20).
`generated_at` of every published file anchors to the bundle's
`collected_at` (LT-D6), so served freshness is honest.

Usage:
  transform.py --bundle-dir DIR --out-dir DIR --static ZIP
"""

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from classify import StaticSets  # noqa: E402
from gtfs_rt import decode_feed  # noqa: E402
from sorta_config import (  # noqa: E402
    AGENCY,
    ALERTS_FILE,
    TRIP_UPDATES_FILE,
    TU_DIR,
    TU_INDEX_FILE,
    TU_MAX_BYTES,
    VEHICLES_FILE,
)

MPS_TO_MPH = 2.23694


def iso(epoch):
    if epoch is None:
        return None
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_bundle(bundle_dir):
    bundle = Path(bundle_dir)
    manifest_path = bundle / "manifest.json"
    if not manifest_path.exists():
        raise RuntimeError(
            "bundle has no manifest.json — not a complete bundle (LT-D6)"
        )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    payloads = {}
    for leg_id, entry in manifest["legs"].items():
        if not entry["ok"]:
            payloads[leg_id] = None
            continue
        data = (bundle / entry["file"]).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest != entry["sha256"]:
            raise RuntimeError(f"bundle leg {leg_id}: sha256 mismatch")
        payloads[leg_id] = data
    return manifest, payloads


def decode_leg(payloads, manifest, leg_id):
    """-> (decoded|None, source_state). Never raises for a leg."""
    entry = manifest["legs"][leg_id]
    state = {
        "ok": False,
        "error": None,
        "count": 0,
        "feed_header_at": None,
        "bytes": entry.get("bytes"),
    }
    if not entry["ok"]:
        state["error"] = f"collect: {entry.get('error')}"
        return None, state
    try:
        decoded = decode_feed(payloads[leg_id])
    except Exception as e:  # a corrupt leg must not abort the run
        state["error"] = f"decode: {type(e).__name__}: {e}"[:300]
        return None, state
    state["ok"] = True
    state["feed_header_at"] = iso(decoded["header_ts"])
    state["count"] = len(decoded["entities"])
    return decoded, state


def vehicle_records(decoded, family, statics):
    """Canonical vehicle records for one VP leg (KAES-24/25)."""
    records = []
    counts = {"TRIP-MATCHED": 0, "ROUTE-MATCHED": 0, "UNASSIGNED": 0}
    unresolved_trips = 0
    if decoded is None:
        return records, counts, unresolved_trips
    seen = set()
    for ent in decoded["entities"]:
        vp = ent["vehicle"]
        if vp is None or vp["position"] is None:
            continue
        pos = vp["position"]
        if pos["lat"] is None or pos["lon"] is None:
            continue
        if not (38.7 < pos["lat"] < 39.65 and -84.9 < pos["lon"] < -83.9):
            continue  # Cincinnati sanity box (staged-streets bbox + margin)
        trip = vp["trip"] or {}
        desc = vp["vehicle"] or {}
        vehicle_id = desc.get("id") or desc.get("label") or ent["id"]
        # Exact (label, position) duplicate entities collapse, as in
        # the platform original (a SEPTA rail through-routing
        # behavior; retained because it only collapses exact
        # duplicates and is a no-op otherwise).
        key = (
            desc.get("label") or vehicle_id,
            round(pos["lat"], 5),
            round(pos["lon"], 5),
        )
        if key in seen:
            continue
        seen.add(key)
        trip_id = trip.get("trip_id")
        route_id = trip.get("route_id")
        classification, unresolved = statics.classify(family, trip_id, route_id)
        counts[classification] += 1
        if unresolved:
            unresolved_trips += 1
        ts = vp["timestamp"] or decoded["header_ts"]
        records.append(
            {
                "agency": AGENCY,
                "family": family,
                "route_id": route_id,
                "vehicle_id": vehicle_id,
                "lat": round(pos["lat"], 6),
                "lon": round(pos["lon"], 6),
                "bearing": pos["bearing"],
                "speed_mph": (
                    round(pos["speed_mps"] * MPS_TO_MPH, 1)
                    if pos["speed_mps"] is not None
                    else None
                ),
                "destination": (
                    statics.trip_headsign(family, trip_id)
                    if classification == "TRIP-MATCHED"
                    else None
                ),
                "updated_at": iso(ts),
                "trip_id": trip_id,
                "classification": classification,
            }
        )
    return records, counts, unresolved_trips


def trip_update_records(decoded, family, statics):
    records = []
    if decoded is None:
        return records
    for ent in decoded["entities"]:
        tu = ent["trip_update"]
        if tu is None:
            continue
        trip = tu["trip"] or {}
        trip_id = trip.get("trip_id")
        stus = []
        for s in tu["stop_time_updates"]:
            stus.append(
                {
                    "stop_sequence": s["stop_sequence"],
                    "stop_id": s["stop_id"],
                    "arrival": s["arrival"],
                    "departure": s["departure"],
                    "schedule_relationship": s["schedule_relationship"],
                }
            )
        records.append(
            {
                "id": ent["id"],
                "agency": AGENCY,
                "family": family,
                "trip_id": trip_id,
                "route_id": trip.get("route_id"),
                "direction_id": trip.get("direction_id"),
                "start_time": trip.get("start_time"),
                "start_date": trip.get("start_date"),
                "vehicle_id": (tu["vehicle"] or {}).get("id"),
                "timestamp": iso(tu["timestamp"]),
                "delay": tu["delay"],
                "trip_resolved": bool(
                    trip_id and trip_id in statics.trips.get(family, {})
                ),
                "stop_time_updates": stus,
            }
        )
    return records


def alert_records(decoded, family):
    records = []
    if decoded is None:
        return records
    for ent in decoded["entities"]:
        al = ent["alert"]
        if al is None:
            continue
        records.append(
            {
                "id": ent["id"],
                "agency": AGENCY,
                "family": family,
                "header": al["header"],
                "description": al["description"],
                "url": al["url"],
                "cause": al["cause"],
                "effect": al["effect"],
                "severity": al["severity"],
                "active_periods": [
                    {
                        "start": iso(p["start"]),
                        "end": iso(p["end"]),
                        "start_epoch": p["start"],
                        "end_epoch": p["end"],
                    }
                    for p in al["active_periods"]
                ],
                "informed_entities": al["informed_entities"],
            }
        )
    return records


def family_source(vp_state, extra_legs):
    """sources.<family> from its VP leg state (KAES-20)."""
    src = {
        "ok": vp_state["ok"],
        "error": vp_state["error"],
        "count": vp_state["count"],
        "feed_header_at": vp_state["feed_header_at"],
    }
    src.update(extra_legs)
    return src


def safe_route_name(route_id):
    return re.sub(r"[^A-Za-z0-9._-]", "_", route_id or "unknown")


def write_tu_derivatives(out_data, generated_at, tu_records):
    """Per-route TU derivatives <= TU_MAX_BYTES each (KAES-45)."""
    tu_dir = out_data / TU_DIR
    by_route = {}
    for rec in tu_records:
        by_route.setdefault((rec["family"], rec["route_id"] or "unknown"), []).append(
            rec
        )
    index_routes = []
    total_files = 0
    oversize = []
    for (family, route_id), recs in sorted(by_route.items()):
        fam_dir = tu_dir / family
        fam_dir.mkdir(parents=True, exist_ok=True)
        base = safe_route_name(route_id)
        files = []
        chunk, chunk_no = [], 1

        def flush(chunk, chunk_no):
            name = f"{base}.json" if chunk_no == 1 else f"{base}.{chunk_no}.json"
            doc = {
                "generated_at": generated_at,
                "agency": AGENCY,
                "family": family,
                "route_id": route_id,
                "count": len(chunk),
                "trip_updates": chunk,
            }
            blob = json.dumps(doc, separators=(",", ":")).encode()
            (fam_dir / name).write_bytes(blob)
            if len(blob) > TU_MAX_BYTES:
                oversize.append({"file": f"{family}/{name}", "bytes": len(blob)})
            files.append({"file": name, "count": len(chunk), "bytes": len(blob)})
            return len(files)

        for rec in recs:
            trial = chunk + [rec]
            doc = {
                "generated_at": generated_at,
                "agency": AGENCY,
                "family": family,
                "route_id": route_id,
                "count": len(trial),
                "trip_updates": trial,
            }
            if (
                len(json.dumps(doc, separators=(",", ":")).encode()) > TU_MAX_BYTES
                and chunk
            ):
                flush(chunk, chunk_no)
                chunk_no += 1
                chunk = [rec]
            else:
                chunk = trial
        if chunk:
            flush(chunk, chunk_no)
        total_files += len(files)
        index_routes.append(
            {"family": family, "route_id": route_id, "count": len(recs), "files": files}
        )
    index = {
        "generated_at": generated_at,
        "agency": AGENCY,
        "count": len(tu_records),
        "route_count": len(index_routes),
        "file_count": total_files,
        "routes": index_routes,
    }
    tu_dir.mkdir(parents=True, exist_ok=True)
    (tu_dir / TU_INDEX_FILE).write_text(
        json.dumps(index, separators=(",", ":")), encoding="utf-8"
    )
    return index, oversize


def transform(bundle_dir, out_dir, sorta_static):
    manifest, payloads = load_bundle(bundle_dir)
    generated_at = manifest["collected_at"]
    statics = StaticSets()
    static_info = [statics.load("sorta", sorta_static)]

    decoded, states = {}, {}
    for leg_id in manifest["legs"]:
        decoded[leg_id], states[leg_id] = decode_leg(payloads, manifest, leg_id)

    out_data = Path(out_dir) / "data"
    (out_data / TU_DIR).mkdir(parents=True, exist_ok=True)

    # ---- vehicles (KAES-24/25) ----
    vehicles, classification, unresolved = [], {}, 0
    vp_states = {}
    for family, leg in (("sorta", "sorta-vp"),):
        recs, counts, unres = vehicle_records(decoded[leg], family, statics)
        vehicles.extend(recs)
        vp_states[family] = states[leg]
        unresolved += unres
        for k, v in counts.items():
            classification[k] = classification.get(k, 0) + v
    classification["total"] = len(vehicles)
    classification["unresolved_trip_ids"] = unresolved
    vehicles_doc = {
        "generated_at": generated_at,
        "count": len(vehicles),
        "vehicles": vehicles,
        "sources": {
            fam: family_source(
                vp_states[fam],
                {
                    "leg": f"{fam}-vp",
                    "classification": {
                        k: sum(
                            1
                            for r in vehicles
                            if r["family"] == fam and r["classification"] == k
                        )
                        for k in ("TRIP-MATCHED", "ROUTE-MATCHED", "UNASSIGNED")
                    },
                },
            )
            for fam in ("sorta",)
        },
        "legs": {
            leg: {
                "ok": s["ok"],
                "error": s["error"],
                "count": s["count"],
                "feed_header_at": s["feed_header_at"],
            }
            for leg, s in states.items()
        },
        "classification": classification,
    }
    (out_data / VEHICLES_FILE).write_text(
        json.dumps(vehicles_doc, separators=(",", ":")), encoding="utf-8"
    )

    # ---- trip updates + derivatives (KAES-16/45) ----
    tu_records = []
    for family, leg in (("sorta", "sorta-tu"),):
        tu_records.extend(trip_update_records(decoded[leg], family, statics))
    tu_doc = {
        "generated_at": generated_at,
        "count": len(tu_records),
        "trip_updates": tu_records,
        "sources": {
            fam: {
                "ok": states[f"{fam}-tu"]["ok"],
                "error": states[f"{fam}-tu"]["error"],
                "count": states[f"{fam}-tu"]["count"],
                "feed_header_at": states[f"{fam}-tu"]["feed_header_at"],
            }
            for fam in ("sorta",)
        },
    }
    (out_data / TRIP_UPDATES_FILE).write_text(
        json.dumps(tu_doc, separators=(",", ":")), encoding="utf-8"
    )
    tu_index, oversize = write_tu_derivatives(out_data, generated_at, tu_records)

    # ---- alerts (KAES-16/34) ----
    alerts = []
    for family, leg in (("sorta", "sorta-sa"),):
        alerts.extend(alert_records(decoded[leg], family))
    alerts_doc = {
        "generated_at": generated_at,
        "count": len(alerts),
        "alerts": alerts,
        "sources": {
            fam: {
                "ok": states[f"{fam}-sa"]["ok"],
                "error": states[f"{fam}-sa"]["error"],
                "count": states[f"{fam}-sa"]["count"],
                "feed_header_at": states[f"{fam}-sa"]["feed_header_at"],
            }
            for fam in ("sorta",)
        },
    }
    (out_data / ALERTS_FILE).write_text(
        json.dumps(alerts_doc, separators=(",", ":")), encoding="utf-8"
    )

    report = {
        "stage": "transform",
        "generated_at": generated_at,
        "bundle_collected_at": manifest["collected_at"],
        "statics": static_info,
        "legs": {
            leg: {
                "ok": s["ok"],
                "error": s["error"],
                "entities": s["count"],
                "feed_header_at": s["feed_header_at"],
            }
            for leg, s in states.items()
        },
        "vehicles": {"count": len(vehicles), "classification": classification},
        "trip_updates": {
            "count": len(tu_records),
            "resolved": sum(1 for r in tu_records if r["trip_resolved"]),
            "derivative_files": tu_index["file_count"],
            "derivative_routes": tu_index["route_count"],
            "oversize_files": oversize,
        },
        "alerts": {"count": len(alerts)},
    }
    Path(out_dir, "transform-report.json").write_text(
        json.dumps(report, indent=1), encoding="utf-8"
    )
    print(
        f"transform: vehicles={len(vehicles)} "
        f"classification={classification} "
        f"tu={len(tu_records)} alerts={len(alerts)}"
    )
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle-dir", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--static", required=True)
    args = ap.parse_args()
    return transform(args.bundle_dir, args.out_dir, args.static)


if __name__ == "__main__":
    sys.exit(main())
