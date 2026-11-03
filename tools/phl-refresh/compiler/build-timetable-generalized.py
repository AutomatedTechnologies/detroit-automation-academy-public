#!/usr/bin/env python3
"""Generalized multi-feed GTFS -> planner-timetable compiler.

Board 47 item 7, implementation tranche 1 (2026-10-22). One compiler
serves the program: it replaces the three historical per-city
builders —

  - goals/forge-line-live-transit-layer/files/build-timetable.py
    (DDOT lane: page-registry stop mapping, sequence-fraction
    interpolation of timepoint=0 rows, GTFS-coordinate walk edges)
  - goals/daa-uplift-u7-smart-planning/hidden_files/phaseb-work/
    build-planner-timetable.py (the merge: first feed carried
    verbatim, second feed appended with namespaced service ids, a
    legacy-id coordinate crosswalk, registry-space walk edges for
    every pair involving the appended feed)
  - goals/live-transit-philadelphia/hidden_files/nav-harness/
    build-timetable-septa.py (GTFS-defined registry; its
    DAY-SIGNATURE service folding is NOT carried forward — see below)

— with per-feed lane configuration. The lane algorithms are ported
verbatim from those builders (iteration orders, tie rules, and
edge-ordering semantics included): the Detroit regression gate (G1)
requires the generalized compiler to reproduce the served merged
Detroit asset, and it can only do that if the port is faithful,
quirks included. Every quirk kept is marked PORT in a comment.

SERVICE MODEL — the generalization (design section 1). Services are
carried RAW: calendar.txt rows as published (mask, window), plus a
service entry for every service_id that appears only in
calendar_dates.txt (all-zero mask; window = its exception dates —
design section 4.1 / SVC-1: a date set is a calendar set of measure
zero plus additions; nothing is synthesized). service_exceptions are
carried RAW (date, service, added 1/2 — additions AND removals).
Every GTFS trip is emitted exactly once, its `s` naming its published
service. meta.service_model is "set": the asset pairs with an engine
whose resolver returns the active service SET per (feed, date).

CROSS-FEED WALK EDGES (design section 2) are an unconditional step:
registry keys are (feed, stop_id) pairs — feeds are never merged at
the registry level — and edges are built over the merged registry,
400 m radius, secs = max(60, round(d / 1.4)), so co-located stops
across feeds land on the 60 s floor edge and disjoint-namespace
feeds (Philadelphia) get purely coordinate-built cross-feed edges.
Detroit's published first-feed edge set is reproduced as the seed
(the historical builders' split is a config flag, not a fork).

INGEST GATE (design section 4.4, tranche 5). Feed validity is a hard
ingest gate: before any building, each feed's feed_info window is
checked against the build date (America/Detroit). A build date outside
the published window FAILS the build loudly, naming the feed, its
version, and the expired window — the Sacramento catalog hazard (an
18-month-expired feed served with no error) must never compile
silently. A window ending within INGEST_WARN_DAYS of the build date
warns instead (the feed is valid but its re-fetch horizon is near).
Gate verdicts are recorded per feed in build-record.json; the gate is
a check, never a transformation — it does not alter asset bytes.
Absent-window behavior (tranche 6, 2026-10-23, resolving consolidation
finding F1): a feed with no feed_info.txt, no data row, or empty /
unparseable window fields fails with the named IngestGateError — a
feed that cannot state its validity cannot be certified current.

CAPABILITY CENSUS (design sections 4.6/4.7, tranche 6). Every build
records a per-feed capability census in build-record.json: fare
presence (FARES-PRESENT with the feed-carried products, or
FARES-ABSENT with the not-published record) and accessibility flag
populations per field (a uniformly 0/blank field is UNPOPULATED and
sources no claim in either direction). The census is a compile-report
product only; it never enters the planner asset.

LOCAL ONLY. Outputs are offline evaluation assets; nothing here is
deployed.
"""

import csv
import json
import math
import os
import sys
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

WALK_M = 400.0
WALK_MPS = 1.4
INGEST_WARN_DAYS = 45

EXP = "/home/hatch/workspace/goals/live-transit-multi-city-expansion"
PHL = "/home/hatch/workspace/goals/live-transit-philadelphia"
FORGE = "/home/hatch/workspace/goals/forge-line-live-transit-layer"
U7 = "/home/hatch/workspace/goals/daa-uplift-u7-smart-planning/hidden_files/phaseb-work"

