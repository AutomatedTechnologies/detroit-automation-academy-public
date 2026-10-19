#!/usr/bin/env node
'use strict';
/**
 * Live Transit Detroit — static feed builder (GitHub Actions).
 *
 * Migration 2026-10-15: the page's live feed moved off the Netlify proxy
 * (quota-paused: HTTP 503 usage_exceeded on all paths) onto static JSON
 * in this repo, published by .github/workflows/live-feed.yml on a
 * 5-minute cron and served by GitHub Pages from live-data/.
 *
 * This script is a faithful port of the retired proxy's legs
 * (smit4786/forge-line-live-proxy: netlify/functions/vehicles.js,
 * netlify/functions/alerts.js, lib/mappers.js, lib/gtfsrt.js,
 * lib/alerts-map.js) with the SMART legs removed — SMART was removed
 * from the product 2026-10-15 (stamp 20261015-1502); sources.smart is
 * reported as an explicit removed state, never polled, never emitted
 * as vehicles or alerts.
 *
 * Legs:
 *  - DDOT: Clever Devices BusTime v3 getvehicles (batched 10 routes per
 *    call over the 37-route set, every cycle) + getservicebulletins
 *    (per route, collected at most once per BULLETIN_REUSE_MS — see
 *    the bulletin sub-cadence section; 37 calls every 5-minute cycle
 *    would by itself approach the BusTime daily transaction cap).
 *    Key from the DDOT_BUSTIME_KEY env var (a GitHub Actions secret,
 *    placed by the repo owner; in the proxy era the same key lived in
 *    the Netlify site's env as DDOT_KEY). Absent key is a named
 *    not-configured source state — never a crash, never fabricated data.
 *  - QLINE: public GTFS-RT VehiclePositions (no key). The protobuf is
 *    decoded by the minimal reader below (no npm dependencies), mapping
 *    with the same semantics as lib/gtfsrt.js.
 *  - SMART (Swiftly, DORMANT — added 2026-10-15): authenticated GTFS-RT
 *    VehiclePositions from Swiftly's realtime API, active ONLY when the
 *    SWIFTLY_KEY env var (repo secret, placed by the repo owner when
 *    Swiftly issues the key) is present and non-empty. Key requested
 *    2026-10-13 for SMART only; SMART was removed from the product the
 *    same week, and this leg exists so the receiving infrastructure is
 *    ready before the key arrives — it does NOT return SMART to the
 *    map (the page does not consume the display payload yet).
 *    DISPLAY-ONLY (Swiftly API License Agreement §4(vi), decision
 *    2026-10-15): Swiftly Content is never merged into vehicles.json
 *    (the publicly documented feed contract) and never enters the
 *    telemetry archive (the logger excludes agency "smart"
 *    structurally). Decoded SMART vehicles are written to a separate
 *    display payload, live-data/smart-display.json, which the page
 *    will fetch solely to render markers when SMART returns. It is
 *    not referenced by api.html or any public documentation and is
 *    not linked from any page. Absent key: the leg performs ZERO
 *    network calls, sources.smart keeps the removed state verbatim,
 *    and a stale display payload left in the checkout is deleted so
 *    revoked access cannot keep serving Swiftly Content.
 *
 *  - SMART trip updates (Swiftly; deployed 2026-10-17):
 *    authenticated GTFS-RT TripUpdates from the second
 *    endpoint Swiftly's issuance enabled (2026-10-15), active ONLY
 *    when SWIFTLY_KEY is present, on the same cycle as the positions
 *    leg. DISPLAY-ONLY under the same §4(vi) terms: decoded trip
 *    updates are normalized into a separate display payload,
 *    live-data/smart-trip-updates.json, which the page fetches
 *    solely to render live arrival times on SMART stop cards. Trip
 *    updates are NEVER merged into vehicles.json, NEVER enter the
 *    telemetry archive, and NEVER feed the page's trip planner or
 *    delay matcher — display rendering only (the no-contamination
 *    rule). Service alerts are NOT part of this leg: Swiftly did not
 *    enable the alerts endpoint, and nothing here polls it. Absent
 *    key: the leg performs ZERO network calls and a stale trip-
 *    updates payload is deleted, exactly like the display payload.
 *    Volume: one request per 5-minute cycle per endpoint — the two
 *    Swiftly legs together make 2 requests per cycle = 6 requests
 *    per 15 minutes against the issuance limit of 180 per 15
 *    minutes (~3.3%).
 *
 *  - SMART trip-updates watch derivative (Project 29 item 4, added
 *    2026-10-19; authorized by the registered Project 29 decision-5
 *    pick): the same normalized trips are re-encoded in the same run
 *    into per-route trimmed files under live-data/smart-tu/ plus an
 *    index.json, in the positional schema of the Project 29
 *    data-stream specification §3.2/§3.3, so an Apple Watch can fetch
 *    only the routes serving its context instead of the 3.6 MB
 *    payload. It is a re-encoding of the SAME display data — no new
 *    source, no new request, the §4(vi) display-only posture is
 *    unchanged, and nothing about it enters vehicles.json, the
 *    telemetry archive, or any computation. Lifecycle mirrors the
 *    trip-updates payload: published only while SWIFTLY_KEY is
 *    active and the trip-updates leg succeeded; on a leg failure the
 *    previously published derivative is left untouched (its gen ages
 *    honestly); on key withdrawal the whole directory is deleted.
 *
 * Output envelopes are byte-compatible with the proxy contract the page
 * consumes:
 *  vehicles.json: {generated_at, count, vehicles[], sources:{ddot, smart, qline}}
 *  alerts.json:   {generated_at, count, alerts[], sources:[ddotState]}
 * Vehicle record: {agency, route_id, vehicle_id, lat, lon, bearing,
 * speed_mph, destination, updated_at}. Alert record: see mapDdotBulletins.
 *
 * Write policy (history hygiene): a file is rewritten only when its
 * content changed materially — vehicle set/positions, alert set, or any
 * source's ok state — ignoring volatile timestamps (generated_at,
 * sources' at/fetched_at); or when the existing file's generated_at is
 * older than HEARTBEAT_MS (a bounded liveness heartbeat). The workflow
 * commits only when the files actually changed.
 *
 * Env: DDOT_BUSTIME_KEY (secret; absent = DDOT not-configured state),
 *      DDOT_ROUTES (optional override, comma-separated),
 *      QLINE_VP_URL (optional override),
 *      SWIFTLY_KEY (secret; absent/empty = SMART leg fully dormant,
 *      zero network calls, sources.smart stays the removed state),
 *      SMART_VP_URL (optional override; default is the Swiftly
 *      pattern for agency key "detroit-smartbus", confirmed by
 *      Swiftly's key-issuance email 2026-10-15 — see pollSmart),
 *      SMART_TU_URL (optional override; default is the same Swiftly
 *      pattern with the trip-updates endpoint — see
 *      pollSmartTripUpdates),
 *      FEED_OUT_DIR (optional; default <repo>/live-data — local testing).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = process.env.FEED_OUT_DIR || path.join(ROOT, 'live-data');
const HEARTBEAT_MS = 30 * 60 * 1000;

const DDOT_KEY = process.env.DDOT_BUSTIME_KEY || '';
const ALL_DDOT_ROUTES = '1,2,3,4,5,6,7,8,9,10,11,12,13,15,16,17,18,19,23,27,29,30,31,32,38,39,40,41,42,43,46,47,52,54,60,67,68';
const DDOT_ROUTES = (process.env.DDOT_ROUTES || ALL_DDOT_ROUTES).split(',').map((s) => s.trim()).filter(Boolean);
const QLINE_VP_URL = process.env.QLINE_VP_URL || 'https://s3.amazonaws.com/etatransit.gtfs/qline.etaspot.net/position_updates.pb';
const SMART_REMOVED_REASON = 'SMART removed from Live Transit Detroit 2026-10-15';
const SWIFTLY_KEY = process.env.SWIFTLY_KEY || '';
const SMART_VP_URL = process.env.SMART_VP_URL || 'https://api.goswift.ly/real-time/detroit-smartbus/gtfs-rt-vehicle-positions';
const SMART_TU_URL = process.env.SMART_TU_URL || 'https://api.goswift.ly/real-time/detroit-smartbus/gtfs-rt-trip-updates';

/* ---------------- fetch helpers (proxy equivalents) ---------------- */

