#!/usr/bin/env python3
"""Build a union GTFS zip bridging a SEPTA wave boundary. (v2 — streams
stop_times; v1 was OOM-killed on the 2.18M-row bus file.)

Old wave governs dates <= CUT; new wave governs dates >= NEW_START.
Rules (deterministic):
  - calendar.txt: new rows as-is; old rows dropped if start_date > CUT,
    else end_date clipped to CUT; old service_id renamed (+SUFFIX) iff it
    exists in the new book's service universe (calendar + calendar_dates).
  - calendar_dates.txt: new rows as-is; old rows kept iff date <= CUT,
    with the same renaming rule.
  - trips.txt: new rows as-is; old rows kept with service_id renamed per
    the rule and trip_id renamed iff it collides with a new trip_id.
  - stop_times.txt: new rows as-is; old rows follow their trip_id rename.
  - routes.txt / stops.txt: new rows win; old-only ids appended.
  - feed_info.txt: DERIVED row — version UNION_VERSION, start = old start,
    end = UNION_END (calendar-measured service end of the union).
  - every other file: carried from the new book only.
The derivation is recorded to <out>.record.json alongside the zip.
"""

import csv
import io
import json
import os
import sys
import tempfile
import zipfile

CUT = "20261031"
SUFFIX = "_w27"


def parse(z, name):
    try:
        data = z.read(name)
    except KeyError:
        return [], []
    rdr = csv.DictReader(io.StringIO(data.decode("utf-8-sig")))
    return rdr.fieldnames or [], list(rdr)


def emit(fieldnames, rows):
    buf = io.StringIO()
    w = csv.DictWriter(
        buf, fieldnames=fieldnames, lineterminator="\n", extrasaction="ignore"
    )
    w.writeheader()
    for r in rows:
        w.writerow({k: r.get(k, "") for k in fieldnames})
    return buf.getvalue().encode("utf-8")


