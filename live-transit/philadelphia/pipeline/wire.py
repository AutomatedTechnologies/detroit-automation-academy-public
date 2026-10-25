#!/usr/bin/env python3
"""wire.py — shared GTFS-RT protobuf wire-format reader (LT-KAES-08).

PHL REBUILD R2. Label: UNVERIFIED / legacy-unsigned.

This is PLATFORM wire code: the one protobuf reader every Live
Transit collector in this tree uses. A city contributes endpoint
configuration, never a per-city hand-rolled reader (the outgoing
PHL collector's private reader is retired with it). Stdlib only.

The reader is deliberately schema-free: it yields
(field_no, wire_type, value) triples and the typed decoders in
gtfs_rt.py interpret them against the GTFS-RT specification.
Wire types: 0 varint, 1 fixed64, 2 length-delimited, 5 fixed32.
"""

import struct


def varint(buf, i):
    """Decode a varint at offset i -> (value, next_offset)."""
    shift = 0
    result = 0
    while True:
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, i
        shift += 7
        if shift > 70:
            raise ValueError("varint too long")


def fields(buf):
    """Yield (field_no, wire_type, value) for one message buffer.

    value is int for wire type 0, bytes for types 1/2/5.
    """
    i, n = 0, len(buf)
    while i < n:
        tag, i = varint(buf, i)
        fno, wt = tag >> 3, tag & 7
        if wt == 0:
            v, i = varint(buf, i)
        elif wt == 1:
            v = buf[i : i + 8]
            i += 8
        elif wt == 2:
            ln, i = varint(buf, i)
            v = buf[i : i + ln]
            i += ln
        elif wt == 5:
            v = buf[i : i + 4]
            i += 4
        else:
            raise ValueError(f"unsupported wire type {wt}")
        yield fno, wt, v


def f32(b):
    return struct.unpack("<f", b)[0]


def f64(b):
    return struct.unpack("<d", b)[0]


def text(b):
    return b.decode("utf-8", "replace")


def subfields(buf, fno_want):
    """All length-delimited values for one field number."""
    return [v for fno, wt, v in fields(buf) if fno == fno_want and wt == 2]