async function fetchJson(url, timeoutMs = 15000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.split('?')[0]}`);
  return res.json();
}

async function fetchBuffer(url, timeoutMs = 15000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.split('?')[0]}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Fetch with the Swiftly API key. The key travels only in the
 *  Authorization header as the RAW key value, and is never placed in
 *  a URL, a log line, or an error message. Auth form measured live
 *  2026-10-15 (workflow test runs 38821825120 / 38822082150 /
 *  38822211656): "Authorization: Bearer <key>" scores HTTP 401
 *  "Invalid Credentials" — identical to a bogus value and to no
 *  credential at all — while the raw key is READ by the server (a
 *  bogus raw value still scores 401; the genuine key scores 403,
 *  i.e. recognized but not authorized for this agency feed). The
 *  401's WWW-Authenticate: Bearer challenge is therefore not the
 *  scheme this API accepts for key auth; integrator documentation
 *  for the same API (Marin Transit / SF Bay Ferry developer pages,
 *  third-party configs) likewise shows the raw key in the header. */
async function fetchBufferSwiftly(url, key, timeoutMs = 15000) {
  const res = await fetch(url, {
    headers: { Authorization: key },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.split('?')[0]}`);
  return Buffer.from(await res.arrayBuffer());
}

/* ---------------- lib/mappers.js port ---------------- */

function toIsoBusTime(tmstmp) {
  // BusTime v3 tmstmp: "YYYYMMDD HH:MM" (agency local, America/Detroit)
  const m = /^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2})/.exec(String(tmstmp || ''));
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** DDOT: Clever Devices BusTime v3 getvehicles, format=json */
function mapDdotVehicles(json) {
  try {
    const list = json && json['bustime-response'] && json['bustime-response'].vehicle;
    if (!Array.isArray(list)) return [];
    return list
      .map((v) => ({
        agency: 'ddot',
        route_id: String(v.rt ?? ''),
        vehicle_id: String(v.vid ?? ''),
        lat: num(v.lat),
        lon: num(v.lon),
        bearing: num(v.hdg),
        speed_mph: num(v.spd),
        destination: String(v.des ?? '').trim() || null,
        updated_at: toIsoBusTime(v.tmstmp),
      }))
      .filter((v) => v.vehicle_id && v.lat !== null && v.lon !== null);
  } catch {
    return [];
  }
}

/* ------------- GTFS-RT: minimal protobuf reader + mapper -------------
 * Field numbers per the GTFS-RT schema (gtfs-realtime.proto):
 * FeedMessage.entity = 2; FeedEntity.id = 1, .vehicle = 4;
 * VehiclePosition.trip = 1, .position = 2, .vehicle = 8, .timestamp = 5;
 * TripDescriptor.route_id = 5; VehicleDescriptor.id = 1;
 * Position.latitude = 1 (float), .longitude = 2 (float),
 * .bearing = 3 (float), .speed = 5 (float).
 * Mapping semantics mirror lib/gtfsrt.js exactly: entities without a
 * vehicle/position or with non-finite coordinates are skipped; bearing
 * and speed are null unless the field is present; updated_at comes from
 * the vehicle timestamp, else the poll time.
 */

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated varint');
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7n;
    if (shift > 63n) throw new Error('varint too long');
  }
  return [result, pos];
}

function* protoFields(buf) {
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const fieldNo = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) {
      let v;
      [v, pos] = readVarint(buf, pos);
      yield [fieldNo, { wire, varint: v }];
    } else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      const n = Number(len);
      yield [fieldNo, { wire, bytes: buf.subarray(pos, pos + n) }];
      pos += n;
    } else if (wire === 5) {
      yield [fieldNo, { wire, bytes: buf.subarray(pos, pos + 4) }];
      pos += 4;
    } else if (wire === 1) {
      yield [fieldNo, { wire, bytes: buf.subarray(pos, pos + 8) }];
      pos += 8;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
}

function float32(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, true);
}

function utf8(bytes) {
  return Buffer.from(bytes).toString('utf8');
}