def main(old_path, new_path, out_path, union_version, union_end):
    zo = zipfile.ZipFile(old_path)
    zn = zipfile.ZipFile(new_path)
    rec = {
        "old": old_path,
        "new": new_path,
        "cut": CUT,
        "suffix": SUFFIX,
        "union_version": union_version,
        "union_end": union_end,
    }

    _, ncal = parse(zn, "calendar.txt")
    _, ncd = parse(zn, "calendar_dates.txt")
    new_svc = {r["service_id"] for r in ncal} | {r["service_id"] for r in ncd}
    _, ocal = parse(zo, "calendar.txt")
    _, ocd = parse(zo, "calendar_dates.txt")
    old_svc = {r["service_id"] for r in ocal} | {r["service_id"] for r in ocd}
    rename_svc = {s: s + SUFFIX for s in (old_svc & new_svc)}
    rec["services"] = {
        "old": len(old_svc),
        "new": len(new_svc),
        "renamed_old": sorted(rename_svc),
    }

    cal_fields, _ = parse(zo, "calendar.txt")
    merged_cal = list(ncal)
    dropped_cal = 0
    for r in ocal:
        if r["start_date"] > CUT:
            dropped_cal += 1
            continue
        r = dict(r)
        if r["end_date"] > CUT:
            r["end_date"] = CUT
        if r["service_id"] in rename_svc:
            r["service_id"] = rename_svc[r["service_id"]]
        merged_cal.append(r)
    rec["calendar"] = {
        "new_rows": len(ncal),
        "old_rows_kept": len(merged_cal) - len(ncal),
        "old_rows_dropped": dropped_cal,
    }

    cd_fields, _ = parse(zo, "calendar_dates.txt")
    merged_cd = list(ncd)
    dropped_cd = 0
    for r in ocd:
        if r["date"] > CUT:
            dropped_cd += 1
            continue
        r = dict(r)
        if r["service_id"] in rename_svc:
            r["service_id"] = rename_svc[r["service_id"]]
        merged_cd.append(r)
    rec["calendar_dates"] = {
        "new_rows": len(ncd),
        "old_rows_kept": len(merged_cd) - len(ncd),
        "old_rows_dropped_after_cut": dropped_cd,
    }

    # Ghost guard: an old trip whose final service_id has no entry in
    # the merged calendar/calendar_dates can never be active on any
    # date in the union (its old-book service starts after the cut, or
    # its exception dates all sit in the new book's segment, where the
    # new book's own trips govern). The compiler requires every trip's
    # service to exist, so these trips (and their stop_times) are
    # dropped and recorded. Measured cases: bus 308155/308849 (cd-only
    # holiday services), rail SID190115 (calendar starts 20261107).
    merged_svc = {r["service_id"] for r in merged_cal} | {
        r["service_id"] for r in merged_cd
    }
    tr_fields, ntrips = parse(zn, "trips.txt")
    _, otrips = parse(zo, "trips.txt")
    new_trip_ids = {r["trip_id"] for r in ntrips}
    rename_trip = {}
    dropped_trip_ids = set()
    merged_trips = list(ntrips)
    for r in otrips:
        r = dict(r)
        if r["service_id"] in rename_svc:
            r["service_id"] = rename_svc[r["service_id"]]
        if r["service_id"] not in merged_svc:
            dropped_trip_ids.add(r["trip_id"])
            continue
        if r["trip_id"] in new_trip_ids:
            rename_trip[r["trip_id"]] = r["trip_id"] + SUFFIX
            r["trip_id"] = rename_trip[r["trip_id"]]
        merged_trips.append(r)
    rec["trips"] = {
        "new_rows": len(ntrips),
        "old_rows": len(otrips),
        "renamed_old_trip_ids": len(rename_trip),
        "dropped_ghost_trip_ids": sorted(dropped_trip_ids),
    }

    def merge_by(fname, key):
        fields, nrows = parse(zn, fname)
        _, orows = parse(zo, fname)
        have = {r[key] for r in nrows}
        extra = [r for r in orows if r[key] not in have]
        diffs = 0
        ob = {r[key]: r for r in orows}
        for r in nrows:
            o = ob.get(r[key])
            if o and any((o.get(k) or "") != (r.get(k) or "") for k in set(o) | set(r)):
                diffs += 1
        return (
            fields,
            nrows + extra,
            {
                "new_rows": len(nrows),
                "old_only_appended": len(extra),
                "shared_with_attr_diffs_new_wins": diffs,
            },
        )

    rt_fields, merged_routes, rt_rec = merge_by("routes.txt", "route_id")
    sp_fields, merged_stops, sp_rec = merge_by("stops.txt", "stop_id")
    rec["routes"] = rt_rec
    rec["stops"] = sp_rec

    fi_fields, nfi = parse(zn, "feed_info.txt")
    _, ofi = parse(zo, "feed_info.txt")
    derived = dict(nfi[0])
    derived["feed_version"] = union_version
    derived["feed_start_date"] = ofi[0]["feed_start_date"]
    derived["feed_end_date"] = union_end
    rec["feed_info"] = {"old": ofi[0], "new": nfi[0], "derived": derived}

    # --- stop_times streamed to a temp file
    tmp = tempfile.NamedTemporaryFile("w", newline="", delete=False, suffix=".csv")
    tmp_path = tmp.name
    with zn.open("stop_times.txt") as f:
        rdr = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
        st_fields = rdr.fieldnames
        w = csv.DictWriter(
            tmp, fieldnames=st_fields, lineterminator="\n", extrasaction="ignore"
        )
        w.writeheader()
        n_new = 0
        for r in rdr:
            w.writerow({k: r.get(k, "") for k in st_fields})
            n_new += 1
            if n_new % 500000 == 0:
                print(f"  stop_times new: {n_new}", flush=True)
    n_old = 0
    n_old_dropped = 0
    with zo.open("stop_times.txt") as f:
        rdr = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
        w = csv.DictWriter(
            tmp, fieldnames=st_fields, lineterminator="\n", extrasaction="ignore"
        )
        for r in rdr:
            if r["trip_id"] in dropped_trip_ids:
                n_old_dropped += 1
                continue
            if r["trip_id"] in rename_trip:
                r = dict(r)
                r["trip_id"] = rename_trip[r["trip_id"]]
            w.writerow({k: r.get(k, "") for k in st_fields})
            n_old += 1
            if n_old % 500000 == 0:
                print(f"  stop_times old: {n_old}", flush=True)
    tmp.close()
    rec["stop_times"] = {
        "new_rows": n_new,
        "old_rows": n_old,
        "old_rows_dropped_ghost": n_old_dropped,
    }

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(zn.namelist()):
            if name in (
                "calendar.txt",
                "calendar_dates.txt",
                "trips.txt",
                "stop_times.txt",
                "routes.txt",
                "stops.txt",
                "feed_info.txt",
            ):
                continue
            z.writestr(name, zn.read(name))
        z.writestr("calendar.txt", emit(cal_fields, merged_cal))
        z.writestr("calendar_dates.txt", emit(cd_fields, merged_cd))
        z.writestr("trips.txt", emit(tr_fields, merged_trips))
        z.writestr("routes.txt", emit(rt_fields, merged_routes))
        z.writestr("stops.txt", emit(sp_fields, merged_stops))
        z.writestr("feed_info.txt", emit(fi_fields, [derived]))
        z.write(tmp_path, "stop_times.txt")
    os.unlink(tmp_path)
    with open(out_path + ".record.json", "w") as f:
        json.dump(rec, f, indent=1)
    print(json.dumps(rec, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
