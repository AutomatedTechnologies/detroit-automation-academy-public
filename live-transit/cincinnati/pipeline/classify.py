#!/usr/bin/env python3
"""classify.py — trip-matching classification (LT-KAES-25 / §5).

CINCINNATI BUILD (Board 51) — platform stage, adapted from PHL REBUILD R2. Label: UNVERIFIED / legacy-unsigned.

Every live vehicle record classifies BEFORE any surface consumes
it, against the city's compiled static trip/route sets:

  TRIP-MATCHED   trip_id present and resolves to a static trip.
  ROUTE-MATCHED  no trip resolution, but route_id present and
                 resolves to a static route (the unresolved-trip
                 population is reported, never absorbed).
  UNASSIGNED     neither — verified descriptor-less records are
                 classified and carried, never silently dropped.

No suffix rules: SORTA publishes static route_ids directly
(measured at A2, 2026-10-22 — TripDescriptor coverage 100%).
The SEPTA "_OWL" suffix rule from the platform original is NOT
carried: no such behavior is measured in this feed (LT-F6).

The static sets load from the A3-recorded agency zips. In the
local build those are the retained copies under
`hidden_files/gtfs/`; the production chain resolves the same two
feeds through the vintage registry (Board 50).
"""

import csv
import io
import zipfile

CLASS_TRIP = "TRIP-MATCHED"
CLASS_ROUTE = "ROUTE-MATCHED"
CLASS_UNASSIGNED = "UNASSIGNED"


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

    def trip_headsign(self, family, trip_id):
        return self.trips.get(family, {}).get(trip_id)

    def route_resolves(self, family, route_id):
        if not route_id:
            return False
        routes = self.routes.get(family, set())
        return route_id in routes

    def classify(self, family, trip_id, route_id):
        """-> (classification, trip_unresolved_flag)."""
        if trip_id and trip_id in self.trips.get(family, {}):
            return CLASS_TRIP, False
        if self.route_resolves(family, route_id):
            return CLASS_ROUTE, bool(trip_id)
        return CLASS_UNASSIGNED, bool(trip_id)