function decodePosition(buf) {
  const out = {};
  for (const [no, val] of protoFields(buf)) {
    if (val.wire !== 5) continue;
    if (no === 1) out.latitude = float32(val.bytes);
    else if (no === 2) out.longitude = float32(val.bytes);
    else if (no === 3) out.bearing = float32(val.bytes);
    else if (no === 5) out.speed = float32(val.bytes);
  }
  return out;
}

function decodeTripDescriptor(buf) {
  const out = {};
  for (const [no, val] of protoFields(buf)) {
    if (no === 1 && val.wire === 2) out.tripId = utf8(val.bytes);
    else if (no === 2 && val.wire === 2) out.startTime = utf8(val.bytes);
    else if (no === 3 && val.wire === 2) out.startDate = utf8(val.bytes);
    else if (no === 4 && val.wire === 0) out.scheduleRelationship = val.varint;
    else if (no === 5 && val.wire === 2) out.routeId = utf8(val.bytes);
    else if (no === 6 && val.wire === 0) out.directionId = val.varint;
  }
  return out;
}

function decodeVehicleDescriptor(buf) {
  const out = {};
  for (const [no, val] of protoFields(buf)) {
    if (no === 1 && val.wire === 2) out.id = utf8(val.bytes);
  }
  return out;
}

function decodeVehiclePosition(buf) {
  const out = {};
  for (const [no, val] of protoFields(buf)) {
    if (no === 1 && val.wire === 2) out.trip = decodeTripDescriptor(val.bytes);
    else if (no === 2 && val.wire === 2) out.position = decodePosition(val.bytes);
    else if (no === 8 && val.wire === 2) out.vehicle = decodeVehicleDescriptor(val.bytes);
    else if (no === 5 && val.wire === 0) out.timestamp = val.varint;
  }
  return out;
}

/* GTFS-RT TripUpdate decoding (deployed 2026-10-17).
 * Field numbers per gtfs-realtime.proto: FeedEntity.trip_update = 3;
 * TripUpdate.trip = 1, .stop_time_update = 2, .vehicle = 3,
 * .timestamp = 4, .delay = 5; TripDescriptor.trip_id = 1,
 * .start_time = 2, .start_date = 3, .schedule_relationship = 4,
 * .route_id = 5, .direction_id = 6; StopTimeUpdate.stop_sequence = 1,
 * .arrival = 2, .departure = 3, .stop_id = 4,
 * .schedule_relationship = 5; StopTimeEvent.delay = 1 (int32, seconds,
 * may be negative), .time = 2 (int64, POSIX epoch seconds),
 * .uncertainty = 3. ScheduleRelationship enums are rendered as their
 * GTFS names so the display payload stays self-describing. */

const TRIP_SCHEDULE_REL = ['SCHEDULED', 'ADDED', 'UNSCHEDULED', 'CANCELED'];
const STOP_SCHEDULE_REL = ['SCHEDULED', 'SKIPPED', 'NO_DATA'];

function int32FromVarint(v) {
  // Protobuf int32 negatives arrive sign-extended to 64 bits.
  return Number(BigInt.asIntN(32, v));
}

function decodeStopTimeEvent(buf) {
  const out = {};
  for (const [no, val] of protoFields(buf)) {
    if (no === 1 && val.wire === 0) out.delay = int32FromVarint(val.varint);
    else if (no === 2 && val.wire === 0) out.time = Number(BigInt.asIntN(64, val.varint));
    else if (no === 3 && val.wire === 0) out.uncertainty = Number(val.varint);
  }
  return out;
}

function decodeStopTimeUpdate(buf) {
  const out = {};
  for (const [no, val] of protoFields(buf)) {
    if (no === 1 && val.wire === 0) out.stopSequence = Number(val.varint);
    else if (no === 2 && val.wire === 2) out.arrival = decodeStopTimeEvent(val.bytes);
    else if (no === 3 && val.wire === 2) out.departure = decodeStopTimeEvent(val.bytes);
    else if (no === 4 && val.wire === 2) out.stopId = utf8(val.bytes);
    else if (no === 5 && val.wire === 0) out.scheduleRelationship = val.varint;
  }
  return out;
}

function decodeTripUpdate(buf) {
  const out = { stopTimeUpdates: [] };
  for (const [no, val] of protoFields(buf)) {
    if (no === 1 && val.wire === 2) out.trip = decodeTripDescriptor(val.bytes);
    else if (no === 2 && val.wire === 2) out.stopTimeUpdates.push(decodeStopTimeUpdate(val.bytes));
    else if (no === 3 && val.wire === 2) out.vehicle = decodeVehicleDescriptor(val.bytes);
    else if (no === 4 && val.wire === 0) out.timestamp = val.varint;
  }
  return out;
}

const MS_PER_S = 2.23694; // m/s -> mph