CITIES = {
    "detroit": {
        "seed_edges_first_feed": True,
        "timepoint_policy": "ddot: interpolated+flagged; "
        "smart: publisher times verbatim",
        "feeds": [
            {
                "tag": 0,
                "zip": FORGE + "/hidden_files/gtfs/ddot_gtfs_S1000182.zip",
                "registry": "page",
                "registry_file": U7 + "/served/ddot-routes-3d.json",
                "matchers": ["exact"],
                "time_policy": "interpolate",
                "namespace": "",
                "agency": "DDOT",
                "meta_feed": {"agency": "DDOT"},
            },
            {
                "tag": 1,
                "zip": U7 + "/gtfs/smart_gtfs.zip",
                "registry": "page",
                "registry_file": U7 + "/served/smart-routes-3d.json",
                "matchers": ["namespaced:SMARTGTFS:", "crosswalk:SMARTMI:"],
                "time_policy": "verbatim",
                "namespace": "S:",
                "agency": "SMART",
                "route_color": "#c30915",
                "meta_feed": {
                    "agency": "SMART",
                    "source": "SMART published GTFS "
                    "(apps1.smartbus.org/gtfs/smart_gtfs.zip)",
                    "publisher": "SMART",
                },
            },
        ],
    },
    "philadelphia": {
        "seed_edges_first_feed": False,
        "timepoint_policy": "septa: publisher times verbatim (both zips: "
        "0 missing times in 2,181,035 stop_times; "
        "timepoint=0 rows carry published values)",
        "feeds": [
            {
                "tag": 0,
                "zip": PHL + "/hidden_files/gtfs/google_bus.zip",
                "registry": "gtfs",
                "matchers": ["gtfs"],
                "time_policy": "verbatim",
                "namespace": "B:",
                "agency": "SEPTA",
                "meta_feed": {
                    "agency": "SEPTA",
                    "family": "bus",
                    "source": "SEPTA developer service "
                    "(https://www3.septa.org/developer/google_bus.zip)",
                    "publisher": "SEPTA",
                },
            },
            {
                "tag": 1,
                "zip": PHL + "/hidden_files/gtfs/google_rail.zip",
                "registry": "gtfs",
                "matchers": ["gtfs"],
                "time_policy": "verbatim",
                "namespace": "R:",
                "agency": "SEPTA",
                "meta_feed": {
                    "agency": "SEPTA",
                    "family": "rail",
                    "source": "SEPTA developer service "
                    "(https://www3.septa.org/developer/google_rail.zip)",
                    "publisher": "SEPTA",
                },
            },
        ],
    },
    "sacramento": {
        # Tranche 5 (section 4.4 acceptance): first section-4 city on the
        # generalized compiler. The zip of record is the agency portal's
        # current link (apps.sacrt.com/gtfs/srtd/google_transit.zip,
        # SEP26 GTFS, valid to 2027-01-02) as staged by A2 — NEVER the
        # Mobility Database catalog URL, which served the expired
        # January_2025 feed (hidden_files/a2-sacramento/
        # sacrt-static-WPCONTENT-STALE.zip, retained as the gate's
        # failure fixture).
        "seed_edges_first_feed": False,
        "timepoint_policy": "sacrt: publisher times verbatim",
        "feeds": [
            {
                "tag": 0,
                "zip": EXP + "/hidden_files/a2-sacramento/" "sacrt-static.zip",
                "registry": "gtfs",
                "matchers": ["gtfs"],
                "time_policy": "verbatim",
                "namespace": "",
                "agency": "SacRT",
                "meta_feed": {
                    "agency": "SacRT",
                    "source": "SacRT agency portal "
                    "(apps.sacrt.com/gtfs/srtd/"
                    "google_transit.zip)",
                    "publisher": "Sacramento Regional Transit",
                },
            },
        ],
    },
    # Section 4 second pass (tranche 6, 2026-10-23): the remaining
    # measured PASS cities join the generalized compiler so the
    # capability gates (4.6/4.7) and section 5 classification ride on
    # real per-city compiles. Zips are the A2-staged artifacts of
    # record; single-feed GTFS lane, verbatim times, no namespace.
    "denver": {
        "seed_edges_first_feed": False,
        "timepoint_policy": "rtd: publisher times verbatim",
        "feeds": [
            {
                "tag": 0,
                "zip": EXP + "/hidden_files/a2-denver/" "rtd.gtfs.zip",
                "registry": "gtfs",
                "matchers": ["gtfs"],
                "time_policy": "verbatim",
                "namespace": "",
                "agency": "RTD",
                "meta_feed": {
                    "agency": "RTD",
                    "source": "RTD open data " "(open-data.rtd-denver.com)",
                    "publisher": "RTD",
                },
            },
        ],
    },
    "columbus": {
        "seed_edges_first_feed": False,
        "timepoint_policy": "cota: publisher times verbatim",
        "feeds": [
            {
                "tag": 0,
                "zip": EXP + "/hidden_files/a2-columbus/" "cota.gtfs.zip",
                "registry": "gtfs",
                "matchers": ["gtfs"],
                "time_policy": "verbatim",
                "namespace": "",
                "agency": "COTA",
                "meta_feed": {
                    "agency": "COTA",
                    "source": "COTA developer data " "(cota.com/data)",
                    "publisher": "Central Ohio Transit " "Authority",
                },
            },
        ],
    },
    "cincinnati": {
        "seed_edges_first_feed": False,
        "timepoint_policy": "sorta: publisher times verbatim",
        "feeds": [
            {
                "tag": 0,
                "zip": EXP + "/hidden_files/basemap-staging/"
                "cincinnati/work/sorta.gtfs.zip",
                "registry": "gtfs",
                "matchers": ["gtfs"],
                "time_policy": "verbatim",
                "namespace": "",
                "agency": "SORTA",
                "meta_feed": {
                    "agency": "SORTA",
                    "source": "SORTA developer data "
                    "(go-metro.com/about/"
                    "developer-data)",
                    "publisher": "Southwest Ohio Regional " "Transit Authority",
                },
            },
        ],
    },
    "austin": {
        # SVC-1 shape: no calendar.txt — service defined entirely by
        # calendar_dates.txt (432 added rows, 30 service_ids, A2).
        "seed_edges_first_feed": False,
        "timepoint_policy": "capmetro: publisher times verbatim",
        "feeds": [
            {
                "tag": 0,
                "zip": EXP + "/hidden_files/basemap-staging/"
                "austin/work/capmetro.gtfs.zip",
                "registry": "gtfs",
                "matchers": ["gtfs"],
                "time_policy": "verbatim",
                "namespace": "",
                "agency": "CapMetro",
                "meta_feed": {
                    "agency": "CapMetro",
                    "source": "CapMetro via data.texas.gov "
                    "Socrata (dataset r4v4-vz24)",
                    "publisher": "Capital Metropolitan " "Transportation Authority",
                },
            },
        ],
    },
}


