#!/usr/bin/env python3
"""septa_config.py — pipeline-side endpoint set (mirror of record).

PHL REBUILD R2. Label: UNVERIFIED / legacy-unsigned.

The source of truth for the endpoint set is the R1 foundation
config, `../config/city-config.mjs` (CITY_CONFIG.feeds.realtime,
from the A3 custody record). This module mirrors those six URLs
for the Python pipeline; the pipeline harness
(`../harness/verify-pipeline.mjs`) asserts the two sets are
identical, so the mirror cannot drift silently. Key posture is
the A3 finalized state: KEYLESS, agency-direct only; the Swiftly
mirrors are excluded from every path.
"""

# id, family, kind, url — exactly CITY_CONFIG.feeds.realtime.
LEGS = [
    (
        "bus-vp",
        "bus",
        "vehicle-positions",
        "https://www3.septa.org/gtfsrt/septa-pa-us/Vehicle/rtVehiclePosition.pb",
    ),
    (
        "bus-tu",
        "bus",
        "trip-updates",
        "https://www3.septa.org/gtfsrt/septa-pa-us/Trip/rtTripUpdates.pb",
    ),
    (
        "bus-sa",
        "bus",
        "service-alerts",
        "https://www3.septa.org/gtfsrt/septa-pa-us/Service/rtServiceAlerts.pb",
    ),
    (
        "rail-vp",
        "rail",
        "vehicle-positions",
        "https://www3.septa.org/gtfsrt/septarail-pa-us/Vehicle/rtVehiclePosition.pb",
    ),
    (
        "rail-tu",
        "rail",
        "trip-updates",
        "https://www3.septa.org/gtfsrt/septarail-pa-us/Trip/rtTripUpdates.pb",
    ),
    (
        "rail-sa",
        "rail",
        "service-alerts",
        "https://www3.septa.org/gtfsrt/septarail-pa-us/Service/rtServiceAlerts.pb",
    ),
]

AGENCY = "septa"
USER_AGENT = "lt-phl-rebuild-collect/2.0"
FETCH_TIMEOUT_SEC = 60

# Published family layout (LT-KAES-21/45), relative to the data dir.
VEHICLES_FILE = "vehicles.json"
ALERTS_FILE = "alerts.json"
TRIP_UPDATES_FILE = "trip-updates.json"
TU_DIR = "tu"
TU_INDEX_FILE = "index.json"
TU_MAX_BYTES = 25000  # LT-KAES-45 per-file ceiling for derivatives