function mapGtfsRtVehicles(buffer, nowIso, agency) {
  try {
    const out = [];
    for (const [no, val] of protoFields(buffer)) {
      if (no !== 2 || val.wire !== 2) continue; // FeedEntity
      let entityId = '';
      let vp = null;
      for (const [eno, eval2] of protoFields(val.bytes)) {
        if (eno === 1 && eval2.wire === 2) entityId = utf8(eval2.bytes);
        else if (eno === 4 && eval2.wire === 2) vp = decodeVehiclePosition(eval2.bytes);
      }
      if (!vp || !vp.position) continue;
      const lat = Number(vp.position.latitude);
      const lon = Number(vp.position.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const bearing = vp.position.hasOwnProperty('bearing') ? Number(vp.position.bearing) : NaN;
      const speedMs = vp.position.hasOwnProperty('speed') ? Number(vp.position.speed) : NaN;
      const ts = vp.timestamp !== undefined ? Number(vp.timestamp) : NaN;
      out.push({
        agency,
        route_id: String((vp.trip && vp.trip.routeId) || ''),
        vehicle_id: String((vp.vehicle && vp.vehicle.id) || entityId || ''),
        lat,
        lon,
        bearing: Number.isFinite(bearing) ? bearing : null,
        speed_mph: Number.isFinite(speedMs) ? Math.round(speedMs * MS_PER_S * 10) / 10 : null,
        updated_at: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : nowIso,
      });
    }
    return out.filter((v) => v.vehicle_id);
  } catch {
    return [];
  }
}

/* Normalize a GTFS-RT TripUpdates feed into the display payload's
 * trip records (deployed 2026-10-17). The shape is keyed
 * for display lookup: the page finds a stop's upcoming live times by
 * scanning trips' stop_time_updates for its stop_id. Times stay in
 * POSIX epoch seconds (the page formats them); delays are carried
 * verbatim for transparency. Entities without a trip update, and
 * updates whose trip carries neither a trip_id nor a route_id, are
 * skipped — an unidentifiable update can never be displayed honestly.
 * Output is sorted by (route_id, trip_id) so the payload is stable
 * across cycles and the material-change write policy sees real
 * changes only. */
function mapGtfsRtTripUpdates(buffer, nowIso) {
  try {
    const out = [];
    for (const [no, val] of protoFields(buffer)) {
      if (no !== 2 || val.wire !== 2) continue; // FeedEntity
      let tu = null;
      for (const [eno, eval2] of protoFields(val.bytes)) {
        if (eno === 3 && eval2.wire === 2) tu = decodeTripUpdate(eval2.bytes);
      }
      if (!tu || !tu.trip) continue;
      const tripId = String(tu.trip.tripId || '');
      const routeId = String(tu.trip.routeId || '');
      if (!tripId && !routeId) continue;
      const ts = tu.timestamp !== undefined ? Number(tu.timestamp) : NaN;
      const stops = [];
      for (const stu of tu.stopTimeUpdates) {
        if (!stu.stopId) continue;
        const rel = stu.scheduleRelationship !== undefined ? Number(stu.scheduleRelationship) : 0;
        stops.push({
          stop_id: String(stu.stopId),
          stop_sequence: stu.stopSequence !== undefined ? stu.stopSequence : null,
          arrival_time: stu.arrival && stu.arrival.time !== undefined ? stu.arrival.time : null,
          arrival_delay_sec: stu.arrival && stu.arrival.delay !== undefined ? stu.arrival.delay : null,
          departure_time: stu.departure && stu.departure.time !== undefined ? stu.departure.time : null,
          departure_delay_sec: stu.departure && stu.departure.delay !== undefined ? stu.departure.delay : null,
          schedule_relationship: STOP_SCHEDULE_REL[rel] || 'SCHEDULED',
        });
      }
      const tripRel = tu.trip.scheduleRelationship !== undefined ? Number(tu.trip.scheduleRelationship) : 0;
      out.push({
        trip_id: tripId,
        route_id: routeId,
        direction_id: tu.trip.directionId !== undefined ? Number(tu.trip.directionId) : null,
        start_date: tu.trip.startDate ? String(tu.trip.startDate) : null,
        start_time: tu.trip.startTime ? String(tu.trip.startTime) : null,
        schedule_relationship: TRIP_SCHEDULE_REL[tripRel] || 'SCHEDULED',
        vehicle_id: tu.vehicle && tu.vehicle.id ? String(tu.vehicle.id) : null,
        updated_at: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : nowIso,
        stop_time_updates: stops,
      });
    }
    out.sort((a, b) => (a.route_id + '|' + a.trip_id).localeCompare(b.route_id + '|' + b.trip_id));
    return out;
  } catch {
    return [];
  }
}

/* ------------- SMART trip-updates watch derivative -------------
 * Project 29 item 4 (2026-10-19), spec: Project 29 data-stream
 * specification §3.2 (trimmed schema) + §3.3 (derivative contract).
 * Pure functions of the normalized trips above, so the derivative is
 * testable without the network and adds zero upstream requests.
 *
 * Trimming rules (§3.2): an update's time is its departure epoch,
 * falling back to arrival; its delay is the departure delay, falling
 * back to arrival (null = schedule-based prediction, still carried);
 * SKIPPED updates are omitted entirely (absence at a stop means "not
 * served"); only updates inside [gen - 300 s, gen + 120 min] are
 * kept. Trip tuple: [trip_id, route_id, direction_id, updates], with
 * the trip's schedule_relationship appended as a 5th element when it
 * is not SCHEDULED. Trips keep the source payload's (route, trip)
 * sort, so bytes are stable across runs over unchanged input. */
const SMART_TU_WINDOW_AHEAD_S = 120 * 60;
const SMART_TU_WINDOW_BEHIND_S = 300;

function trimSmartTuTrip(t, genSec) {
  const ups = [];
  for (const u of t.stop_time_updates || []) {
    if (!u.stop_id || u.schedule_relationship === 'SKIPPED') continue;
    const ts = u.departure_time ?? u.arrival_time;
    if (ts === null || ts === undefined) continue;
    if (ts < genSec - SMART_TU_WINDOW_BEHIND_S || ts > genSec + SMART_TU_WINDOW_AHEAD_S) continue;
    const delay = u.departure_delay_sec ?? u.arrival_delay_sec ?? null;
    ups.push([String(u.stop_id), ts, delay]);
  }
  if (!ups.length) return null;
  const tuple = [String(t.trip_id || ''), String(t.route_id || ''), t.direction_id ?? null, ups];
  if (t.schedule_relationship && t.schedule_relationship !== 'SCHEDULED') tuple.push(t.schedule_relationship);
  return tuple;
}

/** route_id -> windowed trimmed trip tuples (possibly an empty list
 *  for a route present in the payload with no in-window updates). */
function buildSmartTuDerivative(trips, genSec) {
  const byRoute = new Map();
  for (const t of trips) {
    const rid = String(t.route_id || '');
    if (!rid) continue;
    if (!byRoute.has(rid)) byRoute.set(rid, []);
    const tuple = trimSmartTuTrip(t, genSec);
    if (tuple) byRoute.get(rid).push(tuple);
  }
  return byRoute;
}

/** Filename for a route's derivative file. Route ids in the payload
 *  are plain tokens today; encodeURIComponent keeps any future id
 *  filesystem-safe while leaving plain ids byte-identical. */
function smartTuFileName(routeId) {
  return encodeURIComponent(routeId) + '.json';
}

/**
 * Write the derivative under `dir`: one file per route in the
 * universe (routes in `byRoute` UNION routes in the previously
 * published index, so a route with no in-window trips still
 * publishes an explicit empty file rather than a 404) plus
 * index.json. Files are written whole, never patched; unchanged
 * input reproduces byte-identical files, so the workflow's commit
 * step sees a change only when the data changed. Returns a summary
 * for the run log.
 */
function writeSmartTuDerivative(dir, byRoute, genSec) {
  const priorIndex = readExisting(path.join(dir, 'index.json'));
  if (priorIndex && Array.isArray(priorIndex.routes)) {
    for (const r of priorIndex.routes) {
      const rid = r && r.route_id ? String(r.route_id) : '';
      if (rid && !byRoute.has(rid)) byRoute.set(rid, []);
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  const routeIds = [...byRoute.keys()].sort();
  const wanted = new Set();
  const indexRoutes = [];
  let totalBytes = 0;
  let totalTrips = 0;
  for (const rid of routeIds) {
    const tripsArr = byRoute.get(rid);
    const body = { v: 1, gen: genSec, route_id: rid, source_ok: true, trips: tripsArr };
    const text = JSON.stringify(body) + '\n';
    const fname = smartTuFileName(rid);
    wanted.add(fname);
    fs.writeFileSync(path.join(dir, fname), text);
    const bytes = Buffer.byteLength(text);
    indexRoutes.push({ route_id: rid, bytes, trips: tripsArr.length });
    totalBytes += bytes;
    totalTrips += tripsArr.length;
  }
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json') && f !== 'index.json' && !wanted.has(f)) {
      fs.unlinkSync(path.join(dir, f));
    }
  }
  const indexBody = { v: 1, gen: genSec, source_ok: true, routes: indexRoutes };
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(indexBody) + '\n');
  return { routes: routeIds.length, trips: totalTrips, bytes: totalBytes };
}

