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
 *
 * Keyless split modes (Project 30 Phase 4 revision, 2026-10-19 — the
 * API keys never leave GitHub Actions; the transform half runs on the
 * VM with no keys and makes zero source calls):
 *      FEED_COLLECT_DIR (collect mode): instead of building, perform
 *      ONLY the source fetches (DDOT BusTime vehicles + bulletins,
 *      QLINE, Swiftly VP + TU) and write the RAW payloads, with fetch
 *      outcomes and timestamps, as a versioned bundle in this dir
 *      (feed-raw-bundle/v1; bundle.json manifest written last). Runs
 *      in Actions under feed-collect.yml, which commits the bundle to
 *      the feed-raw orphan branch. FEED_PREV_BUNDLE_DIR points at the
 *      previous bundle (its manifest drives the bulletin sub-cadence:
 *      bulletins are fetched fresh at most once per BULLETIN_REUSE_MS,
 *      exactly as the live build's reuse rule — the draw REPLACES the
 *      live build's fetches, never adds to them).
 *      FEED_REPLAY_DIR (replay mode): build from a collected bundle
 *      instead of the network. Every poll leg reads its payloads from
 *      the bundle; the run's anchor time (generated_at, source `at`,
 *      fetched_at) is the bundle's collected_at, so rider-visible
 *      freshness is anchored to the true fetch instant. Transforms,
 *      envelopes, source states, write policy and the SMART
 *      delete-on-key-withdrawal lifecycle are byte-identical to a
 *      live run over the same payloads (proven by the Project 30
 *      fixture harness). With neither var set, behavior is the
 *      original live build, unchanged — live-feed.yml remains the
 *      manual fallback on exactly this code path.
 *
 * FULL INTEGRATION (2026-11-11, owner directive 12:26 EST): SMART is
 * fully integrated — the display-only posture narrated above is
 * superseded. SMART vehicles merge into vehicles.json with full
 * attribution (route, trip, direction, destination); SMART trip
 * updates feed computation (adherence.json, delay estimates); an
 * accuracy layer (track state, filters, stop-serving detection)
 * covers every agency. See the FULL INTEGRATION section in the body.
 * smart-display.json keeps publishing through the consumer migration
 * as a compatibility copy; its removal is a later, verified step.
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

/* ------------- keyless split modes (Project 30, see header) ------------- */

const COLLECT_DIR = process.env.FEED_COLLECT_DIR || '';
const REPLAY_DIR = process.env.FEED_REPLAY_DIR || '';

/** Replay bundle, loaded once at startup when FEED_REPLAY_DIR is set.
 *  The publisher verifies every payload's sha256 against the manifest
 *  before invoking this script; the transform trusts the directory. */
let REPLAY = null;
if (REPLAY_DIR) {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPLAY_DIR, 'bundle.json'), 'utf8'));
  if (manifest.kind !== 'feed-raw-bundle/v1' || typeof manifest.collected_at !== 'string') {
    throw new Error(`FEED_REPLAY_DIR: ${REPLAY_DIR}/bundle.json is not a feed-raw-bundle/v1 manifest`);
  }
  REPLAY = {
    dir: REPLAY_DIR,
    collected_at: manifest.collected_at,
    ddot: manifest.ddot || { configured: false },
    qline: manifest.qline || { ok: false, error: 'bundle manifest has no qline entry' },
    smart: manifest.smart || { active: false },
  };
}

function replayPayloadBytes(rel) {
  return fs.readFileSync(path.join(REPLAY.dir, rel));
}

function replayPayloadJson(rel) {
  return JSON.parse(replayPayloadBytes(rel).toString('utf8'));
}

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

/* Collect-mode raw fetches: same HTTP-error message shape as the live
 * helpers above (so a recorded error replays into the identical source
 * state), but the body is kept as raw bytes for the bundle. The JSON
 * variant additionally validates that the body parses — a body that
 * fails to parse is recorded as a fetch failure carrying the parser's
 * own message, exactly what the live legs see from res.json(). */
