// modules/data-layer.mjs — data layer (client side).
// R1 foundation contract; R2 implementation landed 2026-10-24
// (loaders + classification below; the server pipeline lives in
// ../pipeline/). Label: UNVERIFIED / legacy-unsigned.
//
// R2 (data pipeline) implements the collector/publisher chain
// (LT-KAES-08 shared wire code, LT-KAES-19 raw-bundle/transform
// separation, LT-KAES-16 complete leg set, LT-KAES-20 fault
// isolation, LT-KAES-18 cadence as adapted). THIS module is the
// client-side half of that contract: the published-file shapes the
// page consumes, and the loaders that consume them. The collector
// itself is server-side R2 work and never ships to the page.
//
// Published contracts R2 must produce and this layer consumes:
//   vehicles — canonical envelope (LT-KAES-24):
//     { generated_at, count, vehicles[], sources{} } with records
//     { agency, route_id, vehicle_id, lat, lon, bearing, speed_mph,
//       destination, updated_at }; a field the source does not
//     carry renders ABSENT (LT-F7) — never dropped from the schema,
//     never synthesized. (Outgoing envelope {city, fetched_at,
//     feeds{}} with records {entity, route, trip, label, lat, lon,
//     bearing, ts} is the GAP being replaced.)
//   alerts — { generated_at, alerts[] }; generated_at advances only
//     on real re-collection under the bulletin sub-cadence
//     (LT-KAES-34 build half / LT-S8.1).
//   per-route trip-update derivatives under data/tu/, each
//     <= 25,000 B, index-verified (LT-KAES-45).
//   per-source state in the vehicles envelope: sources keyed by
//     feed family (the family's set is config-derived, DL-1)
//     each { ok, ...batch counters } — a failed leg is VISIBLE in
//     the product, never silent (LT-KAES-20 / RC7).
//
// Client behaviours fixed here as contract:
//   - Trip-matching classification runs before any live surface
//     (LT-KAES-25 / LT-N10): every record classifies TRIP-MATCHED,
//     ROUTE-MATCHED (surfaced, never silently dropped), or
//     UNASSIGNED (verified descriptor-less). A LIVE-EMPTY feed
//     composes as UNMEASURED with feed state attached (LT-F7).
//   - Unresolved-route records draw no marker, are not counted,
//     are not pickable (RC8) — enforced by the renderer from the
//     classification, not re-decided per surface.
//   - Display separation (LT-KAES-23, ADAPTABLE): split points
//     follow this city's feed structure — bus and rail stay
//     separate through storage and computation and join only at
//     render (LT-F5(b)). a city with no display-only feed
//     (its agency.displayOnlyFeeds list is empty) has no fence
//     split; the fence itself is the LT-F4 rule, stated once here.

import { CITY_CONFIG } from '../config/city-config.mjs';

// Feed families are CONFIG-DERIVED (DL-1): the union of the families
// declared in feeds.static and feeds.realtime. No family literal
// survives in code (remnant-scan rule R-3).
export const FEED_FAMILIES = Object.freeze([...new Set([
  ...(CITY_CONFIG.feeds.static || []).map((f) => f.family),
  ...(CITY_CONFIG.feeds.realtime || []).map((f) => f.family),
])]);
import { stampedJson, stampedFetch } from '../platform/loader.mjs';
import { createProjector } from '../platform/projector.mjs';

export const VEHICLE_RECORD_FIELDS = Object.freeze([
  'agency', 'route_id', 'vehicle_id', 'lat', 'lon',
  'bearing', 'speed_mph', 'destination', 'updated_at',
]);

export const CLASSIFICATION = Object.freeze({
  TRIP_MATCHED: 'TRIP-MATCHED',
  ROUTE_MATCHED: 'ROUTE-MATCHED',
  UNASSIGNED: 'UNASSIGNED',
});

/** Validate a published vehicles document against KAES-24. Pure. */
export function validateVehicleEnvelope(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object') return ['envelope is not an object'];
  if (typeof doc.generated_at !== 'string') problems.push('missing generated_at');
  if (!Array.isArray(doc.vehicles)) problems.push('vehicles is not an array');
  if (typeof doc.count !== 'number') problems.push('missing numeric count');
  if (Array.isArray(doc.vehicles) && typeof doc.count === 'number'
      && doc.count !== doc.vehicles.length) {
    problems.push(`count ${doc.count} != vehicles.length ${doc.vehicles.length}`);
  }
  if (!doc.sources || typeof doc.sources !== 'object') {
    problems.push('missing sources{} per-source state (KAES-20)');
  } else {
    for (const family of FEED_FAMILIES) {
      const s = doc.sources[family];
      if (!s || typeof s.ok !== 'boolean') problems.push(`sources.${family}.ok missing/not boolean`);
    }
  }
  return problems;
}

