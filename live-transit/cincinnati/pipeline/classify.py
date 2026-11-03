#!/usr/bin/env python3
"""classify.py — trip-matching classification (LT-KAES-25 / §5).

CINCINNATI BUILD (Board 51) — platform stage, adapted from
PHL REBUILD R2. Label: UNVERIFIED / legacy-unsigned.

Every live vehicle record classifies BEFORE any surface consumes
it, against the city's compiled static trip/route sets:

  TRIP-MATCHED   trip_id present and resolves to a static trip.
  ROUTE-MATCHED  no trip resolution, but route_id present and
                 resolves to a static route (the unresolved-trip
                 population is reported, never absorbed).
  UNASSIGNED     neither — verified descriptor-less records are
                 classified and carried, never silently dropped.

Instance-suffix rule (MEASURED, adopted 2026-10-27): SORTA's
CAD appends an instance suffix `_<digits>` to some published
trip_ids (form `<static trip_id>_<n>`); the static carries no
suffixed id (10,859 trips, all numeric, zero underscores in the
static of record). Measured on served families 2026-10-27:
`2029379_1` (vehicle 2415, route 78; families 13:25–14:15Z —
while plain `2029379` was simultaneously TRIP-MATCHED on
vehicle 2517, i.e. the suffix marks a concurrent second
instance of the same static trip), `2029873_1` and `2029874_1`
(vehicle 4037, route 4; families 02:55–04:10Z). Every observed
base resolves uniquely in the static on the route the record
carried. Trip resolution therefore tries the published id,
then — only when the published id does not resolve as-is,
matches `^(\\d+)_(\\d+)$`, and the stripped base resolves in
the static trips dict (a single key, unique by construction)
— the base. The record's published trip_id is NEVER mutated
(the SEPTA "_OWL" discipline); normalization is reported
distinctly by the transform (classification block +
transform report), never silently absorbed. Any other
unresolving id stays unresolved, exactly as before.
(Sacramento Board 66 diagnosis 2026-10-27 §4 named this
remedy class for Cincinnati; the A2-era "no suffix rules"
note above is superseded by this measurement for trip_ids.
Route_ids carry no measured suffix behavior; route
resolution is unchanged.)

The static sets load from the A3-recorded agency zips. In the
local build those are the retained copies under
`hidden_files/gtfs/`; the production chain resolves the same two
feeds through the vintage registry (Board 50).
"""

import csv
import io
import re
import zipfile

CLASS_TRIP = "TRIP-MATCHED"
CLASS_ROUTE = "ROUTE-MATCHED"
CLASS_UNASSIGNED = "UNASSIGNED"

# SORTA CAD instance suffix on published trip_ids: `<base>_<n>`
# where <base> is a static trip_id (measured 2026-10-27; see
# module docstring). Gated in resolve_trip_id below.
INSTANCE_SUFFIX_RE = re.compile(r"^(\d+)_(\d+)$")


class StaticSets:
    """Per-family trip/route sets + trip headsigns from GTFS zips."""

    def __init__(self):
        self.trips = {}  # family -> {trip_id: headsign}
        self.routes = {}  # family -> set(route_id)

    def load(self, family, zip_path):
        trips, routes = {}, set()
        with zipfile.ZipFile(zip_path) as z:
            with z.open("trips.txt") as f:
                for row in csv.DictReader(io.TextIOWrapper(f, "utf-8")):
                    trips[row["trip_id"]] = row.get("trip_headsign") or None
            with z.open("routes.txt") as f:
                for row in csv.DictReader(io.TextIOWrapper(f, "utf-8")):
                    routes.add(row["route_id"])
        self.trips[family] = trips
        self.routes[family] = routes
        return {"family": family, "trips": len(trips), "routes": len(routes)}

    def resolve_trip_id(self, family, trip_id):
        """-> the static trip key a published trip_id resolves to,
        or None. Exact match first; then the gated instance-suffix
        rule (module docstring): the published id does not resolve
        as-is, matches `^(\\d+)_(\\d+)$`, and the stripped base is
        a static trip key (unique by construction — one dict key).
        """
        if not trip_id:
            return None
        trips = self.trips.get(family, {})
        if trip_id in trips:
            return trip_id
        m = INSTANCE_SUFFIX_RE.match(trip_id)
        if m and m.group(1) in trips:
            return m.group(1)
        return None

    def trip_headsign(self, family, trip_id):
        resolved = self.resolve_trip_id(family, trip_id)
        if resolved is None:
            return None
        return self.trips.get(family, {}).get(resolved)

    def route_resolves(self, family, route_id):
        if not route_id:
            return False
        routes = self.routes.get(family, set())
        return route_id in routes

    def classify(self, family, trip_id, route_id):
        """-> (classification, trip_unresolved_flag)."""
        if self.resolve_trip_id(family, trip_id) is not None:
            return CLASS_TRIP, False
        if self.route_resolves(family, route_id):
            return CLASS_ROUTE, bool(trip_id)
        return CLASS_UNASSIGNED, bool(trip_id)