/* ---------------- vehicle legs (vehicles.js port) ---------------- */

async function pollDdot(nowIso) {
  if (!DDOT_KEY) {
    return {
      vehicles: [],
      calls: 0,
      state: { ok: false, at: nowIso, reason: 'DDOT_BUSTIME_KEY secret not configured', configured: false },
    };
  }
  const batches = [];
  for (let i = 0; i < DDOT_ROUTES.length; i += 10) batches.push(DDOT_ROUTES.slice(i, i + 10));
  const settled = await Promise.allSettled(batches.map((group) => {
    const url = `https://myddotbus.com/bustime/api/v3/getvehicles?key=${encodeURIComponent(DDOT_KEY)}&rt=${encodeURIComponent(group.join(','))}&format=json`;
    return fetchJson(url);
  }));
  const vehicles = [];
  let batchesOk = 0;
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      batchesOk++;
      vehicles.push(...mapDdotVehicles(s.value));
    }
  }
  return {
    vehicles,
    calls: batches.length,
    state: {
      ok: true, at: nowIso, vehicles: vehicles.length,
      batches_ok: batchesOk, batches_failed: settled.length - batchesOk,
    },
  };
}

/* ------------- SMART leg (Swiftly GTFS-RT) -------------
 * Endpoint: https://api.goswift.ly/real-time/<agencyKey>/gtfs-rt-vehicle-positions
 * — Swiftly's documented realtime pattern (agency developer pages,
 * e.g. Marin Transit and SF Bay Ferry, publish the identical shape).
 * Agency key "detroit-smartbus", confirmed by Swiftly's key-issuance
 * email (Technical Support, 2026-10-15), which also enables the
 * trip-updates endpoint (NOT integrated — this leg consumes vehicle
 * positions only) and states the usage limit below. History: the leg
 * originally shipped with the conventional slug "smart";
 * unauthenticated probes could not verify any slug (api.goswift.ly's
 * auth layer answers 401 for every agency slug before route
 * resolution), and the genuine key scored 403 on the "smart" path
 * because that is not the agency this key authorizes. SMART_VP_URL
 * overrides the URL without a code change.
 *
 * Volume: one request per 5-minute build cycle = 12 requests/hour.
 * Swiftly's issuance terms state a maximum of 180 requests per
 * 15 minutes (720/hour), so the leg runs at ~1.7% of the limit;
 * §4(vii) additionally prohibits usage Swiftly deems excessive or
 * abusive. A single fixed-cadence request per cycle — never per
 * visitor — is the conservative shape.
 *
 * Honesty: mapGtfsRtVehicles returns [] both for a genuinely empty
 * feed and for undecodable bytes, so the leg first checks the payload
 * IS a GTFS-RT FeedMessage (header field present). An auth rejection,
 * an HTTP error, or a non-GTFS-RT body surfaces as an { ok:false }
 * source state with the reason — never as a silent zero presented as
 * ok (the DDOT vehicles-leg masking defect is the counterexample this
 * guard exists against). A decodable feed with zero vehicle entities
 * is a genuine zero and reports ok with vehicles: 0.
 */

function gtfsRtFeedShape(buffer) {
  let header = false;
  let entities = 0;
  for (const [no, val] of protoFields(buffer)) {
    if (no === 1 && val.wire === 2) header = true;
    else if (no === 2 && val.wire === 2) entities++;
  }
  return { header, entities };
}

async function pollSmart(nowIso) {
  // Called ONLY when SWIFTLY_KEY is non-empty (main gates on key
  // presence), so the dormant state performs zero network calls.
  try {
    const buf = await fetchBufferSwiftly(SMART_VP_URL, SWIFTLY_KEY);
    let shape;
    try {
      shape = gtfsRtFeedShape(buf);
    } catch (e) {
      shape = null;
    }
    if (!shape || !shape.header) {
      return {
        vehicles: [],
        state: { ok: false, at: nowIso, reason: 'Swiftly SMART feed: response was not a GTFS-RT FeedMessage' },
      };
    }
    const vehicles = mapGtfsRtVehicles(buf, nowIso, 'smart');
    return { vehicles, state: { ok: true, at: nowIso, vehicles: vehicles.length } };
  } catch (err) {
    return { vehicles: [], state: { ok: false, at: nowIso, reason: `Swiftly SMART feed: ${err.message}` } };
  }
}

