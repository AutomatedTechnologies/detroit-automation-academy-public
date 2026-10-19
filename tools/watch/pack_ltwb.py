#!/usr/bin/env python3
"""Production LTWB v1 timetable packer (Project 29, item 4).

Packs the served DDOT timetable JSON (ddot-timetable-<version>.json)
plus the three served stop-registry geometry files (ddot-routes-3d,
smart-routes-3d, qline-3d) into the LTWB v1 binary bundle defined by
the Project 29 data-stream specification (files/
data-stream-specification.md, section 4.2), and emits the manifest
the watch verifies before swapping bundles (section 4.4).

Inputs are the SERVED bytes (fetch them from the www host; the
specification's measurements were taken on served bytes md5-verified
against the repo). Usage:

    python3 pack_ltwb.py --timetable ddot-timetable-S1000182.json \
        --ddot ddot-routes-3d.json --smart smart-routes-3d.json \
        --qline qline-3d.json --outdir live-data/watch

Outputs in --outdir:
    ltwb-<feed_version>.ltwbz   zlib-9 form (the sync/transfer form)
    ltwb-manifest.json          sizes, validity, sha256 of the zlib
                                bytes; `signature` is null until the
                                Ed25519 key-custody step (Project 14
                                pattern) is wired — sha256 is the
                                integrity check until then.

The packer self-verifies: after packing, it decodes the bundle with
an independent reader and compares every reconstructed value against
the sources (all stop-times exactly — delta encoding is lossless).
A mismatch exits non-zero and writes nothing.
"""

import argparse
import hashlib
import json
import os
import struct
import sys
import zlib
from datetime import datetime, timezone

SCHEMA = 1
HEADER_LEN = 64


def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


class StrTab:
    """Deduped UTF-8 string table: varint length + bytes, u32 offsets."""

    def __init__(self):
        self.buf = bytearray()
        self.map = {}

    def off(self, s):
        if s in self.map:
            return self.map[s]
        o = len(self.buf)
        b = s.encode("utf-8")
        self.buf += varint(len(b)) + b
        self.map[s] = o
        return o


