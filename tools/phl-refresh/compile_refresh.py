#!/usr/bin/env python3
"""Compile the PHL union asset with the generalized compiler of record.

Staged copy of the Board 65 item 3 compile driver (compile_union.py),
with the two workspace paths replaced by environment variables so the
same driver runs in GitHub Actions:

  PHL_TOOLS_DIR  directory holding compiler/build-timetable-generalized.py
  PHL_WORK_DIR   scratch dir holding the union zips; output -> compiled/

The compiler file is NOT modified. This driver imports it as a module
and calls build_city with the PHL lane configuration pointed at the
union zips.

Memory patch (driver-side only): the compiler's read_csv materializes
stop_times.txt as a list of dicts (~1 KB/row); the union bus file has
~4.35M rows and the stock path was OOM-killed at ~3.2 GB available
(exit 137, measured). The wrapper below returns stop_times rows as
slotted tuple-backed objects exposing exactly the interface the
compiler uses (__getitem__ + .get), with values interned. Row
semantics are identical; every other file keeps the stock dict path.
"""

import csv
import importlib.util
import io
import json
import os
import sys
import zipfile  # noqa: F401  (kept from the driver of record)

TOOLS = os.environ["PHL_TOOLS_DIR"]
SCRATCH = os.environ["PHL_WORK_DIR"]
COMPILER = os.path.join(TOOLS, "compiler", "build-timetable-generalized.py")

spec = importlib.util.spec_from_file_location("btg", COMPILER)
btg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(btg)

_stock_read_csv = btg.read_csv


class STRow:
    __slots__ = ("v", "idx")

    def __init__(self, vals, idx):
        self.v = vals
        self.idx = idx

    def __getitem__(self, k):
        return self.v[self.idx[k]]

    def get(self, k, default=None):
        i = self.idx.get(k)
        return default if i is None else self.v[i]


def lean_read_csv(z, name):
    if name != "stop_times.txt":
        return _stock_read_csv(z, name)
    with z.open(name) as f:
        rdr = csv.reader(io.TextIOWrapper(f, encoding="utf-8-sig"))
        header = next(rdr)
        idx = {c: i for i, c in enumerate(header)}
        rows = [STRow(tuple(sys.intern(v) for v in row), idx) for row in rdr]
    print(f"lean stop_times: {len(rows)} rows", flush=True)
    return rows


btg.read_csv = lean_read_csv

cfg = {
    "seed_edges_first_feed": False,
    "timepoint_policy": "septa: publisher times verbatim (union build: "
    "old wave v202609271 governs <=2026-10-31, new "
    "wave v202611010 governs >=2026-11-01; see "
    "build_union.py derivation records)",
    "feeds": [
        {
            "tag": 0,
            "zip": os.path.join(SCRATCH, "google_bus_union.zip"),
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
            "zip": os.path.join(SCRATCH, "google_rail_union.zip"),
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
}

outdir = os.path.join(SCRATCH, "compiled")
os.makedirs(outdir, exist_ok=True)
rec = btg.build_city("philadelphia", cfg, outdir)
print("BUILD_RECORD_SUMMARY", flush=True)
print(json.dumps(rec["asset"], indent=1))
print("ingest_gate", json.dumps(rec["ingest_gate"], indent=1))
for f in rec["feeds"]:
    print(
        "feed",
        f["feed"],
        f["feed_version"],
        f["feed_valid_from"],
        f["feed_valid_to"],
        "segment",
        f["registry_segment"],
        "served",
        f["served_stops"],
        "services",
        f["services"],
        "cd_only",
        f["services_calendar_dates_only"],
        "exceptions",
        f["exceptions"],
        "trips_emitted",
        f.get("trips_emitted"),
    )
print("transfers", rec.get("transfers"))
print("COMPILE_OK", flush=True)
