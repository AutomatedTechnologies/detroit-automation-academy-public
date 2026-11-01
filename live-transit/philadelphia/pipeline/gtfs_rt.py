#!/usr/bin/env python3
"""gtfs_rt.py — GTFS-RT typed decoders on the shared wire code.

PHL REBUILD R2. Label: UNVERIFIED / legacy-unsigned.

Decodes a GTFS-RT FeedMessage into plain dicts for the three leg
kinds SEPTA publishes (LT-KAES-16): vehicle positions, trip
updates, service alerts. Field numbers are the GTFS-RT
specification's; the SEPTA feeds were verified standard-layout
against the reference bindings on 2026-10-24 (the outgoing
collector's "nonstandard serialization" comment was a misread of
its own naive recursion — position IS field 2, the vehicle
descriptor IS field 8, the timestamp IS field 5 of
VehiclePosition).

A field the source does not carry decodes as None (LT-F7: absent,
never synthesized).
"""

from wire import f32, fields, text

CAUSE = {
    1: "UNKNOWN_CAUSE",
    2: "OTHER_CAUSE",
    3: "TECHNICAL_PROBLEM",
    4: "STRIKE",
    5: "DEMONSTRATION",
    6: "ACCIDENT",
    7: "HOLIDAY",
    8: "WEATHER",
    9: "MAINTENANCE",
    10: "CONSTRUCTION",
    11: "POLICE_ACTIVITY",
    12: "MEDICAL_EMERGENCY",
}
EFFECT = {
    1: "NO_SERVICE",
    2: "REDUCED_SERVICE",
    3: "SIGNIFICANT_DELAYS",
    4: "DETOUR",
    5: "ADDITIONAL_SERVICE",
    6: "MODIFIED_SERVICE",
    7: "OTHER_EFFECT",
    8: "UNKNOWN_EFFECT",
    9: "STOP_MOVED",
    10: "NO_EFFECT",
    11: "ACCESSIBILITY_ISSUE",
}
SEVERITY = {1: "UNKNOWN_SEVERITY", 2: "INFO", 3: "WARNING", 4: "SEVERE"}
SCHED_REL = {0: "SCHEDULED", 1: "SKIPPED", 2: "NO_DATA", 3: "UNSCHEDULED"}


def _trip_descriptor(buf):
    trip = {
        "trip_id": None,
        "start_time": None,
        "start_date": None,
        "schedule_relationship": None,
        "route_id": None,
        "direction_id": None,
    }
    for fno, wt, v in fields(buf):
        if wt == 2 and fno == 1:
            trip["trip_id"] = text(v)
        elif wt == 2 and fno == 2:
            trip["start_time"] = text(v)
        elif wt == 2 and fno == 3:
            trip["start_date"] = text(v)
        elif wt == 0 and fno == 4:
            trip["schedule_relationship"] = v
        elif wt == 2 and fno == 5:
            trip["route_id"] = text(v)
        elif wt == 0 and fno == 6:
            trip["direction_id"] = v
    return trip


def _vehicle_descriptor(buf):
    desc = {"id": None, "label": None}
    for fno, wt, v in fields(buf):
        if wt == 2 and fno == 1:
            desc["id"] = text(v)
        elif wt == 2 and fno == 2:
            desc["label"] = text(v)
    return desc


def _position(buf):
    pos = {"lat": None, "lon": None, "bearing": None, "speed_mps": None}
    for fno, wt, v in fields(buf):
        if wt != 5:
            continue
        if fno == 1:
            pos["lat"] = f32(v)
        elif fno == 2:
            pos["lon"] = f32(v)
        elif fno == 3:
            pos["bearing"] = round(f32(v), 1)
        elif fno == 5:
            pos["speed_mps"] = f32(v)
    return pos


def _vehicle_position(buf):
    vp = {
        "trip": None,
        "vehicle": None,
        "position": None,
        "timestamp": None,
        "stop_id": None,
        "current_stop_sequence": None,
    }
    for fno, wt, v in fields(buf):
        if wt == 2 and fno == 1:
            vp["trip"] = _trip_descriptor(v)
        elif wt == 2 and fno == 2:
            vp["position"] = _position(v)
        elif wt == 0 and fno == 3:
            vp["current_stop_sequence"] = v
        elif wt == 0 and fno == 5:
            vp["timestamp"] = v
        elif wt == 2 and fno == 7:
            vp["stop_id"] = text(v)
        elif wt == 2 and fno == 8:
            vp["vehicle"] = _vehicle_descriptor(v)
    return vp


def _stop_time_event(buf):
    ev = {"delay": None, "time": None, "uncertainty": None}
    for fno, wt, v in fields(buf):
        if wt != 0:
            continue
        if fno == 1:
            ev["delay"] = v
        elif fno == 2:
            ev["time"] = v
        elif fno == 3:
            ev["uncertainty"] = v
    return ev