def pack(tt, geos):
    """Pack sources into (blob, section_sizes, counts)."""
    st = StrTab()
    sizes = {}
    counts = {}

    # ---- stops: registry order DDOT, SMART, QLINE; agency 0/1/2 ----
    stops_blob = bytearray()
    n_stops = 0
    for agency, geo in ((0, geos[0]), (1, geos[1]), (2, geos[2])):
        for s in geo["stops"]:
            stops_blob += struct.pack(
                "<IIiiB",
                st.off(s["n"]),
                st.off(str(s["id"])),
                int(round(s["x"] * 10)),
                int(round(s["z"] * 10)),
                agency,
            )
            n_stops += 1
    sizes["stops"] = len(stops_blob)
    counts["stops"] = n_stops

    # ---- routes (the timetable's 37 DDOT routes) ----
    routes_blob = bytearray()
    for r in tt["routes"]:
        col = r["color"].lstrip("#")
        routes_blob += struct.pack(
            "<II3sB", st.off(r["id"]), st.off(r["name"]), bytes.fromhex(col), 0
        )
    sizes["routes"] = len(routes_blob)
    counts["routes"] = len(tt["routes"])

    # ---- services + exceptions ----
    svc_index = {}
    svc_blob = bytearray()
    for i, s in enumerate(tt["services"]):
        svc_index[s["id"]] = i
        mask = 0
        for d_i, on in enumerate(s["mask"]):
            if on:
                mask |= 1 << d_i
        svc_blob += struct.pack(
            "<IIIBxxx", st.off(s["id"]), int(s["start"]), int(s["end"]), mask
        )
    exc_blob = bytearray()
    for e in tt["service_exceptions"]:
        exc_blob += struct.pack(
            "<IHBx", int(e["date"]), svc_index[e["service"]], int(e["added"])
        )
    sizes["services"] = len(svc_blob)
    sizes["exceptions"] = len(exc_blob)
    counts["services"] = len(tt["services"])
    counts["exceptions"] = len(tt["service_exceptions"])

    # ---- patterns + trips (grouping exactly as raptor.js buildIndex:
    # key = route + stop sequence; trips sorted by first departure) ----
    patterns = {}
    order = []
    for t in tt["trips"]:
        key = (t["r"], tuple(t["stops"]))
        if key not in patterns:
            patterns[key] = []
            order.append(key)
        patterns[key].append(t)

    pat_dir = bytearray()
    pat_stops_blob = bytearray()
    trips_blob = bytearray()
    neg_deltas = 0
    for key in order:
        route_idx, stop_seq = key
        trips = sorted(patterns[key], key=lambda t: t["dep"][0])
        pat_dir += struct.pack(
            "<IIIHH",
            len(pat_stops_blob),
            len(trips_blob),
            len(trips),
            len(stop_seq),
            route_idx,
        )
        for s in stop_seq:
            pat_stops_blob += struct.pack("<H", s)
        for t in trips:
            dep, arr = t["dep"], t["arr"]
            trips_blob += struct.pack("<B", t["s"])
            trips_blob += struct.pack("<I", st.off(t.get("h", "")))
            trips_blob += struct.pack("<I", dep[0])
            trips_blob += varint(dep[0] - arr[0])  # stop-0 dwell
            for i in range(1, len(stop_seq)):
                travel = arr[i] - dep[i - 1]
                dwell = dep[i] - arr[i]
                if travel < 0 or dwell < 0:
                    neg_deltas += 1
                trips_blob += varint(travel)
                trips_blob += varint(dwell)
            interp = set(t.get("interp", []))
            bits = bytearray((len(stop_seq) + 7) // 8)
            for p in interp:
                if 0 <= p < len(stop_seq):
                    bits[p // 8] |= 1 << (p % 8)
            trips_blob += bits
    assert neg_deltas == 0, f"negative travel/dwell deltas: {neg_deltas}"
    sizes["pattern_dir"] = len(pat_dir)
    sizes["pattern_stops"] = len(pat_stops_blob)
    sizes["trips"] = len(trips_blob)
    counts["patterns"] = len(order)
    counts["trips"] = len(tt["trips"])
    counts["stop_times"] = sum(len(t["stops"]) for t in tt["trips"])

    # ---- transfers (sorted u16 triplets) ----
    tr_blob = bytearray()
    for a, b, w in sorted(tt["transfers"]):
        assert 0 <= a < 65536 and 0 <= b < 65536 and 0 <= w < 65536
        tr_blob += struct.pack("<HHH", a, b, w)
    sizes["transfers"] = len(tr_blob)
    counts["transfers"] = len(tt["transfers"])

    sizes["strings"] = len(st.buf)
    meta = tt["meta"]

    # ---- header (64 B) ----
    header = bytearray(HEADER_LEN)
    struct.pack_into("<4sHH", header, 0, b"LTWB", SCHEMA, 0)
    struct.pack_into("<I", header, 8, st.off(meta["feed_version"]))
    struct.pack_into("<I", header, 12, int(meta["valid_from"]))
    struct.pack_into("<I", header, 16, int(meta["valid_to"]))
    struct.pack_into("<I", header, 20, counts["stops"])
    struct.pack_into("<I", header, 24, counts["routes"])
    struct.pack_into("<I", header, 28, counts["services"])
    struct.pack_into("<I", header, 32, counts["exceptions"])
    struct.pack_into("<I", header, 36, counts["patterns"])
    struct.pack_into("<I", header, 40, counts["trips"])
    struct.pack_into("<I", header, 44, counts["transfers"])
    total = HEADER_LEN + sum(sizes.values())
    struct.pack_into("<I", header, 48, total)
    struct.pack_into("<I", header, 52, sizes["strings"])
    struct.pack_into("<I", header, 56, sizes["pattern_stops"])
    struct.pack_into("<I", header, 60, sizes["trips"])
    # the feed_version string was added last; rebuild size check below
    sizes["strings"] = len(st.buf)
    total = HEADER_LEN + sum(sizes.values())
    struct.pack_into("<I", header, 48, total)
    struct.pack_into("<I", header, 52, sizes["strings"])

    blob = (
        bytes(header)
        + bytes(st.buf)
        + bytes(stops_blob)
        + bytes(routes_blob)
        + bytes(svc_blob)
        + bytes(exc_blob)
        + bytes(pat_dir)
        + bytes(pat_stops_blob)
        + bytes(trips_blob)
        + bytes(tr_blob)
    )
    assert len(blob) == total, (len(blob), total)
    return blob, sizes, counts


class Reader:
    """Independent LTWB reader used only for round-trip verification."""

    def __init__(self, blob):
        self.b = blob
        assert blob[:4] == b"LTWB"
        (self.schema,) = struct.unpack_from("<H", blob, 4)
        (self.fv_off,) = struct.unpack_from("<I", blob, 8)
        (self.valid_from,) = struct.unpack_from("<I", blob, 12)
        (self.valid_to,) = struct.unpack_from("<I", blob, 16)
        (self.n_stops,) = struct.unpack_from("<I", blob, 20)
        (self.n_routes,) = struct.unpack_from("<I", blob, 24)
        (self.n_services,) = struct.unpack_from("<I", blob, 28)
        (self.n_exceptions,) = struct.unpack_from("<I", blob, 32)
        (self.n_patterns,) = struct.unpack_from("<I", blob, 36)
        (self.n_trips,) = struct.unpack_from("<I", blob, 40)
        (self.n_transfers,) = struct.unpack_from("<I", blob, 44)
        (self.strings_len,) = struct.unpack_from("<I", blob, 52)
        (self.pat_stops_len,) = struct.unpack_from("<I", blob, 56)
        (self.trips_len,) = struct.unpack_from("<I", blob, 60)
        o = HEADER_LEN
        self.strings_at = o
        o += self.strings_len
        self.stops_at = o
        o += self.n_stops * 17
        self.routes_at = o
        o += self.n_routes * 12
        self.services_at = o
        o += self.n_services * 16
        self.exceptions_at = o
        o += self.n_exceptions * 8
        self.patdir_at = o
        o += self.n_patterns * 16
        self.pat_stops_at = o
        o += self.pat_stops_len
        self.trips_at = o
        o += self.trips_len
        self.transfers_at = o

    def string(self, off):
        pos = self.strings_at + off
        ln, pos = self._varint(pos)
        return self.b[pos : pos + ln].decode("utf-8")

    def _varint(self, pos):
        val = 0
        shift = 0
        while True:
            byte = self.b[pos]
            pos += 1
            val |= (byte & 0x7F) << shift
            if not (byte & 0x80):
                return val, pos
            shift += 7

    def stop(self, i):
        name_off, id_off, x, z, agency = struct.unpack_from(
            "<IIiiB", self.b, self.stops_at + i * 17
        )
        return self.string(name_off), self.string(id_off), x, z, agency

    def pattern(self, pi):
        stops_off, trips_off, n_trips, n_stops, route_idx = struct.unpack_from(
            "<IIIHH", self.b, self.patdir_at + pi * 16
        )
        stops = [
            struct.unpack_from("<H", self.b, self.pat_stops_at + stops_off + 2 * j)[0]
            for j in range(n_stops)
        ]
        return stops, trips_off, n_trips, route_idx

    def pattern_trips(self, pi):
        stops, trips_off, n_trips, _ = self.pattern(pi)
        pos = self.trips_at + trips_off
        out = []
        n = len(stops)
        for _ in range(n_trips):
            (svc,) = struct.unpack_from("<B", self.b, pos)
            pos += 1
            (h_off,) = struct.unpack_from("<I", self.b, pos)
            pos += 4
            (first_dep,) = struct.unpack_from("<I", self.b, pos)
            pos += 4
            dwell0, pos = self._varint(pos)
            arr = [first_dep - dwell0]
            dep = [first_dep]
            for _i in range(1, n):
                travel, pos = self._varint(pos)
                dwell, pos = self._varint(pos)
                arr.append(dep[-1] + travel)
                dep.append(arr[-1] + dwell)
            nbytes = (n + 7) // 8
            bits = self.b[pos : pos + nbytes]
            pos += nbytes
            interp = [j for j in range(n) if bits[j // 8] >> (j % 8) & 1]
            out.append(
                {
                    "s": svc,
                    "h": self.string(h_off),
                    "arr": arr,
                    "dep": dep,
                    "interp": interp,
                }
            )
        return out


def verify(blob, tt, geos):
    """Full round-trip comparison; returns a list of problems."""
    problems = []
    r = Reader(blob)
    if r.schema != SCHEMA:
        problems.append(f"schema {r.schema}")
    if r.string(r.fv_off) != tt["meta"]["feed_version"]:
        problems.append("feed_version mismatch")
    if (r.valid_from, r.valid_to) != (
        int(tt["meta"]["valid_from"]),
        int(tt["meta"]["valid_to"]),
    ):
        problems.append("validity mismatch")

    # stops, in registry order
    expect_stops = []
    for agency, geo in enumerate(geos):
        for s in geo["stops"]:
            expect_stops.append(
                (
                    s["n"],
                    str(s["id"]),
                    int(round(s["x"] * 10)),
                    int(round(s["z"] * 10)),
                    agency,
                )
            )
    if r.n_stops != len(expect_stops):
        problems.append(f"stop count {r.n_stops} != {len(expect_stops)}")
    for i, exp in enumerate(expect_stops):
        if r.stop(i) != exp:
            problems.append(f"stop {i} differs")
            break

    # routes
    for i, rt in enumerate(tt["routes"]):
        id_off, name_off, col, agency = struct.unpack_from(
            "<II3sB", blob, r.routes_at + i * 12
        )
        got = (r.string(id_off), r.string(name_off), col.hex().upper(), agency)
        want = (rt["id"], rt["name"], rt["color"].lstrip("#").upper(), 0)
        if got != want:
            problems.append(f"route {i} differs: {got} != {want}")
            break

    # services + exceptions
    svc_ids = [s["id"] for s in tt["services"]]
    for i, s in enumerate(tt["services"]):
        id_off, start, end, mask = struct.unpack_from(
            "<IIIB", blob, r.services_at + i * 16
        )
        want_mask = sum((1 << j) for j, on in enumerate(s["mask"]) if on)
        if (r.string(id_off), start, end, mask) != (
            s["id"],
            int(s["start"]),
            int(s["end"]),
            want_mask,
        ):
            problems.append(f"service {i} differs")
            break
    for i, e in enumerate(tt["service_exceptions"]):
        date, sidx, added = struct.unpack_from("<IHB", blob, r.exceptions_at + i * 8)
        if (date, svc_ids[sidx], added) != (
            int(e["date"]),
            e["service"],
            int(e["added"]),
        ):
            problems.append(f"exception {i} differs")
            break

    # patterns + trips: reconstruct and compare against the source
    # grouping (route + stop sequence; trips sorted by first dep).
    groups = {}
    order = []
    for t in tt["trips"]:
        key = (t["r"], tuple(t["stops"]))
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(t)
    if r.n_patterns != len(order):
        problems.append(f"pattern count {r.n_patterns} != {len(order)}")
    n_times = 0
    for pi, key in enumerate(order):
        stops, _, n_trips, route_idx = r.pattern(pi)
        if tuple(stops) != key[1] or route_idx != key[0]:
            problems.append(f"pattern {pi} header differs")
            break
        src = sorted(groups[key], key=lambda t: t["dep"][0])
        if n_trips != len(src):
            problems.append(f"pattern {pi} trip count differs")
            break
        got = r.pattern_trips(pi)
        for ti, (g, s) in enumerate(zip(got, src)):
            n_times += len(s["stops"])
            if (
                g["s"] != s["s"]
                or g["h"] != s.get("h", "")
                or g["arr"] != s["arr"]
                or g["dep"] != s["dep"]
                or g["interp"] != sorted(s.get("interp", []))
            ):
                problems.append(f"pattern {pi} trip {ti} differs")
                break
        if problems:
            break
    if not problems and n_times != sum(len(t["stops"]) for t in tt["trips"]):
        problems.append(f"stop-time count {n_times}")

    # transfers
    src_tr = sorted(tuple(x) for x in tt["transfers"])
    got_tr = [
        struct.unpack_from("<HHH", blob, r.transfers_at + 6 * i)
        for i in range(r.n_transfers)
    ]
    if [tuple(x) for x in got_tr] != src_tr:
        problems.append("transfers differ")
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timetable", required=True)
    ap.add_argument("--ddot", required=True)
    ap.add_argument("--smart", required=True)
    ap.add_argument("--qline", required=True)
    ap.add_argument("--outdir", required=True)
    args = ap.parse_args()

    tt = json.load(open(args.timetable))
    geos = [
        json.load(open(args.ddot)),
        json.load(open(args.smart)),
        json.load(open(args.qline)),
    ]
    blob, sizes, counts = pack(tt, geos)
    problems = verify(blob, tt, geos)
    if problems:
        print("VERIFY FAILED:", *problems, sep="\n  ")
        sys.exit(1)
    comp = zlib.compress(blob, 9)
    meta = tt["meta"]
    version = meta["feed_version"]
    manifest = {
        "schema": SCHEMA,
        "feed_version": version,
        "valid_from": meta["valid_from"],
        "valid_to": meta["valid_to"],
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "bundle_file": f"ltwb-{version}.ltwbz",
        "raw_bytes": len(blob),
        "zlib_bytes": len(comp),
        "sha256": hashlib.sha256(comp).hexdigest(),
        "signature": None,
        "signature_note": (
            "Ed25519 signing pending the Project 14 key-custody step; "
            "sha256 above is the integrity check until then."
        ),
        "counts": counts,
    }
    os.makedirs(args.outdir, exist_ok=True)
    with open(os.path.join(args.outdir, f"ltwb-{version}.ltwbz"), "wb") as f:
        f.write(comp)
    with open(os.path.join(args.outdir, "ltwb-manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    print(
        f"source timetable      : {version} "
        f"({meta['valid_from']}..{meta['valid_to']})"
    )
    for k, v in sizes.items():
        print(f"  section {k:<15}: {v:>10,} B")
    print(f"LTWB raw total        : {len(blob):,} B")
    print(f"LTWB zlib-9 total     : {len(comp):,} B")
    print(f"stop-times verified   : {counts['stop_times']:,} (lossless)")
    print(f"sha256 (zlib form)    : {manifest['sha256']}")
    print("round-trip verify     : PASS")


if __name__ == "__main__":
    main()
