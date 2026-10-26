#!/usr/bin/env python3
"""sorta_config.py — pipeline-side endpoint set (mirror of record).

CINCINNATI BUILD (Board 51). Label: UNVERIFIED / legacy-unsigned.

The source of truth for the endpoint set is the foundation
config, `../config/city-config.mjs` (CITY_CONFIG.feeds.realtime,
from the A2 validation + A3 custody record). This module mirrors
those three URLs for the Python pipeline; the pipeline harness
asserts the two sets are identical, so the mirror cannot drift
silently. Key posture is the A3 finalized state: KEYLESS,
agency-direct only (Trapeze cloud endpoints published on the
SORTA developer page; no credential exists for this city).
"""

# id, family, kind, url — exactly CITY_CONFIG.feeds.realtime.
# The three legs are collected separately (LT-D2 fault
# isolation); the combined trapezerealtimefeed.pb is a true
# same-generation union (A2-measured) and is NOT a source here.
LEGS = [
    (
        "sorta-vp",
        "sorta",
        "vehicle-positions",
        "https://tmgtfsprd.sorttrpcloud.com/TMGTFSRealTimeWebService/vehicle/vehiclepositions.pb",
    ),
    (
        "sorta-tu",
        "sorta",
        "trip-updates",
        "https://tmgtfsprd.sorttrpcloud.com/TMGTFSRealTimeWebService/tripupdate/tripupdates.pb",
    ),
    (
        "sorta-sa",
        "sorta",
        "service-alerts",
        "https://tmgtfsprd.sorttrpcloud.com/TMGTFSRealTimeWebService/alert/alerts.pb",
    ),
]

AGENCY = "sorta"
USER_AGENT = "lt-cincinnati-build-collect/1.0"
FETCH_TIMEOUT_SEC = 60

# Published family layout (LT-KAES-21/45), relative to the data dir.
VEHICLES_FILE = "vehicles.json"
ALERTS_FILE = "alerts.json"
TRIP_UPDATES_FILE = "trip-updates.json"
TU_DIR = "tu"
TU_INDEX_FILE = "index.json"
TU_MAX_BYTES = 25000  # LT-KAES-45 per-file ceiling for derivatives