class IngestGateError(Exception):
    """A feed's published validity window does not cover the build
    date (design section 4.4). The build fails loudly; nothing is
    written."""


def build_date_local():
    return datetime.now(ZoneInfo("America/Detroit")).date()


def ingest_gate(feed_label, feed_info, build_date):
    """Section 4.4 validity gate. Returns a verdict dict; raises
    IngestGateError when the build date falls outside the feed's
    published [feed_start_date, feed_end_date] window. A window ending
    within INGEST_WARN_DAYS after the build date passes with a
    warning (re-fetch horizon near).

    Absent-window behavior (specified 2026-10-23, section 4 second
    pass, resolving consolidation finding F1): GTFS does not require
    feed_info.txt, and a feed may carry the file with empty or
    unparseable window fields. An absent or unparseable window fails
    the gate with the named IngestGateError, exactly as an
    out-of-window feed does — a feed that cannot state its validity
    cannot be certified current, and section 4.4's rule is that an
    uncertifiable feed never compiles silently."""
    raw_start = (feed_info or {}).get("feed_start_date")
    raw_end = (feed_info or {}).get("feed_end_date")
    try:
        start = datetime.strptime((raw_start or "").strip(), "%Y%m%d").date()
        end = datetime.strptime((raw_end or "").strip(), "%Y%m%d").date()
    except (ValueError, AttributeError):
        raise IngestGateError(
            f"INGEST-GATE FAIL: {feed_label} — feed_info validity "
            f"window absent or unparseable (feed_start_date="
            f"{raw_start!r}, feed_end_date={raw_end!r}) — a feed "
            f"that cannot state its validity cannot be certified "
            f"current and is refused at ingest (design 4.4; "
            f"absent-window behavior specified 2026-10-23)"
        )
    version = feed_info.get("feed_version", "?")
    verdict = {
        "feed": feed_label,
        "feed_version": version,
        "valid_from": start.isoformat(),
        "valid_to": end.isoformat(),
        "build_date": build_date.isoformat(),
        "result": "pass",
    }
    if build_date < start or build_date > end:
        raise IngestGateError(
            f"INGEST-GATE FAIL: {feed_label} feed_version {version} "
            f"window {start.isoformat()}..{end.isoformat()} does not "
            f"cover build date {build_date.isoformat()} — expired or "
            f"not-yet-valid feed refused at ingest (design 4.4)"
        )
    if (end - build_date).days <= INGEST_WARN_DAYS:
        verdict["result"] = "warn"
        verdict["warning"] = (
            f"validity window ends {end.isoformat()}, within "
            f"{INGEST_WARN_DAYS} days of build date "
            f"{build_date.isoformat()} — re-fetch horizon near"
        )
    return verdict


def t2s(t):
    h, m, s = t.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def read_csv(z, name):
    if name not in z.namelist():
        return []
    with z.open(name) as f:
        return list(csv.DictReader(f.read().decode("utf-8-sig").splitlines()))


def norm_name(n):
    # PORT: U7 merge builder's crosswalk name normalization.
    return " ".join((n or "").replace("&", "/").split()).lower()


# ------------------------------------------------------------------
# Capability census (design sections 4.6 FARE-CAP and 4.7 A11Y-CAP,
# section 4 second pass). The census is a compile-REPORT product: it
# rides in build-record.json, never in the planner asset (the asset
# has no fare or accessibility consumer yet, and its Detroit sections
# are G1-frozen). The gates it feeds: a city whose feed carries no
# fare files is FARES-ABSENT (no fare surface, no placeholder price,
# no value borrowed from another city); a $0.00 product the feed DOES
# carry is FARES-PRESENT priced at zero — absence and free are
# different states. An accessibility field whose population is
# uniformly 0/blank (GTFS: no information) is UNPOPULATED and yields
# no accessibility surface and no claim in either direction; 0 is
# never recoded as "not accessible."
# ------------------------------------------------------------------
FARE_FILES_V1 = ("fare_attributes.txt", "fare_rules.txt")
FARE_FILES_V2 = (
    "fare_products.txt",
    "fare_media.txt",
    "fare_leg_rules.txt",
    "fare_transfer_rules.txt",
    "rider_categories.txt",
)