def _stop_time_update(buf):
    stu = {
        "stop_sequence": None,
        "arrival": None,
        "departure": None,
        "stop_id": None,
        "schedule_relationship": None,
    }
    for fno, wt, v in fields(buf):
        if wt == 0 and fno == 1:
            stu["stop_sequence"] = v
        elif wt == 2 and fno == 2:
            stu["arrival"] = _stop_time_event(v)
        elif wt == 2 and fno == 3:
            stu["departure"] = _stop_time_event(v)
        elif wt == 2 and fno == 4:
            stu["stop_id"] = text(v)
        elif wt == 0 and fno == 5:
            stu["schedule_relationship"] = SCHED_REL.get(v, v)
    return stu


def _trip_update(buf):
    tu = {
        "trip": None,
        "stop_time_updates": [],
        "vehicle": None,
        "timestamp": None,
        "delay": None,
    }
    for fno, wt, v in fields(buf):
        if wt == 2 and fno == 1:
            tu["trip"] = _trip_descriptor(v)
        elif wt == 2 and fno == 2:
            tu["stop_time_updates"].append(_stop_time_update(v))
        elif wt == 2 and fno == 3:
            tu["vehicle"] = _vehicle_descriptor(v)
        elif wt == 0 and fno == 4:
            tu["timestamp"] = v
        elif wt == 0 and fno == 5:
            tu["delay"] = v
    return tu


def _translated(buf):
    """TranslatedString -> its first translation's text (or None)."""
    for fno, wt, v in fields(buf):
        if wt == 2 and fno == 1:
            for tf, twt, tv in fields(v):
                if twt == 2 and tf == 1:
                    return text(tv)
    return None


def _entity_selector(buf):
    sel = {
        "agency_id": None,
        "route_id": None,
        "route_type": None,
        "direction_id": None,
        "trip_id": None,
        "stop_id": None,
    }
    for fno, wt, v in fields(buf):
        if wt == 2 and fno == 1:
            sel["agency_id"] = text(v)
        elif wt == 2 and fno == 2:
            sel["route_id"] = text(v)
        elif wt == 0 and fno == 3:
            sel["route_type"] = v
        elif wt == 0 and fno == 4:
            sel["direction_id"] = v
        elif wt == 2 and fno == 5:
            sel["trip_id"] = _trip_descriptor(v)["trip_id"]
        elif wt == 2 and fno == 6:
            sel["stop_id"] = text(v)
    return sel


def _alert(buf):
    al = {
        "active_periods": [],
        "informed_entities": [],
        "cause": None,
        "effect": None,
        "url": None,
        "header": None,
        "description": None,
        "severity": None,
    }
    for fno, wt, v in fields(buf):
        if wt == 2 and fno == 1:
            period = {"start": None, "end": None}
            for pf, pwt, pv in fields(v):
                if pwt == 0 and pf == 1:
                    period["start"] = pv
                elif pwt == 0 and pf == 2:
                    period["end"] = pv
            al["active_periods"].append(period)
        elif wt == 2 and fno == 5:
            al["informed_entities"].append(_entity_selector(v))
        elif wt == 0 and fno == 6:
            al["cause"] = CAUSE.get(v, v)
        elif wt == 0 and fno == 7:
            al["effect"] = EFFECT.get(v, v)
        elif wt == 2 and fno == 8:
            al["url"] = _translated(v)
        elif wt == 2 and fno == 10:
            al["header"] = _translated(v)
        elif wt == 2 and fno == 11:
            al["description"] = _translated(v)
        elif wt == 0 and fno in (13, 14):
            # severity_level: field 13 in the current spec; SEPTA's
            # vendor emits it at 14 (measured 2026-10-24). Accept both.
            al["severity"] = SEVERITY.get(v, v)
    return al


def decode_feed(buf):
    """FeedMessage bytes -> {header_ts, entities}.

    Each entity is {id, vehicle|trip_update|alert} with exactly one
    payload key (or none for an entity carrying no known payload).
    """
    header_ts = None
    entities = []
    for fno, wt, v in fields(buf):
        if wt != 2:
            continue
        if fno == 1:
            for hf, hwt, hv in fields(v):
                if hwt == 0 and hf == 3:
                    header_ts = hv
        elif fno == 2:
            ent = {"id": None, "vehicle": None, "trip_update": None, "alert": None}
            for ef, ewt, ev in fields(v):
                if ewt == 2 and ef == 1:
                    ent["id"] = text(ev)
                elif ewt == 2 and ef == 3:
                    ent["trip_update"] = _trip_update(ev)
                elif ewt == 2 and ef == 4:
                    ent["vehicle"] = _vehicle_position(ev)
                elif ewt == 2 and ef == 5:
                    ent["alert"] = _alert(ev)
            entities.append(ent)
    return {"header_ts": header_ts, "entities": entities}