async function fetchRawBuffer(url, timeoutMs = 15000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.split('?')[0]}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchRawBufferSwiftly(url, key, timeoutMs = 15000) {
  const res = await fetch(url, {
    headers: { Authorization: key },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.split('?')[0]}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchRawJson(url, timeoutMs = 15000) {
  const buf = await fetchRawBuffer(url, timeoutMs);
  JSON.parse(buf.toString('utf8')); // validate only; raw bytes are stored
  return buf;
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

/* withTrip (stop-card Option A, Justin's decision 2026-10-21): the
 * SMART display payload additionally carries each vehicle's trip_id
 * and direction_id, restored from the GTFS-RT TripDescriptor the
 * decoder already parses. The page joins trip_id to the agency GTFS
 * headsign map (live-data/smart-headsigns.json) so SMART stop-card
 * rows can name their direction and group by route + headsign. The
 * fields ride ONLY on the SMART display payload: the QLINE call sites
 * below do not pass withTrip, so vehicles.json stays byte-identical,
 * and nothing here feeds vehicles.json, telemetry, or any computation
 * path — display-only, exactly like the rest of the SMART leg. */
function mapGtfsRtVehicles(buffer, nowIso, agency, withTrip) {
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
        ...(withTrip ? {
          trip_id: String((vp.trip && vp.trip.tripId) || ''),
          direction_id: vp.trip && vp.trip.directionId !== undefined ? Number(vp.trip.directionId) : null,
        } : {}),
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

function trimSmartTuTrip(t, genSec, delayMap) {
  const ups = [];
  for (const u of t.stop_time_updates || []) {
    if (!u.stop_id || u.schedule_relationship === 'SKIPPED') continue;
    const ts = u.departure_time ?? u.arrival_time;
    if (ts === null || ts === undefined) continue;
    if (ts < genSec - SMART_TU_WINDOW_BEHIND_S || ts > genSec + SMART_TU_WINDOW_AHEAD_S) continue;
    const delay = u.departure_delay_sec ?? u.arrival_delay_sec
      ?? (delayMap && delayMap.has(String(u.stop_id)) ? delayMap.get(String(u.stop_id)) : null);
    ups.push([String(u.stop_id), ts, delay]);
  }
  if (!ups.length) return null;
  const tuple = [String(t.trip_id || ''), String(t.route_id || ''), t.direction_id ?? null, ups];
  if (t.schedule_relationship && t.schedule_relationship !== 'SCHEDULED') tuple.push(t.schedule_relationship);
  return tuple;
}

/** route_id -> windowed trimmed trip tuples (possibly an empty list
 *  for a route present in the payload with no in-window updates). */
function buildSmartTuDerivative(trips, genSec, delaysByTrip) {
  const byRoute = new Map();
  for (const t of trips) {
    const rid = String(t.route_id || '');
    if (!rid) continue;
    if (!byRoute.has(rid)) byRoute.set(rid, []);
    const tuple = trimSmartTuTrip(t, genSec, delaysByTrip ? delaysByTrip.get(t.trip_id) : null);
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

/* ------------- FULL INTEGRATION + ACCURACY REFINEMENT -------------
 * Owner directive 2026-11-11 12:26 EST ("FULL INTEGRATION"),
 * superseding the 2026-11-07 display-only fence and the §4(vi)
 * display-only posture recorded in the sections above: SMART vehicles
 * are merged into vehicles.json with full attribution, SMART trip
 * updates become a computation input (adherence + estimates), and an
 * accuracy layer (per-vehicle track state, filters, smoothing inputs,
 * stop-serving detection) applies to every agency.
 *
 * Static extracts (seeded files in OUT_DIR, built by
 * tools/feed/build-extracts.py from the agencies' published GTFS;
 * provenance + feed versions recorded inside each file):
 *   smart-headsigns.json        trip_id -> headsign (+ route|dir fallback)
 *   smart-schedule-extract.json trip_id -> scheduled departure seconds
 *   ddot-patterns.json          route+direction -> ordered stop geometry
 * Every join degrades independently when its extract is absent: no
 * destination, no delay, no detection — never a failed build.
 *
 * Track state (live-data/track-state.json, seeded + rewritten each
 * cycle): the builder is otherwise stateless per cycle; the state
 * file carries each vehicle's recent samples so filters judge motion
 * across samples, never from a single snapshot. Filters ANNOTATE
 * (quality, age_sec) — a vehicle's published position is the feed's
 * own; only the adherence/detection computations consume the cleaned
 * track. Quality values: ok | held-teleport | speed-mismatch |
 * stale-sample | stale-ts.
 *
 * Adherence (live-data/adherence.json):
 *   SMART — delay computed exactly: Swiftly TU predicted departure
 *     minus the GTFS-static scheduled departure for the same
 *     (trip_id, stop_id), anchored on the TU start_date. Method
 *     'tu-static-join' — a computation, not an inference.
 *   DDOT — the BusTime feed carries no trip_id, so delay is NOT
 *     computed here; the board (which holds the full timetable)
 *     labels inferred delay. This layer contributes what only a
 *     track can prove: stop-serving detection. A stop bracketed by a
 *     vehicle's on-pattern samples with no dwell sample inside the
 *     dwell radius is recorded as a missed stop (method
 *     'track-dwell', explicitly inferred) with the vehicle's run key.
 *     The acceptance case is DDOT 10 vehicle 2224 passing
 *     Greenfield & Warren unserved on 2026-11-11 (~12:11 EST).
 */

const DETROIT_TZ = 'America/Detroit';
const _detroitDtf = new Intl.DateTimeFormat('en-US', {
  timeZone: DETROIT_TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function detroitOffsetSec(epochSec) {
  const parts = {};
  for (const p of _detroitDtf.formatToParts(new Date(epochSec * 1000))) parts[p.type] = p.value;
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) / 1000;
  return asUTC - epochSec;
}

/** Epoch seconds of Detroit-local midnight on a GTFS date (YYYYMMDD). */
function detroitMidnightEpochSec(ymd) {
  const y = +ymd.slice(0, 4), m = +ymd.slice(4, 6), d = +ymd.slice(6, 8);
  let guess = Date.UTC(y, m - 1, d) / 1000;
  for (let i = 0; i < 3; i++) guess = Date.UTC(y, m - 1, d) / 1000 - detroitOffsetSec(guess);
  return guess;
}

/** Epoch seconds for a feed updated_at. GTFS-RT legs carry Z-suffixed
 * ISO (true epochs). The DDOT BusTime mapper emits NAIVE Detroit-local
 * ISO (toIsoBusTime: "agency local, America/Detroit", no designator) —
 * parsing that as UTC would age every DDOT sample by the zone offset
 * (~5 h). Naive values are therefore read as Detroit wall time. */
function feedEpochSec(s) {
  if (!s) return NaN;
  const str = String(s);
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(str)) return Math.floor(Date.parse(str) / 1000);
  const ms = Date.parse(str);
  if (!Number.isFinite(ms)) return NaN;
  const naiveSec = Math.floor(ms / 1000);
  return naiveSec - detroitOffsetSec(naiveSec);
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180, dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* SMART vehicle finalization: destination from the headsign extract
 * (VP trip first, then the vehicle's TU trip, then the route|direction
 * dominant headsign); missing VP attribution is adopted from the
 * vehicle's TU trip where the TU carries it. VP route wins over TU
 * route on disagreement (the position's own descriptor is primary;
 * disagreements are counted in the run log by the caller).
 * ER-FIX-FEED-01 (2026-11-13): when the headsign extract has no entry
 * for an attributed route, the destination falls back to the route's
 * GTFS routes.txt name from route-meta.json (long name, else short
 * name) rather than shipping the vehicle with no display value. The
 * meta is GTFS-derived at extract time (tools/feed/
 * build-smart-extracts.py) — no hand-maintained route lists. */
function finalizeSmartVehicles(smartVehicles, smartTrips, headsigns, routeMeta) {
  const byTrip = (headsigns && headsigns.by_trip) || {};
  const byRouteDir = (headsigns && headsigns.by_route_dir) || {};
  const metaRoutes = (routeMeta && routeMeta.smart && routeMeta.smart.routes) || {};
  const tuByVehicle = new Map();
  for (const t of smartTrips || []) {
    if (!t.vehicle_id) continue;
    const ex = tuByVehicle.get(t.vehicle_id);
    if (!ex || String(t.updated_at) > String(ex.updated_at)) tuByVehicle.set(t.vehicle_id, t);
  }
  return smartVehicles.map((v) => {
    const out = { ...v };
    const tu = tuByVehicle.get(v.vehicle_id);
    if (tu) {
      if (!out.trip_id && tu.trip_id) out.trip_id = tu.trip_id;
      if (!out.route_id && tu.route_id) out.route_id = tu.route_id;
      if ((out.direction_id === null || out.direction_id === undefined)
        && tu.direction_id !== null && tu.direction_id !== undefined) {
        out.direction_id = tu.direction_id;
      }
    }
    let hs = out.trip_id ? byTrip[out.trip_id] : null;
    if (!hs && out.route_id) {
      hs = byRouteDir[`${out.route_id}|${out.direction_id === null || out.direction_id === undefined ? '' : out.direction_id}`];
    }
    if (!hs && out.route_id && metaRoutes[out.route_id]) {
      hs = metaRoutes[out.route_id].long_name || metaRoutes[out.route_id].short_name || null;
    }
    if (hs) out.destination = hs;
    return out;
  });
}

/* ER-FIX-FEED-01 (2026-11-13) — routes_dark + unmatched accounting.
 * routes_dark names every route that has scheduled trips today
 * (GTFS route-meta.json: trips.txt x calendar for the Detroit date),
 * whose service window opened at least 30 minutes ago, and that has
 * NO live vehicle in this cycle. A complete-attribution route whose
 * first departure falls inside the next 300 minutes is also named,
 * with window_source 'gtfs-schedule-inferred'. window_minutes is the elapsed
 * scheduled-service window: first scheduled departure today ->
 * min(now, last scheduled departure today); window_source names its
 * provenance ('gtfs-schedule'). DDOT attribution is complete (every
 * BusTime vehicle carries its route), so a DDOT entry is a proven
 * absence; SMART attribution rides the Swiftly VP TripDescriptor, so
 * a SMART entry is an absence of ATTRIBUTED vehicles and carries
 * attribution_basis 'vp-attributed' to say so. The list ships in
 * vehicles.json so a dark route is a served fact, not a client-side
 * inference (ER-04). */
const DARK_MIN_WINDOW_MIN = 30;
const DARK_INFER_WINDOW_MIN = 300;
const WEEKDAY_IDX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

function detroitToday(nowSec) {
  const parts = {};
  for (const p of _detroitDtf.formatToParts(new Date(nowSec * 1000))) parts[p.type] = p.value;
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: DETROIT_TZ, weekday: 'short' })
    .format(new Date(nowSec * 1000));
  return {
    ymd: `${parts.year}${parts.month}${parts.day}`,
    weekdayIdx: WEEKDAY_IDX[wd],
  };
}

function computeRoutesDark(routeMeta, agency, liveCounts, nowSec) {
  const meta = routeMeta && routeMeta[agency];
  if (!meta || !meta.routes || !meta.services || !meta.svc_routes) return [];
  const { ymd, weekdayIdx } = detroitToday(nowSec);
  if (weekdayIdx === undefined) return [];
  const midnight = detroitMidnightEpochSec(ymd);
  const today = {};
  for (const [sid, svc] of Object.entries(meta.services)) {
    let active = Boolean(svc.days && svc.days[weekdayIdx])
      && (!svc.start || svc.start <= ymd) && (!svc.end || ymd <= svc.end);
    if ((svc.add || []).includes(ymd)) active = true;
    if ((svc.remove || []).includes(ymd)) active = false;
    if (!active) continue;
    for (const [rid, cell] of Object.entries(meta.svc_routes[sid] || {})) {
      const e = today[rid] || (today[rid] = { trips: 0, first: Infinity, last: 0 });
      e.trips += cell.trips;
      if (cell.first < e.first) e.first = cell.first;
      if (cell.last > e.last) e.last = cell.last;
    }
  }
  const out = [];
  for (const [rid, e] of Object.entries(today)) {
    if (!e.trips || (liveCounts.get(rid) || 0) > 0) continue;
    const firstEpoch = midnight + e.first;
    const lastEpoch = midnight + e.last;
    const r = meta.routes[rid] || {};
    if (nowSec < firstEpoch) {
      /* Service not yet started. Only a complete-attribution agency
       * may name a route here, and only when its first departure
       * falls inside the standing 300-minute observation window:
       * the entry is an inference from the schedule, and says so in
       * window_source (the ER-04 diagnostic's 'inferred window'). */
      if (agency !== 'ddot') continue;
      if (firstEpoch - nowSec > DARK_INFER_WINDOW_MIN * 60) continue;
      out.push({
        agency,
        route_id: rid,
        route_short_name: r.short_name || rid,
        route_long_name: r.long_name || '',
        trips_today: e.trips,
        window_minutes: DARK_INFER_WINDOW_MIN,
        window_source: 'gtfs-schedule-inferred',
        attribution_basis: 'complete',
      });
      continue;
    }
    const windowMinutes = Math.floor((Math.min(nowSec, lastEpoch) - firstEpoch) / 60);
    if (windowMinutes < DARK_MIN_WINDOW_MIN) continue;
    out.push({
      agency,
      route_id: rid,
      route_short_name: r.short_name || rid,
      route_long_name: r.long_name || '',
      trips_today: e.trips,
      window_minutes: windowMinutes,
      window_source: 'gtfs-schedule',
      attribution_basis: agency === 'ddot' ? 'complete' : 'vp-attributed',
    });
  }
  out.sort((a, b) => a.route_id.localeCompare(b.route_id, undefined, { numeric: true }));
  return out;
}

function routeCounts(vehicles) {
  const m = new Map();
  for (const v of vehicles || []) {
    if (v.route_id) m.set(String(v.route_id), (m.get(String(v.route_id)) || 0) + 1);
  }
  return m;
}

/* Unmatched-vehicle alarm (ER-FIX-FEED-01 standing alarm): a vehicle
 * with no route attribution after every honest join is counted per
 * agency every cycle; above 2 the count ships as a NAMED warning in
 * the run log (::warning:: line, forwarded by feed-publisher.py) and
 * as sources.<agency>.unmatched in vehicles.json — never silently. */
const UNMATCHED_ALARM_THRESHOLD = 2;

function unmatchedCount(vehicles) {
  return (vehicles || []).filter((v) => !v.route_id).length;
}

/* SMART delay per (trip, stop): TU predicted departure epoch minus
 * (Detroit midnight of the TU start_date + GTFS scheduled departure
 * seconds). Returns Map trip_id -> Map stop_id -> delay seconds.
 * Trips the extract does not know, or without a start_date, are
 * absent — unknown, never zero-filled. */
function computeSmartTripDelays(smartTrips, sched) {
  const out = new Map();
  if (!sched || !sched.trips) return out;
  const midnightCache = new Map();
  for (const t of smartTrips || []) {
    const sTrip = sched.trips[t.trip_id];
    if (!sTrip || !t.start_date) continue;
    const ymd = String(t.start_date);
    if (!midnightCache.has(ymd)) midnightCache.set(ymd, detroitMidnightEpochSec(ymd));
    const mid = midnightCache.get(ymd);
    const byStop = new Map(sTrip[3].map(([sid, dep]) => [String(sid), dep]));
    const delays = new Map();
    for (const u of t.stop_time_updates || []) {
      const schedSec = byStop.get(String(u.stop_id));
      if (schedSec === undefined) continue;
      const pred = u.departure_time ?? u.arrival_time;
      if (pred === null || pred === undefined) continue;
      delays.set(String(u.stop_id), pred - (mid + schedSec));
    }
    if (delays.size) out.set(t.trip_id, delays);
  }
  return out;
}

/* ---------------- track state + filters + detection ---------------- */

const TRACK_MAX_SAMPLES = 10;
const TRACK_PRUNE_SEC = 20 * 60;
const TRACK_RUN_GAP_SEC = 10 * 60;
const TELEPORT_MPS = 45;              // ~100 mph: impossible for this fleet
const TELEPORT_MIN_DIST_M = 300;
const SPEED_MISMATCH_MPS = 12;
const STALE_SAMPLE_SEC = 300;
const DWELL_RADIUS_M = 60;
const DWELL_MAX_SPEED_MPH = 2;
const SLOWDOWN_RADIUS_M = 150;
const SLOWDOWN_MAX_SPEED_MPH = 3;
const BRACKET_MAX_M = 250;
const MIN_PASS_MPS = 6;
const PATTERN_SNAP_M = 400;
const MISSED_EVENTS_CAP = 100;
const MISSED_EVENT_TTL_SEC = 12 * 3600;

function loadTrackState() {
  const s = readExisting(path.join(OUT_DIR, 'track-state.json'));
  if (s && s.v === 1 && s.vehicles && typeof s.vehicles === 'object') {
    if (!Array.isArray(s.missed_events)) s.missed_events = [];
    return s;
  }
  return { v: 1, generated_at: null, vehicles: {}, missed_events: [] };
}

/** Cumulative arc lengths (m) along a pattern polyline. */
function patternArcs(pattern) {
  const arcs = [0];
  for (let i = 1; i < pattern.length; i++) {
    arcs.push(arcs[i - 1] + haversineM(pattern[i - 1][1], pattern[i - 1][2], pattern[i][1], pattern[i][2]));
  }
  return arcs;
}

/** Project a point onto the pattern polyline: returns {arc, perp} —
 *  distance along the path and perpendicular distance to it. Arc
 *  length (not nearest-stop index) is the progress measure: samples
 *  near a stop quantize to that stop's index, which defeats
 *  index-bracket logic; arc position is continuous. */
function projectToPattern(pattern, arcs, lat, lon) {
  let best = { arc: 0, perp: Infinity };
  for (let i = 0; i < pattern.length - 1; i++) {
    const aLat = pattern[i][1], aLon = pattern[i][2];
    const bLat = pattern[i + 1][1], bLon = pattern[i + 1][2];
    const segLen = arcs[i + 1] - arcs[i];
    // Local equirectangular projection around the segment.
    const kx = 111320 * Math.cos((aLat * Math.PI) / 180), ky = 110540;
    const ax = 0, ay = 0;
    const bx = (bLon - aLon) * kx, by = (bLat - aLat) * ky;
    const px = (lon - aLon) * kx, py = (lat - aLat) * ky;
    const bb = bx * bx + by * by || 1;
    let f = ((px - ax) * bx + (py - ay) * by) / bb;
    f = Math.max(0, Math.min(1, f));
    const dx = px - (ax + f * bx), dy = py - (ay + f * by);
    const perp = Math.sqrt(dx * dx + dy * dy);
    if (perp < best.perp) best = { arc: arcs[i] + f * segLen, perp };
  }
  return best;
}

/** Detect stops a DDOT vehicle passed without dwelling. Mutates the
 *  track entry (emitted set) and returns new event objects. */
function detectMissedStops(entry, vehicle, patterns, nowIso) {
  if (!patterns || !patterns.routes || vehicle.agency !== 'ddot') return [];
  const routePats = patterns.routes[vehicle.route_id];
  if (!routePats || entry.samples.length < 3) return [];
  // Direction: the pattern direction whose along-path arc sequence is
  // the more monotonic-increasing over the on-pattern samples.
  let chosen = null;
  for (const dir of Object.keys(routePats)) {
    const pattern = routePats[dir];
    const arcs = patternArcs(pattern);
    const seq = [];
    for (const s of entry.samples) {
      const pr = projectToPattern(pattern, arcs, s[1], s[2]);
      if (pr.perp <= PATTERN_SNAP_M) seq.push({ t: s[0], arc: pr.arc, lat: s[1], lon: s[2], spd: s[3] });
    }
    if (seq.length < 3) continue;
    let inc = 0;
    for (let j = 1; j < seq.length; j++) if (seq[j].arc >= seq[j - 1].arc - 5) inc++;
    const score = inc / (seq.length - 1);
    if (!chosen || score > chosen.score) chosen = { dir, pattern, arcs, seq, score };
  }
  if (!chosen || chosen.score < 0.8) return [];
  const { pattern, arcs, seq } = chosen;
  const firstArc = seq[0].arc;
  const lastArc = seq[seq.length - 1].arc;
  if (lastArc - firstArc < 200) return [];
  if (!entry.emitted || typeof entry.emitted !== 'object') entry.emitted = {};
  const events = [];
  for (let i = 0; i < pattern.length; i++) {
    const stopArc = arcs[i];
    if (stopArc <= firstArc + 20 || stopArc >= lastArc - 20) continue;
    const stopId = String(pattern[i][0]);
    if (entry.emitted[stopId]) continue;
    const stopLat = pattern[i][1], stopLon = pattern[i][2];
    // Served evidence: a dwell sample close in, or any clear slowdown
    // near the stop. Sampling is ~30 s, so absence of a dwell sample
    // alone proves nothing — a miss is only claimed when the samples
    // bracket the stop DENSELY and the vehicle held speed through it.
    let served = false;
    for (const s of seq) {
      const dStop = haversineM(s.lat, s.lon, stopLat, stopLon);
      if (dStop <= DWELL_RADIUS_M && (s.spd === null || s.spd === undefined || s.spd <= DWELL_MAX_SPEED_MPH)) served = true;
      if (Math.abs(s.arc - stopArc) <= SLOWDOWN_RADIUS_M && s.spd !== null && s.spd !== undefined && s.spd <= SLOWDOWN_MAX_SPEED_MPH) served = true;
    }
    let bracketed = false;
    if (!served) {
      for (let j = 1; j < seq.length; j++) {
        const a = seq[j - 1], b = seq[j];
        // Crossing pair: the stop's arc falls between the two samples
        // (a sample landing ON the stop at speed is itself the
        // pass-through evidence, so no deadband around stopArc).
        if (!(a.arc <= stopArc + 1 && b.arc >= stopArc - 1 && b.arc > a.arc)) continue;
        if (stopArc - a.arc > BRACKET_MAX_M || b.arc - stopArc > BRACKET_MAX_M) continue;
        const dt = b.t - a.t;
        if (dt > 0 && (b.arc - a.arc) / dt >= MIN_PASS_MPS) bracketed = true;
      }
    }
    if (!served && bracketed) {
      entry.emitted[stopId] = nowIso;
      events.push({
        agency: 'ddot',
        route_id: vehicle.route_id,
        direction_id: Number(chosen.dir),
        stop_id: stopId,
        vehicle_id: vehicle.vehicle_id,
        detected_at: nowIso,
        method: 'track-dwell',
        inference: true,
      });
    }
  }
  return events;
}

/** Apply the accuracy layer to one cycle's merged vehicles: annotate
 *  quality/age, update track state, run stop-serving detection.
 *  Mutates `vehicles` records and `state`; returns run statistics. */
function processTracks(vehicles, state, nowSec, nowIso, patterns) {
  const stats = { tracked: 0, teleport: 0, mismatch: 0, stale: 0, missed: 0 };
  const seenKeys = new Set();
  for (const v of vehicles) {
    const key = `${v.agency}:${v.vehicle_id}`;
    seenKeys.add(key);
    const tSec = feedEpochSec(v.updated_at);
    v.age_sec = Number.isFinite(tSec) ? Math.max(0, nowSec - tSec) : null;
    let quality = 'ok';
    let entry = state.vehicles[key];
    if (!entry || entry.route_id !== v.route_id || (Number.isFinite(tSec) && tSec - entry.run_start > TRACK_RUN_GAP_SEC && tSec - (entry.samples.length ? entry.samples[entry.samples.length - 1][0] : 0) > TRACK_RUN_GAP_SEC)) {
      entry = { route_id: v.route_id, trip_id: v.trip_id || null, run_start: Number.isFinite(tSec) ? tSec : nowSec, samples: [], emitted: {} };
      state.vehicles[key] = entry;
    }
    const prev = entry.samples.length ? entry.samples[entry.samples.length - 1] : null;
    if (prev && Number.isFinite(tSec)) {
      const dt = tSec - prev[0];
      if (dt <= 0) {
        quality = 'stale-ts';
      } else {
        const dist = haversineM(prev[1], prev[2], v.lat, v.lon);
        const implied = dist / dt;
        if (implied > TELEPORT_MPS && dist > TELEPORT_MIN_DIST_M) {
          quality = 'held-teleport';
          stats.teleport++;
        } else {
          if (v.speed_mph !== null && v.speed_mph !== undefined) {
            const reported = v.speed_mph / MS_PER_S;
            if (Math.abs(implied - reported) > SPEED_MISMATCH_MPS && dist > 150) {
              quality = 'speed-mismatch';
              stats.mismatch++;
            }
          }
          entry.samples.push([tSec, v.lat, v.lon, v.speed_mph ?? null]);
        }
      }
    } else if (Number.isFinite(tSec)) {
      entry.samples.push([tSec, v.lat, v.lon, v.speed_mph ?? null]);
    }
    if (quality === 'ok' && v.age_sec !== null && v.age_sec > STALE_SAMPLE_SEC) quality = 'stale-sample';
    if (quality === 'stale-sample') stats.stale++;
    entry.samples = entry.samples.filter((s) => nowSec - s[0] <= TRACK_PRUNE_SEC).slice(-TRACK_MAX_SAMPLES);
    entry.trip_id = v.trip_id || entry.trip_id || null;
    v.quality = quality;
    stats.tracked++;
    if (v.agency === 'ddot' && quality !== 'held-teleport') {
      const ev = detectMissedStops(entry, v, patterns, nowIso);
      for (const e of ev) {
        state.missed_events.push(e);
        stats.missed++;
      }
    }
  }
  // Prune vehicles not seen this cycle once their samples all expire.
  for (const key of Object.keys(state.vehicles)) {
    const e = state.vehicles[key];
    if (!seenKeys.has(key) && (!e.samples.length || nowSec - e.samples[e.samples.length - 1][0] > TRACK_PRUNE_SEC)) {
      delete state.vehicles[key];
    }
  }
  state.missed_events = state.missed_events
    .filter((e) => nowSec - Math.floor(Date.parse(e.detected_at) / 1000) <= MISSED_EVENT_TTL_SEC)
    .slice(-MISSED_EVENTS_CAP);
  state.generated_at = nowIso;
  return stats;
}

/** SMART adherence entries from the TU x static delay computation. */
function buildSmartAdherence(smartTrips, delaysByTrip, headsigns, nowSec, nowIso) {
  const byTrip = (headsigns && headsigns.by_trip) || {};
  const byRouteDir = (headsigns && headsigns.by_route_dir) || {};
  const trips = {};
  for (const t of smartTrips || []) {
    const delays = delaysByTrip ? delaysByTrip.get(t.trip_id) : null;
    let next = null;
    for (const u of t.stop_time_updates || []) {
      const pred = u.departure_time ?? u.arrival_time;
      if (pred === null || pred === undefined) continue;
      if (pred >= nowSec - 120 && (!next || pred < next.pred)) {
        next = { stop_id: String(u.stop_id), pred, rel: u.schedule_relationship || 'SCHEDULED' };
      }
    }
    if (!next) continue;
    const inService = Boolean(t.vehicle_id);
    const delay = delays && next ? (delays.get(next.stop_id) ?? null) : null;
    let stateLabel = 'untracked';
    if (next.rel === 'SKIPPED') stateLabel = 'skipped';
    else if (delay !== null) stateLabel = delay > 60 ? 'late' : delay < -60 ? 'early' : 'on-time';
    trips[t.trip_id] = {
      route_id: t.route_id,
      direction_id: t.direction_id,
      vehicle_id: t.vehicle_id || null,
      headsign: byTrip[t.trip_id]
        || byRouteDir[`${t.route_id}|${t.direction_id === null || t.direction_id === undefined ? '' : t.direction_id}`]
        || null,
      state: stateLabel,
      delay_sec: delay,
      next_stop_id: next.stop_id,
      next_stop_eta: new Date(next.pred * 1000).toISOString(),
      in_service: inService,
      method: delay !== null ? 'tu-static-join' : 'tu-prediction',
      updated_at: t.updated_at || nowIso,
    };
  }
  return trips;
}

/* ---------------- vehicle legs (vehicles.js port) ---------------- */

async function pollDdot(nowIso) {
  if (REPLAY) {
    // Replay: reproduce the live leg's settled-batch semantics over
    // the recorded payloads — fulfilled batches map, rejected batches
    // only count. No network, no key.
    const d = REPLAY.ddot;
    if (!d.configured) {
      return {
        vehicles: [],
        calls: 0,
        state: { ok: false, at: nowIso, reason: 'DDOT_BUSTIME_KEY secret not configured', configured: false },
      };
    }
    const vehicles = [];
    let batchesOk = 0;
    for (const b of d.vehicle_batches || []) {
      if (b.ok) {
        batchesOk++;
        vehicles.push(...mapDdotVehicles(replayPayloadJson(b.file)));
      }
    }
    return {
      vehicles,
      calls: (d.vehicle_batches || []).length,
      state: {
        ok: true, at: nowIso, vehicles: vehicles.length,
        batches_ok: batchesOk, batches_failed: (d.vehicle_batches || []).length - batchesOk,
      },
    };
  }
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

/** Replay source for the Swiftly legs: the recorded payload bytes, or
 *  a throw carrying the recorded fetch error — which lands in the
 *  caller's catch and reproduces the live error state verbatim. */
function replaySmartBuffer(which) {
  const s = REPLAY.smart[which];
  if (!s || !s.ok) throw new Error((s && s.error) || 'replay bundle missing Swiftly payload');
  return replayPayloadBytes(s.file);
}

async function pollSmart(nowIso) {
  // Called ONLY when the leg is active (live: SWIFTLY_KEY non-empty;
  // replay: the collect run's key was present — main gates on the
  // bundle manifest), so the dormant state performs zero network calls.
  try {
    const buf = REPLAY ? replaySmartBuffer('vp') : await fetchBufferSwiftly(SMART_VP_URL, SWIFTLY_KEY);
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
    const vehicles = mapGtfsRtVehicles(buf, nowIso, 'smart', true);
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
  // Called ONLY when the leg is active (same gate as pollSmart), so
  // the dormant state performs zero network calls.
  try {
    const buf = REPLAY ? replaySmartBuffer('tu') : await fetchBufferSwiftly(SMART_TU_URL, SWIFTLY_KEY);
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
  if (REPLAY) {
    const q = REPLAY.qline;
    if (!q.ok) {
      return { vehicles: [], state: { ok: false, at: nowIso, reason: q.error } };
    }
    const vehicles = mapGtfsRtVehicles(replayPayloadBytes(q.file), nowIso, 'qline').map((v) => ({ ...v, route_id: 'QLINE' }));
    return { vehicles, state: { ok: true, at: nowIso, vehicles: vehicles.length } };
  }
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
  if (REPLAY) {
    // Fresh-collection replay (main routes the bundle's reuse mode to
    // the prior alerts.json instead, exactly like the live reuse
    // branch). The recorded per-route outcomes run through the SAME
    // collectDdotBulletins machinery, so BusTime error envelopes,
    // the no-bulletins filter and failure states reproduce verbatim.
    const d = REPLAY.ddot;
    if (!d.configured) {
      return {
        alerts: [],
        calls: 0,
        state: { ...base, ok: false, status: 'error', alerts: 0, reason: 'DDOT_BUSTIME_KEY secret not configured', configured: false },
      };
    }
    const collected = await collectDdotBulletins((rt) => {
      const e = (d.bulletins && d.bulletins.routes) || {};
      const rec = e[rt];
      if (!rec) throw new Error(`replay bundle missing bulletin payload for route ${rt}`);
      if (!rec.ok) throw new Error(rec.error);
      return replayPayloadJson(rec.file);
    });
    return { ...ddotCollectedState(base, collected, nowIso), calls: collected.calls };
  }
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
  // Replay anchor: in replay mode the run's "now" is the bundle's
  // collected_at — the instant the payloads were actually fetched —
  // so generated_at and every source timestamp stay truthful about
  // the data's age, never about the publish instant.
  const nowIso = REPLAY ? REPLAY.collected_at : new Date().toISOString();
  const alertsPath = path.join(OUT_DIR, 'alerts.json');
  let reuse;
  if (REPLAY) {
    // The collect run already made the sub-cadence decision (it is
    // the only side that can act on it — it holds the key): a 'fresh'
    // or 'not-configured' bundle rebuilds alerts from its payloads
    // via pollDdotAlerts; a 'reuse' bundle carries the previously
    // published alerts.json forward verbatim, the same body the live
    // reuse branch would emit.
    const mode = REPLAY.ddot.configured ? (REPLAY.ddot.bulletins || {}).mode : 'not-configured';
    if (mode === 'reuse') {
      const prior = readExisting(alertsPath);
      if (!prior) {
        throw new Error('replay bundle requests bulletin reuse but OUT_DIR has no prior alerts.json');
      }
      reuse = {
        reuse: true,
        body: {
          generated_at: prior.generated_at,
          count: prior.count,
          alerts: prior.alerts,
          sources: prior.sources,
        },
      };
    } else {
      reuse = { reuse: false };
    }
  } else {
    reuse = ddotBulletinsReusable(readExisting(alertsPath), {
      keyPresent: Boolean(DDOT_KEY),
      nowMs: Date.now(),
    });
  }

  const smartActive = REPLAY ? Boolean(REPLAY.smart.active) : Boolean(SWIFTLY_KEY);
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

  /* FULL INTEGRATION prep (2026-11-11) — static extracts + track
   * state are seeded files in OUT_DIR (publisher FEED_FILES). Absent
   * extracts degrade their joins independently, never the build. */
  const smartHeadsigns = readExisting(path.join(OUT_DIR, 'smart-headsigns.json')) || { by_trip: {}, by_route_dir: {} };
  const smartSched = readExisting(path.join(OUT_DIR, 'smart-schedule-extract.json'));
  const ddotPatterns = readExisting(path.join(OUT_DIR, 'ddot-patterns.json'));
  const routeMeta = readExisting(path.join(OUT_DIR, 'route-meta.json'));
  const trackState = loadTrackState();
  const nowSec = Math.floor(Date.parse(nowIso) / 1000);
  const smartTripList = smartActive && smartTu ? smartTu.trips : [];
  const smartFinal = smartActive && smart ? finalizeSmartVehicles(smart.vehicles, smartTripList, smartHeadsigns, routeMeta) : [];
  const delaysByTrip = computeSmartTripDelays(smartTripList, smartSched);
  const allVehicles = [...ddot.vehicles, ...qline.vehicles, ...smartFinal];

  /* ER-FIX-FEED-01 (2026-11-13): per-agency unmatched accounting +
   * the routes_dark list, both computed from this cycle's own data
   * and the GTFS-derived route-meta extract. Absent extract degrades
   * routes_dark to empty — the build never fails on a seed. */
  const unmatchedByAgency = {
    ddot: unmatchedCount(ddot.vehicles),
    smart: smartActive ? unmatchedCount(smartFinal) : 0,
    qline: unmatchedCount(qline.vehicles),
  };
  const routesDark = [
    ...computeRoutesDark(routeMeta, 'ddot', routeCounts(ddot.vehicles), nowSec),
    ...computeRoutesDark(routeMeta, 'smart', routeCounts(smartFinal), nowSec),
  ];

  const vehiclesBody = {
    generated_at: nowIso,
    count: allVehicles.length,
    vehicles: allVehicles,
    routes_dark: routesDark,
    sources: {
      ddot: { ...ddot.state, unmatched: unmatchedByAgency.ddot },
      // FULL INTEGRATION (2026-11-11): SMART vehicles are merged into
      // this file with attribution, same as DDOT/QLINE. With a key
      // present, sources.smart reports the leg's own state; without
      // one it is the removed state, byte-identical to before.
      smart: smartActive
        ? { ...smart.state, unmatched: unmatchedByAgency.smart }
        : { ok: false, removed: true, at: nowIso, reason: SMART_REMOVED_REASON },
      qline: { ...qline.state, unmatched: unmatchedByAgency.qline },
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

  const trackStats = processTracks(allVehicles, trackState, nowSec, nowIso, ddotPatterns);
  const v = writeIfChanged(path.join(OUT_DIR, 'vehicles.json'), vehiclesBody);
  const a = reuse.reuse ? 'unchanged' : writeIfChanged(alertsPath, alertsBody);

  /* Canonical trip-updates (KAES-21) — honest empty envelope (T6.3b).
   * Detroit has NO canonical TU source: DDOT BusTime publishes no
   * trip-updates leg this builder consumes, QLINE publishes none, and
   * the SMART Swiftly TU payload is DISPLAY-ONLY (§4(vi)) — it ships
   * as smart-trip-updates.json and must NEVER be republished as the
   * canonical file (provenance fence). Until a canonical source
   * exists, this file publishes the truth: zero trip updates, every
   * family in the named no-tu-source state. Same write policy as the
   * siblings (material change or heartbeat). Fault-isolated: a
   * failure here must never abort or corrupt the sibling writes. */
  let t = 'failed';
  try {
    const tuBody = {
      generated_at: nowIso,
      count: 0,
      trip_updates: [],
      sources: {
        ddot: { ok: false, state: 'no-tu-source' },
        smart: { ok: false, state: 'no-tu-source' },
        qline: { ok: false, state: 'no-tu-source' },
      },
    };
    t = writeIfChanged(path.join(OUT_DIR, 'trip-updates.json'), tuBody);
  } catch (err) {
    console.log(`trip-updates.json: failed (${err.message})`);
  }

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
    const summary = writeSmartTuDerivative(smartTuDir, buildSmartTuDerivative(smartTu.trips, genSec, delaysByTrip), genSec);
    smartTuDerivNote = `smart-tu/: ${summary.routes} route files (${summary.trips} windowed trips, ${summary.bytes} B) + index.json`;
  } else if (smartActive) {
    smartTuDerivNote = 'smart-tu/: left unchanged (Swiftly trip-updates leg failed this cycle)';
  } else {
    if (fs.existsSync(smartTuDir)) fs.rmSync(smartTuDir, { recursive: true, force: true });
    smartTuDerivNote = 'smart-tu/: not written (SWIFTLY_KEY not set; leg dormant)';
  }

  const adhBody = {
    generated_at: nowIso,
    smart: {
      method: 'tu-static-join',
      static_feed: smartSched ? smartSched.feed_version : null,
      trips: buildSmartAdherence(smartTripList, delaysByTrip, smartHeadsigns, nowSec, nowIso),
    },
    ddot: {
      method: 'track-dwell',
      missed_stops: trackState.missed_events,
    },
  };
  const adh = writeIfChanged(path.join(OUT_DIR, 'adherence.json'), adhBody);
  fs.writeFileSync(path.join(OUT_DIR, 'track-state.json'), JSON.stringify(trackState) + '\n');
  console.log(`adherence.json: ${adh} (smart trips=${Object.keys(adhBody.smart.trips).length}, missed stops retained=${trackState.missed_events.length})`);
  console.log(`track-state: ${trackStats.tracked} vehicles (teleport=${trackStats.teleport}, speed-mismatch=${trackStats.mismatch}, stale=${trackStats.stale}, missed-detected=${trackStats.missed})`);
  console.log(`vehicles.json: ${v} (ddot=${ddot.vehicles.length} ok=${ddot.state.ok}, qline=${qline.vehicles.length} ok=${qline.state.ok}, smart=${smartFinal.length} ok=${smartActive ? smart.state.ok : false})`);
  console.log(
    `unmatched vehicles: ddot=${unmatchedByAgency.ddot}/${ddot.vehicles.length} `
    + `smart=${unmatchedByAgency.smart}/${smartFinal.length} qline=${unmatchedByAgency.qline}/${qline.vehicles.length}`
  );
  for (const [agency, n] of Object.entries(unmatchedByAgency)) {
    const total = agency === 'ddot' ? ddot.vehicles.length
      : agency === 'smart' ? smartFinal.length : qline.vehicles.length;
    if (n > UNMATCHED_ALARM_THRESHOLD) {
      console.log(
        `::warning::UNMATCHED_VEHICLES_ALARM agency=${agency} unmatched=${n} total=${total} `
        + `threshold=${UNMATCHED_ALARM_THRESHOLD} — vehicles served without route attribution`
      );
    }
  }
  console.log(
    `routes_dark: ${routesDark.length} route(s) with scheduled trips today and no live vehicle`
    + (routesDark.length
      ? ` (${routesDark.map((r) => `${r.agency}:${r.route_id}`).join(', ')})`
      : '')
  );
  console.log(`alerts.json: ${a} (ddot alerts=${ddotAlerts.alerts.length} ok=${ddotAlerts.state.ok})`);
  console.log(`trip-updates.json: ${t} (canonical TU: no source; honest empty envelope)`);
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

/* ---------------- collect mode (Project 30) ----------------
 * Perform ONLY the source fetches and record the raw payloads and
 * their outcomes as a feed-raw-bundle/v1 in COLLECT_DIR. No
 * transforms, no feed outputs — the replay side runs the identical
 * poll legs over these recordings. Source errors are data (recorded
 * verbatim, including the HTTP-error strings the live helpers
 * produce), never a failed run, exactly as the live legs treat them.
 * The fetch cadence here REPLACES the live build's fetches (the
 * publisher makes zero source calls), including the bulletin
 * sub-cadence: fresh bulletin collection at most once per
 * BULLETIN_REUSE_MS, decided against the previous bundle's manifest
 * (FEED_PREV_BUNDLE_DIR) — the same rule the live reuse branch
 * applies to the previously published alerts.json, including the
 * key-presence-transition invalidation. */

function bundleWrite(rel, buf) {
  const p = path.join(COLLECT_DIR, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return { file: rel, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

function readPrevBundle() {
  const dir = process.env.FEED_PREV_BUNDLE_DIR || '';
  if (!dir) return null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8'));
    return m && m.kind === 'feed-raw-bundle/v1' ? m : null;
  } catch {
    return null;
  }
}

async function collectMain() {
  const collectedAt = new Date().toISOString();
  fs.mkdirSync(COLLECT_DIR, { recursive: true });
  const ddotConfigured = Boolean(DDOT_KEY);
  const smartActive = Boolean(SWIFTLY_KEY);

  // DDOT vehicles — same batching and settled semantics as pollDdot.
  const vehicleBatches = [];
  if (ddotConfigured) {
    const batches = [];
    for (let i = 0; i < DDOT_ROUTES.length; i += 10) batches.push(DDOT_ROUTES.slice(i, i + 10));
    const settled = await Promise.allSettled(batches.map((group) => {
      const url = `https://myddotbus.com/bustime/api/v3/getvehicles?key=${encodeURIComponent(DDOT_KEY)}&rt=${encodeURIComponent(group.join(','))}&format=json`;
      return fetchRawJson(url);
    }));
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') {
        vehicleBatches.push({ routes: batches[i], ok: true, ...bundleWrite(`ddot-vehicles-${i}.json`, s.value) });
      } else {
        vehicleBatches.push({ routes: batches[i], ok: false, error: s.reason.message });
      }
    });
  }

  // DDOT bulletins — fresh at most once per BULLETIN_REUSE_MS.
  let bulletins;
  if (!ddotConfigured) {
    bulletins = { mode: 'not-configured', fetched_at: null };
  } else {
    const prev = readPrevBundle();
    const prevFetchedAt = prev && prev.ddot && prev.ddot.bulletins ? prev.ddot.bulletins.fetched_at : null;
    const prevConfigured = prev && prev.ddot ? prev.ddot.configured : null;
    const due = !prev || prevConfigured !== true || !prevFetchedAt
      || (Date.parse(collectedAt) - Date.parse(prevFetchedAt) >= BULLETIN_REUSE_MS);
    if (!due) {
      bulletins = { mode: 'reuse', fetched_at: prevFetchedAt };
    } else {
      const routes = {};
      const recordingFetch = async (rt) => {
        try {
          const buf = await fetchRawJson(buildDdotBulletinsUrl(DDOT_KEY, rt), DDOT_BULLETIN_TIMEOUT_MS);
          routes[rt] = { ok: true, ...bundleWrite(`ddot-bulletins/${rt}.json`, buf) };
          return JSON.parse(buf.toString('utf8'));
        } catch (e) {
          routes[rt] = { ok: false, error: e.message };
          throw e;
        }
      };
      await collectDdotBulletins(recordingFetch);
      bulletins = { mode: 'fresh', fetched_at: collectedAt, routes };
    }
  }

  // QLINE — public GTFS-RT protobuf.
  let qline;
  try {
    const buf = await fetchRawBuffer(QLINE_VP_URL);
    qline = { ok: true, ...bundleWrite('qline-vp.pb', buf) };
  } catch (e) {
    qline = { ok: false, error: e.message };
  }

  // SMART — gated on the key exactly like the build legs: an absent
  // key performs zero network calls and records the dormant state.
  let smart = { active: false };
  if (smartActive) {
    const one = async (url, rel) => {
      try {
        const buf = await fetchRawBufferSwiftly(url, SWIFTLY_KEY);
        return { ok: true, ...bundleWrite(rel, buf) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    };
    smart = { active: true, vp: await one(SMART_VP_URL, 'smart-vp.pb'), tu: await one(SMART_TU_URL, 'smart-tu.pb') };
  }

  const manifest = {
    kind: 'feed-raw-bundle/v1',
    collected_at: collectedAt,
    ddot: { configured: ddotConfigured, vehicle_batches: vehicleBatches, bulletins },
    qline,
    smart,
  };
  // Manifest LAST: its presence marks a complete bundle.
  fs.writeFileSync(path.join(COLLECT_DIR, 'bundle.json'), JSON.stringify(manifest, null, 2) + '\n');
  const okCount = vehicleBatches.filter((b) => b.ok).length;
  console.log(
    `collect: ddot_configured=${ddotConfigured} batches_ok=${okCount}/${vehicleBatches.length} ` +
    `bulletins=${bulletins.mode} qline_ok=${qline.ok} smart_active=${smart.active}`
  );
}

export { collectDdotBulletins, ddotBulletinsReusable, gtfsRtFeedShape, pollSmart, pollSmartTripUpdates, mapGtfsRtTripUpdates, trimSmartTuTrip, buildSmartTuDerivative, writeSmartTuDerivative, main, collectMain, finalizeSmartVehicles, computeSmartTripDelays, processTracks, loadTrackState, buildSmartAdherence, detroitMidnightEpochSec, feedEpochSec, haversineM };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = COLLECT_DIR ? collectMain : main;
  run().catch((e) => {
    console.error(COLLECT_DIR ? 'collect-feed failed:' : 'build-feed failed:', e);
    process.exit(1);
  });
}