def _field_census(rows, field):
    """Distribution of one GTFS field over rows. 'informative' counts
    values that state a fact — for accessibility fields, codes 1 and
    2 (0 and blank both mean 'no information' in GTFS)."""
    dist = {}
    for r in rows:
        v = (r.get(field) or "").strip()
        dist[v] = dist.get(v, 0) + 1
    informative = sum(n for v, n in dist.items() if v in ("1", "2"))
    total = len(rows)
    return {
        "total": total,
        "values": {k if k else "<blank>": v for k, v in sorted(dist.items())},
        "informative": informative,
        "population": ("POPULATED" if informative > 0 else "UNPOPULATED"),
    }


def capability_census(z, stops, trips):
    names = set(z.namelist())
    fares = {
        "files_present": sorted(f for f in FARE_FILES_V1 + FARE_FILES_V2 if f in names)
    }
    if not fares["files_present"]:
        fares.update(
            {
                "state": "ABSENT",
                "products": [],
                "routes_mapped": 0,
                "record": "fare data not published in feed "
                "(design 4.6 FARES-ABSENT)",
            }
        )
    else:
        products = []
        if "fare_attributes.txt" in names:
            for r in read_csv(z, "fare_attributes.txt"):
                products.append(
                    {
                        "fare_id": r.get("fare_id"),
                        "price": r.get("price"),
                        "currency": r.get("currency_type"),
                    }
                )
        routes_mapped = 0
        if "fare_rules.txt" in names:
            routes_mapped = len(
                {
                    r["route_id"]
                    for r in read_csv(z, "fare_rules.txt")
                    if r.get("route_id")
                }
            )
        v2_count = (
            len(read_csv(z, "fare_products.txt")) if "fare_products.txt" in names else 0
        )
        fares.update(
            {
                "state": "PRESENT",
                "products": products,
                "routes_mapped": routes_mapped,
                "fares_v2_products": v2_count,
                "record": "values rendered only from "
                "feed-carried products (design 4.6)",
            }
        )
    a11y = {
        "stops_wheelchair_boarding": _field_census(stops, "wheelchair_boarding"),
        "trips_wheelchair_accessible": _field_census(trips, "wheelchair_accessible"),
        "pathways_txt": "pathways.txt" in names,
        "levels_txt": "levels.txt" in names,
    }
    return {"fares": fares, "accessibility": a11y}


# ------------------------------------------------------------------
# Lane: services + exceptions, raw carriage (design section 1.3).
# ------------------------------------------------------------------
def build_services(calendar, cal_dates, namespace, tag):
    services, svc_idx = [], {}
    for c in calendar:
        mask = [
            int(c[d])
            for d in (
                "monday",
                "tuesday",
                "wednesday",
                "thursday",
                "friday",
                "saturday",
                "sunday",
            )
        ]
        sid = namespace + c["service_id"]
        svc_idx[sid] = len(services)
        services.append(
            {
                "id": sid,
                "mask": mask,
                "start": c["start_date"],
                "end": c["end_date"],
                "feed": tag,
            }
        )
    # Services defined by calendar_dates alone (SVC-1): all-zero mask,
    # window = the service's own exception dates. Appended in
    # first-appearance order in calendar_dates.
    cd_only = {}
    for r in cal_dates:
        sid = namespace + r["service_id"]
        if sid not in svc_idx:
            cd_only.setdefault(sid, []).append(r["date"])
    for sid, dates in cd_only.items():
        svc_idx[sid] = len(services)
        services.append(
            {
                "id": sid,
                "mask": [0, 0, 0, 0, 0, 0, 0],
                "start": min(dates),
                "end": max(dates),
                "feed": tag,
            }
        )
    exceptions = [
        {
            "date": r["date"],
            "service": namespace + r["service_id"],
            "added": int(r["exception_type"]),
        }
        for r in cal_dates
    ]
    return services, svc_idx, exceptions, len(cd_only)


# ------------------------------------------------------------------
# Lane: page-registry stop mapping (Detroit builders, ported).
# ------------------------------------------------------------------
def page_stop_mapping(feed_cfg, geo, stops, st_stop_ids):
    """Return (stop_to_idx_local, points_local) for a page-registry
    lane: local indices into the registry file's stop list, and the
    registry-space point (x, z) of every registry stop."""
    reg_stops = geo["stops"]
    points = [(s["x"], s["z"]) for s in reg_stops]
    stop_to_idx = {}
    for matcher in feed_cfg["matchers"]:
        if matcher == "exact":
            # PORT: DDOT builder — registry ids ARE the GTFS stop ids.
            for i, s in enumerate(reg_stops):
                stop_to_idx[s["id"]] = i
        elif matcher.startswith("namespaced:"):
            prefix = matcher.split(":", 1)[1]
            for i, s in enumerate(reg_stops):
                if s["id"].startswith(prefix):
                    stop_to_idx[s["id"][len(prefix) :]] = i
        elif matcher.startswith("crosswalk:"):
            # PORT: U7 merge builder — legacy-id records resolve by
            # coordinate identity (<= 25 m in the registry's own
            # projected space) + normalized-name equality.
            prefix = matcher.split(":", 1)[1]
            legacy = [
                (i, s) for i, s in enumerate(reg_stops) if s["id"].startswith(prefix)
            ]
            proj = geo["projection"]
            kx = 111320 * math.cos(math.radians(proj["lat0"]))

            def project(lat, lon):
                return ((lon - proj["lon0"]) * kx, -(lat - proj["lat0"]) * 111320)

            stop_by_id = {s["stop_id"]: s for s in stops}
            n_dup = 0
            for sid in sorted(st_stop_ids):
                if sid in stop_to_idx:
                    continue
                s = stop_by_id.get(sid)
                if s is None:
                    continue
                x, zz = project(float(s["stop_lat"]), float(s["stop_lon"]))
                cands = []
                for ridx, rs in legacy:
                    d = math.hypot(x - rs["x"], zz - rs["z"])
                    if d <= 25 and norm_name(rs["n"]) == norm_name(s["stop_name"]):
                        cands.append((d, ridx))
                if not cands:
                    continue
                cands.sort(key=lambda c: (round(c[0], 1), c[1]))
                if len(cands) > 1 and cands[1][0] - cands[0][0] < 5:
                    n_dup += 1
                stop_to_idx[sid] = cands[0][1]
            print(f"    crosswalk duplicate-record cases: {n_dup}")
        else:
            raise ValueError(f"unknown matcher {matcher}")
    return stop_to_idx, points


