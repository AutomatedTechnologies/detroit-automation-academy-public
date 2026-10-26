#!/usr/bin/env python3
"""Independent GTFS truth for the FULL-WINDOW service audit: per feed,
per date in the union published window (2026-09-27 -> 2027-02-20), the
set of GTFS trip_ids whose service is active that date — computed
directly from calendar.txt + calendar_dates.txt in the raw zips (a
second implementation of the active-date rule, independent of both
the compiler and the engine). Dates outside a feed's own window map
to the empty set. Companion to audit-truth.py (the 8-day first-pass
window), which this extends without modifying."""

import csv
import io
import json
import os
import tempfile
import zipfile
from collections import defaultdict
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
GTFS_DIR = os.path.join(tempfile.gettempdir(), "phl-rail-refresh")
WIN_START, WIN_END = date(2026, 9, 27), date(2027, 2, 20)


def rows(z, name):
    if name not in z.namelist():
        return []
    with z.open(name) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")))


def dparse(s):
    return date(int(s[:4]), int(s[4:6]), int(s[6:]))


all_dates = []
d = WIN_START
while d <= WIN_END:
    all_dates.append(d)
    d += timedelta(days=1)

out = {}
for tag, zn in [(0, "google_bus_union.zip"), (1, "google_rail_union.zip")]:
    z = zipfile.ZipFile(os.path.join(GTFS_DIR, zn))
    cal = rows(z, "calendar.txt")
    cd = rows(z, "calendar_dates.txt")
    trips = rows(z, "trips.txt")
    exc = defaultdict(dict)
    for r in cd:
        exc[r["service_id"]][r["date"]] = int(r["exception_type"])
    active = {}
    for c in cal:
        days = [
            int(c[k])
            for k in (
                "monday",
                "tuesday",
                "wednesday",
                "thursday",
                "friday",
                "saturday",
                "sunday",
            )
        ]
        dd, e = dparse(c["start_date"]), dparse(c["end_date"])
        cur = set()
        while dd <= e:
            if days[dd.weekday()]:
                cur.add(dd)
            dd += timedelta(days=1)
        active[c["service_id"]] = cur
    for sid, m in exc.items():
        s = active.setdefault(sid, set())
        for ds, t in m.items():
            ddd = dparse(ds)
            if t == 1:
                s.add(ddd)
            else:
                s.discard(ddd)
    per_date = {dt.strftime("%Y%m%d"): [] for dt in all_dates}
    for t in trips:
        for dt in active.get(t["service_id"], set()):
            k = dt.strftime("%Y%m%d")
            if k in per_date:
                per_date[k].append(t["trip_id"])
    out[str(tag)] = {k: sorted(v) for k, v in sorted(per_date.items())}
    nonempty = sum(1 for v in per_date.values() if v)
    print(f"feed {tag}: {len(per_date)} dates, {nonempty} with service")
with open(os.path.join(GTFS_DIR, "audit", "audit-truth-full.json"), "w") as f:
    json.dump(out, f)
print("wrote audit-truth-full.json")