/** Validate a published alerts document (KAES-34 build half). Pure. */
export function validateAlertsEnvelope(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object') return ['alerts envelope is not an object'];
  if (typeof doc.generated_at !== 'string') problems.push('missing generated_at');
  if (!Array.isArray(doc.alerts)) problems.push('alerts is not an array');
  return problems;
}

// ---- R2 implementation (platform rebuild R2, 2026-10-24) ----
// The loaders consume exactly the published family the R2 server
// pipeline (../pipeline/) produces. Classification is computed
// server-side against the static trip/route sets and carried on
// each record; classifyRecords below is the client-side form of
// the same rule, applied to any record that arrives without a
// classification (and used by harnesses to re-derive counts).

/** Validate a published trip-updates document. Pure. */
export function validateTripUpdatesEnvelope(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object') return ['trip-updates envelope is not an object'];
  if (typeof doc.generated_at !== 'string') problems.push('missing generated_at');
  if (!Array.isArray(doc.trip_updates)) problems.push('trip_updates is not an array');
  if (typeof doc.count !== 'number') problems.push('missing numeric count');
  if (Array.isArray(doc.trip_updates) && typeof doc.count === 'number'
      && doc.count !== doc.trip_updates.length) {
    problems.push(`count ${doc.count} != trip_updates.length ${doc.trip_updates.length}`);
  }
  if (!doc.sources || typeof doc.sources !== 'object') {
    problems.push('missing sources{} per-source state (KAES-20)');
  } else {
    for (const family of FEED_FAMILIES) {
      const s = doc.sources[family];
      if (!s || typeof s.ok !== 'boolean') problems.push(`sources.${family}.ok missing/not boolean`);
    }
  }
  return problems;
}

/** Poll the canonical vehicles file on the configured cadence. */
export async function pollVehicles(fetchImpl) {
  const doc = await stampedJson(CITY_CONFIG.assets.liveData.vehicles, fetchImpl);
  const problems = validateVehicleEnvelope(doc);
  if (problems.length) {
    throw new Error(`vehicles envelope failed KAES-24 validation: ${problems.join('; ')}`);
  }
  return doc;
}

/** Poll the alerts file. R2 collection; R5 renders. */
export async function pollAlerts(fetchImpl) {
  const doc = await stampedJson(CITY_CONFIG.assets.liveData.alerts, fetchImpl);
  const problems = validateAlertsEnvelope(doc);
  if (problems.length) {
    throw new Error(`alerts envelope failed KAES-34 validation: ${problems.join('; ')}`);
  }
  return doc;
}

/** Poll the full trip-updates file (R5 consumer loader: stop-card
 *  arrivals + Ride Along times consume it through the same
 *  validated path as vehicles/alerts). */
export async function pollTripUpdates(fetchImpl) {
  const doc = await stampedJson(CITY_CONFIG.assets.liveData.tripUpdates, fetchImpl);
  const problems = validateTripUpdatesEnvelope(doc);
  if (problems.length) {
    throw new Error(`trip-updates envelope failed KAES-21 validation: ${problems.join('; ')}`);
  }
  return doc;
}

/**
 * Classify live records before any surface consumes them
 * (LT-KAES-25 / LT-N10). A record the pipeline already classified
 * keeps its classification; an unclassified record classifies by
 * the §5 rule on the fields it carries: trip_id present ->
 * TRIP-MATCHED, route_id present -> ROUTE-MATCHED, neither ->
 * UNASSIGNED (verified descriptor-less). Returns the records with
 * `classification` set plus reconciling counts; the counts always
 * sum to records.length.
 */