# ------------------------------------------------------------------
# Lane: trip building (shared loop; the three builders' common shape).
# ------------------------------------------------------------------
def build_trips(feed_cfg, svc_idx, route_idx_of, stop_to_idx_global, trips, stop_times):
    """Emit each GTFS trip once. route_idx_of: gtfs route_id -> global
    route index. stop_to_idx_global: gtfs stop_id -> global registry
    index (or absent: the stop is passed through, not boardable —
    page-lane semantics; the GTFS lane maps every served stop)."""
    by_trip = defaultdict(list)
    for st in stop_times:
        by_trip[st["trip_id"]].append(st)
    trip_rows = {t["trip_id"]: t for t in trips}
    out, skipped = [], 0
    for tid, rows in by_trip.items():
        t = trip_rows.get(tid)
        if not t:
            skipped += 1
            continue
        rows.sort(key=lambda r: int(r["stop_sequence"]))
        if feed_cfg["time_policy"] == "interpolate":
            # PORT: DDOT builder's sequence-fraction interpolation.
            # (Its unused `known` list is not ported; `known0` — rows
            # whose timepoint is not explicitly '0' — is the operative
            # set, exactly as in the original.)
            seqs = [int(r["stop_sequence"]) for r in rows]
            kp = [
                (seqs[i], t2s(r["arrival_time"]), t2s(r["departure_time"]))
                for i, r in enumerate(rows)
                if r.get("timepoint") != "0"
            ]
            if not kp:
                skipped += 1
                continue
            arr = [None] * len(rows)
            dep = [None] * len(rows)
            interp = [0] * len(rows)
            for j, r in enumerate(rows):
                s = seqs[j]
                if r.get("timepoint") != "0":
                    arr[j] = t2s(r["arrival_time"])
                    dep[j] = t2s(r["departure_time"])
                else:
                    prev = max([k for k in kp if k[0] <= s], default=None)
                    nxt = min([k for k in kp if k[0] >= s], default=None)
                    if prev is None:
                        arr[j], dep[j] = nxt[1], nxt[2]
                    elif nxt is None:
                        arr[j], dep[j] = prev[1], prev[2]
                    elif prev[0] == nxt[0]:
                        arr[j], dep[j] = prev[1], prev[2]
                    else:
                        f = (s - prev[0]) / (nxt[0] - prev[0])
                        arr[j] = round(prev[1] + f * (nxt[1] - prev[1]))
                        dep[j] = round(prev[2] + f * (nxt[2] - prev[2]))
                    interp[j] = 1
            idxs, arr2, dep2, interp2 = [], [], [], []
            for j, r in enumerate(rows):
                pi = stop_to_idx_global.get(r["stop_id"])
                if pi is None:
                    continue  # stop not on the page map: passes through
                idxs.append(pi)
                arr2.append(arr[j])
                dep2.append(dep[j])
                if interp[j]:
                    interp2.append(len(idxs) - 1)
        else:
            # Publisher times verbatim (SMART lane / SEPTA builders).
            idxs, arr2, dep2, interp2 = [], [], [], []
            for r in rows:
                pi = stop_to_idx_global.get(r["stop_id"])
                if pi is None:
                    continue
                idxs.append(pi)
                arr2.append(t2s(r["arrival_time"]))
                dep2.append(t2s(r["departure_time"]))
        if len(idxs) < 2:
            skipped += 1
            continue
        headsign = (
            t.get("trip_headsign") or rows[-1].get("stop_headsign") or ""
        ).strip()
        out.append(
            {
                "r": route_idx_of[t["route_id"]],
                "s": svc_idx[feed_cfg["namespace"] + t["service_id"]],
                "stops": idxs,
                "arr": arr2,
                "dep": dep2,
                "interp": interp2,
                "h": headsign,
                "_gtfs_trip": tid,
            }
        )
    return out, skipped


