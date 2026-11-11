#!/usr/bin/env python3
"""Build LTD live-data static extracts from published GTFS zips.

Inputs (estate copies, hidden_files/gtfs/):
  smart_gtfs_S1000147.zip  (SMART published GTFS, apps1.smartbus.org/gtfs/smart_gtfs.zip)
  ddot_gtfs_S1000182.zip   (DDOT published GTFS)
Outputs (live-data/):
  smart-headsigns.json     {by_trip:{trip_id:headsign}, by_route_dir:{"route|dir":headsign}}
  smart-schedule-extract.json {version, services{...}, trips{trip_id:[route,dir,service,[[stop,dep_sec]...]]}}
  ddot-patterns.json       {version, routes:{route:{dir:[[stop_id,lat,lon]...]}}}  (longest trip per route+dir)
"""
import csv, io, json, sys, zipfile
from collections import Counter, defaultdict

def rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))

def t2s(t):
    h, m, s = t.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)

def build_smart(zip_path, out_dir):
    z = zipfile.ZipFile(zip_path)
    feed_version = None
    for row in rows(z, "feed_info.txt"):
        feed_version = row["feed_version"]
    trips = {}
    by_trip = {}
    rd = defaultdict(Counter)
    for row in rows(z, "trips.txt"):
        trips[row["trip_id"]] = row
        hs = (row.get("trip_headsign") or "").strip()
        if hs:
            by_trip[row["trip_id"]] = hs
            rd[f"{row['route_id']}|{row['direction_id']}"][hs] += 1
    by_route_dir = {k: c.most_common(1)[0][0] for k, c in rd.items()}
    stops_by_trip = defaultdict(list)
    for row in rows(z, "stop_times.txt"):
        stops_by_trip[row["trip_id"]].append(
            (int(row["stop_sequence"]), row["stop_id"], t2s(row["departure_time"])))
    trips_out = {}
    for tid, t in trips.items():
        st = sorted(stops_by_trip.get(tid, []))
        trips_out[tid] = [t["route_id"], int(t["direction_id"] or 0), t["service_id"],
                          [[sid, dep] for _seq, sid, dep in st]]
    services = {}
    for row in rows(z, "calendar.txt"):
        services[row["service_id"]] = {
            "days": [int(row[d]) for d in ("monday","tuesday","wednesday","thursday","friday","saturday","sunday")],
            "start": row["start_date"], "end": row["end_date"], "add": [], "remove": []}
    for row in rows(z, "calendar_dates.txt"):
        svc = services.setdefault(row["service_id"], {"days": [0]*7, "start": "", "end": "", "add": [], "remove": []})
        (svc["add"] if row["exception_type"] == "1" else svc["remove"]).append(row["date"])
    hs = {"feed_version": feed_version, "by_trip": by_trip, "by_route_dir": by_route_dir}
    sched = {"feed_version": feed_version, "services": services, "trips": trips_out}
    with open(f"{out_dir}/smart-headsigns.json", "w") as f:
        json.dump(hs, f, separators=(",", ":"))
    with open(f"{out_dir}/smart-schedule-extract.json", "w") as f:
        json.dump(sched, f, separators=(",", ":"))
    return feed_version, len(by_trip), len(trips_out)

def build_ddot(zip_path, out_dir):
    z = zipfile.ZipFile(zip_path)
    feed_version = None
    for row in rows(z, "feed_info.txt"):
        feed_version = row["feed_version"]
    coords = {}
    for row in rows(z, "stops.txt"):
        coords[row["stop_id"]] = (float(row["stop_lat"]), float(row["stop_lon"]))
    trip_route = {}
    for row in rows(z, "trips.txt"):
        trip_route[row["trip_id"]] = (row["route_id"], row["direction_id"])
    stops_by_trip = defaultdict(list)
    for row in rows(z, "stop_times.txt"):
        stops_by_trip[row["trip_id"]].append((int(row["stop_sequence"]), row["stop_id"]))
    best = {}
    for tid, (route, direc) in trip_route.items():
        st = sorted(stops_by_trip.get(tid, []))
        key = (route, direc)
        if key not in best or len(st) > len(best[key]):
            best[key] = [sid for _s, sid in st]
    routes_out = defaultdict(dict)
    for (route, direc), stop_ids in best.items():
        routes_out[route][direc] = [[sid, coords[sid][0], coords[sid][1]] for sid in stop_ids if sid in coords]
    with open(f"{out_dir}/ddot-patterns.json", "w") as f:
        json.dump({"feed_version": feed_version, "routes": dict(routes_out)}, f, separators=(",", ":"))
    return feed_version, len(routes_out)

if __name__ == "__main__":
    smart_zip, ddot_zip, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    v1, n1, n2 = build_smart(smart_zip, out_dir)
    print(f"SMART {v1}: headsigns {n1}, schedule trips {n2}")
    v2, n3 = build_ddot(ddot_zip, out_dir)
    print(f"DDOT {v2}: pattern routes {n3}")
