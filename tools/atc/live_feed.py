#!/usr/bin/env python3
"""ATC live feed poller — real ADS-B traffic around KDTW -> atc/live.json.

Sources (both free, keyless):
  primary   adsb.lol  /v2/lat/<lat>/lon/<lon>/dist/<nm>  (callsign, type,
                      baro altitude ft, ground speed kt, track, position age)
  fallback  OpenSky Network /api/states/all bbox         (only consulted
                      when the primary fails or returns <5 airborne;
                      anonymous credit budget is 400/day, so it is not
                      polled on the happy path)

Fields a source cannot populate are omitted per-aircraft, never fabricated:
neither ADS-B source carries origin/destination, so those keys are absent.
Ground traffic (alt_baro == "ground" / on_ground) is excluded — the feed is
airborne traffic for the scope.

Usage: live_feed.py [output_path]   (default: atc/live.json)
Exit code 0 on publish-ready output (even if aircraft list is short);
exit code 1 only when BOTH sources fail (no file written).
"""
import json
import math
import sys
import time
import urllib.request
from datetime import datetime, timezone

CENTER_LAT = 42.2162
CENTER_LON = -83.3554
RADIUS_NM = 40
ADSBLOL_URL = f"https://api.adsb.lol/v2/lat/{CENTER_LAT}/lon/{CENTER_LON}/dist/{RADIUS_NM}"
# ~40 NM box around KDTW for OpenSky (its API is bbox-only).
OPENSKY_URL = (
    "https://opensky-network.org/api/states/all"
    "?lamin=41.55&lamax=42.88&lomin=-84.42&lomax=-82.29"
)
UA = {"User-Agent": "daa-atc-live-feed/1.0 (detroitautomationacademy.com)"}


def iso_z(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_json(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def dist_nm(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 3440.065 * 2 * math.asin(math.sqrt(a))


def from_adsblol(data, now):
    out = []
    for ac in data.get("ac", []):
        alt = ac.get("alt_baro")
        if alt == "ground" or alt is None:
            continue
        lat, lon = ac.get("lat"), ac.get("lon")
        if lat is None or lon is None:
            continue
        if dist_nm(CENTER_LAT, CENTER_LON, lat, lon) > RADIUS_NM:
            continue
        seen_pos = ac.get("seen_pos")
        observed = now - seen_pos if isinstance(seen_pos, (int, float)) else now
        rec = {}
        cs = (ac.get("flight") or "").strip()
        if cs:
            rec["callsign"] = cs
        rec["lat"] = round(lat, 5)
        rec["lon"] = round(lon, 5)
        rec["alt_ft"] = int(alt)
        if ac.get("track") is not None:
            rec["heading_deg"] = int(round(ac["track"])) % 360
        if ac.get("gs") is not None:
            rec["speed_kt"] = int(round(ac["gs"]))
        if ac.get("t"):
            rec["type"] = ac["t"]
        rec["observed_at"] = iso_z(observed)
        out.append(rec)
    return out


def from_opensky(data, now):
    out = []
    for s in data.get("states") or []:
        # state vector: [icao24, callsign, origin_country, time_position,
        # last_contact, lon, lat, baro_altitude_m, on_ground, velocity_m_s,
        # true_track, ...]
        if s[8]:
            continue
        lat, lon = s[6], s[5]
        if lat is None or lon is None:
            continue
        if dist_nm(CENTER_LAT, CENTER_LON, lat, lon) > RADIUS_NM:
            continue
        rec = {}
        cs = (s[1] or "").strip()
        if cs:
            rec["callsign"] = cs
        rec["lat"] = round(lat, 5)
        rec["lon"] = round(lon, 5)
        if s[7] is not None:
            rec["alt_ft"] = int(round(s[7] * 3.28084))
        if s[10] is not None:
            rec["heading_deg"] = int(round(s[10])) % 360
        if s[9] is not None:
            rec["speed_kt"] = int(round(s[9] * 1.94384))
        rec["observed_at"] = iso_z(s[3] if s[3] else now)
        out.append(rec)
    return out


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "atc/live.json"
    now = time.time()
    aircraft, sources = [], []

    try:
        aircraft = from_adsblol(fetch_json(ADSBLOL_URL), now)
        sources.append("adsb.lol")
        print(f"adsb.lol: {len(aircraft)} airborne in {RADIUS_NM} NM")
    except Exception as e:  # noqa: BLE001 - fallback path is the point
        print(f"adsb.lol FAILED: {type(e).__name__}: {str(e)[:200]}")

    if len(aircraft) < 5:
        try:
            extra = from_opensky(fetch_json(OPENSKY_URL), now)
            sources.append("OpenSky Network")
            print(f"OpenSky: {len(extra)} airborne in box")
            seen = {(a.get("callsign"), a["lat"], a["lon"]) for a in aircraft}
            for a in extra:
                if (a.get("callsign"), a["lat"], a["lon"]) not in seen:
                    aircraft.append(a)
        except Exception as e:  # noqa: BLE001
            print(f"OpenSky FAILED: {type(e).__name__}: {str(e)[:200]}")

    if not sources:
        print("BOTH sources failed; not writing feed")
        return 1

    aircraft.sort(key=lambda a: a.get("callsign", ""))
    feed = {
        "generated_at": iso_z(now),
        "source": " + ".join(sources),
        "center": {"lat": CENTER_LAT, "lon": CENTER_LON},
        "radius_nm": RADIUS_NM,
        "aircraft": aircraft,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(feed, f, indent=1)
        f.write("\n")
    print(f"wrote {out_path}: {len(aircraft)} aircraft, source={feed['source']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