/* SMART trip-updates leg (deployed 2026-10-17).
 * Endpoint: https://api.goswift.ly/real-time/<agencyKey>/gtfs-rt-trip-updates
 * — the same Swiftly pattern as the positions leg, on the second
 * endpoint the 2026-10-15 issuance enabled. One request per cycle,
 * gated on SWIFTLY_KEY exactly like pollSmart; the two legs together
 * stay at 6 requests per 15 minutes against the 180 limit. Failure
 * honesty mirrors pollSmart: a non-GTFS-RT body or an HTTP/auth error
 * is an { ok:false } source state with the reason, never a silent
 * zero. The normalized trips go ONLY to the trip-updates display
 * payload — never into vehicles.json, the telemetry path, or any
 * computation input. */
async function pollSmartTripUpdates(nowIso) {
  // Called ONLY when SWIFTLY_KEY is non-empty (main gates on key
  // presence), so the dormant state performs zero network calls.
  try {
    const buf = await fetchBufferSwiftly(SMART_TU_URL, SWIFTLY_KEY);
    let shape;
    try {
      shape = gtfsRtFeedShape(buf);
    } catch (e) {
      shape = null;
    }
    if (!shape || !shape.header) {
      return {
        trips: [],
        state: { ok: false, at: nowIso, reason: 'Swiftly SMART trip updates: response was not a GTFS-RT FeedMessage' },
      };
    }
    const trips = mapGtfsRtTripUpdates(buf, nowIso);
    return { trips, state: { ok: true, at: nowIso, trips: trips.length } };
  } catch (err) {
    return { trips: [], state: { ok: false, at: nowIso, reason: `Swiftly SMART trip updates: ${err.message}` } };
  }
}

async function pollQline(nowIso) {
  try {
    const buf = await fetchBuffer(QLINE_VP_URL);
    const vehicles = mapGtfsRtVehicles(buf, nowIso, 'qline').map((v) => ({ ...v, route_id: 'QLINE' }));
    return { vehicles, state: { ok: true, at: nowIso, vehicles: vehicles.length } };
  } catch (err) {
    return { vehicles: [], state: { ok: false, at: nowIso, reason: err.message } };
  }
}

/* ---------------- alerts (alerts.js + alerts-map.js ports) ---------------- */

function asArray(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function strList(v, key) {
  return asArray(v)
    .map((e) => {
      if (e === null || e === undefined) return '';
      if (typeof e === 'object') return String(e[key] ?? e.id ?? '');
      return String(e);
    })
    .map((s) => s.trim())
    .filter(Boolean);
}

function cleanText(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

function ddotBulletinError(json) {
  try {
    const errs = json && json['bustime-response'] && json['bustime-response'].error;
    if (!Array.isArray(errs) || !errs.length) return null;
    return errs.map((e) => String((e && e.msg) || '')).filter(Boolean).join('; ') || 'BusTime error';
  } catch {
    return null;
  }
}

function mapDdotBulletins(json, nowIso) {
  try {
    const root = json && json['bustime-response'];
    const list = asArray(root && root.sb);
    const out = [];
    for (const sb of list) {
      if (!sb || typeof sb !== 'object') continue;
      const header = cleanText(sb.sbnm);
      const description = cleanText(sb.sbdt) || cleanText(sb.brf);
      let id = String(sb.sbid ?? '').trim();
      if (!id) {
        if (!header && !description) continue;
        id = 'ddot-' + createHash('sha1').update(header + '|' + String(sb.dt || '')).digest('hex').slice(0, 10);
      }
      out.push({
        id,
        agency: 'ddot',
        header: header || 'DDOT service bulletin',
        description,
        effect: null,
        cause: null,
        active_period: { start: toIsoBusTime(sb.dt), end: null },
        routes: strList(sb.rt, 'rt'),
        stops: strList(sb.stpid, 'stpid'),
        url: null,
        source: 'bustime',
        fetched_at: nowIso,
        kind: 'realtime',
      });
    }
    return out;
  } catch {
    return [];
  }
}

function mergeDdotBulletins(payloads, nowIso) {
  const byId = new Map();
  for (const payload of asArray(payloads)) {
    for (const rec of mapDdotBulletins(payload, nowIso)) {
      const prev = byId.get(rec.id);
      if (!prev) {
        byId.set(rec.id, rec);
        continue;
      }
      prev.routes = [...new Set([...prev.routes, ...rec.routes])];
      prev.stops = [...new Set([...prev.stops, ...rec.stops])];
    }
  }
  return [...byId.values()];
}

function buildDdotBulletinsUrl(key, route) {
  return `https://myddotbus.com/bustime/api/v3/getservicebulletins?key=${encodeURIComponent(key)}&rt=${encodeURIComponent(route)}&format=json`;
}

const DDOT_BULLETIN_CHUNK = 8;
const DDOT_BULLETIN_TIMEOUT_MS = 4000;
const NO_BULLETINS_RE = /no (service )?bulletins|no data/i;

async function collectDdotBulletins(fetchRoute) {
  const payloads = [];
  const failures = [];
  let calls = 0;
  for (let i = 0; i < DDOT_ROUTES.length; i += DDOT_BULLETIN_CHUNK) {
    const chunk = DDOT_ROUTES.slice(i, i + DDOT_BULLETIN_CHUNK);
    const results = await Promise.all(chunk.map(async (rt) => {
      calls++;
      try {
        return { rt, json: await fetchRoute(rt) };
      } catch (e) {
        return { rt, failure: e.message };
      }
    }));
    for (const r of results) {
      if (r.failure) {
        failures.push(r);
        continue;
      }
      const err = ddotBulletinError(r.json);
      if (err && !NO_BULLETINS_RE.test(err)) {
        failures.push({ rt: r.rt, failure: err });
        continue;
      }
      payloads.push(r.json);
    }
  }
  return { payloads, failures, total: DDOT_ROUTES.length, calls };
}

function ddotCollectedState(base, { payloads, failures, total }, nowIso) {
  if (total > 0 && failures.length === total) {
    return { alerts: [], state: { ...base, ok: false, status: 'error', alerts: 0, reason: failures[0].failure } };
  }
  const alerts = mergeDdotBulletins(payloads, nowIso);
  return { alerts, state: { ...base, ok: true, status: 'ok', alerts: alerts.length } };
}

async function pollDdotAlerts(nowIso) {
  const base = { agency: 'ddot', kind: 'realtime', via: 'bustime', fetched_at: nowIso };
  try {
    if (!DDOT_KEY) {
      return {
        alerts: [],
        calls: 0,
        state: { ...base, ok: false, status: 'error', alerts: 0, reason: 'DDOT_BUSTIME_KEY secret not configured', configured: false },
      };
    }
    const collected = await collectDdotBulletins(
      (rt) => fetchJson(buildDdotBulletinsUrl(DDOT_KEY, rt), DDOT_BULLETIN_TIMEOUT_MS)
    );
    return { ...ddotCollectedState(base, collected, nowIso), calls: collected.calls };
  } catch (e) {
    return { alerts: [], calls: 0, state: { ...base, ok: false, status: 'error', alerts: 0, reason: e.message } };
  }
}

/* ---------------- materiality + write ---------------- */

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'at' || k === 'fetched_at' || k === 'generated_at') continue;
      out[k] = stripVolatile(v);
    }
    return out;
  }
  return value;
}