export function classifyRecords(records) {
  const counts = {
    [CLASSIFICATION.TRIP_MATCHED]: 0,
    [CLASSIFICATION.ROUTE_MATCHED]: 0,
    [CLASSIFICATION.UNASSIGNED]: 0,
  };
  const out = (records || []).map((r) => {
    let c = r.classification;
    if (!Object.values(CLASSIFICATION).includes(c)) {
      if (r.trip_id) c = CLASSIFICATION.TRIP_MATCHED;
      else if (r.route_id) c = CLASSIFICATION.ROUTE_MATCHED;
      else c = CLASSIFICATION.UNASSIGNED;
    }
    counts[c] += 1;
    return { ...r, classification: c };
  });
  return { records: out, counts, total: out.length };
}

// ---- Core fold F2 (2026-10-31): CG-1 / CG-2 / CG-5 data half ----
// Every mechanism below is CONFIG-GATED: its config field absent
// (the state of every fleet config today) makes the export a
// no-fetch no-op and leaves every export above byte-for-byte in
// behaviour. Display/external data is a fault-isolated side
// channel: a display or external feed can never fail, delay, or
// mutate a canonical poll (census §D.1/§D.2 fence).

const DISPLAY_FETCH_TIMEOUT_MS = 8000; // census §D.1 (monolith 8 s abort)

/** Age of a generated_at value (ISO string | epoch s | epoch ms). */
function generatedAgeMs(generatedAt, nowMs) {
  let t = null;
  if (typeof generatedAt === 'number') t = generatedAt < 1e12 ? generatedAt * 1000 : generatedAt;
  else if (typeof generatedAt === 'string') {
    const n = Number(generatedAt);
    t = Number.isFinite(n) && generatedAt.trim() !== '' ? (n < 1e12 ? n * 1000 : n) : Date.parse(generatedAt);
  }
  return Number.isFinite(t) ? nowMs - t : null;
}

function isStaleGenerated(generatedAt, staleMs, nowMs) {
  if (typeof staleMs !== 'number' || !(staleMs > 0)) return false;
  const age = generatedAgeMs(generatedAt, nowMs);
  return age !== null && age > staleMs;
}

/**
 * Fault-isolated JSON fetch for display/external side channels:
 * the loader stays the only fetch path (KAES-05), wrapped with the
 * caller's own AbortController + timeout race. Resolves null on
 * ANY failure (network, HTTP, parse, abort, timeout) — never throws.
 */
