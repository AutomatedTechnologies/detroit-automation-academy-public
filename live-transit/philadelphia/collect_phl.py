#!/usr/bin/env python3
"""
collect_phl.py — Philadelphia live-vehicle collector (stdlib only).

Fetches SEPTA's agency-direct GTFS-RT vehicle-position feeds (the
A2-validated endpoints at www3.septa.org), decodes the protobuf with a
minimal wire-format reader, and writes one JSON envelope whose bus and
rail sections remain separate feed records (silo rule: the file is a
transport envelope, never a merge — each section is one feed's records
with its own header stamp).

Source endpoints (no key, agency-direct; Swiftly mirrors excluded):
  bus : https://www3.septa.org/gtfsrt/septa-pa-us/Vehicle/rtVehiclePosition.pb
  rail: https://www3.septa.org/gtfsrt/septarail-pa-us/Vehicle/rtVehiclePosition.pb

Usage: collect_phl.py <output.json>
"""

import json
import struct
import sys
import time
import urllib.request
from datetime import datetime, timezone

ENDPOINTS = {
    "septa-bus": (
        "https://www3.septa.org/gtfsrt/septa-pa-us/" "Vehicle/rtVehiclePosition.pb"
    ),
    "septa-rail": (
        "https://www3.septa.org/gtfsrt/septarail-pa-us/" "Vehicle/rtVehiclePosition.pb"
    ),
}


# ------------------------------------------------------------ protobuf wire
def _varint(buf, i):
    shift = 0
    result = 0
    while True:
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, i
        shift += 7


def fields(buf):
    """Yield (field_no, wire_type, value) — value is int, bytes, or raw slice."""
    i, n = 0, len(buf)
    while i < n:
        tag, i = _varint(buf, i)
        fno, wt = tag >> 3, tag & 7
        if wt == 0:
            v, i = _varint(buf, i)
        elif wt == 1:
            v = buf[i : i + 8]
            i += 8
        elif wt == 2:
            ln, i = _varint(buf, i)
            v = buf[i : i + ln]
            i += ln
        elif wt == 5:
            v = buf[i : i + 4]
            i += 4
        else:
            raise ValueError(f"unsupported wire type {wt}")
        yield fno, wt, v


def _f32(b):
    return struct.unpack("<f", b)[0]


def decode_feed(buf):
    """GTFS-RT FeedMessage -> (header_timestamp, [vehicle dicts])."""
    header_ts = None
    vehicles = []
    for fno, wt, v in fields(buf):
        if fno == 1:  # FeedHeader
            for hf, _, hv in fields(v):
                if hf == 3:
                    header_ts = hv
        elif fno == 2:  # FeedEntity
            ent_id, veh = None, None
            for ef, _, ev in fields(v):
                if ef == 1:
                    ent_id = ev.decode("utf-8", "replace")
                elif ef == 4:  # FeedEntity.vehicle (3 is trip_update)
                    veh = ev
            if veh is None:
                continue
            rec = {
                "entity": ent_id,
                "route": None,
                "trip": None,
                "label": None,
                "lat": None,
                "lon": None,
                "bearing": None,
                "ts": None,
            }
            # SEPTA's vendor serializes VehiclePosition NONSTANDARDLY
            # (measured 2026-10-23 against the live feed + TransitView
            # ground truth): position at field 2 (fixed32 subfields),
            # descriptor at field 8, timestamp at field 5. Standard-layout
            # messages (descriptor at 2, position at 3, timestamp at 7)
            # are handled by type-checking each candidate field.
            subs = {}
            for vf, wt, vv in fields(veh):
                subs.setdefault(vf, []).append((wt, vv))

            def parse_position(msg):
                lat = lon = bearing = None
                for pf, pwt, pv in fields(msg):
                    if pwt == 5 and pf == 1:
                        lat = _f32(pv)
                    elif pwt == 5 and pf == 2:
                        lon = _f32(pv)
                    elif pwt == 5 and pf == 3:
                        bearing = round(_f32(pv), 1)
                if (
                    lat is not None
                    and lon is not None
                    and 38.0 < lat < 42.0
                    and -77.0 < lon < -73.0
                ):
                    return lat, lon, bearing
                return None

            def parse_descriptor(msg):
                label = None
                for df, dwt, dv in fields(msg):
                    if dwt == 2 and df in (1, 2):
                        label = dv.decode("utf-8", "replace")
                return label

            for vf, lst in subs.items():
                wt, vv = lst[0]
                if vf == 1 and wt == 2:  # TripDescriptor (standard)
                    for tf, _, tv in fields(vv):
                        if tf == 1:
                            rec["trip"] = tv.decode("utf-8", "replace")
                        elif tf == 5:
                            rec["route"] = tv.decode("utf-8", "replace")
                elif vf == 2 and wt == 2:
                    p = parse_position(vv)
                    if p:
                        rec["lat"], rec["lon"], rec["bearing"] = p
                    else:
                        lab = parse_descriptor(vv)
                        if lab:
                            rec["label"] = lab
                elif vf == 3 and wt == 2 and rec["lat"] is None:
                    p = parse_position(vv)
                    if p:
                        rec["lat"], rec["lon"], rec["bearing"] = p
                elif vf == 8 and wt == 2:
                    lab = parse_descriptor(vv)
                    if lab:
                        rec["label"] = lab
                elif (
                    vf in (5, 7)
                    and wt == 0
                    and isinstance(vv, int)
                    and vv > 1_500_000_000
                ):
                    rec["ts"] = vv
            if rec["lat"] is not None and rec["lon"] is not None:
                vehicles.append(rec)
    return header_ts, vehicles


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "vehicles.json"
    fetched = int(time.time())
    doc = {"city": "philadelphia", "fetched_at": iso(fetched), "feeds": {}}
    for feed_id, url in ENDPOINTS.items():
        req = urllib.request.Request(url, headers={"User-Agent": "lt-phl-collect/1.0"})
        # URLs are the hard-coded https ENDPOINTS above; no external input.
        with urllib.request.urlopen(req, timeout=60) as r:  # nosec B310
            buf = r.read()
        header_ts, vehicles = decode_feed(buf)
        # SEPTA rail emits one entity per trip assignment for
        # through-routed trains (same vehicle, same position, several
        # trip/route pairs). For a position display, collapse exact
        # (label, position) duplicates, keeping the first assignment.
        seen = set()
        deduped = []
        for v in vehicles:
            k = (v["label"], round(v["lat"], 5), round(v["lon"], 5))
            if k in seen:
                continue
            seen.add(k)
            deduped.append(v)
        vehicles = deduped
        with_route = sum(1 for v in vehicles if v["route"])
        doc["feeds"][feed_id] = {
            "source": url,
            "feed_header_at": iso(header_ts) if header_ts else None,
            "vehicles": vehicles,
            "count": len(vehicles),
            "with_route": with_route,
        }
        print(
            f"{feed_id}: {len(vehicles)} vehicles, {with_route} with route, "
            f"header {doc['feeds'][feed_id]['feed_header_at']}"
        )
    with open(out_path, "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    print("wrote", out_path)


if __name__ == "__main__":
    main()