function readExisting(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Write `body` to `file` only on material change or heartbeat expiry.
 *  Returns 'written' or 'unchanged'. */
function writeIfChanged(file, body) {
  const existing = readExisting(file);
  if (existing) {
    const same = JSON.stringify(stripVolatile(existing)) === JSON.stringify(stripVolatile(body));
    const genAt = Date.parse(existing.generated_at || '');
    const fresh = Number.isFinite(genAt) && Date.now() - genAt < HEARTBEAT_MS;
    if (same && fresh) return 'unchanged';
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
  return 'written';
}

/* ------------- bulletin sub-cadence (hourly, 2026-10-15) -------------
 * DDOT bulletins change rarely, and the BusTime daily transaction cap
 * (10,000/day per the BusTime v3 developer guide) makes 37
 * getservicebulletins calls per 5-minute cycle — ~10,700 calls/day on
 * that leg alone — unsustainable; the cap was exhausted on 2026-10-15
 * ("Transaction limit for current day has been exceeded."). Bulletin
 * collection therefore runs at most once per BULLETIN_REUSE_MS:
 *
 * Each run reads the previously committed alerts.json (the workflow
 * checks out the repo, so the prior file is on disk at OUT_DIR). If
 * its DDOT bulletin source state's fetched_at is younger than the
 * window, the prior alerts[] and sources[] are reused VERBATIM and
 * zero getservicebulletins calls are made. Otherwise bulletins are
 * fetched fresh, exactly as before.
 *
 * Reuse applies to whatever the prior state is, success or error: a
 * BusTime error state (e.g. the exhausted daily cap) also settles for
 * the window, because retrying 37 failing calls every 5 minutes only
 * deepens the burn while the cap is down. The error reason stays
 * published in the reused sources[] meanwhile, so the page keeps
 * naming the state honestly.
 *
 * Timestamp honesty: a reuse cycle emits the prior generated_at too,
 * so the file stays byte-stable — old bulletins are never presented
 * as newly fetched, sources[].fetched_at is untouched, and the
 * workflow's material-change logic sees no alerts.json change (no
 * empty commits). Consequently alerts.json gets no 30-minute
 * heartbeat rewrite of its own: its generated_at advances only when
 * bulletins are actually re-collected (~hourly), which is the true
 * statement of the data's freshness; the sources state the page
 * renders carries fetched_at either way. vehicles.json keeps its
 * existing heartbeat semantics unchanged.
 *
 * A key-presence transition invalidates reuse: if the prior state was
 * the not-configured state and a key is present now (or vice versa),
 * the new configuration must take effect on this run, not after the
 * window — a freshly placed DDOT_BUSTIME_KEY secret publishes DDOT
 * bulletins on the very next cycle.
 */
const BULLETIN_REUSE_MS = 55 * 60 * 1000;

function priorDdotBulletinState(prior) {
  if (!prior || !Array.isArray(prior.sources)) return null;
  const s = prior.sources.find((x) => x && x.agency === 'ddot' && x.kind === 'realtime');
  return s && typeof s.fetched_at === 'string' ? s : null;
}

/**
 * Decide whether the prior committed alerts.json may be carried
 * forward untouched. Pure in (prior, keyPresent, nowMs) so the rule
 * is unit-testable without the network. Returns { reuse:false } or
 * { reuse:true, body } where body is the prior envelope verbatim.
 */
function ddotBulletinsReusable(prior, { keyPresent, nowMs }) {
  const state = priorDdotBulletinState(prior);
  if (!state || !Array.isArray(prior.alerts)) return { reuse: false };
  const fetchedMs = Date.parse(state.fetched_at);
  if (!Number.isFinite(fetchedMs)) return { reuse: false };
  const priorNotConfigured = state.configured === false;
  if (priorNotConfigured === keyPresent) return { reuse: false };
  if (nowMs - fetchedMs >= BULLETIN_REUSE_MS) return { reuse: false };
  return {
    reuse: true,
    body: {
      generated_at: prior.generated_at,
      count: prior.count,
      alerts: prior.alerts,
      sources: prior.sources,
    },
  };
}

/* ---------------- main ---------------- */

async function main() {
  const nowIso = new Date().toISOString();
  const alertsPath = path.join(OUT_DIR, 'alerts.json');
  const reuse = ddotBulletinsReusable(readExisting(alertsPath), {
    keyPresent: Boolean(DDOT_KEY),
    nowMs: Date.now(),
  });

  const smartActive = Boolean(SWIFTLY_KEY);
  const [ddot, qline, ddotAlerts, smart, smartTu] = await Promise.all([
    pollDdot(nowIso),
    pollQline(nowIso),
    reuse.reuse
      ? { alerts: reuse.body.alerts, calls: 0, state: priorDdotBulletinState(reuse.body) }
      : pollDdotAlerts(nowIso),
    // Dormant gate: no key -> no promise, no network call, and
    // sources.smart below stays the removed state verbatim, so every
    // output file is byte-identical to the pre-SMART-leg builder.
    smartActive ? pollSmart(nowIso) : Promise.resolve(null),
    // Same dormant gate for the trip-updates leg.
    smartActive ? pollSmartTripUpdates(nowIso) : Promise.resolve(null),
  ]);

  const vehiclesBody = {
    generated_at: nowIso,
    count: ddot.vehicles.length + qline.vehicles.length,
    vehicles: [...ddot.vehicles, ...qline.vehicles],
    sources: {
      ddot: ddot.state,
      // Display-only (§4(vi)): SMART vehicles are NEVER merged into
      // this file. With a key present, sources.smart reports the
      // display leg's own state (same shape family as the other legs);
      // without one it is the removed state, byte-identical to before.
      smart: smartActive
        ? smart.state
        : { ok: false, removed: true, at: nowIso, reason: SMART_REMOVED_REASON },
      qline: qline.state,
    },
  };
  const alertsBody = reuse.reuse
    ? reuse.body
    : {
        generated_at: nowIso,
        count: ddotAlerts.alerts.length,
        alerts: ddotAlerts.alerts,
        sources: [ddotAlerts.state],
      };

  const v = writeIfChanged(path.join(OUT_DIR, 'vehicles.json'), vehiclesBody);
  const a = reuse.reuse ? 'unchanged' : writeIfChanged(alertsPath, alertsBody);

  /* SMART display payload — written only while the leg is active.
   * Envelope mirrors vehicles.json (generated_at, count, vehicles)
   * plus the leg's own source state under `source`. Same write policy
   * (material change or 30-minute heartbeat). When the key is absent
   * the payload must not exist: if a previous active era left one in
   * the checkout, delete it so the workflow commit removes it from
   * the served site — Swiftly Content stops being served the cycle
   * the key is withdrawn (license §14 posture). */
  const smartDisplayPath = path.join(OUT_DIR, 'smart-display.json');
  let smartNote;
  if (smartActive) {
    const displayBody = {
      generated_at: nowIso,
      count: smart.vehicles.length,
      vehicles: smart.vehicles,
      source: smart.state,
    };
    const s = writeIfChanged(smartDisplayPath, displayBody);
    smartNote = `smart-display.json: ${s} (smart=${smart.vehicles.length} ok=${smart.state.ok})`;
  } else {
    if (fs.existsSync(smartDisplayPath)) fs.unlinkSync(smartDisplayPath);
    smartNote = 'smart-display.json: not written (SWIFTLY_KEY not set; leg dormant)';
  }

  /* SMART trip-updates display payload (deployed 2026-10-17) — same posture as
   * the positions display payload: written only while the key is
   * active, under its own envelope ({generated_at, count, trips,
   * source}), deleted when the key is withdrawn. It is a separate
   * file: vehicles.json above is byte-for-byte the pre-candidate
   * composition, and nothing in this block feeds it. */
  const smartTuPath = path.join(OUT_DIR, 'smart-trip-updates.json');
  let smartTuNote;
  if (smartActive) {
    const tuBody = {
      generated_at: nowIso,
      count: smartTu.trips.length,
      trips: smartTu.trips,
      source: smartTu.state,
    };
    const s2 = writeIfChanged(smartTuPath, tuBody);
    smartTuNote = `smart-trip-updates.json: ${s2} (trips=${smartTu.trips.length} ok=${smartTu.state.ok})`;
  } else {
    if (fs.existsSync(smartTuPath)) fs.unlinkSync(smartTuPath);
    smartTuNote = 'smart-trip-updates.json: not written (SWIFTLY_KEY not set; leg dormant)';
  }

  /* SMART trip-updates watch derivative (Project 29 item 4,
   * 2026-10-19) — per-route trimmed files under live-data/smart-tu/
   * plus index.json, derived in THIS run from the same normalized
   * trips written above (no extra fetch). Posture mirrors the
   * trip-updates payload, with one deliberate difference: when the
   * trip-updates leg FAILS on a cycle, the derivative is left
   * untouched rather than republished empty — empty files would
   * claim "no service" for what is a fetch failure, while a frozen
   * gen is honest and the watch's age rules retire the data on
   * schedule. When the key is withdrawn the whole directory is
   * deleted, exactly like the payloads above. */
  const smartTuDir = path.join(OUT_DIR, 'smart-tu');
  let smartTuDerivNote;
  if (smartActive && smartTu.state.ok) {
    const genSec = Math.floor(Date.parse(nowIso) / 1000);
    const summary = writeSmartTuDerivative(smartTuDir, buildSmartTuDerivative(smartTu.trips, genSec), genSec);
    smartTuDerivNote = `smart-tu/: ${summary.routes} route files (${summary.trips} windowed trips, ${summary.bytes} B) + index.json`;
  } else if (smartActive) {
    smartTuDerivNote = 'smart-tu/: left unchanged (Swiftly trip-updates leg failed this cycle)';
  } else {
    if (fs.existsSync(smartTuDir)) fs.rmSync(smartTuDir, { recursive: true, force: true });
    smartTuDerivNote = 'smart-tu/: not written (SWIFTLY_KEY not set; leg dormant)';
  }

  console.log(`vehicles.json: ${v} (ddot=${ddot.vehicles.length} ok=${ddot.state.ok}, qline=${qline.vehicles.length} ok=${qline.state.ok})`);
  console.log(`alerts.json: ${a} (ddot alerts=${ddotAlerts.alerts.length} ok=${ddotAlerts.state.ok})`);
  console.log(smartNote);
  console.log(smartTuNote);
  console.log(smartTuDerivNote);
  console.log(
    `bustime calls: vehicles=${ddot.calls} bulletins=${ddotAlerts.calls}` +
      (reuse.reuse
        ? ` (reused, fetched_at=${ddotAlerts.state.fetched_at})`
        : ' (bulletins fetched fresh)')
  );
}

export { collectDdotBulletins, ddotBulletinsReusable, gtfsRtFeedShape, pollSmart, pollSmartTripUpdates, mapGtfsRtTripUpdates, trimSmartTuTrip, buildSmartTuDerivative, writeSmartTuDerivative, main };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('build-feed failed:', e);
    process.exit(1);
  });
}