async function timedJson(url, fetchImpl, timeoutMs) {
  const ms = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DISPLAY_FETCH_TIMEOUT_MS;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { if (ctrl) ctrl.abort(); reject(new Error('display fetch timeout')); }, ms);
  });
  const signalling = fetchImpl
    ? (u, opts) => fetchImpl(u, { ...(opts || {}), ...(ctrl ? { signal: ctrl.signal } : {}) })
    : undefined; // stampedFetch falls back to the platform fetch
  try {
    const res = await Promise.race([stampedFetch(url, signalling), timeout]);
    return await res.json();
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---- CG-1: display-only vehicle feeds ----

/** Configured display-vehicle entries ([] when the gate is off). */
export function displayVehicleEntries() {
  const dv = CITY_CONFIG.assets && CITY_CONFIG.assets.liveData
    ? CITY_CONFIG.assets.liveData.displayVehicles : undefined;
  return Array.isArray(dv) ? dv.filter((e) => e && typeof e.url === 'string') : [];
}

/**
 * Validate a display vehicles document: the light envelope
 * { generated_at, vehicles[] } only — a display file carries no
 * canonical sources{} state and is never held to KAES-24. Pure.
 */
export function validateDisplayVehiclesEnvelope(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object') return ['display envelope is not an object'];
  if (typeof doc.generated_at !== 'string' && typeof doc.generated_at !== 'number') {
    problems.push('missing generated_at');
  }
  if (!Array.isArray(doc.vehicles)) problems.push('vehicles is not an array');
  return problems;
}

function tagDisplayRecords(records, entry) {
  return classifyRecords(records.map((r) => ({
    ...r,
    agency: r.agency != null ? r.agency : entry.feed,
    feed: entry.feed,
    displayFeed: entry.feed,
    displayOnly: true,
  }))).records;
}

/**
 * Poll every configured display-vehicle feed. Each entry fetches
 * with its own abort/timeout and resolves independently: failure,
 * malformation, or staleness (age of generated_at > entry.staleMs)
 * drops THAT payload whole and contributes zero records. Resolves
 * { vehicles: taggedRecords, byFeed: { feed: { ok, stale,
 * generated_at, count } } }; never throws.
 */
export async function pollDisplayVehicles(fetchImpl, nowMs = Date.now()) {
  const out = { vehicles: [], byFeed: {} };
  for (const entry of displayVehicleEntries()) {
    const feed = entry.feed;
    const doc = await timedJson(entry.url, fetchImpl, entry.timeoutMs);
    if (!doc || validateDisplayVehiclesEnvelope(doc).length) {
      out.byFeed[feed] = { ok: false, stale: false, generated_at: null, count: 0 };
      continue;
    }
    if (isStaleGenerated(doc.generated_at, entry.staleMs, nowMs)) {
      out.byFeed[feed] = { ok: true, stale: true, generated_at: doc.generated_at, count: 0 };
      continue;
    }
    const tagged = tagDisplayRecords(doc.vehicles, entry);
    out.byFeed[feed] = { ok: true, stale: false, generated_at: doc.generated_at, count: tagged.length };
    out.vehicles.push(...tagged);
  }
  return out;
}

/**
 * Canonical vehicles poll with the display merge applied: the
 * canonical poll runs first and is untouched on failure (it throws
 * exactly as pollVehicles does); display records are then merged
 * ALONGSIDE it. The returned envelope is a new object — canonical
 * sources{} and generated_at are carried verbatim, vehicles is
 * canonical ++ display, count is the merged total, and the display
 * set also rides separately as displayVehicles/displayFeeds so a
 * surface can label or exclude it. Gate off (no displayVehicles):
 * returns the canonical document itself, unchanged.
 */
export async function pollVehiclesWithDisplay(fetchImpl, nowMs = Date.now()) {
  const canonical = await pollVehicles(fetchImpl);
  if (!displayVehicleEntries().length) return canonical;
  const display = await pollDisplayVehicles(fetchImpl, nowMs);
  return {
    ...canonical,
    vehicles: [...canonical.vehicles, ...display.vehicles],
    count: canonical.vehicles.length + display.vehicles.length,
    displayVehicles: display.vehicles,
    displayFeeds: display.byFeed,
  };
}

// ---- CG-1: lazy headsign sidecar (fetch-once) ----

const displayHeadsignCache = new Map(); // headsignsUrl -> Promise<Map<string,string>>

function absorbHeadsigns(map, doc) {
  if (!doc || typeof doc !== 'object') return;
  if (Array.isArray(doc)) { for (const item of doc) absorbHeadsigns(map, item); return; }
  const containers = [doc.headsigns, doc.map, doc.destinations, doc.data];
  let absorbedContainer = false;
  for (const c of containers) {
    if (c && typeof c === 'object') { absorbHeadsigns(map, c); absorbedContainer = true; }
  }
  if (absorbedContainer) return;
  // Record form: one object naming vehicle/trip keys + a label.
  const label = doc.destination || doc.headsign || doc.label || doc.text;
  const keys = [doc.vehicle_id, doc.vehicleId, doc.trip_id, doc.tripId, doc.vehicle, doc.trip, doc.id];
  if (typeof label === 'string' && keys.some((k) => k != null)) {
    for (const k of keys) if (k != null) map.set(String(k), label);
    return;
  }
  // Map form: { key: label | {destination|headsign|label} }.
  for (const [k, v] of Object.entries(doc)) {
    if (typeof v === 'string') map.set(String(k), v);
    else if (v && typeof v === 'object') {
      const l = v.destination || v.headsign || v.label;
      if (typeof l === 'string') map.set(String(k), l);
    }
  }
}

/**
 * Fetch every configured headsign sidecar ONCE (the promise is
 * cached per URL; later calls reuse it) and resolve a merged
 * lookup Map keyed by vehicle id / trip id. Any failure resolves
 * an empty contribution — never throws. Gate off: empty Map, no fetch.
 */
export async function ensureDisplayHeadsigns(fetchImpl) {
  const merged = new Map();
  for (const entry of displayVehicleEntries()) {
    if (typeof entry.headsignsUrl !== 'string') continue;
    if (!displayHeadsignCache.has(entry.headsignsUrl)) {
      displayHeadsignCache.set(entry.headsignsUrl,
        timedJson(entry.headsignsUrl, fetchImpl, entry.timeoutMs)
          .then((doc) => { const m = new Map(); absorbHeadsigns(m, doc); return m; })
          .catch(() => new Map()));
    }
    const m = await displayHeadsignCache.get(entry.headsignsUrl);
    for (const [k, v] of m) merged.set(k, v);
  }
  return merged;
}

/**
 * Destination label for a vehicle/trip from a sidecar lookup
 * (Map or plain object, as ensureDisplayHeadsigns returns a Map).
 * `query` is a record ({vehicle_id, trip_id, ...}) or a bare key.
 * Returns the label string or null. Pure.
 */
export function displayHeadsignFor(lookup, query) {
  if (!lookup || query == null) return null;
  const get = lookup instanceof Map
    ? (k) => lookup.get(String(k))
    : (k) => lookup[String(k)];
  if (typeof query === 'string' || typeof query === 'number') return get(query) ?? null;
  for (const k of [query.vehicle_id, query.trip_id, query.vehicleId, query.tripId, query.id]) {
    if (k != null) { const v = get(k); if (v != null) return v; }
  }
  return null;
}

// ---- CG-2: display-only trip updates (stop arrivals) ----
// FENCE: this state is display-only. It is never merged into the
// canonical trip-updates document, any planner-read structure, or
// the canonical poll path (census §D.2).

/** Configured display-TU entries ([] when the gate is off). */
export function displayTripUpdateEntries() {
  const dt = CITY_CONFIG.assets && CITY_CONFIG.assets.liveData
    ? CITY_CONFIG.assets.liveData.displayTripUpdates : undefined;
  if (Array.isArray(dt)) return dt.filter((e) => e && typeof e.url === 'string');
  return dt && typeof dt.url === 'string' ? [dt] : [];
}

// feed -> Map<bareStopId, rows[]>; replaced wholesale per fresh ingest.
const displayTuByFeed = new Map();

/** Bare stop id: strip any registry prefix before the first ':'. */
export function bareStopId(stopId) {
  const s = String(stopId);
  const i = s.indexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}

function displayTuRow(raw, bareId, ctx) {
  const arrival = raw.arrival && typeof raw.arrival === 'object' ? raw.arrival : null;
  const departure = raw.departure && typeof raw.departure === 'object' ? raw.departure : null;
  return {
    ...raw,
    stop_id: bareId,
    feed: ctx.feed,
    displayOnly: true,
    trip_id: raw.trip_id ?? raw.tripId ?? ctx.trip_id ?? null,
    route_id: raw.route_id ?? raw.routeId ?? ctx.route_id ?? null,
    vehicle_id: raw.vehicle_id ?? raw.vehicleId ?? ctx.vehicle_id ?? null,
    arrival_time: raw.arrival_time ?? raw.arrivalTime ?? (arrival ? (arrival.time ?? arrival.timestamp ?? null) : null),
    departure_time: raw.departure_time ?? raw.departureTime ?? (departure ? (departure.time ?? departure.timestamp ?? null) : null),
  };
}

/**
 * Ingest one display-TU document into the per-stop display map.
 * Stale-gated at entry.staleMs against the document generated_at:
 * a stale payload is ignored whole (prior fresh state stands).
 * Accepts canonical-style {trip_updates[] with stop_time_updates},
 * the served display shape {trips[] with stop_time_updates} (the
 * Swiftly publication's own key — T6 parity α, 2026-10-31),
 * realtime-JSON {entity[].trip_update}, flat arrival rows, and
 * pre-keyed {stops|by_stop: {stopId: rows[]}} shapes. Returns
 * { ingested, stale, rows }. Never throws.
 */
export function ingestDisplayTripUpdates(doc, entry, nowMs = Date.now()) {
  const feed = (entry && entry.feed) || 'display';
  if (!doc || typeof doc !== 'object') return { ingested: false, stale: false, rows: 0 };
  if (isStaleGenerated(doc.generated_at, entry && entry.staleMs, nowMs)) {
    return { ingested: false, stale: true, rows: 0 };
  }
  const byStop = new Map();
  const push = (raw, stopId, ctx) => {
    if (stopId == null || !raw || typeof raw !== 'object') return;
    const bare = bareStopId(stopId);
    if (!byStop.has(bare)) byStop.set(bare, []);
    byStop.get(bare).push(displayTuRow(raw, bare, ctx));
  };
  const keyed = doc.stops || doc.by_stop || doc.byStop;
  if (keyed && typeof keyed === 'object' && !Array.isArray(keyed)) {
    for (const [stopId, rows] of Object.entries(keyed)) {
      for (const r of Array.isArray(rows) ? rows : [rows]) push(r, stopId, { feed });
    }
  }
  const updates = Array.isArray(doc) ? doc
    : Array.isArray(doc.trip_updates) ? doc.trip_updates
    : Array.isArray(doc.trips) ? doc.trips
    : Array.isArray(doc.entity) ? doc.entity.map((e) => (e && (e.trip_update || e.tripUpdate)) || e)
    : Array.isArray(doc.updates) ? doc.updates : [];
  for (const u of updates) {
    if (!u || typeof u !== 'object') continue;
    const trip = u.trip && typeof u.trip === 'object' ? u.trip : {};
    const ctx = {
      feed,
      trip_id: u.trip_id ?? u.tripId ?? trip.trip_id ?? trip.tripId ?? null,
      route_id: u.route_id ?? u.routeId ?? trip.route_id ?? trip.routeId ?? null,
      vehicle_id: u.vehicle_id ?? u.vehicleId ?? trip.vehicle_id ?? trip.vehicleId ?? null,
    };
    const stus = u.stop_time_updates || u.stop_time_update || u.stopTimeUpdates;
    if (Array.isArray(stus) && stus.length) {
      for (const stu of stus) push(stu, stu && (stu.stop_id ?? stu.stopId), ctx);
    } else if (u.stop_id != null || u.stopId != null) {
      push(u, u.stop_id ?? u.stopId, ctx); // flat arrival row
    }
  }
  displayTuByFeed.set(feed, byStop);
  let rows = 0;
  for (const rs of byStop.values()) rows += rs.length;
  return { ingested: true, stale: false, rows };
}

/**
 * Poll every configured display-TU entry (own abort/timeout,
 * null-on-failure) and ingest the fresh payloads. Resolves a
 * per-feed result list; never throws; gate off: empty list, no fetch.
 */
export async function pollDisplayTripUpdates(fetchImpl, nowMs = Date.now()) {
  const results = [];
  for (const entry of displayTripUpdateEntries()) {
    const doc = await timedJson(entry.url, fetchImpl, entry.timeoutMs);
    if (!doc) { results.push({ feed: entry.feed, ingested: false, stale: false, rows: 0 }); continue; }
    results.push({ feed: entry.feed, ...ingestDisplayTripUpdates(doc, entry, nowMs) });
  }
  return results;
}

/**
 * Arrival rows for one stop from the display-TU map, across all
 * ingested display feeds. The query id is prefix-stripped the same
 * way ingest keys are, so bare and registry-prefixed ids both hit.
 * Returns [] when nothing is ingested for the stop.
 */
export function displayTuRowsForStop(stopId) {
  const bare = bareStopId(stopId);
  const out = [];
  for (const byStop of displayTuByFeed.values()) {
    const rows = byStop.get(bare);
    if (rows) out.push(...rows);
  }
  return out;
}

// ---- CG-5 (data half): external layers, 'gbfs' kind ----

/** Configured external-layer entries ([] when the gate is off). */
export function externalLayerEntries() {
  const el = CITY_CONFIG.assets ? CITY_CONFIG.assets.externalLayers : undefined;
  return Array.isArray(el) ? el.filter((e) => e && typeof e.baseUrl === 'string') : [];
}

const externalLayerLatest = new Map(); // layer id -> { ok, stations, fetched_at }

function gbfsStations(doc) {
  if (!doc || typeof doc !== 'object') return [];
  if (Array.isArray(doc)) return doc;
  if (doc.data && Array.isArray(doc.data.stations)) return doc.data.stations;
  if (Array.isArray(doc.stations)) return doc.stations;
  return [];
}

function gbfsName(name) {
  if (typeof name === 'string') return name;
  if (Array.isArray(name)) {
    const first = name.find((n) => n && typeof n.text === 'string');
    return first ? first.text : null;
  }
  return null;
}

function stationProjector() {
  const p = CITY_CONFIG.assets && CITY_CONFIG.assets.projection;
  if (!p || typeof p.lat0 !== 'number' || typeof p.lon0 !== 'number') return null;
  try { return createProjector(p); } catch { return null; }
}

/**
 * Poll one 'gbfs' external layer: station_information +
 * station_status from entry.baseUrl, merged by station id into
 * { id, station_id, name, lat, lon, x, z, capacity, available,
 * num_bikes_available, num_docks_available, is_installed,
 * is_renting, is_returning, last_reported, layerId, kind }.
 * x/z are projected via the config projection when lat/lon are
 * present (scene-model convention); null otherwise. Any failure
 * (either document) resolves { ok:false, stations: [] } — an
 * external layer never throws into the transit polls.
 */
export async function pollGbfsLayer(entry, fetchImpl) {
  const fail = { id: entry && entry.id, kind: 'gbfs', ok: false, stations: [] };
  if (!entry || entry.kind !== 'gbfs' || typeof entry.baseUrl !== 'string') return fail;
  const base = entry.baseUrl.replace(/\/+$/, '');
  const [info, status] = await Promise.all([
    timedJson(`${base}/station_information.json`, fetchImpl, entry.timeoutMs),
    timedJson(`${base}/station_status.json`, fetchImpl, entry.timeoutMs),
  ]);
  if (!info || !status) return fail;
  const statusById = new Map();
  for (const s of gbfsStations(status)) {
    if (s && s.station_id != null) statusById.set(String(s.station_id), s);
  }
  const projector = stationProjector();
  const stations = [];
  for (const s of gbfsStations(info)) {
    if (!s || s.station_id == null) continue;
    const st = statusById.get(String(s.station_id)) || {};
    const lat = typeof s.lat === 'number' ? s.lat : null;
    const lon = typeof s.lon === 'number' ? s.lon : null;
    const [x, z] = lat !== null && lon !== null && projector ? projector.project(lat, lon) : [null, null];
    const available = typeof st.num_bikes_available === 'number' ? st.num_bikes_available : null;
    stations.push({
      id: String(s.station_id),
      station_id: s.station_id,
      name: gbfsName(s.name),
      lat, lon, x, z,
      capacity: typeof s.capacity === 'number' ? s.capacity : null,
      available,
      num_bikes_available: available,
      num_docks_available: typeof st.num_docks_available === 'number' ? st.num_docks_available : null,
      is_installed: st.is_installed ?? null,
      is_renting: st.is_renting ?? null,
      is_returning: st.is_returning ?? null,
      last_reported: st.last_reported ?? null,
      layerId: entry.id,
      kind: 'gbfs',
    });
  }
  return { id: entry.id, kind: 'gbfs', ok: true, stations };
}

/**
 * Poll every configured external layer once (the caller owns the
 * cadence: entry.pollMs, on the same setInterval pattern surfaces
 * use for the canonical polls). Resolves { layers: {id: result},
 * stations: all layers' stations merged }; never throws. The
 * latest result per layer is retained for externalLayerStations.
 * Gate off: empty result, no fetch.
 */
export async function pollExternalLayers(fetchImpl) {
  const layers = {};
  const stations = [];
  for (const entry of externalLayerEntries()) {
    const result = entry.kind === 'gbfs'
      ? await pollGbfsLayer(entry, fetchImpl)
      : { id: entry.id, kind: entry.kind, ok: false, stations: [] };
    layers[entry.id] = result;
    externalLayerLatest.set(entry.id, {
      ok: result.ok, stations: result.stations, fetched_at: new Date().toISOString(),
    });
    stations.push(...result.stations);
  }
  return { layers, stations };
}

/** Latest merged station records (one layer by id, or all layers). */
export function externalLayerStations(layerId) {
  if (layerId != null) {
    const l = externalLayerLatest.get(layerId);
    return l ? [...l.stations] : [];
  }
  const out = [];
  for (const l of externalLayerLatest.values()) out.push(...l.stations);
  return out;
}

/** Clear all fold side-channel state (sidecar cache, display-TU
 *  map, external-layer latest). Canonical state does not exist in
 *  this module and is therefore untouched. Harness/test utility. */
export function resetFoldLayerState() {
  displayHeadsignCache.clear();
  displayTuByFeed.clear();
  externalLayerLatest.clear();
}

/** The live-data paths this layer consumes — from config, only. */
export function liveDataPaths() {
  return CITY_CONFIG.assets.liveData;
}

export { stampedJson as _stampedJson }; // loader path is the only fetch path (KAES-05)