# ------------------------------------------------------------------
# Walk edges (design section 2): seed set (historical first-feed
# split) + the unconditional geometric pass over the merged registry.
# ------------------------------------------------------------------
def seed_edges_ddot_style(feed0_stops, stop_to_idx0):
    """PORT: the DDOT builder's walking transfers — grid over the
    feed's GTFS stops.txt coordinates (ALL stops, served or not),
    pairs keyed by stop_id string order, discovery-order output."""
    coords = [(float(s["stop_lat"]), float(s["stop_lon"])) for s in feed0_stops]
    sid_list = [s["stop_id"] for s in feed0_stops]
    lat0 = sum(c[0] for c in coords) / len(coords)
    kx, ky = 111320 * math.cos(math.radians(lat0)), 110540
    pts = [(c[1] * kx, c[0] * ky, sid_list[i]) for i, c in enumerate(coords)]
    grid = defaultdict(list)
    for x, y, sid in pts:
        grid[(int(x // WALK_M), int(y // WALK_M))].append((x, y, sid))
    transfers, seen = [], set()
    for (cx, cy), members in grid.items():
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for x1, y1, s1 in members:
                    for x2, y2, s2 in grid.get((cx + dx, cy + dy), []):
                        if s1 >= s2:
                            continue
                        d = math.hypot(x1 - x2, y1 - y2)
                        if d <= WALK_M and (s1, s2) not in seen:
                            seen.add((s1, s2))
                            a, b = stop_to_idx0.get(s1), stop_to_idx0.get(s2)
                            if a is not None and b is not None and a != b:
                                transfers.append([a, b, max(60, round(d / WALK_MPS))])
    return transfers


def geometric_edges(points, skip_both_in_first_segment_until, have):
    """The unconditional pass (design section 2.2): every stop pair
    within the radius cap over the merged registry, in the registry's
    own projected space. PORT of the U7 merge builder's new-edge pass
    (min-keeping dict, `have` check against the published tuples as
    stored) fused with the SEPTA builder's whole-registry pass (when
    no segment is skipped and `have` is empty the two coincide)."""
    grid = defaultdict(list)
    for idx, (x, y) in enumerate(points):
        grid[(int(x // WALK_M), int(y // WALK_M))].append((idx, x, y))
    edges = {}
    for (cx, cy), members in grid.items():
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i1, x1, y1 in members:
                    for i2, x2, y2 in grid.get((cx + dx, cy + dy), []):
                        if i1 >= i2:
                            continue
                        if i2 < skip_both_in_first_segment_until:
                            continue  # pair owned by the seed set
                        d = math.hypot(x1 - x2, y1 - y2)
                        if d <= WALK_M and (i1, i2) not in have:
                            secs = max(60, round(d / WALK_MPS))
                            key = (i1, i2)
                            if key not in edges or secs < edges[key]:
                                edges[key] = secs
    return edges


# ------------------------------------------------------------------
# City assembly.
# ------------------------------------------------------------------
def build_city(name, cfg, outdir):
    os.makedirs(outdir, exist_ok=True)
    record = {
        "city": name,
        "compiler": "build-timetable-generalized.py",
        "service_model": "set",
        "feeds": [],
    }
    all_services, all_exceptions, all_routes, all_trips = [], [], [], []
    trip_map = []  # per emitted trip: [feed tag, gtfs trip_id]
    registry = []  # sidecar rows, global index order
    reg_points = []  # merged-registry points (projected space)
    seg_starts = []
    feed0_stops_rows, feed0_stop_idx = None, None
    gtfs_lane_latlons = []  # (global idx, lat, lon) pending projection

    bdate = build_date_local()
    gate_verdicts = []
    for feed_cfg in cfg["feeds"]:
        tag = feed_cfg["tag"]
        z = zipfile.ZipFile(feed_cfg["zip"])
        stops = read_csv(z, "stops.txt")
        routes = read_csv(z, "routes.txt")
        trips = read_csv(z, "trips.txt")
        stop_times = read_csv(z, "stop_times.txt")
        calendar = read_csv(z, "calendar.txt")
        cal_dates = read_csv(z, "calendar_dates.txt")
        feed_info_rows = read_csv(z, "feed_info.txt")
        feed_info = feed_info_rows[0] if feed_info_rows else {}
        # ---- ingest gate (design section 4.4): validity is a hard
        # gate, checked before any building on this feed. A failure
        # raises and aborts the whole build — no partial asset.
        verdict = ingest_gate(
            f"{name} feed {tag} ({os.path.basename(feed_cfg['zip'])})", feed_info, bdate
        )
        gate_verdicts.append(verdict)
        if verdict["result"] == "warn":
            print(f"INGEST-GATE WARN: {verdict['warning']}")
        else:
            print(
                f"ingest gate pass: feed {tag} "
                f"{verdict['feed_version']} window "
                f"{verdict['valid_from']}..{verdict['valid_to']} "
                f"covers build date {verdict['build_date']}"
            )
        feed_rec = {
            "feed": tag,
            "zip": os.path.basename(feed_cfg["zip"]),
            "feed_version": feed_info["feed_version"],
            "feed_valid_from": feed_info["feed_start_date"],
            "feed_valid_to": feed_info["feed_end_date"],
            "publisher": feed_info.get("feed_publisher_name"),
        }
        # ---- capability census (design 4.6/4.7): compile-report
        # product, recorded per feed; never enters the asset. ----
        feed_rec["capabilities"] = capability_census(z, stops, trips)
        cap = feed_rec["capabilities"]
        a11y = cap["accessibility"]
        print(
            f"    capabilities: fares {cap['fares']['state']} "
            f"({len(cap['fares']['products'])} v1 products, "
            f"{cap['fares']['routes_mapped']} routes mapped); "
            f"a11y stops "
            f"{a11y['stops_wheelchair_boarding']['population']}, "
            f"trips "
            f"{a11y['trips_wheelchair_accessible']['population']}"
        )
        seg_start = len(registry)
        seg_starts.append(seg_start)
        st_stop_ids = {st["stop_id"] for st in stop_times}

        # ---- registry segment ----
        if feed_cfg["registry"] == "page":
            with open(feed_cfg["registry_file"]) as f:
                geo = json.load(f)
            local_idx, local_points = page_stop_mapping(
                feed_cfg, geo, stops, st_stop_ids
            )
            stop_to_idx = {sid: seg_start + i for sid, i in local_idx.items()}
            for i, s in enumerate(geo["stops"]):
                registry.append(
                    {
                        "idx": seg_start + i,
                        "feed": tag,
                        "stop_id": s["id"],
                        "name": s.get("n", ""),
                        "lat": s.get("lat"),
                        "lon": s.get("lon"),
                    }
                )
                reg_points.append(local_points[i])
            page_routes = {r["id"]: i for i, r in enumerate(geo["routes"])}
            gtfs_route_ids = {r["route_id"] for r in routes}
            assert not (gtfs_route_ids - set(page_routes)), (  # nosec B101
                "GTFS routes missing from page registry: "
                f"{gtfs_route_ids - set(page_routes)}"
            )
            route_base = len(all_routes)
            route_idx_of = {
                rid: route_base + i
                for rid, i in page_routes.items()
                if rid in gtfs_route_ids or True
            }
            # PORT: routes meta in registry order (all registry routes,
            # as both Detroit builders emitted them).
            for r in geo["routes"]:
                entry = {
                    "id": r["id"],
                    "name": r.get("name", r["id"]),
                    "color": feed_cfg.get("route_color", r.get("color", "#9AA0A6")),
                }
                entry["ag"] = feed_cfg["agency"]
                all_routes.append(entry)
            feed_rec["registry_segment"] = [
                seg_start,
                seg_start + len(geo["stops"]) - 1,
            ]
        else:  # gtfs-defined registry (SEPTA builder)
            stop_by_id = {s["stop_id"]: s for s in stops}
            stop_to_idx = {}
            for sid in sorted(st_stop_ids):
                s = stop_by_id[sid]
                lat, lon = s["stop_lat"].strip(), s["stop_lon"].strip()
                assert lat and lon, (  # nosec B101
                    f"served stop without coordinates: {sid}"
                )
                idx = len(registry)
                stop_to_idx[sid] = idx
                registry.append(
                    {
                        "idx": idx,
                        "feed": tag,
                        "stop_id": sid,
                        "name": s["stop_name"],
                        "lat": float(lat),
                        "lon": float(lon),
                    }
                )
                gtfs_lane_latlons.append((idx, float(lat), float(lon)))
            route_base = len(all_routes)
            route_idx_of = {}
            for r in routes:
                route_idx_of[r["route_id"]] = len(all_routes)
                color = (r.get("route_color") or "").strip()
                all_routes.append(
                    {
                        "id": r["route_id"],
                        "name": (
                            r.get("route_long_name")
                            or r.get("route_short_name")
                            or r["route_id"]
                        ).strip(),
                        "color": "#" + color if color else "#9AA0A6",
                        "ag": feed_cfg["agency"],
                    }
                )
            feed_rec["registry_segment"] = [seg_start, len(registry) - 1]
        feed_rec["served_stops"] = len(st_stop_ids)
        if tag == 0:
            feed0_stops_rows, feed0_stop_idx = stops, stop_to_idx

        # ---- services + exceptions (raw carriage) ----
        services, svc_idx_local, exceptions, n_cd_only = build_services(
            calendar, cal_dates, feed_cfg["namespace"], tag
        )
        svc_base = len(all_services)
        svc_idx = {k: v + svc_base for k, v in svc_idx_local.items()}
        all_services.extend(services)
        all_exceptions.extend(exceptions)
        feed_rec["services"] = len(services)
        feed_rec["services_calendar_dates_only"] = n_cd_only
        feed_rec["exceptions"] = len(exceptions)

        # ---- trips (each GTFS trip once) ----
        feed_trips, skipped = build_trips(
            feed_cfg, svc_idx, route_idx_of, stop_to_idx, trips, stop_times
        )
        for t in feed_trips:
            trip_map.append([tag, t.pop("_gtfs_trip")])
            all_trips.append(t)
        feed_rec["gtfs_trips"] = len(trips)
        feed_rec["trips_emitted"] = len(feed_trips)
        feed_rec["trips_skipped"] = skipped
        feed_rec["routes"] = len(routes)
        record["feeds"].append(feed_rec)
        print(
            f"feed {tag} ({feed_rec['zip']}): segment "
            f"{feed_rec['registry_segment']}, services {len(services)} "
            f"(+{n_cd_only} calendar_dates-only), exceptions "
            f"{len(exceptions)}, trips {len(feed_trips)} emitted, "
            f"{skipped} skipped"
        )

    # ---- merged-registry points for GTFS lanes (joint projection,
    # SEPTA builder convention: lat0 = mean latitude over the whole
    # merged registry, kx from lat0, ky = 110540) ----
    if gtfs_lane_latlons:
        lat0 = sum(v[1] for v in gtfs_lane_latlons) / len(gtfs_lane_latlons)
        kx, ky = 111320 * math.cos(math.radians(lat0)), 110540
        reg_points = [None] * len(registry)
        for idx, lat, lon in gtfs_lane_latlons:
            reg_points[idx] = (lon * kx, lat * ky)
        # page-lane points, if a mixed city ever appears, already sit
        # in reg_points by segment construction; assert completeness.
        assert all(p is not None for p in reg_points)  # nosec B101

    # ---- walk edges: seed (optional) + unconditional geometric pass ----
    seed = []
    if cfg["seed_edges_first_feed"]:
        seed = seed_edges_ddot_style(feed0_stops_rows, feed0_stop_idx)
        print(f"seed edges (feed 0 published set): {len(seed)}")
    have = {(a, b) for a, b, _ in seed}
    skip_until = seg_starts[1] if len(seg_starts) > 1 else 0
    if not cfg["seed_edges_first_feed"]:
        skip_until = 0
        have = set()
    geo_edges = geometric_edges(reg_points, skip_until, have)
    transfers = seed + [[a, b, s] for (a, b), s in sorted(geo_edges.items())]
    seg_of = {}
    for n, st in enumerate(seg_starts):
        seg_of[n] = st
    bounds = seg_starts + [len(registry)]

    def seg(i):
        for n in range(len(seg_starts)):
            if bounds[n] <= i < bounds[n + 1]:
                return n
        return len(seg_starts) - 1

    cross = [t for t in transfers if seg(t[0]) != seg(t[1])]
    record["transfers"] = {
        "total": len(transfers),
        "seed": len(seed),
        "geometric": len(geo_edges),
        "cross_feed": len(cross),
        "cross_feed_at_60s_floor": sum(1 for t in cross if t[2] == 60),
        "at_60s_floor_total": sum(1 for t in transfers if t[2] == 60),
    }
    print(
        f"transfers: {len(transfers)} total (seed {len(seed)}, "
        f"geometric {len(geo_edges)}), cross-feed {len(cross)} "
        f"({record['transfers']['cross_feed_at_60s_floor']} at the "
        f"60 s floor)"
    )

    record["ingest_gate"] = gate_verdicts
    versions = [f["feed_version"] for f in record["feeds"]]
    meta_feeds = []
    for feed_cfg, feed_rec in zip(cfg["feeds"], record["feeds"]):
        mf = dict(feed_cfg["meta_feed"])
        entry = {}
        for k in ("agency", "family"):
            if k in mf:
                entry[k] = mf[k]
        entry["feed_version"] = feed_rec["feed_version"]
        entry["valid_from"] = feed_rec["feed_valid_from"]
        entry["valid_to"] = feed_rec["feed_valid_to"]
        if "source" in mf:
            entry["source"] = mf["source"]
        if "publisher" in mf:
            entry["publisher"] = mf["publisher"]
        meta_feeds.append(entry)
    out = {
        "meta": {
            "feed_version": "+".join(versions),
            "feeds": meta_feeds,
            "valid_from": record["feeds"][0]["feed_valid_from"],
            "valid_to": max(f["feed_valid_to"] for f in record["feeds"]),
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "timepoint_policy": cfg["timepoint_policy"],
            "service_model": "set",
            "walk_m": WALK_M,
            "walk_mps": WALK_MPS,
            "n_trips": len(all_trips),
        },
        "services": all_services,
        "service_exceptions": all_exceptions,
        "routes": all_routes,
        "trips": all_trips,
        "transfers": transfers,
    }
    fn = "planner-timetable-" + "-".join(versions) + ".json"
    path = os.path.join(outdir, fn)
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    raw = os.path.getsize(path)
    import gzip

    with open(path, "rb") as f:
        gz = len(gzip.compress(f.read(), 9))
    record["asset"] = {
        "file": fn,
        "bytes": raw,
        "gzip_bytes": gz,
        "stops": len(registry),
        "services": len(all_services),
        "exceptions": len(all_exceptions),
        "routes": len(all_routes),
        "trips": len(all_trips),
    }
    print(
        f"wrote {path}: {raw/1e6:.2f} MB raw, {gz/1e6:.2f} MB gzipped; "
        f"stops {len(registry)}, trips {len(all_trips)}"
    )
    with open(os.path.join(outdir, "stops-sidecar.json"), "w") as f:
        json.dump(registry, f)
    with open(os.path.join(outdir, "trip-map.json"), "w") as f:
        json.dump(trip_map, f)
    with open(os.path.join(outdir, "build-record.json"), "w") as f:
        json.dump(record, f, indent=1)
    return record


if __name__ == "__main__":
    city = sys.argv[1]
    outdir = sys.argv[2]
    try:
        build_city(city, CITIES[city], outdir)
    except IngestGateError as e:
        print(str(e), file=sys.stderr)
        sys.exit(4)
