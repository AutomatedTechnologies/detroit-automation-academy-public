// modules/surfaces.mjs — feature surfaces (LT-KAES-30…36/40/41/47).
// Platform rebuild R5 implementation, on the R1 contract. Label:
// UNVERIFIED / legacy-unsigned.
//
// Every surface mounts into a region the R1 shell declares
// (SURFACE_MOUNTS below) — the shell's structure is never edited
// (LT-KAES-02). Surfaces are built as view-models over the real
// state (R2 published family + R3 scene model + R4 planner host)
// plus thin DOM renderers; the event handlers the page binds are
// the same functions the harness drives — no stubbed interaction
// path exists anywhere in this module.
//
// Rendering discipline: every feed-derived or rider-derived string
// passes esc() before it enters HTML (the estate's innerHTML sink
// rule). Records render only from fields they carry (LT-F7): a
// missing field omits its segment, never synthesizes one.
//
// Timetable-dependent enrichments (stop-card scheduled rows,
// direction rows, TU headsigns, Ride Along scheduled times) ride
// the R4 planner host's loaded asset + the bundle's trip-map,
// loaded LAZILY on first need (LT-KAES-05) — the 41.8 MB asset is
// never a boot cost. Until it lands, those sections render their
// honest pending state and re-render on arrival.

import { CITY_CONFIG, layerDefaultOn } from '../config/city-config.mjs';
import { stampedJson } from '../platform/loader.mjs';
import * as DataLayer from './data-layer.mjs';
import { pollVehicles, pollAlerts, pollTripUpdates } from './data-layer.mjs';
import { createRideAlong, compareVehiclesS3 } from './ride-along.mjs';
import { resolveRouteId } from '../renderer/scene-model.mjs';

/** Shell mount ids — asserted against index.html by the R1
 *  harness; this list and the shell cannot drift. */
export const SURFACE_MOUNTS = Object.freeze([
  'lt-status', //      header status line: counts + updated time from the file's own generated_at (LT-S3.1)
  'lt-map', //         the map canvas (renderer host, R3)
  'lt-launcher', //    first-view launcher sheet (KAES-36)
  'lt-filter-panel', // agency/route filters (KAES-33)
  'lt-browse-panel', // browse + search (KAES-33)
  'lt-info', //        stop / vehicle card region (KAES-30/31)
  'lt-alerts', //      alerts region (KAES-34 surface half)
  'lt-planner', //     planner surface mount (R4 host renders here)
  'lt-ride-along', //  Ride Along mount (KAES-32)
  'lt-places', //      Places layer controls (KAES-35)
  'lt-load-error', //  load-error overlay (KAES-40)
  'lt-degraded', //    degradation notice (KAES-40 / LT-S8.2)
]);

// ------------------------------------------------------------------
// Text + label helpers (Standards S2/S3 live here for the surfaces)
// ------------------------------------------------------------------

/** Escape a string for HTML text/attribute contexts. */
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Repair 2026-10-25 (literal entities): an agency's GTFS-RT
 * alert text may arrive entity-encoded at the source ("A
 * &amp; B Ave", "&ldquo;...&rdquo;") and the pipeline
 * stores it verbatim — provenance-correct. Rendering it through
 * esc() alone double-encodes it, so riders saw the literal
 * "&amp;". Decode first, then esc(): the visible text is the
 * agency's text, and the pipeline bytes stay untouched. */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  hellip: '…', mdash: '—', ndash: '–', nbsp: ' ',
};
export function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body] != null ? NAMED_ENTITIES[body] : m;
  });
}

/* Repair 2026-10-25 (empty heading): an alert whose header the
 * agency left blank still needs a rider-visible title — derive
 * it from the alert's effect rather than printing an empty <h3>. */
const EFFECT_TITLES = {
  DETOUR: 'Detour', NO_SERVICE: 'No service',
  REDUCED_SERVICE: 'Reduced service', MODIFIED_SERVICE: 'Modified service',
  STOP_MOVED: 'Stop moved', ADDITIONAL_SERVICE: 'Additional service',
};
export function alertHeader(a) {
  const h = decodeEntities(String((a && a.header) || '').trim());
  if (h) return h;
  return EFFECT_TITLES[a && a.effect] || 'Service alert';
}

/** Standard S2 route label: name alone when name == id or the id
 *  is non-numeric, else "Name - Number". */
export function routeLabel(route) {
  if (!route) return '';
  const id = String(route.id);
  if (String(route.name) === id || !/^\d+$/.test(id)) return String(route.name);
  return `${route.name} - ${id}`;
}

/** Standard S3 route order: by name, numeric tiebreak. */
export function compareRoutesS3(a, b) {
  const an = String(a.name), bn = String(b.name);
  if (an !== bn) return an < bn ? -1 : 1;
  const na = Number(a.id), nb = Number(b.id);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a.id) < String(b.id) ? -1 : 1;
}

export { compareVehiclesS3 };

// ------------------------------------------------------------------
// Fold mechanisms (core fold F4) — pure model helpers.
//
// Every helper here is CONFIG-GATED: it reads an OPTIONAL fold
// field and, when the field is absent, its result is the current
// fleet behaviour (empty list / null / pass-through). No city,
// agency or product literal appears anywhere in this section —
// every identifier arrives through config. Sibling-tranche seams
// are resolved dynamically (see dlFn / plannerFn below) so this
// module links and runs whether or not the sibling exports have
// landed yet; the assumed primary export names are stated in the
// F4 delivery report.
// ------------------------------------------------------------------

function dlFn(...names) {
  for (const n of names) {
    if (typeof DataLayer[n] === 'function') return DataLayer[n];
  }
  return null;
}

/** CG-1: configured display-only vehicle feeds (config-gated). */
export function displayVehicleConfigs(cfg = CITY_CONFIG) {
  const list = cfg && cfg.assets && cfg.assets.liveData
    ? cfg.assets.liveData.displayVehicles : null;
  return Array.isArray(list) ? list : [];
}

/** CG-2: configured display-only trip-updates source, or null. */
export function displayTripUpdatesConfig(cfg = CITY_CONFIG) {
  const v = cfg && cfg.assets && cfg.assets.liveData
    ? cfg.assets.liveData.displayTripUpdates : null;
  return v && typeof v === 'object' ? v : null;
}

/** Feed ids that are display-only, from either fold declaration:
 *  the live-data display lists or agency.displayOnlyFeeds. */
export function displayFeedIds(cfg = CITY_CONFIG) {
  const ids = new Set();
  for (const d of displayVehicleConfigs(cfg)) if (d && d.feed) ids.add(String(d.feed));
  const tu = displayTripUpdatesConfig(cfg);
  if (tu && tu.feed) ids.add(String(tu.feed));
  for (const d of (cfg && cfg.agency && cfg.agency.displayOnlyFeeds) || []) ids.add(String(d));
  return ids;
}

export function displayVehiclesConfigured(cfg = CITY_CONFIG) {
  return displayVehicleConfigs(cfg).length > 0;
}

/** The layer group a display feed's surfaces belong to: the group
 *  whose id equals the feed id when one exists, else the group of
 *  the feed's first route, else the feed id itself. */
export function groupIdForDisplayFeed(feed, cfg = CITY_CONFIG, routesByFeed = null) {
  const f = String(feed);
  const groups = (cfg && cfg.layerGroups) || [];
  if (groups.some((g) => g.id === f)) return f;
  if (routesByFeed && routesByFeed[f] && Array.isArray(routesByFeed[f].routes)
    && routesByFeed[f].routes.length && routesByFeed[f].routes[0].group) {
    return String(routesByFeed[f].routes[0].group);
  }
  return f;
}

/** CG-1: the age-note span id for a group (derived from the
 *  group id only — never a hardcoded per-city id). */
export function groupAgeNoteId(groupId) { return `${groupId}-age-note`; }

/** CG-1: freshness model for one display payload, from the
 *  payload's OWN timestamps (never the canonical envelope's). */
export function displayAgeModel(payload, nowMs) {
  if (!payload) return null;
  let genMs = Date.parse(payload.generated_at || payload.generatedAt || '');
  if (!Number.isFinite(genMs) && Array.isArray(payload.vehicles)) {
    for (const v of payload.vehicles) {
      const t = Date.parse((v && v.updated_at) || '');
      if (Number.isFinite(t) && (!Number.isFinite(genMs) || t > genMs)) genMs = t;
    }
  }
  if (!Number.isFinite(genMs)) return null;
  const ageSec = Math.max(0, Math.round((nowMs - genMs) / 1000));
  const ageMin = Math.floor(ageSec / 60);
  const label = ageSec < 45 ? 'updated just now'
    : ageMin < 1 ? `updated ${ageSec} sec ago`
      : ageMin === 1 ? 'updated 1 min ago' : `updated ${ageMin} min ago`;
  return { generatedMs: genMs, ageSec, ageMin, label };
}

/** CG-1 (local fallback, census semantics): a display payload is
 *  dropped WHOLE when missing, malformed, or older than its
 *  configured stale gate; survivors pass through unchanged. */
export function filterFreshDisplayVehicles(payload, staleMs, nowMs) {
  if (!payload || !Array.isArray(payload.vehicles)) return [];
  const genMs = Date.parse(payload.generated_at || '');
  if (Number.isFinite(genMs) && typeof staleMs === 'number' && staleMs > 0
    && nowMs - genMs > staleMs) return [];
  return payload.vehicles;
}

/** CG-1 (local fallback): canonical records followed by every
 *  fresh display record, de-duplicated on agency|vehicle_id with
 *  the canonical record winning. */
export function mergeDisplayVehicleLists(canonical, displayPayloads, nowMs) {
  const out = [];
  const seen = new Set();
  const push = (r) => {
    if (!r) return;
    const k = `${r.agency}|${r.vehicle_id}`;
    if (seen.has(k)) return;
    seen.add(k); out.push(r);
  };
  for (const r of canonical || []) push(r);
  for (const p of displayPayloads || []) {
    for (const r of filterFreshDisplayVehicles(p && p.payload, p && p.staleMs, nowMs)) push(r);
  }
  return out;
}

/** CG-1: is this record a display-only record under cfg? */
export function isDisplayRecord(record, cfg = CITY_CONFIG) {
  if (!record) return false;
  if (record.displayOnly === true) return true;
  const ids = displayFeedIds(cfg);
  if (!ids.size) return false;
  return ids.has(String(record.feed || '')) || ids.has(String(record.agency || ''))
    || ids.has(String(record.family || ''));
}

/** CG-3: merge registry files (in config order) into ONE stop
 *  registry with segment offsets, plus the routes-by-feed map
 *  with the configured recolour applied. Pure: inputs are never
 *  mutated. docs[i] corresponds to segments[i] when segments are
 *  declared; a segment's stopCount bounds that file's slice. */
export function buildMergedRegistry(docs, registryCfg) {
  const files = (registryCfg && registryCfg.files) || [];
  const segments = (registryCfg && registryCfg.segments) || [];
  const recolor = (registryCfg && registryCfg.recolor) || {};
  const stops = [];
  const offsets = {};
  const resolved = [];
  const routesByFeed = {};
  let offset = 0;
  const list = Array.isArray(docs) ? docs : [];
  list.forEach((doc, i) => {
    const seg = segments[i] || null;
    const feed = seg && seg.feed ? String(seg.feed) : (doc && doc.feed ? String(doc.feed) : `feed-${i}`);
    const rawStops = doc && Array.isArray(doc.stops) ? doc.stops : [];
    const take = seg && typeof seg.stopCount === 'number' ? rawStops.slice(0, seg.stopCount) : rawStops;
    offsets[feed] = offset;
    resolved.push({ feed, offset, stopCount: take.length });
    take.forEach((st, j) => stops.push({ ...st, registryIndex: offset + j }));
    offset += take.length;
    const routes = doc && Array.isArray(doc.routes) ? doc.routes : [];
    if (routes.length) {
      routesByFeed[feed] = {
        ...(doc || {}),
        routes: routes.map((r) => (recolor[feed] ? { ...r, color: recolor[feed] } : { ...r })),
      };
    }
    void files;
  });
  const projection = (list[0] && (list[0].projection || (list[0].meta && list[0].meta.projection))) || null;
  return { stopsDoc: { stops, projection }, routesByFeed, offsets, segments: resolved, totalStops: stops.length };
}

/** CG-3: apply ONLY the recolour to an already-loaded
 *  routes-by-feed map (feed -> colour), returning new route
 *  objects; feeds without a recolour entry pass through. */
export function applyRegistryRecolor(routesByFeed, recolor) {
  if (!recolor || !routesByFeed) return routesByFeed;
  const out = {};
  for (const [feed, doc] of Object.entries(routesByFeed)) {
    if (!doc || !Array.isArray(doc.routes) || !recolor[feed]) { out[feed] = doc; continue; }
    out[feed] = { ...doc, routes: doc.routes.map((r) => ({ ...r, color: recolor[feed] })) };
  }
  return out;
}

/** CG-3: which resolved segment contains a registry index. */
export function registrySegmentForIndex(index, resolvedSegments) {
  if (!Array.isArray(resolvedSegments)) return null;
  for (const s of resolvedSegments) {
    if (index >= s.offset && index < s.offset + s.stopCount) return s;
  }
  return null;
}

/** CG-3: the gated street-extension tier is shown only while
 *  its gating group is displayed; no gate configured = shown. */
export function streetExtVisibleForGroups(groupVisibility, gatedByGroup) {
  if (!gatedByGroup) return true;
  return !!(groupVisibility && groupVisibility[gatedByGroup]);
}

/** CG-10: a group's toggle state is persisted unless the group
 *  declares persist === false (session-only). */
export function groupPersistEnabled(group) {
  return !group || group.persist !== false;
}

/** CG-10: the hide-idle decision for one route. Exempt route ids
 *  are never hidden by this filter. */
export function shouldHideRouteForIdle({ routeId, runningState, hideIdleOn, exemptRoutes } = {}) {
  if (!hideIdleOn) return false;
  if (Array.isArray(exemptRoutes) && exemptRoutes.includes(routeId)) return false;
  return runningState === 'not-running';
}

/** CG-10: near-me radius — cfg filters radius field when present,
 *  else the census value. */
export function nearMeRadiusM(cfg = CITY_CONFIG) {
  const f = (cfg && cfg.filters) || {};
  if (typeof f.nearMeRadiusM === 'number') return f.nearMeRadiusM;
  if (typeof f.radius === 'number') return f.radius;
  return 1250;
}

/** CG-10: route ids serving any stop within radiusM of a centre
 *  point, in projected (metre) coordinates. Pure. */
export function computeNearMeRouteIds(stops, center, radiusM) {
  const ids = new Set();
  if (!center || typeof center.x !== 'number') return ids;
  for (const st of stops || []) {
    if (typeof st.x !== 'number' || typeof st.z !== 'number') continue;
    if (Math.hypot(st.x - center.x, st.z - center.z) <= radiusM) {
      for (const rid of st.r || []) ids.add(rid);
    }
  }
  return ids;
}

/** CG-10: snapshot of per-route visibility (routeId -> bool). */
export function snapshotRouteVisibility(routeIds, visibleFn) {
  const snap = new Map();
  for (const id of routeIds || []) snap.set(id, !!visibleFn(id));
  return snap;
}

/** CG-5: normalise one external station record (data-layer GBFS
 *  record shape) to the card fields: name / capacity / available. */
export function stationCardModel(record) {
  if (!record) return null;
  return {
    kind: 'station',
    stationId: record.id != null ? String(record.id) : (record.station_id != null ? String(record.station_id) : ''),
    name: record.name || record.station_name || '',
    capacity: typeof record.capacity === 'number' ? record.capacity : null,
    available: typeof record.available === 'number' ? record.available
      : (typeof record.num_bikes_available === 'number' ? record.num_bikes_available : null),
    docksAvailable: typeof record.docksAvailable === 'number' ? record.docksAvailable
      : (typeof record.num_docks_available === 'number' ? record.num_docks_available : null),
  };
}

/** CG-5 (local fallback): join station-information and
 *  station-status payloads into station records. */
export function joinGbfsStations(infoDoc, statusDoc) {
  const infos = (infoDoc && infoDoc.data && infoDoc.data.stations) || [];
  const byId = new Map();
  for (const s of ((statusDoc && statusDoc.data && statusDoc.data.stations) || [])) {
    byId.set(String(s.station_id), s);
  }
  return infos.map((s) => {
    const st = byId.get(String(s.station_id)) || {};
    return {
      id: String(s.station_id), name: s.name || '',
      capacity: typeof s.capacity === 'number' ? s.capacity : null,
      available: typeof st.num_bikes_available === 'number' ? st.num_bikes_available : null,
      docksAvailable: typeof st.num_docks_available === 'number' ? st.num_docks_available : null,
      lat: typeof s.lat === 'number' ? s.lat : null,
      lon: typeof s.lon === 'number' ? s.lon : null,
    };
  });
}

/** CG-13 (history paint half): vehicle records from a telemetry-
 *  shaped history document. Structurally carries no display-only
 *  agencies (chain property of the file, not a filter here). */
export function historyVehiclesFromDoc(doc) {
  const list = Array.isArray(doc) ? doc
    : (doc && Array.isArray(doc.vehicles) ? doc.vehicles
      : (doc && doc.data && Array.isArray(doc.data.vehicles) ? doc.data.vehicles : []));
  return list.filter((r) => r && typeof r.lat === 'number' && typeof r.lon === 'number');
}

/** CG-14: passes-tab model — disclaimer + outbound links only.
 *  No fare figures are read or rendered, ever. */
export function buildPassesModel(cfg = CITY_CONFIG) {
  const p = cfg && cfg.page ? cfg.page.passesTab : null;
  if (!p) return null;
  return {
    disclaimer: typeof p.disclaimer === 'string' ? p.disclaimer : '',
    links: (Array.isArray(p.links) ? p.links : [])
      .filter((l) => l && typeof l.url === 'string' && l.url)
      .map((l) => ({ label: typeof l.label === 'string' && l.label ? l.label : l.url, url: l.url })),
  };
}

/** CG-14: departure-board link model (string or {url,label}). */
export function boardLinkModel(cfg = CITY_CONFIG) {
  const b = cfg && cfg.page ? cfg.page.boardLink : null;
  if (!b) return null;
  if (typeof b === 'string') return b ? { url: b, label: 'Departure board' } : null;
  if (typeof b === 'object' && (b.url || b.href)) {
    return { url: b.url || b.href, label: b.label || 'Departure board' };
  }
  return null;
}

/** CG-14: empirical speed prior from timed samples — the model
 *  function the departure-suggestion surface consumes when no
 *  platform/renderer seam exposes a prior. Median of per-sample
 *  speeds; empty/invalid samples fall back to the given value. */
export function empiricalSpeedMpsFromSamples(samples, fallbackMps) {
  const speeds = [];
  for (const s of samples || []) {
    if (s && typeof s.distanceM === 'number' && typeof s.durationSec === 'number'
      && s.durationSec > 0 && s.distanceM >= 0) speeds.push(s.distanceM / s.durationSec);
  }
  if (!speeds.length) return typeof fallbackMps === 'number' ? fallbackMps : null;
  speeds.sort((a, b) => a - b);
  return speeds[Math.floor(speeds.length / 2)];
}

/** CG-14: departure suggestions for a stop's upcoming arrivals.
 *  Each suggestion carries a leave-by instant = arrival minus the
 *  walk time at the applicable speed (the empirical prior when
 *  one is available, else the configured walk speed). Pure. */
export function buildDepartureSuggestions({ arrivals, walkDistanceM, walkSpeedMps, speedPriorMps, atMs } = {}) {
  const speed = typeof speedPriorMps === 'number' && speedPriorMps > 0 ? speedPriorMps
    : (typeof walkSpeedMps === 'number' && walkSpeedMps > 0 ? walkSpeedMps : null);
  const walkSec = speed && typeof walkDistanceM === 'number' ? walkDistanceM / speed : null;
  return (arrivals || []).slice(0, 3).map((r) => ({
    routeId: r.routeId, routeLabel: r.routeLabel || null, headsign: r.headsign || null,
    timeMs: r.timeMs, kind: r.kind || null,
    leaveByMs: walkSec != null && typeof r.timeMs === 'number' ? r.timeMs - walkSec * 1000 : null,
    feasible: walkSec != null && typeof r.timeMs === 'number' && typeof atMs === 'number'
      ? r.timeMs - walkSec * 1000 >= atMs : null,
    speedBasis: speedPriorMps != null && speedPriorMps > 0 ? 'prior' : 'walk-speed',
  }));
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function compassOf(bearing) {
  if (typeof bearing !== 'number' || !Number.isFinite(bearing)) return null;
  return COMPASS[Math.round(((bearing % 360) + 360) % 360 / 45) % 8];
}

// ------------------------------------------------------------------
// City-timezone + GTFS service-day math (LT-S5 scheduled rows).
// Semantics are GTFS calendar/calendar_dates, and the harness
// verifies the active-service set against the hosted engine's own
// servicesFor() over a battery of dates — equivalence is proven,
// not assumed.
// ------------------------------------------------------------------

const TZ = CITY_CONFIG.city.timezone;

// Posture copy (SF-5): the fleet's only behavioral fork becomes data.
// A static-posture city (config posture.model = 'static') renders the
// non-publication copy family carried in its config (posture.copy);
// a live city renders the platform live strings. The branch reads the
// posture field — never a city identity.
const POSTURE_COPY = CITY_CONFIG.posture && CITY_CONFIG.posture.model === 'static'
  ? CITY_CONFIG.posture.copy : null;

function tzOffsetMs(ms) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(ms))) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - Math.floor(ms / 1000) * 1000;
}

/** Local (city-tz) calendar parts for an instant. dowMon0: Mon=0. */
export function localParts(ms) {
  const off = tzOffsetMs(ms);
  const d = new Date(ms + off);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    dowMon0: (d.getUTCDay() + 6) % 7,
    secondsOfDay: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(),
  };
}

export function ymdOfParts(p) { return p.y * 10000 + p.m * 100 + p.d; }

/** Epoch ms of local midnight for a y/m/d in the city timezone. */
export function localMidnightMs(y, m, d) {
  const guess = Date.UTC(y, m - 1, d);
  return guess - tzOffsetMs(guess);
}

function partsOfYmd(ymd) {
  return { y: Math.floor(ymd / 10000), m: Math.floor(ymd / 100) % 100, d: ymd % 100 };
}

/** Shift a ymd (YYYYMMDD number) by whole days. */
export function shiftYmd(ymd, days) {
  const p = partsOfYmd(ymd);
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d) + days * 86400000);
  return t.getUTCFullYear() * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate();
}

/** GTFS service activity on a service day (mask + exceptions).
 *  assetData: the compiled timetable asset ({services,
 *  service_exceptions}). Returns the Set of active service INDEX
 *  values (positions in assetData.services). */
export function activeServicesOn(assetData, ymd) {
  const p = partsOfYmd(ymd);
  const dowMon0 = (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7;
  const active = new Set();
  assetData.services.forEach((svc, i) => {
    const start = Number(svc.start), end = Number(svc.end);
    if (ymd >= start && ymd <= end && svc.mask[dowMon0] === 1) active.add(i);
  });
  const ymdStr = String(ymd);
  for (const ex of assetData.service_exceptions || []) {
    if (ex.date !== ymdStr) continue;
    const idx = assetData.services.findIndex((s) => s.id === ex.service);
    if (idx < 0) continue;
    if (ex.added === 1) active.add(idx);
    else if (ex.added === 2) active.delete(idx);
  }
  return active;
}

/** Format an epoch ms as a city-local clock ("1:37 AM"). */
export function fmtClock(ms) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: 'numeric', minute: '2-digit',
  }).format(new Date(ms));
}

/** "in 12 min" / "now" / clock for an arrival epoch. */
export function fmtArrival(ms, nowMs) {
  const mins = Math.round((ms - nowMs) / 60000);
  if (mins <= 0) return 'now';
  if (mins === 1) return 'in 1 min';
  if (mins < 60) return `in ${mins} min`;
  return fmtClock(ms);
}

// ------------------------------------------------------------------
// Degradation evaluation (LT-S8.2 / LT-KAES-40): measured feed
// states, evaluated in a FIXED order — poll failure, stale
// envelope, source down, source partial. Vehicle counts are never
// a signal. The notice names what still works.
// ------------------------------------------------------------------

export const DEGRADATION_ORDER = Object.freeze([
  'poll-failure', 'stale-envelope', 'source-down', 'source-partial',
]);

export function evaluateDegradation({ vehiclesError = null, vehicles = null, nowMs }) {
  const stillWorks = 'The planner still works from the published timetable, and the map still shows the last data received.';
  if (vehiclesError) {
    return {
      kind: 'poll-failure',
      signature: `poll-failure:${String(vehiclesError.message || vehiclesError).slice(0, 80)}`,
      message: `Live vehicle updates are failing (${esc(vehiclesError.message || vehiclesError)}). ${stillWorks}`,
    };
  }
  if (!vehicles) return null;
  const genMs = Date.parse(vehicles.generated_at);
  // T1 RECONCILIATION (2026-10-30): design C.2 specified a posture
  // short-circuit here (static cities skip live-staleness). The
  // static city's own harness contradicts it — its U5-01 feeds
  // a stale envelope and asserts it IS flagged, and all seven v1
  // builds carry this evaluation unbranched. The generic behavior
  // wins; the field stays in config as documentation of the served
  // behavior. Design iteration 3 owns the re-specification.
  if (Number.isFinite(genMs) && nowMs - genMs > CITY_CONFIG.freshness.degradedAfterMs) {
    const ageMin = Math.round((nowMs - genMs) / 60000);
    return {
      kind: 'stale-envelope',
      signature: `stale-envelope:${vehicles.generated_at}`,
      message: `Live vehicle data is ${ageMin} minutes old — it has stopped advancing. ${stillWorks}`,
    };
  }
  const sources = vehicles.sources || {};
  const down = Object.entries(sources).filter(([, s]) => s && s.ok === false).map(([k]) => k);
  if (down.length) {
    return {
      kind: 'source-down',
      signature: `source-down:${down.slice().sort().join(',')}`,
      message: `The ${down.join(' and ')} vehicle feed is down. Everything else is publishing normally. ${stillWorks}`,
    };
  }
  const legs = vehicles.legs || null;
  if (legs && typeof legs === 'object') {
    const badLegs = Object.entries(legs)
      .filter(([, l]) => l && l.ok === false)
      .map(([k]) => k);
    if (badLegs.length) {
      return {
        kind: 'source-partial',
        signature: `source-partial:${badLegs.slice().sort().join(',')}`,
        message: `Part of the live data is missing (leg ${badLegs.join(', ')}). The rest is publishing normally. ${stillWorks}`,
      };
    }
  }
  return null;
}

// ------------------------------------------------------------------
// The surfaces factory. deps:
//   document    DOM document (the browser's, or a harness fake)
//   storage     localStorage-shaped store (KAES-37 keys)
//   renderer    the R3 renderer api (headless or materialized)
//   plannerHost an R4 planner host (createPlannerHost())
//   fetchImpl   injectable fetch, harness-injected; default = loader path
//   nowFn       () -> epoch ms; default Date.now
// ------------------------------------------------------------------

export function createSurfaces(deps = {}) {
  const doc = deps.document || (typeof document !== 'undefined' ? document : null);
  const storage = deps.storage
    || (typeof localStorage !== 'undefined' ? localStorage : null);
  const renderer = deps.renderer || null;
  const host = deps.plannerHost || null;
  const fetchImpl = deps.fetchImpl;
  const nowFn = deps.nowFn || (() => Date.now());
  const config = CITY_CONFIG;

  const state = {
    mounted: false,
    vehicles: null, alerts: null, tripUpdates: null,
    vehiclesError: null,
    tuByTrip: new Map(), tuByStop: new Map(),
    vehiclesByKey: new Map(),
    degraded: null, degradedDismissedSig: null,
    card: null, // {kind:'stop'|'vehicle'|'route', id}
    cardCovered: false, // T6 parity β: ride card covers the info card (monolith cover semantics)
    launcher: 'open',
    places: { enabled: false, status: 'off', places: [], note: null, fetches: 0 },
    planner: {
      fromIdx: null, toIdx: null, fromLabel: '', toLabel: '',
      busy: false, result: null, error: null, loaded: false,
    },
    browse: { routeQuery: '', stopQuery: '', stopGroups: [], tab: 'routes' },
    tt: { status: 'idle', tripIndexById: new Map(), sidecarByGeom: new Map() },
    // Fold state (F4) — every field below is inert unless its
    // config gate is present; fleet configs carry none of them.
    display: {
      byFeed: new Map(), // feed -> { payload, config }
      mergedIntoRenderer: false,
      separate: [], // display records delivered apart from the canonical envelope
      headsigns: new Map(), // trip/route key -> headsign (sidecar join)
      tuByStop: new Map(), // geom stop id -> display-TU rows (fenced store)
      tuPayload: null,
    },
    registry: null, // CG-3 buildMergedRegistry result (boot)
    layers: {
      staticOn: new Map(), staticData: new Map(),
      externalOn: new Map(), stations: [], stationsStatus: 'off', timers: [],
    },
    filtersState: {
      hideIdleOn: false, idleHidden: new Set(),
      nearMeActive: false, nearMeSnapshot: null, nearMeCenter: null,
    },
    betaTiles: new Map(), // CG-14 tile key -> bool
    historyPainted: false,
    groupNotesEl: null, layerTogglesEl: null, filterExtrasEl: null,
  };

  // ---- fold config accessors (absent field = mechanism off) ----
  const filtersCfg = config.filters && typeof config.filters === 'object' ? config.filters : null;
  const registryCfg = config.assets && config.assets.routesRegistry
    && typeof config.assets.routesRegistry === 'object' ? config.assets.routesRegistry : null;
  const staticLayersCfg = config.assets && Array.isArray(config.assets.staticLayers)
    ? config.assets.staticLayers : [];
  const externalLayersCfg = config.assets && Array.isArray(config.assets.externalLayers)
    ? config.assets.externalLayers : [];
  const sponsoredIds = config.page && config.page.sponsoredSpanIds
    && typeof config.page.sponsoredSpanIds === 'object' ? config.page.sponsoredSpanIds : null;
  const passesModel = buildPassesModel(config);
  const boardLink = boardLinkModel(config);
  const betaCfg = config.betaFeatures && typeof config.betaFeatures === 'object'
    ? config.betaFeatures : null;
  const historyUrl = config.ops && config.ops.clientRecovery
    && typeof config.ops.clientRecovery.historyUrl === 'string'
    ? config.ops.clientRecovery.historyUrl : null;
  for (const l of staticLayersCfg) state.layers.staticOn.set(l.id, l.defaultOn === true);
  for (const l of externalLayersCfg) state.layers.externalOn.set(l.id, l.defaultOn === true);

  const rideAlong = createRideAlong({
    model: renderer ? renderer.model : null,
    tuByTrip: () => state.tuByTrip,
    scheduledTimeFor: (tripId, stop) => scheduledTimeForTrip(tripId, stop),
  });

  const el = (id) => (doc ? doc.getElementById(id) : null);
  const now = () => nowFn();

  // ---------- indexes over the published family ----------

  function geomStopId(family, rawStopId) {
    return `${family === 'rail' ? 'R' : 'B'}:${rawStopId}`;
  }

  function rebuildIndexes() {
    state.tuByTrip = new Map();
    state.tuByStop = new Map();
    for (const tu of (state.tripUpdates && state.tripUpdates.trip_updates) || []) {
      if (tu.trip_id) state.tuByTrip.set(tu.trip_id, tu);
      for (const stu of tu.stop_time_updates || []) {
        const gid = geomStopId(tu.family, stu.stop_id);
        if (!state.tuByStop.has(gid)) state.tuByStop.set(gid, []);
        state.tuByStop.get(gid).push({ tu, stu });
      }
    }
    state.vehiclesByKey = new Map();
    for (const r of (state.vehicles && state.vehicles.vehicles) || []) {
      state.vehiclesByKey.set(`${r.agency}|${r.vehicle_id}`, r);
    }
  }

  function routeOf(record) {
    const byId = (renderer && renderer.model.state.routeById) || {};
    return resolveRouteId(byId, record && record.route_id);
  }

  function routesSorted() {
    const routes = (renderer && renderer.model.state.routes) || [];
    return routes.slice().sort(compareRoutesS3);
  }

  function activeAlerts(atMs) {
    const all = (state.alerts && state.alerts.alerts) || [];
    return all.filter((a) => {
      const periods = a.active_periods || [];
      if (!periods.length) return true;
      return periods.some((p) => {
        const start = typeof p.start_epoch === 'number' ? p.start_epoch * 1000 : -Infinity;
        const end = typeof p.end_epoch === 'number' ? p.end_epoch * 1000 : Infinity;
        return atMs >= start && atMs <= end;
      });
    });
  }

  // ---------- status line (LT-S3.1) ----------

  // CG-1: display records delivered apart from the canonical
  // envelope are counted in the header total; records merged into
  // the renderer envelope are already inside stats.markers, so
  // this counts only the separate remainder (no double count).
  function displaySeparateCount() {
    if (!displayVehiclesConfigured(config)) return 0;
    let n = 0;
    for (const r of state.display.separate) {
      if (typeof r.lat !== 'number' || typeof r.lon !== 'number') continue;
      if (state.vehiclesByKey.has(`${r.agency}|${r.vehicle_id}`)) continue;
      n++;
    }
    return n;
  }

  function statusModel() {
    const stats = renderer ? renderer.stats() : null;
    const markers = (stats ? stats.markers : 0) + displaySeparateCount();
    const unassigned = stats ? stats.unassignedMarkers : 0;
    let text;
    if (!state.vehicles && !state.display.separate.length) text = POSTURE_COPY ? POSTURE_COPY.statusLoading : 'Loading live vehicles…';
    else if (markers === 0) text = POSTURE_COPY ? POSTURE_COPY.statusZero : 'No vehicles live right now';
    else text = `${markers} vehicle${markers === 1 ? '' : 's'} live`;
    if (state.vehicles && unassigned > 0) {
      text += ` · ${unassigned} reporting without a route assignment`;
    }
    if (state.vehicles && state.vehicles.generated_at) {
      text += ` · updated ${fmtClock(Date.parse(state.vehicles.generated_at))}`;
    }
    return { text, markers, unassigned };
  }

  function renderStatus() {
    const n = el('lt-status');
    if (n) n.textContent = statusModel().text;
  }

  // ---------- CG-1 / CG-2 display-only surfaces -------------------
  // Fenced: these helpers read ONLY the display store; canonical
  // arrivals/vehicle state is never written from here.

  /** Headsign for a display trip/route: the data-layer lookup
   *  (displayHeadsignFor(lookup, query)) over the sidecar map
   *  loaded at boot, else a direct map read, else null. */
  function displayHeadsignFor(key) {
    if (key == null) return null;
    const fn = dlFn('displayHeadsignFor');
    if (fn) {
      try {
        const v = fn(state.display.headsigns, key);
        if (v) return v;
      } catch { /* fall through to the direct map read */ }
    }
    return state.display.headsigns.get(String(key)) || null;
  }

  /** Does this geometry stop belong to a display-only feed?
   *  Decided from the feeds of the routes serving the stop. */
  function isDisplayStop(stop) {
    const ids = displayFeedIds(config);
    if (!ids.size || !stop || !renderer) return false;
    const feedOf = (renderer.model.state && renderer.model.state.feedOfRoute) || {};
    return (stop.r || []).some((rid) => ids.has(String(feedOf[rid] || '')));
  }

  /** CG-2: display-TU arrival rows for one stop, from the
   *  data-layer export when present, else the fenced local store
   *  built at ingest. Rows are render-ready and carry their own
   *  freshness (whenText computed from the row's own time). */
  function displayTuRowsFor(stop, atMs) {
    if (!isDisplayStop(stop)) return [];
    const out = [];
    const seen = new Set();
    const push = (r) => {
      if (!r || typeof r.timeMs !== 'number') return;
      if (r.timeMs < atMs - 120000 || r.timeMs > atMs + 90 * 60000) return;
      const k = `${r.routeId}|${r.timeMs}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ ...r, whenText: fmtArrival(r.timeMs, atMs) });
    };
    // Data-layer store first: displayTuRowsForStop(stopId) reads
    // the layer's own ingested map (rows carry arrival_time /
    // departure_time in epoch seconds).
    const fn = dlFn('displayTuRowsForStop');
    if (fn) {
      try {
        for (const r of fn(stop.id) || []) {
          const t = r.arrival_time != null ? r.arrival_time
            : r.departure_time != null ? r.departure_time
              : r.timeMs != null ? r.timeMs : (typeof r.time === 'number' ? r.time : null);
          push({
            routeId: r.route_id != null ? r.route_id : r.routeId,
            routeLabel: r.routeLabel || String(r.route_id != null ? r.route_id : (r.routeId || '')),
            headsign: r.headsign || displayHeadsignFor(r.trip_id || r.tripId) || null,
            timeMs: typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : null,
            kind: 'live', displayOnly: true,
            vehicleId: r.vehicle_id || r.vehicleId || null,
            agency: r.agency || config.agency.id,
          });
        }
      } catch { /* the fenced local store below still applies */ }
    }
    for (const r of state.display.tuByStop.get(stop.id) || []) push(r);
    return out.sort((a, b) => a.timeMs - b.timeMs);
  }

  /** Ingest one display-TU payload into the fenced store. The
   *  payload is dropped whole past its stale gate. Accepted
   *  shapes: { trip_updates[] } in the canonical TU shape,
   *  { trips[] } in the served display shape (flat epoch-second
   *  arrival_time / departure_time on each stop_time_update —
   *  T6 parity α, 2026-10-31), or
   *  { rowsByStop / byStop: { stopId: rows[] } }. */
  function ingestDisplayTripUpdates(payload, cfgEntry) {
    state.display.tuPayload = payload || null;
    state.display.tuByStop = new Map();
    if (!payload) return;
    const staleMs = cfgEntry && typeof cfgEntry.staleMs === 'number' ? cfgEntry.staleMs : null;
    const genMs = Date.parse(payload.generated_at || '');
    if (Number.isFinite(genMs) && staleMs && now() - genMs > staleMs) return;
    const feed = cfgEntry && cfgEntry.feed ? String(cfgEntry.feed) : '';
    const pushRow = (gid, row) => {
      if (!state.display.tuByStop.has(gid)) state.display.tuByStop.set(gid, []);
      state.display.tuByStop.get(gid).push(row);
    };
    const tuList = Array.isArray(payload.trip_updates) ? payload.trip_updates
      : Array.isArray(payload.trips) ? payload.trips : null;
    if (tuList) {
      for (const tu of tuList) {
        for (const stu of tu.stop_time_updates || []) {
          const ev = stu.arrival || stu.departure;
          const evSec = ev && typeof ev.time === 'number' ? ev.time
            : typeof stu.arrival_time === 'number' ? stu.arrival_time
              : typeof stu.departure_time === 'number' ? stu.departure_time : null;
          if (evSec == null) continue;
          const raw = String(stu.stop_id || '').split(':').pop();
          pushRow(geomStopId(tu.family || feed, raw), {
            routeId: tu.route_id, routeLabel: String(tu.route_id || ''),
            headsign: displayHeadsignFor(tu.trip_id) || null,
            timeMs: evSec * 1000, kind: 'live', displayOnly: true,
            vehicleId: tu.vehicle_id || null, agency: tu.agency || config.agency.id,
          });
        }
      }
    }
    const byStop = payload.rowsByStop || payload.byStop || null;
    if (byStop && typeof byStop === 'object') {
      for (const [sid, rows] of Object.entries(byStop)) {
        const gid = sid.includes(':') ? sid : geomStopId(feed, String(sid).split(':').pop());
        for (const r of rows || []) {
          pushRow(gid, {
            routeId: r.routeId != null ? r.routeId : r.route_id,
            routeLabel: r.routeLabel || String(r.routeId != null ? r.routeId : (r.route_id || '')),
            headsign: r.headsign || displayHeadsignFor(r.trip_id || r.tripId) || null,
            timeMs: r.timeMs != null ? r.timeMs : (typeof r.time === 'number' ? r.time * 1000 : null),
            kind: 'live', displayOnly: true,
            vehicleId: r.vehicleId || r.vehicle_id || null,
            agency: r.agency || config.agency.id,
          });
        }
      }
    }
  }

  /** CG-1: per-group note model for display-fed groups: route
   *  count line + the freshness label from that feed's own
   *  payload. One entry per configured display feed. */
  function groupNotesModel() {
    if (!displayVehiclesConfigured(config)) return [];
    const atMs = now();
    const routes = (renderer && renderer.model.state.routes) || [];
    return displayVehicleConfigs(config).map((d) => {
      const feed = String(d.feed);
      let groupId = groupIdForDisplayFeed(feed, config, null);
      if (groupId === feed && renderer && renderer.model.state) {
        const feedOf = renderer.model.state.feedOfRoute || {};
        const first = routes.find((r) => String(feedOf[r.id] || '') === feed);
        if (first && first.group) groupId = String(first.group);
      }
      const groupRoutes = routes.filter((r) => r.group === groupId);
      const entry = state.display.byFeed.get(feed);
      const age = entry ? displayAgeModel(entry.payload, atMs) : null;
      return {
        feed, groupId,
        noteId: groupAgeNoteId(groupId),
        routesCount: groupRoutes.length,
        text: `All ${groupRoutes.length} routes have map lines.`,
        ageLabel: age ? age.label : 'waiting for first update',
        ageSec: age ? age.ageSec : null,
      };
    });
  }

  function renderGroupNotes() {
    if (!displayVehiclesConfigured(config)) return;
    const panel = el('lt-filter-panel');
    if (!panel || !doc) return;
    if (!state.groupNotesEl) {
      state.groupNotesEl = doc.createElement('div');
      state.groupNotesEl.id = 'lt-group-notes';
      panel.appendChild(state.groupNotesEl);
    }
    state.groupNotesEl.innerHTML = groupNotesModel().map((g) => `
      <p class="lt-group-note" data-group-note="${esc(g.groupId)}">${esc(g.text)}
        <span id="${esc(g.noteId)}">${esc(g.ageLabel)}</span></p>`).join('');
  }

  /** CG-3 streetExt sub-item — PARKED (F7 integration, 2026-10-31):
   *  the core geometry carries NO street-extension tier (streets
   *  docs and scene-model loadGeometry know only freeway /
   *  arterial / local), so there is no tier and no visibility seam
   *  in the renderer to drive. The gated decision is still computed
   *  and recorded in state (streetExtVisibleForGroups is asserted by
   *  fixtures); it takes effect only when a future tranche adds the
   *  tier + seam to the geometry/scene-model. No seam is probed or
   *  called here — a probe against a non-existent seam would be a
   *  permanent no-op dressed as wiring. */
  function syncStreetExtVisibility() {
    if (!registryCfg) return;
    const gatedBy = registryCfg.streetExtGatedByGroup || null;
    const groups = {};
    if (renderer && renderer.model.state.groups) Object.assign(groups, renderer.model.state.groups);
    else for (const g of config.layerGroups) groups[g.id] = g.defaultOn === true;
    state.streetExtVisible = streetExtVisibleForGroups(groups, gatedBy);
  }

  // ---------- alerts region (LT-KAES-34 surface half / LT-S8.1) ----

  const SEVERITY_RANK = { SEVERE: 0, WARNING: 1, INFO: 2, UNKNOWN_SEVERITY: 3 };

  function alertsModel() {
    const act = activeAlerts(now()).slice().sort((a, b) => {
      const ra = SEVERITY_RANK[a.severity] != null ? SEVERITY_RANK[a.severity] : 3;
      const rb = SEVERITY_RANK[b.severity] != null ? SEVERITY_RANK[b.severity] : 3;
      if (ra !== rb) return ra - rb;
      return String(a.header || '') < String(b.header || '') ? -1 : 1;
    });
    return act.map((a) => {
      const routes = [];
      for (const e of a.informed_entities || []) {
        if (e.route_id) {
          const r = resolveRouteId((renderer && renderer.model.state.routeById) || {}, e.route_id);
          routes.push(r ? routeLabel(r) : String(e.route_id));
        }
      }
      return {
        id: a.id, header: alertHeader(a), description: decodeEntities(a.description || ''),
        severity: a.severity || null, routes: [...new Set(routes)],
        url: a.url || null,
      };
    });
  }

  function renderAlerts() {
    const n = el('lt-alerts');
    if (!n) return;
    const list = alertsModel();
    if (!state.alerts) {
      n.innerHTML = '<h2>Service alerts</h2><p>Loading alerts…</p>';
      return;
    }
    if (!list.length) {
      n.innerHTML = '<h2>Service alerts</h2><p>No active service alerts.</p>';
      return;
    }
    // Repair 2026-10-25: no "Details" exit link. Every record's
    // url is the agency's generic alerts index — the link exited
    // the product to a page that does not carry the specific
    // alert — while the full alert text already renders here, in
    // product, directly under the header.
    n.innerHTML = `<h2>Service alerts (${list.length})</h2>` + list.map((a) => `
      <article class="lt-alert">
        <h3>${esc(a.header)}</h3>
        ${a.routes.length ? `<p class="lt-alert-routes">Affects: ${esc(a.routes.join(', '))}</p>` : '<p class="lt-alert-routes">System-wide</p>'}
        <p>${esc(a.description)}</p>
      </article>`).join('');
  }

  // ---------- degradation + load-error (LT-KAES-40 / LT-S8.2) ------

  function renderDegraded() {
    const n = el('lt-degraded');
    if (!n) return;
    const d = state.degraded;
    if (!d || d.signature === state.degradedDismissedSig) {
      n.style.display = 'none';
      n.innerHTML = '';
      return;
    }
    n.style.display = 'block';
    n.innerHTML = `<p><strong>Service notice:</strong> ${d.message}</p>
      <p><button type="button" data-action="degraded-dismiss">Dismiss</button></p>`;
  }

  function showLoadError(err) {
    const n = el('lt-load-error');
    if (!n) return;
    n.style.display = 'block';
    n.innerHTML = `<p><strong>Could not load route data.</strong> Please check your connection and reload.</p>
      <p><button type="button" data-action="retry-boot">Retry</button></p>`;
    void err;
  }

  function clearLoadError() {
    const n = el('lt-load-error');
    if (n) { n.style.display = 'none'; n.innerHTML = ''; }
  }

  /** Ingest one poll cycle's results (or errors) and re-render
   *  every derived surface — the same entry the boot poll loop
   *  calls, so a poll and the harness exercise one path. */
  function setData({ vehicles, alerts, tripUpdates, vehiclesError, displayVehicles, displayTripUpdates } = {}) {
    if (vehicles !== undefined) state.vehicles = vehicles;
    if (alerts !== undefined) state.alerts = alerts;
    if (tripUpdates !== undefined) state.tripUpdates = tripUpdates;
    if (vehiclesError !== undefined) state.vehiclesError = vehiclesError;
    // CG-1/CG-2 fenced ingest: display payloads land in their own
    // store. When a payload arrives already merged into the
    // canonical envelope (data-layer merge), only its freshness
    // record is kept here; when it arrives apart, its fresh
    // records are kept as the separate remainder for the header
    // total and the map is handed the merged set.
    if (displayVehicles !== undefined && displayVehiclesConfigured(config)) {
      const entries = Array.isArray(displayVehicles) ? displayVehicles : [displayVehicles];
      state.display.separate = [];
      for (const e of entries) {
        if (!e) continue;
        const payload = e.payload || e;
        const feed = String(e.feed || (e.config && e.config.feed) || payload.feed || '');
        const cfgEntry = e.config || displayVehicleConfigs(config).find((d) => String(d.feed) === feed) || {};
        if (feed) state.display.byFeed.set(feed, { payload, config: cfgEntry });
        if (e.merged) continue;
        const staleMs = typeof cfgEntry.staleMs === 'number' ? cfgEntry.staleMs : null;
        for (const r of filterFreshDisplayVehicles(payload, staleMs, now())) {
          state.display.separate.push(r);
        }
      }
      if (state.display.separate.length && state.vehicles && renderer) {
        const merged = mergeDisplayVehicleLists(state.vehicles.vehicles, entries.map((e) => ({
          payload: e.payload || e,
          staleMs: (() => { const c = e.config || displayVehicleConfigs(config).find((d) => String(d.feed) === String(e.feed || (e.payload || e).feed || '')) || {}; return typeof c.staleMs === 'number' ? c.staleMs : null; })(),
        })), now());
        renderer.setVehicles({ ...state.vehicles, vehicles: merged, count: merged.length });
      }
    }
    if (displayTripUpdates !== undefined) {
      const cfgEntry = displayTripUpdates && displayTripUpdates.config
        ? displayTripUpdates.config : displayTripUpdatesConfig(config);
      ingestDisplayTripUpdates(displayTripUpdates && displayTripUpdates.payload
        ? displayTripUpdates.payload : displayTripUpdates, cfgEntry);
    }
    rebuildIndexes();
    if (renderer && state.vehicles) renderer.setVehicles(state.vehicles);
    rideAlong.update((state.vehicles && state.vehicles.vehicles) || []);
    const d = evaluateDegradation({
      vehiclesError: state.vehiclesError, vehicles: state.vehicles, nowMs: now(),
    });
    if (!d) state.degradedDismissedSig = null; // reset when the condition clears
    state.degraded = d;
    renderStatus();
    renderAlerts();
    renderDegraded();
    renderLauncher();
    renderRideAlong();
    renderGroupNotes();
    if (state.filtersState.hideIdleOn) applyIdleFilter();
    // Browse counts follow a poll too — unless the rider is typing
    // in it right now (a re-render must never eat keystrokes).
    const ae = doc && doc.activeElement;
    const typing = ae && ae.dataset
      && (ae.dataset.role === 'route-search' || ae.dataset.role === 'stop-search');
    if (!typing) renderBrowse();
    if (state.card) renderCard();
  }

  // ---------- timetable enrichment (lazy, LT-KAES-05) --------------

  /** Load the planner host + trip-map on first need. Idempotent;
   *  failures leave tt.status 'error' and the surfaces render
   *  their timetable-free form (never a blank card). */
  async function ensureTimetable() {
    if (state.tt.status === 'ready') return true;
    if (state.tt.status === 'loading') return false;
    if (!host) { state.tt.status = 'error'; return false; }
    state.tt.status = 'loading';
    try {
      await host.loadPlanner({
        assetUrl: `planner/assets/${config.assets.plannerTimetable}`,
        stopsUrl: 'planner/assets/stops-sidecar.json',
        fetchImpl,
      });
      const tripMap = await stampedJson('planner/assets/trip-map.json', fetchImpl);
      const asset = host.state.assetData;
      (tripMap || []).forEach((entry, i) => {
        if (Array.isArray(entry) && entry[1]) state.tt.tripIndexById.set(String(entry[1]), i);
      });
      (host.state.stops || []).forEach((s) => {
        state.tt.sidecarByGeom.set(geomStopId(s.feed === 1 ? 'rail' : 'bus', s.stop_id), s.idx);
      });
      void asset;
      state.tt.status = 'ready';
      state.planner.loaded = true;
      return true;
    } catch (e) {
      state.tt.status = 'error';
      return false;
    }
  }

  function headsignForTrip(tripId) {
    if (tripId == null || state.tt.status !== 'ready') return null;
    const i = state.tt.tripIndexById.get(String(tripId));
    if (i == null) return null;
    const trip = host.state.assetData.trips[i];
    return trip && trip.h ? trip.h : null;
  }

  /** Scheduled departures at a stop (compiled timetable, GTFS
   *  service days D-1 and D in city time). Returns one row per
   *  (route, headsign): the earliest departure at/after the
   *  grace window. kind is always 'scheduled' — labeled as such
   *  wherever rendered (LT-S5 / LT-S6.3 honesty). */
  function scheduledDeparturesAt(geomStop, atMs, graceMs = 120000) {
    if (state.tt.status !== 'ready' || !host) return [];
    const idx = state.tt.sidecarByGeom.get(geomStop.id);
    if (idx == null) return [];
    const asset = host.state.assetData;
    const today = ymdOfParts(localParts(atMs));
    const groups = new Map();
    for (const day of [shiftYmd(today, -1), today]) {
      const active = activeServicesOn(asset, day);
      if (!active.size) continue;
      const p = partsOfYmd(day);
      const base = localMidnightMs(p.y, p.m, p.d);
      for (const trip of asset.trips) {
        if (!active.has(trip.s)) continue;
        const pos = trip.stops.indexOf(idx);
        if (pos < 0) continue;
        const secs = (trip.dep && trip.dep[pos] != null) ? trip.dep[pos] : trip.arr[pos];
        if (secs == null) continue;
        const timeMs = base + secs * 1000;
        if (timeMs < atMs - graceMs) continue;
        const route = asset.routes[trip.r];
        const key = `${route.id}|${trip.h || ''}`;
        if (!groups.has(key) || timeMs < groups.get(key).timeMs) {
          groups.set(key, {
            routeId: route.id, headsign: trip.h || null, timeMs, kind: 'scheduled',
          });
        }
      }
    }
    return [...groups.values()].sort((a, b) => a.timeMs - b.timeMs);
  }

  /** Ride Along's scheduled-time fallback (LT-S6.3): the time a
   *  matched timetable trip serves a stop, on the service day
   *  whose instance is nearest at/after now. */
  function scheduledTimeForTrip(tripId, geomStop) {
    if (state.tt.status !== 'ready' || !host) return null;
    const i = state.tt.tripIndexById.get(String(tripId));
    if (i == null) return null;
    const idx = state.tt.sidecarByGeom.get(geomStop.id);
    if (idx == null) return null;
    const asset = host.state.assetData;
    const trip = asset.trips[i];
    const pos = trip.stops.indexOf(idx);
    if (pos < 0) return null;
    const secs = (trip.dep && trip.dep[pos] != null) ? trip.dep[pos] : trip.arr[pos];
    if (secs == null) return null;
    const atMs = now();
    const today = ymdOfParts(localParts(atMs));
    let best = null;
    for (const day of [shiftYmd(today, -1), today, shiftYmd(today, 1)]) {
      if (!activeServicesOn(asset, day).has(trip.s)) continue;
      const p = partsOfYmd(day);
      const t = localMidnightMs(p.y, p.m, p.d) + secs * 1000;
      if (best === null || Math.abs(t - atMs) < Math.abs(best - atMs)) best = t;
    }
    return best;
  }

  // ---------- stop card (LT-KAES-30 / LT-S5) ------------------------

  function nearestVehicleOnRoute(routeId, stop) {
    const proj = renderer ? renderer.model.projector : null;
    let best = null;
    for (const r of (state.vehicles && state.vehicles.vehicles) || []) {
      const route = routeOf(r);
      if (!route || route.id !== routeId) continue;
      if (typeof r.lat !== 'number' || typeof r.lon !== 'number') continue;
      let d = null;
      if (proj) {
        const [x, z] = proj.project(r.lat, r.lon);
        d = Math.hypot(x - stop.x, z - stop.z);
      }
      if (!best || (d != null && (best.distanceM == null || d < best.distanceM))) {
        best = { record: r, distanceM: d == null ? null : Math.round(d) };
      }
    }
    return best;
  }

  function vehicleHeadsign(record) {
    return headsignForTrip(record.trip_id) || record.destination || null;
  }

  function buildStopCardModel(stop) {
    const atMs = now();
    const byId = (renderer && renderer.model.state.routeById) || {};
    const routesAtStop = (stop.r || [])
      .map((rid) => byId[rid])
      .filter(Boolean)
      .sort(compareRoutesS3);
    // Live arrivals from the TU family (LT-S5.1).
    const live = [];
    const seen = new Set();
    for (const { tu, stu } of state.tuByStop.get(stop.id) || []) {
      const ev = stu.arrival || stu.departure;
      if (!ev || typeof ev.time !== 'number') continue;
      const timeMs = ev.time * 1000;
      if (timeMs < atMs - 120000 || timeMs > atMs + 90 * 60000) continue;
      const key = `${tu.trip_id}|${timeMs}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const route = resolveRouteId(byId, tu.route_id);
      const veh = tu.vehicle_id ? state.vehiclesByKey.get(`${tu.agency || CITY_CONFIG.agency.id}|${tu.vehicle_id}`) : null;
      live.push({
        routeId: route ? route.id : tu.route_id,
        routeLabel: route ? routeLabel(route) : String(tu.route_id || ''),
        headsign: headsignForTrip(tu.trip_id) || (veh && veh.destination) || (route ? route.name : null),
        timeMs, kind: 'live',
        vehicleId: tu.vehicle_id || null,
        agency: tu.agency || CITY_CONFIG.agency.id,
      });
    }
    live.sort((a, b) => a.timeMs - b.timeMs);
    const liveGroups = new Set(live.map((r) => `${r.routeId}|${r.headsign || ''}`));
    // Scheduled where live is absent, labeled (LT-S5).
    const scheduled = state.tt.status === 'ready'
      ? scheduledDeparturesAt(stop, atMs)
        .filter((r) => !liveGroups.has(`${r.routeId}|${r.headsign || ''}`))
        .slice(0, 8)
        .map((r) => ({ ...r, routeLabel: (byId[r.routeId] ? routeLabel(byId[r.routeId]) : String(r.routeId)) }))
      : [];
    // Scoped alerts (LT-S5.1): stop-scoped, route-scoped, system.
    // Repair 2026-10-25 (stop-card flood): an agency may publish its
    // per-trip cancellation notices with an EMPTY informed-entity
    // selector and the trip named only in the header ("Trip
    // cancellation for trip 871100."). The old test read any
    // route-less/stop-less entity as System-wide, so all ~161
    // cancellations landed on every stop card. System-wide now
    // requires the alert to be genuinely unscoped (no selector
    // content at all) AND not a per-trip cancellation; a
    // cancelled trip already shows in this stop's live arrivals.
    const rawId = stop.id.split(':')[1];
    const alerts = [];
    for (const a of activeAlerts(atMs)) {
      let scope = null;
      const ents = a.informed_entities || [];
      for (const e of ents) {
        if (e.stop_id && e.stop_id === rawId) { scope = 'This stop'; break; }
        if (e.route_id && (stop.r || []).includes(e.route_id)) scope = 'This route';
      }
      if (!scope) {
        const unscoped = ents.length === 0
          || ents.every((e) => !e.route_id && !e.stop_id && !e.trip_id);
        if (unscoped && !/^trip cancellation\b/i.test(a.header || '')) scope = 'System-wide';
      }
      if (scope) alerts.push({ header: alertHeader(a), scope });
    }
    // "Live on these routes" boarding rows (LT-S5.1).
    const boardingRows = [];
    for (const route of routesAtStop) {
      const near = nearestVehicleOnRoute(route.id, stop);
      if (near) {
        boardingRows.push({
          routeId: route.id, routeLabel: routeLabel(route),
          vehicleId: near.record.vehicle_id, agency: near.record.agency,
          distanceM: near.distanceM,
          headsign: vehicleHeadsign(near.record),
        });
      }
    }
    // Direction summary rows (LT-S5.2): one per route + headsign
    // serving this stop today; a live vehicle in that direction
    // boards on tap. Absence of the timetable = the section is
    // absent, never implied.
    const directionRows = [];
    if (state.tt.status === 'ready') {
      const sched = scheduledDeparturesAt(stop, atMs);
      const byKey = new Map();
      for (const r of sched) {
        const key = `${r.routeId}|${r.headsign || ''}`;
        if (!byKey.has(key)) byKey.set(key, r);
      }
      for (const r of byKey.values()) {
        let board = null;
        for (const row of boardingRows) {
          if (row.routeId !== r.routeId) continue;
          const rec = state.vehiclesByKey.get(`${row.agency}|${row.vehicleId}`);
          if (rec && vehicleHeadsign(rec) === r.headsign) { board = row; break; }
        }
        directionRows.push({
          routeId: r.routeId,
          routeLabel: byId[r.routeId] ? routeLabel(byId[r.routeId]) : String(r.routeId),
          headsign: r.headsign, nextTimeMs: r.timeMs,
          vehicleId: board ? board.vehicleId : null,
          agency: board ? board.agency : null,
        });
      }
      directionRows.sort((a, b) => (a.routeLabel < b.routeLabel ? -1 : 1) || ((a.headsign || '') < (b.headsign || '') ? -1 : 1));
    }
    // CG-2: display-only arrivals for display-fed stops, read
    // from the fenced display store — never from, and never
    // written into, the canonical TU indexes above.
    const displayArrivals = displayTuRowsFor(stop, atMs);
    // CG-14: departure suggestions (gated on the beta flag AND
    // the empirical-motion flag). Speed prior seam: a helper on
    // the renderer model, the planner host, or an injected dep
    // wins; otherwise the pure sample model with no samples
    // yields null and the walk speed is the basis.
    let suggestions = [];
    if (betaCfg && betaCfg.suggestDepartures && config.motion && config.motion.empirical) {
      const prior = resolveSpeedPriorMps();
      const all = [...live.map((r) => ({ ...r })), ...displayArrivals, ...scheduled]
        .sort((a, b) => a.timeMs - b.timeMs);
      suggestions = buildDepartureSuggestions({
        arrivals: all,
        walkDistanceM: state.filtersState.nearMeCenter && renderer
          ? Math.hypot(stop.x - state.filtersState.nearMeCenter.x, stop.z - state.filtersState.nearMeCenter.z) : null,
        walkSpeedMps: config.planner && config.planner.walkModel ? config.planner.walkModel.speedMps : null,
        speedPriorMps: prior, atMs,
      }).map((s) => ({
        ...s,
        whenText: fmtArrival(s.timeMs, atMs),
        leaveByText: s.leaveByMs != null ? fmtClock(s.leaveByMs) : null,
      }));
    }
    // Places row (LT-S5.1 / LT-S9): only where the layer exists
    // (enabled) and has data near this stop. CG-6: in layer3d
    // mode the renderer carries the places geometry, so the
    // proximity row is suppressed (the 3D layer replaces it).
    let places = null;
    if (config.assets && config.assets.placesMode === 'layer3d') places = null;
    else if (state.places.enabled && state.places.status === 'ready' && renderer) {
      const near = [];
      for (const p of state.places.places) {
        if (typeof p.lat !== 'number' || typeof p.lon !== 'number') continue;
        const [x, z] = renderer.model.projector.project(p.lat, p.lon);
        const d = Math.hypot(x - stop.x, z - stop.z);
        if (d <= 400) near.push({ name: p.name, badge: p.badge || '•', distanceM: Math.round(d) });
      }
      if (near.length) places = near.sort((a, b) => a.distanceM - b.distanceM);
    }
    return {
      kind: 'stop', stopId: stop.id, stopName: stop.n,
      routesLine: routesAtStop.map(routeLabel).join(' · '),
      liveArrivals: live.slice(0, 10).map((r) => ({ ...r, whenText: fmtArrival(r.timeMs, atMs) })),
      displayArrivals: displayArrivals.slice(0, 10),
      scheduledArrivals: scheduled.map((r) => ({ ...r, whenText: fmtArrival(r.timeMs, atMs) })),
      timetablePending: state.tt.status !== 'ready',
      alerts, boardingRows, directionRows, places, suggestions,
    };
  }

  // ---------- vehicle card (LT-KAES-31 / LT-S3.2) -------------------

  function buildVehicleCardModel(record) {
    const route = routeOf(record);
    // CG-1: a display record's freshness is re-based on its
    // OWN payload's generated_at; canonical records keep the
    // canonical envelope basis exactly as before.
    const displayRec = isDisplayRecord(record, config);
    let genMs = state.vehicles ? Date.parse(state.vehicles.generated_at) : NaN;
    let displayAgeLabel = null;
    if (displayRec) {
      for (const { payload } of state.display.byFeed.values()) {
        const m = displayAgeModel(payload, now());
        if (m) { genMs = m.generatedMs; displayAgeLabel = m.label; break; }
      }
    }
    const upMs = record.updated_at ? Date.parse(record.updated_at) : NaN;
    const fixAgeSec = Number.isFinite(genMs) && Number.isFinite(upMs)
      ? Math.max(0, Math.round((genMs - upMs) / 1000)) : null;
    const stale = fixAgeSec != null && fixAgeSec > 180;
    const preview = rideAlong.preview(record);
    const upcoming = preview && preview.ok ? preview.view.upcoming.map((r) => ({
      stopName: r.stop.n, aheadM: r.aheadM,
      timeText: r.timeMs != null ? fmtClock(r.timeMs) : null,
      timeKind: r.timeKind, transfers: r.transfers,
    })) : [];
    return {
      kind: 'vehicle',
      vehicleId: record.vehicle_id, agency: record.agency,
      routeLabel: route ? routeLabel(route) : null,
      routeId: route ? route.id : null,
      classification: record.classification || null,
      unassigned: !route,
      destination: record.destination || headsignForTrip(record.trip_id),
      speedMph: typeof record.speed_mph === 'number' ? record.speed_mph : null,
      bearing: typeof record.bearing === 'number' ? record.bearing : null,
      compass: compassOf(record.bearing),
      fixAgeSec, stale,
      displayAgeLabel,
      upcoming,
      upcomingNote: preview && preview.ok ? preview.view.note : (preview ? preview.reason : null),
      boarded: !!(rideAlong.active() && rideAlong.active().vehicle_id === record.vehicle_id),
    };
  }

  // ---------- route card (pick on a route ribbon) -------------------

  function buildRouteCardModel(route) {
    const vehicles = ((state.vehicles && state.vehicles.vehicles) || [])
      .filter((r) => { const rt = routeOf(r); return rt && rt.id === route.id; })
      .sort(compareVehiclesS3);
    return {
      kind: 'route', routeId: route.id, routeLabel: routeLabel(route),
      group: route.group, paths: (route.paths || []).length,
      vehicles: vehicles.map((r) => ({
        vehicleId: r.vehicle_id, agency: r.agency,
        destination: r.destination || headsignForTrip(r.trip_id),
      })),
      filteredOut: renderer ? !renderer.routeVisible(route.id) : false,
    };
  }

  // ---------- card renderers (pure: model -> HTML) ------------------
  // (Module-level exports renderStopCard / renderVehicleCard below
  // are these same functions; the factory renders through them.)

  function renderCard() {
    const n = el('lt-info');
    if (!n || !state.card) return;
    let model = null;
    if (state.card.kind === 'stop') {
      const stop = (renderer.model.state.stops || []).find((s) => s.id === state.card.id);
      if (stop) model = buildStopCardModel(stop);
    } else if (state.card.kind === 'vehicle') {
      const rec = state.vehiclesByKey.get(state.card.id);
      if (rec) model = buildVehicleCardModel(rec);
    } else if (state.card.kind === 'route') {
      const route = (renderer.model.state.routeById || {})[state.card.id];
      if (route) model = buildRouteCardModel(route);
    } else if (state.card.kind === 'station') {
      const rec = state.layers.stations.find((s) => String(s.id != null ? s.id : s.station_id) === String(state.card.id));
      if (rec) model = stationCardModel(rec);
    }
    if (!model) { n.style.display = 'none'; n.innerHTML = ''; return; }
    n.style.display = 'block';
    n.innerHTML = model.kind === 'stop' ? renderStopCard(model)
      : model.kind === 'vehicle' ? renderVehicleCard(model)
        : model.kind === 'station' ? renderStationCard(model)
          : renderRouteCard(model);
    // T6 parity β: while a ride is boarded the ride card covers
    // this card — the card stays in state and DOM (not closed),
    // marked covered; ride-exit uncovers it (the monolith's
    // return-through-the-bus-card path).
    n.classList.toggle('lt-covered', !!state.cardCovered);
    if (typeof n.setAttribute === 'function') {
      if (state.cardCovered) n.setAttribute('aria-hidden', 'true');
      else if (typeof n.removeAttribute === 'function') n.removeAttribute('aria-hidden');
    }
  }

  function openCard(kind, id) {
    state.card = { kind, id };
    renderCard();
    if (kind === 'stop' && state.tt.status === 'idle') {
      ensureTimetable().then(() => { if (state.card && state.card.kind === 'stop') renderCard(); });
    }
  }

  function closeCard() {
    state.card = null;
    state.cardCovered = false;
    const n = el('lt-info');
    if (n) { n.style.display = 'none'; n.innerHTML = ''; }
  }

  /** The real pick handler: canvas taps (browser) and harness
   *  picks both land here. A null pick closes an open card
   *  (LT-U5: tap-on-empty clears); with no card open it is a
   *  clean no-op (LT-G14). */
  function handlePick(pick) {
    if (!pick) {
      if (state.card) closeCard();
      return { ok: false, reason: 'no-hit' };
    }
    if (pick.kind === 'stop' && pick.stop) {
      openCard('stop', pick.stop.id);
      return { ok: true, kind: 'stop', id: pick.stop.id };
    }
    if ((pick.kind === 'vehicle' || pick.kind === 'vehicle-unassigned') && pick.record) {
      openCard('vehicle', `${pick.record.agency}|${pick.record.vehicle_id}`);
      return { ok: true, kind: 'vehicle', id: pick.record.vehicle_id };
    }
    if (pick.kind === 'route' && pick.route) {
      openCard('route', pick.route.id);
      return { ok: true, kind: 'route', id: pick.route.id };
    }
    // CG-5: a station pick opens the station card from the
    // data-layer records already loaded here. F7 alignment: the
    // F5 renderer's actual pick kinds are 'external-station'
    // (payload {record, station, layerId} — record is the source
    // record, station its model wrapper) and 'static-station'
    // (payload {stop, station, layerId}); the pre-fold names
    // 'station'/'gbfs-station' are kept for harness stubs.
    if ((pick.kind === 'external-station' || pick.kind === 'static-station'
      || pick.kind === 'station' || pick.kind === 'gbfs-station')
      && (pick.station || pick.record || pick.stop)) {
      let rec = pick.record || pick.station || pick.stop;
      if (rec && rec.record && typeof rec.record === 'object') rec = rec.record;
      const sid = String(rec.id != null ? rec.id : rec.station_id);
      if (!state.layers.stations.some((s) => String(s.id != null ? s.id : s.station_id) === sid)) {
        state.layers.stations.push(rec);
      }
      return openStationCard(sid);
    }
    return { ok: false, reason: 'unknown-pick' };
  }

  // ---------- CG-14 speed-prior seam -------------------------------
  // The empirical prior is consumed through whichever seam already
  // exposes it (injected dep, renderer model, planner host). When
  // no seam exists, the pure sample model runs over zero samples
  // and yields null — the suggestion surface then uses the walk
  // speed and labels its basis honestly.
  function resolveSpeedPriorMps() {
    // F7 alignment note: the renderer's empirical seam is
    // empiricalSpeed(routeId, seg, nowMs) — segment-scoped, so it
    // cannot supply this scalar walk prior and is NOT probed here;
    // the scalar seam remains the injected dep / planner host only.
    const cands = [
      deps.empiricalSpeedMps,
      host && host.empiricalSpeedMps,
      host && host.empiricalSpeedFor,
    ];
    for (const c of cands) {
      if (typeof c === 'number' && c > 0) return c;
      if (typeof c === 'function') {
        try { const v = c(); if (typeof v === 'number' && v > 0) return v; } catch { /* next seam */ }
      }
    }
    return empiricalSpeedMpsFromSamples([], null);
  }

  // ---------- CG-10 filter semantics + CG-4/CG-5 layer toggles -----

  function routeRunningState(routeId) {
    return (liveCountByRoute().get(routeId) || 0) > 0 ? 'running' : 'not-running';
  }

  /** Hide routes whose running state is not-running (exemptions
   *  aside), remembering exactly which routes THIS filter hid so
   *  turning it off restores only those. */
  function applyIdleFilter() {
    if (!renderer || !filtersCfg || !filtersCfg.hideIdle) return;
    const exempt = Array.isArray(filtersCfg.hideIdleExemptRoutes) ? filtersCfg.hideIdleExemptRoutes : [];
    if (!state.filtersState.hideIdleOn) {
      for (const rid of state.filtersState.idleHidden) renderer.setRouteVisibility(rid, true);
      state.filtersState.idleHidden = new Set();
      return;
    }
    const next = new Set();
    for (const r of routesSorted()) {
      const hide = shouldHideRouteForIdle({
        routeId: r.id, runningState: routeRunningState(r.id),
        hideIdleOn: true, exemptRoutes: exempt,
      });
      if (hide && renderer.routeVisible(r.id)) { renderer.setRouteVisibility(r.id, false); next.add(r.id); }
      else if (hide) next.add(r.id);
    }
    // Routes the filter hid last cycle that are running now come back.
    for (const rid of state.filtersState.idleHidden) {
      if (!next.has(rid)) renderer.setRouteVisibility(rid, true);
    }
    state.filtersState.idleHidden = next;
  }

  function onHideIdleToggle(on) {
    state.filtersState.hideIdleOn = !!on;
    applyIdleFilter();
    renderStatus(); renderLauncher(); renderBrowse(); renderFilterExtras();
    if (state.card) renderCard();
  }

  /** Near-me route filter: snapshot every route's visibility,
   *  then show only routes serving a stop within the radius. */
  function applyNearMeRouteFilter(center) {
    if (!renderer || !filtersCfg || !filtersCfg.nearMeRouteFilter) return { ok: false, reason: 'not-configured' };
    const ids = routesSorted().map((r) => r.id);
    if (!state.filtersState.nearMeActive) {
      state.filtersState.nearMeSnapshot = snapshotRouteVisibility(ids, (id) => renderer.routeVisible(id));
    }
    state.filtersState.nearMeActive = true;
    state.filtersState.nearMeCenter = center;
    const keep = computeNearMeRouteIds(renderer.model.state.stops || [], center, nearMeRadiusM(config));
    for (const id of ids) renderer.setRouteVisibility(id, keep.has(id));
    renderStatus(); renderLauncher(); renderBrowse(); renderFilterExtras();
    return { ok: true, kept: keep.size };
  }

  function clearNearMeRouteFilter() {
    if (!state.filtersState.nearMeActive) return;
    if (renderer && state.filtersState.nearMeSnapshot) {
      for (const [id, on] of state.filtersState.nearMeSnapshot) renderer.setRouteVisibility(id, on);
    }
    state.filtersState.nearMeActive = false;
    state.filtersState.nearMeSnapshot = null;
    state.filtersState.nearMeCenter = null;
    renderStatus(); renderLauncher(); renderBrowse(); renderFilterExtras();
  }

  // CG-4: static-layer toggle — independent of group toggles and
  // of Show all / All off / near-me. The asset loads lazily on
  // first enable. F7 alignment to the F5 renderer seams (actual
  // names + signatures): loadStaticLayer(entry, doc) — the config
  // entry object first, the fetched asset doc second — then
  // setStaticLayerVisible(id, on). Load precedes the visibility
  // call because the model's seam only flips a loaded layer.
  async function onStaticLayerToggle(layer, on) {
    state.layers.staticOn.set(layer.id, !!on);
    if (on && !state.layers.staticData.has(layer.id)) {
      try {
        const data = await stampedJson(layer.asset, fetchImpl);
        state.layers.staticData.set(layer.id, data);
        if (renderer && typeof renderer.loadStaticLayer === 'function') {
          renderer.loadStaticLayer(layer, data);
        } else if (renderer && renderer.model && typeof renderer.model.loadStaticLayer === 'function') {
          renderer.model.loadStaticLayer(layer, data);
        }
      } catch { state.layers.staticData.set(layer.id, null); }
    }
    if (renderer && typeof renderer.setStaticLayerVisible === 'function') {
      renderer.setStaticLayerVisible(layer.id, !!on);
    } else if (renderer && renderer.model && typeof renderer.model.setStaticLayerVisible === 'function') {
      renderer.model.setStaticLayerVisible(layer.id, !!on);
    }
    renderFilterExtras();
  }

  // CG-5: external-layer toggle (GBFS kind) — independent the
  // same way. Stations come from the data-layer export when
  // present, else the local GBFS join over the two documents.
  async function onExternalLayerToggle(layer, on) {
    state.layers.externalOn.set(layer.id, !!on);
    if (!on) {
      state.layers.stationsStatus = 'off';
      // F7 alignment: F5's actual seam is setExternalLayerVisible.
      if (renderer && typeof renderer.setExternalLayerVisible === 'function') {
        renderer.setExternalLayerVisible(layer.id, false);
      } else if (renderer && renderer.model && typeof renderer.model.setExternalLayerVisible === 'function') {
        renderer.model.setExternalLayerVisible(layer.id, false);
      }
      renderFilterExtras();
      return;
    }
    state.layers.stationsStatus = 'loading';
    renderFilterExtras();
    try {
      state.layers.stations = await loadGbfsStations(layer);
      state.layers.stationsStatus = 'ready';
      // F7 alignment: F5's actual seams are
      // setExternalStations(layerId, records) + setExternalLayerVisible.
      if (renderer && typeof renderer.setExternalStations === 'function') {
        renderer.setExternalStations(layer.id, state.layers.stations);
      } else if (renderer && renderer.model && typeof renderer.model.setExternalStations === 'function') {
        renderer.model.setExternalStations(layer.id, state.layers.stations);
      }
      if (renderer && typeof renderer.setExternalLayerVisible === 'function') {
        renderer.setExternalLayerVisible(layer.id, true);
      } else if (renderer && renderer.model && typeof renderer.model.setExternalLayerVisible === 'function') {
        renderer.model.setExternalLayerVisible(layer.id, true);
      }
    } catch {
      state.layers.stations = [];
      state.layers.stationsStatus = 'unavailable';
    }
    renderFilterExtras();
  }

  async function loadGbfsStations(layer) {
    // F7 alignment: F2's actual GBFS export is pollGbfsLayer only.
    const fn = dlFn('pollGbfsLayer');
    if (fn) {
      const out = await fn(layer, fetchImpl);
      const list = Array.isArray(out) ? out : (out && out.stations) || [];
      return list.map((r) => stationCardModel(r)).filter(Boolean)
        .map((m, i) => ({ ...list[i], ...m, id: m.stationId }));
    }
    const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) throw new Error('no fetch implementation available');
    const base = String(layer.baseUrl || '').replace(/\/$/, '');
    const [info, status] = await Promise.all([
      f(`${base}/station_information.json`).then((r) => r.json()),
      f(`${base}/station_status.json`).then((r) => r.json()),
    ]);
    return joinGbfsStations(info, status);
  }

  function openStationCard(stationId) {
    const rec = state.layers.stations.find((s) => String(s.id != null ? s.id : s.station_id) === String(stationId));
    if (!rec) return { ok: false, reason: 'unknown-station' };
    state.card = { kind: 'station', id: String(stationId) };
    renderCard();
    return { ok: true, kind: 'station', id: String(stationId) };
  }

  /** Filter-panel extras: layer toggles (CG-4/CG-5), hide-idle +
   *  per-route chips + near-me restore (CG-10). Rendered only
   *  when at least one gate is configured; fleet panels are
   *  byte-identical to today. */
  function renderFilterExtras() {
    const hasLayers = staticLayersCfg.length > 0 || externalLayersCfg.length > 0;
    const hasFilters = !!filtersCfg && (filtersCfg.hideIdle || filtersCfg.perRouteChips || filtersCfg.nearMeRouteFilter);
    if (!hasLayers && !hasFilters) return;
    const panel = el('lt-filter-panel');
    if (!panel || !doc) return;
    if (!state.filterExtrasEl) {
      state.filterExtrasEl = doc.createElement('div');
      state.filterExtrasEl.id = 'lt-filter-extras';
      panel.appendChild(state.filterExtrasEl);
    }
    const counts = liveCountByRoute();
    let html = '';
    for (const l of staticLayersCfg) {
      html += `<label><input type="checkbox" data-action="layer-toggle" data-layer-kind="static" data-layer-id="${esc(l.id)}" ${state.layers.staticOn.get(l.id) ? 'checked' : ''}> ${esc(l.label || l.id)}</label> `;
    }
    for (const l of externalLayersCfg) {
      html += `<label><input type="checkbox" data-action="layer-toggle" data-layer-kind="external" data-layer-id="${esc(l.id)}" ${state.layers.externalOn.get(l.id) ? 'checked' : ''}> ${esc(l.label || l.id)}</label> `;
    }
    if (state.layers.externalOn.size && [...state.layers.externalOn.values()].some(Boolean)) {
      if (state.layers.stationsStatus === 'loading') html += '<p>Loading stations…</p>';
      else if (state.layers.stationsStatus === 'unavailable') html += '<p>Stations are unavailable right now.</p>';
      else if (state.layers.stationsStatus === 'ready') {
        html += `<ul class="lt-stations">${state.layers.stations.map((s) => {
          const m = stationCardModel(s);
          return `<li><button type="button" data-action="gbfs-station" data-station-id="${esc(m.stationId)}">${esc(m.name)}</button> · ${m.available != null ? `${m.available} available` : 'availability not reported'}${m.capacity != null ? ` · capacity ${m.capacity}` : ''}</li>`;
        }).join('')}</ul>`;
      }
    }
    if (filtersCfg && filtersCfg.hideIdle) {
      html += `<label><input type="checkbox" data-action="hide-idle" ${state.filtersState.hideIdleOn ? 'checked' : ''}> Hide routes that are not running</label> `;
    }
    if (filtersCfg && filtersCfg.nearMeRouteFilter && state.filtersState.nearMeActive) {
      html += '<button type="button" data-action="near-me-restore">Show all routes again</button> ';
    }
    if (filtersCfg && filtersCfg.perRouteChips) {
      html += `<span class="lt-route-chips">${routesSorted().map((r) => `
        <button type="button" class="lt-chip" data-action="route-chip" data-route="${esc(r.id)}" aria-pressed="${renderer && renderer.routeVisible(r.id) && !(counts.get(r.id) === 0 && state.filtersState.hideIdleOn) ? 'true' : 'false'}">${esc(routeLabel(r))}</button>`).join('')}</span>`;
    }
    if (boardLink) {
      html += `<p><a href="${esc(boardLink.url)}">${esc(boardLink.label)}</a></p>`;
    }
    state.filterExtrasEl.innerHTML = html;
  }

  // ---------- browse / filter / search (LT-KAES-33 / LT-S4) ---------

  function liveCountByRoute() {
    const counts = new Map();
    for (const r of (state.vehicles && state.vehicles.vehicles) || []) {
      const route = routeOf(r);
      if (route) counts.set(route.id, (counts.get(route.id) || 0) + 1);
    }
    return counts;
  }

  function browseModel() {
    const q = state.browse.routeQuery.trim().toLowerCase();
    const counts = liveCountByRoute();
    const routes = routesSorted()
      .filter((r) => !q || String(r.name).toLowerCase().includes(q)
        || String(r.id).toLowerCase().includes(q))
      .map((r) => ({
        routeId: r.id, label: routeLabel(r), group: r.group,
        color: r.color, live: counts.get(r.id) || 0,
        visible: renderer ? renderer.routeVisible(r.id) : true,
      }));
    return { routes, routeQuery: state.browse.routeQuery };
  }

  /** Stop search (LT-S4.4): groups by name for display; EVERY
   *  distinct stop is retained and the button carries the exact
   *  stop — the consuming feature (the card) gets the stop itself,
   *  never a name-group heuristic. */
  function stopSearchGroups(queryText, limit = 60) {
    const q = String(queryText || '').trim().toLowerCase();
    if (!q) return [];
    const stops = (renderer && renderer.model.state.stops) || [];
    const groups = new Map();
    let kept = 0;
    for (const st of stops) {
      if (!st.n.toLowerCase().includes(q)) continue;
      if (!groups.has(st.n)) groups.set(st.n, []);
      groups.get(st.n).push(st);
      kept++;
      if (kept >= limit * 8) break;
    }
    return [...groups.entries()].slice(0, limit)
      .map(([name, sts]) => ({ name, stops: sts }));
  }

  // The routes/stops browse body, shared by the plain panel and
  // the CG-14 tabbed panel (tab mode prepends the tab row).
  function browseRoutesHtml(m, stopGroups) {
    return `
      <h2>Routes &amp; stops</h2>
      <p><label>Find a route <input type="search" id="lt-route-search" data-role="route-search" value="${esc(state.browse.routeQuery)}"></label>
      <label>Find a stop <input type="search" id="lt-stop-search" data-role="stop-search" value="${esc(state.browse.stopQuery)}"></label></p>
      <div id="lt-stop-results">${stopGroups.map((g) => `
        <p class="lt-stop-group"><strong>${esc(g.name)}</strong><br>${g.stops.map((st) =>
          `<button type="button" data-action="browse-stop" data-stop-id="${esc(st.id)}">${esc(st.id.replace(':', ' '))} — ${esc((st.r || []).join(', '))}</button>`).join(' ')}</p>`).join('')}
      </div>
      <ul class="lt-route-list">${m.routes.map((r) => `
        <li>
          <label><input type="checkbox" data-role="route-vis" data-route="${esc(r.routeId)}" ${r.visible ? 'checked' : ''}>
          <span class="lt-route-chip" style="background:${esc(r.color || '#444')}"></span>
          ${esc(r.label)}</label>
          <span class="lt-route-meta">${esc(r.group)} · ${POSTURE_COPY ? POSTURE_COPY.routeMeta : `${r.live} live`}</span>
          <button type="button" data-action="route-solo" data-route="${esc(r.routeId)}">Only this route</button>
          <button type="button" data-action="route-card" data-route="${esc(r.routeId)}">Details</button>
        </li>`).join('')}
      </ul>
      <p><button type="button" data-action="route-show-all">Show all routes</button></p>`;
  }

  function renderBrowse() {
    const n = el('lt-browse-panel');
    if (!n) return;
    // CG-14: a configured Passes tab shares the browse panel;
    // absent config, this branch never runs and the panel is
    // exactly today's routes/stops surface.
    if (passesModel) {
      const tabs = `<p class="lt-browse-tabs">
        <button type="button" data-action="browse-tab" data-tab="routes" ${state.browse.tab === 'routes' ? 'aria-current="true"' : ''}>Routes &amp; stops</button>
        <button type="button" data-action="browse-tab" data-tab="passes" ${state.browse.tab === 'passes' ? 'aria-current="true"' : ''}>Passes</button>
      </p>`;
      if (state.browse.tab === 'passes') {
        n.innerHTML = tabs + renderPassesPanel(passesModel);
        return;
      }
      const m = browseModel();
      const stopGroups = state.browse.stopGroups;
      n.innerHTML = tabs + browseRoutesHtml(m, stopGroups);
      bindSearchInputs(n);
      return;
    }
    const m = browseModel();
    const stopGroups = state.browse.stopGroups;
    n.innerHTML = `
      <h2>Routes &amp; stops</h2>
      <p><label>Find a route <input type="search" id="lt-route-search" data-role="route-search" value="${esc(state.browse.routeQuery)}"></label>
      <label>Find a stop <input type="search" id="lt-stop-search" data-role="stop-search" value="${esc(state.browse.stopQuery)}"></label></p>
      <div id="lt-stop-results">${stopGroups.map((g) => `
        <p class="lt-stop-group"><strong>${esc(g.name)}</strong><br>${g.stops.map((st) =>
          `<button type="button" data-action="browse-stop" data-stop-id="${esc(st.id)}">${esc(st.id.replace(':', ' '))} — ${esc((st.r || []).join(', '))}</button>`).join(' ')}</p>`).join('')}
      </div>
      <ul class="lt-route-list">${m.routes.map((r) => `
        <li>
          <label><input type="checkbox" data-role="route-vis" data-route="${esc(r.routeId)}" ${r.visible ? 'checked' : ''}>
          <span class="lt-route-chip" style="background:${esc(r.color || '#444')}"></span>
          ${esc(r.label)}</label>
          <span class="lt-route-meta">${esc(r.group)} · ${POSTURE_COPY ? POSTURE_COPY.routeMeta : `${r.live} live`}</span>
          <button type="button" data-action="route-solo" data-route="${esc(r.routeId)}">Only this route</button>
          <button type="button" data-action="route-card" data-route="${esc(r.routeId)}">Details</button>
        </li>`).join('')}
      </ul>
      <p><button type="button" data-action="route-show-all">Show all routes</button></p>`;
    bindSearchInputs(n);
  }

  function bindSearchInputs(root) {
    const rs = root.querySelector('[data-role="route-search"]');
    if (rs) rs.addEventListener('input', (e) => {
      state.browse.routeQuery = e.target.value;
      renderBrowseKeepFocus('lt-route-search');
    });
    const ss = root.querySelector('[data-role="stop-search"]');
    if (ss) ss.addEventListener('input', (e) => {
      state.browse.stopQuery = e.target.value;
      state.browse.stopGroups = stopSearchGroups(e.target.value);
      renderBrowseKeepFocus('lt-stop-search');
    });
    root.querySelectorAll('[data-role="route-vis"]').forEach((cb) => {
      cb.addEventListener('change', (e) => onRouteVisibility(e.target.dataset.route, e.target.checked));
    });
  }

  function renderBrowseKeepFocus(inputId) {
    renderBrowse();
    const n = el('lt-browse-panel');
    const input = n && n.querySelector(`#${inputId}`);
    if (input && doc.activeElement !== input) {
      // Harness fakes have no focus model; the browser restores
      // focus + caret so typing is never interrupted by a render.
      if (typeof input.focus === 'function') input.focus();
      if (typeof input.setSelectionRange === 'function') {
        try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* noop */ }
      }
    }
  }

  /** Group toggle — the RC10 handler: persistence (KAES-37/38),
   *  renderer visibility, and EVERY derived display recompute in
   *  the same handler invocation, no poll in between (LT-S4.2). */
  function onGroupToggle(groupId, on) {
    const g = config.layerGroups.find((x) => x.id === groupId);
    // CG-10: persist === false groups are session-only — their
    // toggle state is never written to storage.
    if (storage && groupPersistEnabled(g)) {
      if (g) storage.setItem(g.storageKey, on ? '1' : '0');
    }
    if (renderer) renderer.setGroupVisibility(groupId, on);
    syncStreetExtVisibility();
    renderStatus();
    renderLauncher();
    renderBrowse();
    if (state.card) renderCard();
  }

  function onRouteVisibility(routeId, on) {
    if (renderer) renderer.setRouteVisibility(routeId, on);
    renderStatus();
    renderLauncher();
    if (state.card) renderCard();
  }

  function onRouteSolo(routeId) {
    if (!renderer) return;
    for (const r of routesSorted()) renderer.setRouteVisibility(r.id, r.id === routeId);
    renderStatus();
    renderLauncher();
    renderBrowse();
  }

  function onRouteShowAll() {
    if (!renderer) return;
    for (const r of routesSorted()) renderer.setRouteVisibility(r.id, true);
    renderStatus();
    renderLauncher();
    renderBrowse();
  }

  function renderFilterPanel() {
    const n = el('lt-filter-panel');
    if (!n) return;
    // Sync the shell's group checkboxes to the effective state
    // (stored preference wins over the configured default).
    n.querySelectorAll('input[data-group]').forEach((cb) => {
      const g = config.layerGroups.find((x) => x.id === cb.dataset.group);
      const stored = storage && g ? storage.getItem(g.storageKey) : null;
      cb.checked = g ? layerDefaultOn(g, stored) : cb.checked;
      if (renderer && g) renderer.setGroupVisibility(g.id, cb.checked);
      cb.addEventListener('change', (e) => onGroupToggle(e.target.dataset.group, e.target.checked));
    });
    const extra = doc.createElement('span');
    extra.innerHTML = ' <button type="button" data-action="group-all">All</button> <button type="button" data-action="group-none">None</button>';
    n.appendChild(extra);
    renderFilterExtras();
    renderGroupNotes();
    // CG-4/CG-5: layers configured default-on load at boot the
    // same way a rider toggle would load them.
    for (const l of staticLayersCfg) {
      if (state.layers.staticOn.get(l.id)) onStaticLayerToggle(l, true);
    }
    for (const l of externalLayersCfg) {
      if (state.layers.externalOn.get(l.id)) onExternalLayerToggle(l, true);
    }
  }

  // ---------- Ride Along surface (LT-KAES-32 / LT-S6) ---------------

  /** Move focus to a surface panel (browser focus model; harness
   *  fakes record the call). Ensures the panel is focusable. */
  function focusPanel(id) {
    const n = el(id);
    if (!n) return;
    if (typeof n.setAttribute === 'function' && typeof n.getAttribute === 'function'
      && !n.getAttribute('tabindex')) n.setAttribute('tabindex', '-1');
    if (typeof n.focus === 'function') n.focus();
  }

  function boardVehicle(agency, vehicleId) {
    const rec = state.vehiclesByKey.get(`${agency}|${vehicleId}`);
    if (!rec) return { ok: false, reason: 'not-reporting' };
    const r = rideAlong.board(rec);
    if (r.ok) {
      // T6 parity β — the monolith boarding funnel
      // (rideFromStopLiveRow): showBus selects the vehicle, so
      // the info card becomes the bus card; then the ride card
      // opens OVER the bus/stop cards — covered, not closed —
      // and takes focus. Ride-exit uncovers the bus card.
      state.card = { kind: 'vehicle', id: `${agency}|${vehicleId}` };
      state.cardCovered = true;
      renderCard();
      renderRideAlong();
      focusPanel('lt-ride-along');
    }
    return r;
  }

  function renderRideAlong() {
    const n = el('lt-ride-along');
    if (!n) return;
    const activeRec = rideAlong.active();
    if (!activeRec) {
      const pm = rideAlong.pickerModel((state.vehicles && state.vehicles.vehicles) || []);
      if (!pm.boardable.length) {
        n.innerHTML = `<h2>Ride Along</h2><p>No vehicles reporting right now.</p>`;
        return;
      }
      n.innerHTML = `<h2>Ride Along</h2>
        <p>Pick a vehicle to ride along with:</p>
        <ul class="lt-picker">${pm.boardable.map((r) => {
          const route = routeOf(r);
          return `<li><button type="button" data-action="picker-board" data-agency="${esc(r.agency)}" data-vehicle-id="${esc(r.vehicle_id)}">${esc(r.vehicle_id)} · ${esc(route ? routeLabel(route) : '')}${r.destination || vehicleHeadsign(r) ? ` · to ${esc(r.destination || vehicleHeadsign(r))}` : ''}</button></li>`;
        }).join('')}</ul>
        ${pm.notBoardable.length ? `<p class="lt-note">${pm.notBoardable.length} reporting vehicle${pm.notBoardable.length === 1 ? ' has' : 's have'} no route assignment and cannot be ridden along.</p>` : ''}`;
      return;
    }
    const view = rideAlong.upcoming();
    const route = routeOf(activeRec);
    if (!view) {
      n.innerHTML = `<h2>Ride Along</h2><p>Vehicle ${esc(activeRec.vehicle_id)} stopped reporting.</p>
        <p><button type="button" data-action="ride-exit">Close</button></p>`;
      return;
    }
    const byId = (renderer && renderer.model.state.routeById) || {};
    n.innerHTML = `<h2>Ride Along — ${esc(activeRec.vehicle_id)} · ${esc(route ? routeLabel(route) : '')}</h2>
      ${activeRec.destination || vehicleHeadsign(activeRec) ? `<p>To ${esc(activeRec.destination || vehicleHeadsign(activeRec))}</p>` : ''}
      ${view.position ? `<p class="lt-position">${view.position.relation === 'at' ? 'At' : 'Just past'} ${esc(view.position.stop.n)}</p>` : ''}
      ${view.note ? `<p class="lt-note">${esc(view.note)}</p>` : ''}
      <ol class="lt-upcoming">${view.upcoming.map((r) => `
        <li><strong>${esc(r.stop.n)}</strong>
          ${r.timeMs != null ? ` — ${esc(fmtClock(r.timeMs))}${r.timeKind === 'scheduled' ? ' (scheduled)' : ''}` : ''}
          ${r.transfers.length ? `<br><span class="lt-transfers">Transfer: ${esc(r.transfers.map((rid) => (byId[rid] ? routeLabel(byId[rid]) : rid)).join(', '))}</span>` : ''}
        </li>`).join('')}
      </ol>
      <p><button type="button" data-action="ride-exit">Stop riding</button></p>`;
  }

  // ---------- first-view launcher (LT-KAES-36 / LT-S1.2) ------------

  function launcherModel() {
    const stats = renderer ? renderer.stats() : null;
    const markers = (stats ? stats.markers : 0) + displaySeparateCount();
    const routesTotal = stats ? stats.routesTotal : 0;
    const alerts = state.alerts ? activeAlerts(now()).length : 0;
    return {
      collapsed: state.launcher === 'collapsed',
      tiles: [
        {
          id: 'live-map', label: POSTURE_COPY ? POSTURE_COPY.mapTileLabel : 'Live map',
          proof: state.vehicles
            ? (markers === 0 ? (POSTURE_COPY ? POSTURE_COPY.mapTileProofZero : 'No vehicles live right now') : `${markers} vehicle${markers === 1 ? '' : 's'} live right now`)
            : (POSTURE_COPY ? POSTURE_COPY.statusLoading : 'Loading live vehicles…'),
        },
        {
          id: 'plan', label: 'Plan a trip',
          // Repair 2026-10-25: rider copy only — the raw feed
          // version string ("(feed v202609271+v202609271)") is an
          // internal identifier, not information for a rider.
          proof: 'From the published timetable',
        },
        {
          id: 'ride-along', label: 'Ride Along',
          // Repair 2026-10-25 (count basis, RC5/RC10): the tile
          // counted boardable vehicles over the raw envelope
          // while the status line counts the current view, so
          // under a route filter the two disagreed on the same
          // quantity (6 live vs 430 reporting). One basis for
          // every rider-facing count: the view (renderer stats).
          proof: markers ? `${markers} vehicle${markers === 1 ? '' : 's'} reporting` : 'No vehicles reporting right now',
        },
        { id: 'all-routes', label: 'All routes', proof: `${routesTotal} ${CITY_CONFIG.agency.shortName} routes` },
        { id: 'near-me', label: 'Near me', proof: 'Find your nearest stop' },
        {
          id: 'alerts', label: 'Alerts',
          proof: state.alerts ? (alerts === 0 ? 'No active alerts' : `${alerts} active alert${alerts === 1 ? '' : 's'}`) : 'Loading alerts…',
        },
      ],
    };
  }

  function renderLauncher() {
    const n = el('lt-launcher');
    if (!n) return;
    const m = launcherModel();
    if (m.collapsed) {
      n.innerHTML = `<button type="button" data-action="launcher-toggle" aria-expanded="false">Start here ▸</button>`;
      return;
    }
    // CG-14: board link + beta tile toggles ride the launcher
    // only when configured; absent config this string is exactly
    // today's launcher markup.
    const boardHtml = boardLink
      ? `<p><a href="${esc(boardLink.url)}">${esc(boardLink.label)}</a></p>` : '';
    const betaHtml = betaCfg && Array.isArray(betaCfg.tiles) && betaCfg.tiles.length
      ? `<div class="lt-beta-tiles"><h3>Beta features</h3>${betaCfg.tiles.map((t) => `
        <label><input type="checkbox" data-action="beta-tile" data-key="${esc(t.key)}" ${state.betaTiles.get(t.key) ? 'checked' : ''}> ${esc(t.label || t.key)}</label>`).join('')}
      </div>` : '';
    n.innerHTML = `<div class="lt-launcher-head">
        <strong>Start here</strong>
        <button type="button" data-action="launcher-toggle" aria-expanded="true">Collapse</button>
      </div>
      ${boardHtml}
      <div class="lt-tiles">${m.tiles.map((t) => `
        <button type="button" class="lt-tile" data-action="launcher-tile" data-tile="${esc(t.id)}">
          <span class="lt-tile-label">${esc(t.label)}</span>
          <span class="lt-tile-proof">${esc(t.proof)}</span>
        </button>`).join('')}
      </div>${betaHtml}`;
  }

  function onLauncherToggle() {
    state.launcher = state.launcher === 'collapsed' ? 'open' : 'collapsed';
    if (storage) storage.setItem(config.storageKeys.launcherSheet, state.launcher);
    renderLauncher();
  }

  function onLauncherTile(tileId) {
    const focus = (id) => {
      const n = el(id);
      if (n && typeof n.scrollIntoView === 'function') n.scrollIntoView();
      if (n && typeof n.focus === 'function') n.focus();
    };
    if (tileId === 'live-map') { if (renderer) renderer.fitToExtent(); focus('lt-map'); }
    else if (tileId === 'plan') focus('lt-planner');
    else if (tileId === 'ride-along') focus('lt-ride-along');
    else if (tileId === 'all-routes') focus('lt-browse-panel');
    else if (tileId === 'alerts') focus('lt-alerts');
    else if (tileId === 'near-me') onNearMe();
  }

  /** Near me: location is an optional inline enhancement, never a
   *  boot modal (LT-S1.2). With coordinates, the nearest stop's
   *  card opens; without, a plain message — never a dead end. */
  function onNearMe(coords) {
    const done = (lat, lon) => {
      if (!renderer) return { ok: false, reason: 'no-renderer' };
      const proj = renderer.model.projector;
      const [x, z] = proj.project(lat, lon);
      // CG-10: with the route filter configured, near-me also
      // snapshots + filters routes (restore via clearNearMeRouteFilter).
      if (filtersCfg && filtersCfg.nearMeRouteFilter) {
        applyNearMeRouteFilter({ x, z });
      }
      let best = null;
      for (const st of renderer.model.state.stops || []) {
        const d = Math.hypot(st.x - x, st.z - z);
        if (!best || d < best.d) best = { stop: st, d };
      }
      if (best) openCard('stop', best.stop.id);
      return { ok: true, stopId: best ? best.stop.id : null };
    };
    if (coords && typeof coords.lat === 'number') return done(coords.lat, coords.lon);
    const geo = deps.geolocation
      || (typeof navigator !== 'undefined' ? navigator.geolocation : null);
    if (geo && typeof geo.getCurrentPosition === 'function') {
      geo.getCurrentPosition(
        (pos) => done(pos.coords.latitude, pos.coords.longitude),
        () => { /* denied/unavailable: the map itself is the fallback */ },
      );
      return { ok: true, pending: true };
    }
    return { ok: false, reason: 'no-geolocation' };
  }

  // ---------- Places layer (LT-KAES-35 / LT-S9) ----------------------

  // CG-6 seam — F7 alignment to F5's actual renderer seams:
  //  setPlaces(dataset) hands the loaded dataset to the model
  //  (called when enabling with data available), setPlacesVisible(on)
  //  is the toggle. Model-level fallbacks mirror the same names.
  function drivePlaces3d(on) {
    if (!renderer) return null;
    const places = state.places.places || [];
    const hasSet = typeof renderer.setPlaces === 'function'
      || (renderer.model && typeof renderer.model.setPlaces === 'function');
    const hasVis = typeof renderer.setPlacesVisible === 'function'
      || (renderer.model && typeof renderer.model.setPlacesVisible === 'function');
    if (!hasVis) return null;
    if (on && places.length && hasSet) {
      if (typeof renderer.setPlaces === 'function') renderer.setPlaces(places);
      else renderer.model.setPlaces(places);
    }
    if (typeof renderer.setPlacesVisible === 'function') renderer.setPlacesVisible(!!on);
    else renderer.model.setPlacesVisible(!!on);
    return 'setPlacesVisible';
  }

  async function onPlacesToggle(on) {
    state.places.enabled = !!on;
    if (!on) {
      state.places.status = 'off';
      if (config.assets && config.assets.placesMode === 'layer3d') drivePlaces3d(false);
      renderPlaces(); return;
    }
    // Session-only (LT-S9.2): the enabled state lives in memory —
    // nothing about Places is ever written to storage.
    // CG-6 layer3d: with the dataset already loaded, re-enabling
    // drives the 3D layer instead of re-rendering the list path.
    if (state.places.status === 'ready') {
      if (config.assets && config.assets.placesMode === 'layer3d') drivePlaces3d(true);
      renderPlaces(); return;
    }
    state.places.status = 'loading';
    renderPlaces();
    state.places.fetches++;
    try {
      const dataset = await stampedJson(config.assets.places, fetchImpl);
      const list = Array.isArray(dataset) ? dataset : dataset.places;
      if (!Array.isArray(list)) throw new Error('places dataset has no places list');
      // T6 parity γ (2026-10-31): dual-key name — the Detroit
      // dataset keys the name `n`; fleet datasets use `name`.
      // Records are normalized to carry `name` so every
      // downstream consumer (stop-card proximity, renderer
      // setPlaces, list render) reads one key.
      state.places.places = list
        .filter((p) => p && (typeof p.name === 'string' || typeof p.n === 'string'))
        .map((p) => (typeof p.name === 'string' ? p : { ...p, name: p.n }));
      state.places.coverage = dataset.coverage || null;
      state.places.attribution = dataset.attribution || null;
      state.places.status = 'ready';
    } catch (e) {
      state.places.status = 'unavailable';
      state.places.note = 'Places is unavailable right now. It will retry the next time you turn it on.';
    }
    if (config.assets && config.assets.placesMode === 'layer3d' && state.places.status === 'ready') {
      drivePlaces3d(true);
    }
    renderPlaces();
    if (state.card) renderCard();
  }

  function renderPlaces() {
    const n = el('lt-places');
    if (!n) return;
    const p = state.places;
    // CG-6: with sponsored span ids configured, the toggle row
    // and the layer note carry spans with those EXACT ids —
    // present but hidden at boot, visible only while enabled.
    // Without the config field the markup is today's class-only
    // form, byte for byte.
    if (sponsoredIds && (sponsoredIds.tag || sponsoredIds.note)) {
      const vis = p.enabled ? '' : ' hidden';
      const tagSpan = sponsoredIds.tag
        ? `<span id="${esc(sponsoredIds.tag)}"${vis}>Sponsored</span>` : '';
      const noteSpan = sponsoredIds.note
        ? `<span id="${esc(sponsoredIds.note)}"${vis}>Sponsored — partner places, shown for context. Places never change transit results or rankings.</span>`
        : 'Sponsored — partner places, shown for context. Places never change transit results or rankings.';
      if (!p.enabled) {
        n.innerHTML = `<h2>Places ${tagSpan}</h2>
        <p class="lt-sponsored-note">${noteSpan}</p>
        <p><button type="button" data-action="places-toggle" data-on="1">Show Places</button></p>`;
        return;
      }
      let body = '';
      if (p.status === 'loading') body = '<p>Loading Places…</p>';
      else if (p.status === 'unavailable') body = `<p>${esc(p.note || 'Places is unavailable right now.')}</p>`;
      else if (p.status === 'ready') {
        body = `<p>${p.places.length} place${p.places.length === 1 ? '' : 's'} in the published dataset.</p>
        <p class="lt-coverage">Coverage: ${esc(p.coverage || 'the published dataset’s extent')}${p.attribution ? ` · Source: ${esc(p.attribution)}` : ''}</p>`;
      }
      n.innerHTML = `<h2>Places ${tagSpan}</h2>
      <p class="lt-sponsored-note">${noteSpan}</p>
      ${body}
      <p><button type="button" data-action="places-toggle" data-on="0">Hide Places</button></p>`;
      return;
    }
    if (!p.enabled) {
      n.innerHTML = `<h2>Places</h2>
        <p><button type="button" data-action="places-toggle" data-on="1">Show Places</button></p>`;
      return;
    }
    let body = '';
    if (p.status === 'loading') body = '<p>Loading Places…</p>';
    else if (p.status === 'unavailable') body = `<p>${esc(p.note || 'Places is unavailable right now.')}</p>`;
    else if (p.status === 'ready') {
      body = `<p>${p.places.length} place${p.places.length === 1 ? '' : 's'} in the published dataset.</p>
        <p class="lt-coverage">Coverage: ${esc(p.coverage || 'the published dataset’s extent')}${p.attribution ? ` · Source: ${esc(p.attribution)}` : ''}</p>`;
    }
    n.innerHTML = `<h2>Places <span class="lt-sponsored">Sponsored</span></h2>
      <p class="lt-sponsored-note">Sponsored — partner places, shown for context. Places never change transit results or rankings.</p>
      ${body}
      <p><button type="button" data-action="places-toggle" data-on="0">Hide Places</button></p>`;
  }

  // ---------- planner surface (LT-KAES-29 / LT-S7) -------------------

  function legClock(sec) {
    if (typeof sec !== 'number') return '';
    const h24 = Math.floor(sec / 3600) % 24;
    const m = Math.floor((sec % 3600) / 60);
    const suffix = h24 >= 12 ? 'PM' : 'AM';
    const h = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h}:${String(m).padStart(2, '0')} ${suffix}`;
  }

  function stopName(idx) {
    const s = host && host.state && host.state.stops && host.state.stops[idx];
    return s ? s.name : `Stop ${idx}`;
  }

  function renderPlanner() {
    const n = el('lt-planner');
    if (!n) return;
    const P = state.planner;
    const meta = host && host.state && host.state.meta;
    // Repair 2026-10-25: the feed version string is an internal
    // identifier; the line tells the rider what the plan is
    // computed from, in rider terms.
    const feedLine = meta ? 'now · from the published timetable' : 'now · timetable loads on first use';
    let results = '';
    if (P.busy) results = '<p>Planning…</p>';
    else if (P.error) results = `<p class="lt-plan-error">${esc(P.error)}</p>`;
    else if (P.result) results = renderPlannerResult(P.result);
    n.innerHTML = `<h2>Plan a trip</h2>
      <p class="lt-plan-feed">${feedLine}</p>
      <p>
        <label>From <input type="search" id="lt-plan-from" data-role="plan-from" value="${esc(P.fromLabel)}"></label>
        <label>To <input type="search" id="lt-plan-to" data-role="plan-to" value="${esc(P.toLabel)}"></label>
        <button type="button" data-action="plan-run">Plan</button>
      </p>
      <div id="lt-plan-from-results"></div>
      <div id="lt-plan-to-results"></div>
      <div id="lt-plan-results">${results}</div>`;
    const bind = (id, which) => {
      const input = n.querySelector(`#${id}`);
      if (!input) return;
      input.addEventListener('input', async (e) => {
        const text = e.target.value;
        if (which === 'from') state.planner.fromLabel = text; else state.planner.toLabel = text;
        await ensureTimetable();
        const groups = host ? host.searchStops(text) : [];
        const box = el(which === 'from' ? 'lt-plan-from-results' : 'lt-plan-to-results');
        if (box) {
          // Repair 2026-10-25 (duplicated suggestions): the
          // group header printed the stop name and every button
          // repeated it, so each stop appeared twice — and
          // same-name stops were indistinguishable buttons. A
          // one-stop group is just its button; a multi-stop
          // group keeps the header once and each button carries
          // its stop number, so the distinct stops the search
          // retains (LT-S4.4) are actually distinguishable.
          box.innerHTML = groups.map((g) => g.stops.length === 1
            ? `<p class="lt-stop-group"><button type="button" data-action="plan-pick" data-which="${which}" data-idx="${g.stops[0].idx}">${esc(g.stops[0].name)}</button></p>`
            : `
            <p class="lt-stop-group"><strong>${esc(g.name)}</strong><br>${g.stops.map((s) =>
              `<button type="button" data-action="plan-pick" data-which="${which}" data-idx="${s.idx}">${esc(s.name)} · stop ${esc(s.stop_id)}</button>`).join(' ')}</p>`).join('');
        }
      });
    };
    bind('lt-plan-from', 'from');
    bind('lt-plan-to', 'to');
  }

  function renderPlannerResult(out) {
    if (!out || !out.ok) {
      const reason = out && out.reason;
      return `<p class="lt-plan-error">${reason === 'same-stop'
        ? 'Choose two different stops.'
        : reason === 'not-ready' ? 'The planner is still loading.'
          : 'No journey found in the window.'}</p>`;
    }
    if (!out.presented.length) return '<p>No journey found in the window.</p>';
    return out.presented.map(({ arch, journey }) => {
      const walkOnly = !(arch.routes || []).length;
      // Repair 2026-10-25 ("direct" over walk legs): the walk
      // chain emits one leg per intermediate stop, so a journey
      // could present three consecutive "Walk …" legs after its
      // ride and still headline itself "direct". Coalesce runs of
      // consecutive walk legs into the single walk the rider
      // actually makes (summed time, final destination) — the
      // presented itinerary is then the journey the headline
      // describes.
      const mergedLegs = [];
      for (const leg of journey.legs || []) {
        const prev = mergedLegs[mergedLegs.length - 1];
        if (leg.type === 'walk' && prev && prev.type === 'walk') {
          prev.secs = (prev.secs || 0) + (leg.secs || 0);
          prev.to = leg.to;
        } else mergedLegs.push({ ...leg });
      }
      const legs = mergedLegs.map((leg) => {
        if (leg.type === 'walk') {
          return `<li>Walk ${Math.max(1, Math.round((leg.secs || 0) / 60))} min to ${esc(stopName(leg.to))}</li>`;
        }
        return `<li><strong>${esc(leg.routeName || leg.routeId || '')}</strong>${leg.headsign ? ` — ${esc(leg.headsign)}` : ''}<br>
          ${esc(stopName(leg.board))} ${esc(legClock(leg.boardSec))} → ${esc(stopName(leg.alight))} ${esc(legClock(leg.alightSec))} <span class="lt-sched">scheduled</span></li>`;
      }).join('');
      return `<article class="lt-journey">
        <h3>${walkOnly ? 'Walk' : esc(journey.departClock || '')} ${walkOnly ? '' : '→ ' + esc(journey.arriveClock || '')}</h3>
        <p>${esc(String(journey.durationMin != null ? journey.durationMin : ''))}${journey.durationMin != null ? ' min' : ''}${journey.transfers ? ` · ${journey.transfers} transfer${journey.transfers === 1 ? '' : 's'}` : ' · direct'}${walkOnly ? ' · walk only — no transit journey in the window' : ''}</p>
        <ol>${legs}</ol>
      </article>`;
    }).join('');
  }

  async function onPlanRun() {
    const P = state.planner;
    if (!host) { P.error = 'The planner is unavailable.'; renderPlanner(); return; }
    await ensureTimetable();
    if (P.fromIdx == null || P.toIdx == null) {
      P.error = 'Choose a starting stop and a destination stop.';
      P.result = null;
      renderPlanner();
      return;
    }
    P.busy = true; P.error = null;
    renderPlanner();
    try {
      P.result = await host.planTripAsync(P.fromIdx, P.toIdx, new Date(now()).toISOString());
    } catch (e) {
      P.error = `Planning failed: ${e.message || e}`;
      P.result = null;
    }
    P.busy = false;
    renderPlanner();
  }

  /** Deep-link prefill (LT-S7.2): parse via the host contract,
   *  apply the resolved endpoints + cleaned labels, and plan when
   *  both ends resolve. Malformed pieces are ignored piece by
   *  piece by the host; out-of-coverage ends refuse by name. */
  async function applyDeepLink(search) {
    if (!host) return { applied: [] };
    await ensureTimetable();
    const parsed = host.parseDeepLink(search);
    if (parsed.from && parsed.from.ok) {
      state.planner.fromIdx = parsed.from.stop.idx;
      state.planner.fromLabel = parsed.labels.from || parsed.from.stop.name;
    }
    if (parsed.to && parsed.to.ok) {
      state.planner.toIdx = parsed.to.stop.idx;
      state.planner.toLabel = parsed.labels.to || parsed.to.stop.name;
    }
    renderPlanner();
    return parsed;
  }

  // ---------- delegated actions (ONE handler path) -------------------

  /* Repair 2026-10-25 (inert tiles): a real browser reports the
   * INNERMOST element as the click target — for launcher tiles
   * that is the label/proof <span> inside the button, which
   * carries no dataset, so the delegated handler swallowed the
   * click and the tile read as inert. Resolve the action holder
   * by walking up from the target (closest() where the DOM
   * offers it, the parent chain where it does not). */
  function actionHolder(t) {
    let cur = t;
    while (cur) {
      if (cur.dataset && cur.dataset.action) return cur;
      if (typeof cur.closest === 'function') return cur.closest('[data-action]');
      cur = cur.parentElement || cur.parent || null;
    }
    return null;
  }

  function onAction(e) {
    const t = actionHolder(e && e.target);
    const d = (t && t.dataset) || {};
    const action = d.action;
    if (!action) return;
    if (action === 'card-close') closeCard();
    else if (action === 'board-vehicle' || action === 'picker-board') boardVehicle(d.agency, d.vehicleId);
    else if (action === 'ride-exit') { rideAlong.exit(); state.cardCovered = false; renderRideAlong(); if (state.card) { renderCard(); focusPanel('lt-info'); } }
    else if (action === 'ride-open') { const n = el('lt-ride-along'); if (n && n.scrollIntoView) n.scrollIntoView(); }
    else if (action === 'launcher-toggle') onLauncherToggle();
    else if (action === 'launcher-tile') onLauncherTile(d.tile);
    else if (action === 'places-toggle') onPlacesToggle(d.on === '1');
    else if (action === 'browse-tab') { state.browse.tab = d.tab === 'passes' ? 'passes' : 'routes'; renderBrowse(); }
    else if (action === 'layer-toggle') {
      const list = d.layerKind === 'external' ? externalLayersCfg : staticLayersCfg;
      const layer = list.find((l) => l.id === d.layerId);
      if (layer) {
        const on = !!(t && t.checked);
        if (d.layerKind === 'external') onExternalLayerToggle(layer, on);
        else onStaticLayerToggle(layer, on);
      }
    }
    else if (action === 'hide-idle') onHideIdleToggle(!!(t && t.checked));
    else if (action === 'route-chip') {
      if (renderer) onRouteVisibility(d.route, !renderer.routeVisible(d.route));
      renderFilterExtras();
    }
    else if (action === 'near-me-restore') clearNearMeRouteFilter();
    else if (action === 'gbfs-station') openStationCard(d.stationId);
    else if (action === 'beta-tile') {
      const tile = betaCfg && Array.isArray(betaCfg.tiles)
        ? betaCfg.tiles.find((x) => x.key === d.key) : null;
      if (tile) {
        const on = !!(t && t.checked);
        state.betaTiles.set(tile.key, on);
        if (storage && tile.storageKey) storage.setItem(tile.storageKey, on ? '1' : '0');
        if (state.card) renderCard();
      }
    }
    else if (action === 'group-all' || action === 'group-none') {
      const on = action === 'group-all';
      for (const g of config.layerGroups) onGroupToggle(g.id, on);
      renderFilterPanel();
    } else if (action === 'route-solo') onRouteSolo(d.route);
    else if (action === 'route-show-all') onRouteShowAll();
    else if (action === 'route-card') openCard('route', d.route);
    else if (action === 'browse-stop') openCard('stop', d.stopId);
    else if (action === 'plan-pick') {
      const idx = Number(d.idx);
      const name = (host && host.state.stops && host.state.stops[idx]) ? host.state.stops[idx].name : '';
      if (d.which === 'from') { state.planner.fromIdx = idx; state.planner.fromLabel = name; }
      else { state.planner.toIdx = idx; state.planner.toLabel = name; }
      renderPlanner();
    } else if (action === 'plan-run') onPlanRun();
    else if (action === 'degraded-dismiss') {
      if (state.degraded) state.degradedDismissedSig = state.degraded.signature;
      renderDegraded();
    } else if (action === 'retry-boot') {
      clearLoadError();
      if (typeof deps.onRetryBoot === 'function') deps.onRetryBoot();
    }
  }

  // ---------- mount ---------------------------------------------------

  function mount() {
    if (!doc) throw new Error('surfaces.mount: no document');
    if (storage) {
      const saved = storage.getItem(config.storageKeys.launcherSheet);
      if (saved === 'collapsed' || saved === 'open') state.launcher = saved;
    }
    // CG-14: beta tile boot state — stored preference wins over
    // the configured default, per tile storageKey.
    if (betaCfg && Array.isArray(betaCfg.tiles)) {
      for (const t of betaCfg.tiles) {
        const stored = storage && t.storageKey ? storage.getItem(t.storageKey) : null;
        state.betaTiles.set(t.key, stored === '1' ? true : stored === '0' ? false : t.defaultOn === true);
      }
    }
    renderFilterPanel();
    renderBrowse();
    renderLauncher();
    renderPlaces();
    renderPlanner();
    renderRideAlong();
    renderAlerts();
    renderStatus();
    for (const id of SURFACE_MOUNTS) {
      const n = el(id);
      if (n && typeof n.addEventListener === 'function') n.addEventListener('click', onAction);
    }
    const canvas = el('lt-map');
    if (canvas && renderer && typeof canvas.addEventListener === 'function') {
      canvas.addEventListener('click', (e) => {
        const rect = typeof canvas.getBoundingClientRect === 'function'
          ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
        handlePick(renderer.pickFromClient(e.clientX, e.clientY, rect));
      });
    }
    const win = deps.window || (typeof window !== 'undefined' ? window : null);
    if (win) installAppLock(doc, win);
    state.mounted = true;
    return api;
  }

  // ---------- CG-13 history instant-paint (surfaces half) --------
  /** Paint history vehicles instantly from a telemetry-shaped
   *  document. Only paints while no live envelope has landed —
   *  fresher live data is never overwritten by history. */
  function paintHistory(doc) {
    if (state.vehicles || state.historyPainted) return { ok: false, reason: 'live-already' };
    const vehicles = historyVehiclesFromDoc(doc);
    if (!vehicles.length) return { ok: false, reason: 'empty' };
    state.historyPainted = true;
    const envelope = {
      generated_at: (doc && doc.generated_at) || new Date(now()).toISOString(),
      count: vehicles.length, vehicles, sources: (doc && doc.sources) || {},
    };
    if (renderer) renderer.setVehicles(envelope);
    state.historyEnvelope = envelope;
    renderStatus();
    renderLauncher();
    return { ok: true, count: vehicles.length };
  }

  /** Fetch the configured history file once and paint it.
   *  Failure is a silent no-op by design. */
  async function fetchAndPaintHistory(fetchImplOverride) {
    if (!historyUrl) return { ok: false, reason: 'not-configured' };
    try {
      const f = fetchImplOverride || fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
      if (!f) return { ok: false, reason: 'no-fetch' };
      const res = await f(historyUrl);
      if (!res || (res.ok === false)) return { ok: false, reason: 'fetch-failed' };
      const doc = typeof res.json === 'function' ? await res.json() : res;
      return paintHistory(doc);
    } catch {
      return { ok: false, reason: 'fetch-failed' };
    }
  }

  const api = {
    mount, setData, handlePick, openCard, closeCard,
    onGroupToggle, onRouteVisibility, onRouteSolo, onRouteShowAll,
    boardVehicle, onLauncherToggle, onLauncherTile, onNearMe,
    onPlacesToggle, onPlanRun, applyDeepLink, ensureTimetable,
    showLoadError, clearLoadError,
    // Fold surface (F4) — all inert without their config gates.
    onStaticLayerToggle, onExternalLayerToggle, openStationCard,
    onHideIdleToggle, applyNearMeRouteFilter, clearNearMeRouteFilter,
    paintHistory, fetchAndPaintHistory,
    groupNotesModel, displayTuRowsFor, isDisplayStop,
    models: {
      status: statusModel, stopCard: buildStopCardModel,
      vehicleCard: buildVehicleCardModel, routeCard: buildRouteCardModel,
      alerts: alertsModel, launcher: launcherModel, browse: browseModel,
      stopSearchGroups, scheduledDeparturesAt,
      groupNotes: groupNotesModel,
      passes: () => passesModel,
      station: stationCardModel,
      // Pure renderer, exposed on the models pattern so the
      // harness can assert journey presentation directly
      // (repair tranche 2026-10-25, walk-leg coalescing).
      renderPlannerResult,
    },
    rideAlong,
    state,
  };
  return api;
}

// ------------------------------------------------------------------
// Pure card renderers (model -> HTML). The factory's builders
// produce the models; these format them. Every dynamic string is
// escaped here or at build time — feed text never reaches HTML
// raw.
// ------------------------------------------------------------------

export function renderStopCard(m) {
  // T6 parity β (2026-10-31): live rows carry the monolith's
  // stop-live-row class (the class was dead shell CSS with no
  // producer); boarding rows below are button.stop-live-row.
  const live = m.liveArrivals.map((r) => `
    <li class="stop-live-row"><strong>${esc(r.routeLabel)}</strong>${r.headsign ? ` — ${esc(r.headsign)}` : ''}
      · ${esc(r.whenText)} <span class="lt-live">LIVE</span>
      ${r.vehicleId ? `<button type="button" data-action="board-vehicle" data-agency="${esc(r.agency)}" data-vehicle-id="${esc(r.vehicleId)}">Ride vehicle ${esc(r.vehicleId)}</button>` : ''}
    </li>`).join('');
  // CG-2: display-only arrivals (present only on models built
  // for display-fed stops; empty/absent on every fleet model).
  const display = (m.displayArrivals || []).map((r) => `
    <li class="stop-live-row"><strong>${esc(r.routeLabel)}</strong>${r.headsign ? ` — ${esc(r.headsign)}` : ''}
      · ${esc(r.whenText)} <span class="lt-live">LIVE</span></li>`).join('');
  const suggestions = (m.suggestions || []).map((s) => `
    <li><strong>${esc(s.routeLabel || '')}</strong>${s.headsign ? ` — ${esc(s.headsign)}` : ''}
      · ${esc(s.whenText)}${s.leaveByText ? ` · leave by ${esc(s.leaveByText)}` : ''}</li>`).join('');
  const sched = m.scheduledArrivals.map((r) => `
    <li><strong>${esc(r.routeLabel)}</strong>${r.headsign ? ` — ${esc(r.headsign)}` : ''}
      · ${esc(r.whenText)} <span class="lt-sched">scheduled</span></li>`).join('');
  return `<article class="lt-card lt-stop-card">
    <h2>${esc(m.stopName)}</h2>
    <p class="lt-card-sub">${esc(m.routesLine)}</p>
    ${m.alerts.length ? `<div class="lt-card-alerts">${m.alerts.map((a) => `<p>⚠ ${esc(a.header)} <span class="lt-scope">(${esc(a.scope)})</span></p>`).join('')}</div>` : ''}
    <h3>Next arrivals</h3>
    ${live || display ? `<ul class="lt-arrivals">${live}${display}</ul>` : `<p>${POSTURE_COPY ? POSTURE_COPY.arrivalsEmpty : 'No live arrivals in the next 90 minutes.'}</p>`}
    ${sched ? `<ul class="lt-arrivals lt-scheduled">${sched}</ul>` : ''}
    ${suggestions ? `<h3>Suggested departures</h3>
      <ul class="lt-suggestions">${suggestions}</ul>` : ''}
    ${m.timetablePending ? '<p class="lt-note">Scheduled times load with the timetable…</p>' : ''}
    ${m.boardingRows.length ? `<h3>Live on these routes</h3>
      <ul class="lt-boarding">${m.boardingRows.map((r) => `
        <li><button type="button" class="stop-live-row" data-action="board-vehicle" data-agency="${esc(r.agency)}" data-vehicle-id="${esc(r.vehicleId)}">${esc(r.routeLabel)} — vehicle ${esc(r.vehicleId)}</button>${r.headsign ? ` to ${esc(r.headsign)}` : ''}${r.distanceM != null ? ` · ${r.distanceM} m away` : ''}</li>`).join('')}
      </ul>` : ''}
    ${m.directionRows.length ? `<h3>Directions</h3>
      <ul class="lt-directions">${m.directionRows.map((r) => `
        <li>${r.vehicleId
          ? `<button type="button" data-action="board-vehicle" data-agency="${esc(r.agency)}" data-vehicle-id="${esc(r.vehicleId)}">${esc(r.routeLabel)} — ${esc(r.headsign || '')}</button>`
          : `${esc(r.routeLabel)} — ${esc(r.headsign || '')}`} · next ${esc(fmtClock(r.nextTimeMs))}${r.vehicleId ? '' : ' (scheduled; no live vehicle in this direction right now)'}</li>`).join('')}
      </ul>` : ''}
    ${m.places ? `<h3>Places nearby <span class="lt-sponsored">Sponsored</span></h3>
      <ul class="lt-places-row">${m.places.map((p) => `<li><span class="lt-badge">${esc(p.badge)}</span> ${esc(p.name)} · ${p.distanceM} m</li>`).join('')}</ul>` : ''}
    <p><button type="button" data-action="card-close">Close</button></p>
  </article>`;
}

export function renderVehicleCard(m) {
  return `<article class="lt-card lt-vehicle-card">
    <h2>Vehicle ${esc(m.vehicleId)}</h2>
    ${m.routeLabel ? `<p class="lt-card-sub">${esc(m.routeLabel)}${m.destination ? ` — to ${esc(m.destination)}` : ''}</p>`
      : '<p class="lt-card-sub">No route assignment on this record.</p>'}
    ${m.unassigned ? `<p class="lt-note">This vehicle is reporting a position without a route assignment in the feed (classification: ${esc(m.classification || 'UNASSIGNED')}). It is shown in the map’s unassigned state.</p>` : ''}
    <ul class="lt-fields">
      ${m.speedMph != null ? `<li>Speed: ${esc(String(m.speedMph))} mph</li>` : ''}
      ${m.bearing != null ? `<li>Heading: ${esc(String(Math.round(m.bearing)))}°${m.compass ? ` (${esc(m.compass)})` : ''}</li>` : ''}
      ${m.fixAgeSec != null ? `<li>Position age: ${esc(String(m.fixAgeSec))} s${m.stale ? ' <span class="lt-stale-chip">stale</span>' : ''}</li>` : ''}
      ${m.displayAgeLabel ? `<li>Feed ${esc(m.displayAgeLabel)}</li>` : ''}
    </ul>
    ${m.upcoming.length ? `<h3>Upcoming stops</h3>
      <ol class="lt-upcoming">${m.upcoming.map((u) => `
        <li><strong>${esc(u.stopName)}</strong>${u.timeText ? ` — ${esc(u.timeText)}${u.timeKind === 'scheduled' ? ' (scheduled)' : ''}` : ''}</li>`).join('')}
      </ol>` : ''}
    ${!m.upcoming.length && m.upcomingNote ? `<p class="lt-note">${esc(m.upcomingNote)}</p>` : ''}
    ${!m.unassigned ? (m.boarded
      ? '<p>Riding along with this vehicle. <button type="button" data-action="ride-exit">Stop riding</button></p>'
      : `<p><button type="button" data-action="board-vehicle" data-agency="${esc(m.agency)}" data-vehicle-id="${esc(m.vehicleId)}">Ride along</button></p>`) : ''}
    <p><button type="button" data-action="card-close">Close</button></p>
  </article>`;
}

export function renderRouteCard(m) {
  return `<article class="lt-card lt-route-card">
    <h2>${esc(m.routeLabel)}</h2>
    <p class="lt-card-sub">${esc(m.group)} · ${m.paths} path${m.paths === 1 ? '' : 's'}${m.filteredOut ? ' · filtered out of the map view' : ''}</p>
    ${m.vehicles.length ? `<h3>Live vehicles</h3>
      <ul class="lt-boarding">${m.vehicles.map((v) => `
        <li><button type="button" data-action="board-vehicle" data-agency="${esc(v.agency)}" data-vehicle-id="${esc(v.vehicleId)}">Vehicle ${esc(v.vehicleId)}</button>${v.destination ? ` to ${esc(v.destination)}` : ''}</li>`).join('')}
      </ul>` : `<p>${POSTURE_COPY ? POSTURE_COPY.routeVehiclesEmpty : 'No vehicles live on this route right now.'}</p>`}
    <p><button type="button" data-action="route-solo" data-route="${esc(m.routeId)}">Show only this route</button>
    <button type="button" data-action="card-close">Close</button></p>
  </article>`;
}

/** CG-5: station card — name / capacity / available, from the
 *  data-layer station record only; a missing field omits its
 *  segment (LT-F7). */
export function renderStationCard(m) {
  return `<article class="lt-card lt-station-card">
    <h2>${esc(m.name || 'Station')}</h2>
    <ul class="lt-fields">
      ${m.capacity != null ? `<li>Capacity: ${esc(String(m.capacity))}</li>` : ''}
      ${m.available != null ? `<li>Available: ${esc(String(m.available))}</li>` : ''}
      ${m.docksAvailable != null ? `<li>Docks available: ${esc(String(m.docksAvailable))}</li>` : ''}
    </ul>
    <p><button type="button" data-action="card-close">Close</button></p>
  </article>`;
}

/** CG-14: Passes tab body — the configured disclaimer plus
 *  outbound links. No fare figures, no selling. */
export function renderPassesPanel(model) {
  if (!model) return '';
  return `<div class="lt-passes">
    <h2>Passes</h2>
    ${model.disclaimer ? `<p>${esc(model.disclaimer)}</p>` : ''}
    ${model.links.length ? `<ul>${model.links.map((l) => `
      <li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a></li>`).join('')}
    </ul>` : ''}
  </div>`;
}

// ------------------------------------------------------------------
// App-lock (LT-KAES-41 / LT-S1.3): the fs-lock pattern — document
// scroll locked while the app runs full-screen, top bar cannot be
// scrolled off; scrollable panels keep pan-y (touch-action
// intersects across ancestors, so the lock never lands on an
// ancestor of a scrollable panel — panels declare data-lt-scroll).
// ------------------------------------------------------------------

export const APP_LOCK_CSS = [
  'body.fs-lock{overflow:hidden;overscroll-behavior:none}',
  'body.fs-lock .lt-chrome{touch-action:none}',
  'body.fs-lock [data-lt-scroll]{touch-action:pan-y}',
].join('\n');

export function installAppLock(docObj, winObj) {
  if (!docObj || !docObj.body) return { setAppLock: () => {}, isLocked: () => false };
  if (!docObj.getElementById('lt-app-lock-css')) {
    const style = docObj.createElement('style');
    style.id = 'lt-app-lock-css';
    style.textContent = APP_LOCK_CSS;
    (docObj.head || docObj.body).appendChild(style);
  }
  let locked = false;
  const setAppLock = (on) => {
    locked = !!on;
    docObj.body.classList.toggle('fs-lock', locked);
    docObj.documentElement.style.overflow = locked ? 'hidden' : '';
    docObj.documentElement.style.overscrollBehavior = locked ? 'none' : '';
  };
  if (winObj && winObj.document && typeof winObj.document.addEventListener === 'function') {
    winObj.document.addEventListener('fullscreenchange', () => {
      setAppLock(!!winObj.document.fullscreenElement);
    });
  }
  if (docObj && typeof docObj.addEventListener === 'function') {
    docObj.addEventListener('fullscreenchange', () => {
      setAppLock(!!docObj.fullscreenElement);
    });
  }
  return { setAppLock, isLocked: () => locked };
}

// ------------------------------------------------------------------
// R1 contract entry points.
// ------------------------------------------------------------------

/** Mount all surfaces against the shell regions. */
export function mountSurfaces(deps = {}) {
  const api = createSurfaces(deps);
  api.mount();
  return api;
}

/** Browser boot (app.mjs calls this): renderer + geometry through
 *  the loader, surfaces mounted, polls at the configured
 *  cadences. A failed load surfaces as the LT-KAES-40 overlay,
 *  never a blank map. */
export async function bootBrowser(deps = {}) {
  const { createRenderer, geometryAssetPaths } = await import('./renderer.mjs');
  const { createPlannerHost } = await import('./planner-host.mjs');
  const docObj = deps.document || document;
  const canvas = docObj.getElementById('lt-map');
  const renderer = await createRenderer(canvas);
  const plannerHost = createPlannerHost();
  const api = createSurfaces({
    document: docObj,
    storage: deps.storage || (typeof localStorage !== 'undefined' ? localStorage : null),
    renderer, plannerHost,
    fetchImpl: deps.fetchImpl,
    nowFn: deps.nowFn,
    onRetryBoot: deps.onRetryBoot,
  });
  api.mount();
  installAppLock(docObj, deps.window || (typeof window !== 'undefined' ? window : null));
  try {
    const paths = geometryAssetPaths();
    // Feed set is config-driven (LT-S4/LT-KAES-12): iterate the
    // city's declared routesByFeed entries, never a hardcoded feed
    // pair. (Launch fix 2026-10-26: this fan-out previously named a
    // fixed pair of feeds, so a single-feed city fetched `undefined`
    // and the boot failed into the load-error overlay on the
    // production URL. The scene model already consumes routesByFeed
    // generically by feed id.)
    const feedEntries = Object.entries(paths.routesByFeed);
    const registryCfgBoot = CITY_CONFIG.assets && CITY_CONFIG.assets.routesRegistry
      && typeof CITY_CONFIG.assets.routesRegistry === 'object'
      ? CITY_CONFIG.assets.routesRegistry : null;
    const [streets, stopsDocRaw, water, landmarks, names, ...rest] = await Promise.all([
      stampedJson(paths.streets, deps.fetchImpl),
      // CG-3: with a registry configured, the standalone stops doc
      // is superseded by the merged registry (built below); the
      // fetch is skipped so a city with no standalone stops doc
      // boots cleanly.
      registryCfgBoot ? Promise.resolve(null) : stampedJson(paths.stops, deps.fetchImpl),
      stampedJson(paths.water, deps.fetchImpl),
      stampedJson(paths.landmarks, deps.fetchImpl),
      stampedJson(paths.streetNames, deps.fetchImpl),
      ...feedEntries.map(([, p]) => stampedJson(p, deps.fetchImpl)),
      ...(registryCfgBoot && Array.isArray(registryCfgBoot.files)
        ? registryCfgBoot.files.map((f) => stampedJson(f, deps.fetchImpl)) : []),
    ]);
    const feedDocs = rest.slice(0, feedEntries.length);
    const registryDocs = rest.slice(feedEntries.length);
    let routesByFeed = Object.fromEntries(
      feedEntries.map(([feedId], i) => [feedId, feedDocs[i]]));
    let stops = stopsDocRaw;
    if (registryCfgBoot) {
      // CG-3: ONE registry — the registry files' stop arrays
      // concatenated in file order with segment offsets, and the
      // configured recolour applied to the routes geometry.
      const merged = buildMergedRegistry(registryDocs, registryCfgBoot);
      api.state.registry = merged;
      const proj = CITY_CONFIG.assets.projection;
      stops = {
        ...merged.stopsDoc,
        projection: merged.stopsDoc.projection || { lat0: proj.lat0, lon0: proj.lon0 },
      };
      if (Object.keys(merged.routesByFeed).length) {
        // Registry files carry the routes: recolour from the
        // merge, keyed by the routesByFeed feed ids in file order.
        const recoloured = { ...routesByFeed };
        feedEntries.forEach(([feedId], i) => {
          const segFeed = merged.segments[i] && merged.segments[i].feed;
          const src = segFeed && merged.routesByFeed[segFeed];
          if (src) recoloured[feedId] = { ...feedDocs[i], routes: src.routes };
        });
        routesByFeed = recoloured;
      } else {
        routesByFeed = applyRegistryRecolor(routesByFeed, registryCfgBoot.recolor);
      }
    }
    await renderer.loadGeometry({
      streets, routesByFeed, stops, water, landmarks, names,
    });
    // CG-3 streetExt sub-item PARKED (F7, see syncStreetExtVisibility):
    // no street-extension tier exists in core geometry, so the gated
    // decision is recorded in state only — no renderer seam is called.
    if (registryCfgBoot) {
      const storedGroups = {};
      for (const g of CITY_CONFIG.layerGroups) {
        const stored = deps.storage && g.storageKey ? deps.storage.getItem(g.storageKey) : null;
        storedGroups[g.id] = layerDefaultOn(g, stored);
      }
      const gatedBy = registryCfgBoot.streetExtGatedByGroup || null;
      api.state.streetExtVisible = streetExtVisibleForGroups(
        (renderer.model.state && renderer.model.state.groups) || storedGroups, gatedBy);
    }
  } catch (e) {
    api.showLoadError(e);
    return api;
  }
  // CG-13: history instant-paint — fired once at boot, never
  // awaited; a failure is silent and live data always wins.
  if (CITY_CONFIG.ops && CITY_CONFIG.ops.clientRecovery
    && typeof CITY_CONFIG.ops.clientRecovery.historyUrl === 'string') {
    void api.fetchAndPaintHistory(deps.fetchImpl);
  }
  // CG-1/CG-2 boot poll helpers (gated; fleet polls never call
  // them). A display fetch NEVER fails the canonical poll: every
  // helper resolves null on any failure.
  const fetchDisplayPayload = async (url) => {
    try { return await stampedJson(url, deps.fetchImpl); } catch { return null; }
  };
  const pollDisplay = async () => {
    const out = {};
    const dvConfigs = displayVehicleConfigs(CITY_CONFIG);
    if (dvConfigs.length) {
      // Headsign sidecar: the data-layer fetch-once loader wins;
      // the per-entry stamped fetch is the fallback.
      const hsFn = dlFn('ensureDisplayHeadsigns');
      let loaded = false;
      if (hsFn) {
        try {
          const map = await hsFn(deps.fetchImpl);
          if (map && typeof map.forEach === 'function') {
            map.forEach((v, k) => api.state.display.headsigns.set(String(k), String(v)));
            loaded = api.state.display.headsigns.size > 0;
          }
        } catch { /* fallback below */ }
      }
      if (!loaded) {
        for (const d of dvConfigs) {
          if (!d.headsignsUrl || api.state.display.headsigns.size) continue;
          const hs = await fetchDisplayPayload(d.headsignsUrl);
          const map = hs && (hs.headsigns || hs);
          if (map && typeof map === 'object' && !Array.isArray(map)) {
            for (const [k, v] of Object.entries(map)) api.state.display.headsigns.set(String(k), String(v));
          } else if (Array.isArray(map)) {
            for (const e of map) {
              if (e && (e.trip_id || e.tripId)) api.state.display.headsigns.set(String(e.trip_id || e.tripId), String(e.headsign || e.destination || ''));
            }
          }
        }
      }
      // Fallback vehicle path (only when the merged poll export
      // is unavailable): per-entry fetch into the fenced store.
      if (!dlFn('pollVehiclesWithDisplay')) {
        const pollFn = dlFn('pollDisplayVehicles');
        const entries = [];
        for (const d of dvConfigs) {
          let payload = null;
          if (pollFn) {
            try {
              const res = await pollFn(deps.fetchImpl, Date.now());
              if (res && Array.isArray(res.vehicles)) {
                payload = { generated_at: (res.byFeed && res.byFeed[d.feed] && res.byFeed[d.feed].generated_at) || null, vehicles: res.vehicles.filter((r) => String(r.feed || r.displayFeed || '') === String(d.feed)) };
              }
            } catch { payload = null; }
          }
          if (!payload && d.url) payload = await fetchDisplayPayload(d.url);
          if (payload) entries.push({ feed: d.feed, config: d, payload });
        }
        if (entries.length) out.displayVehicles = entries;
      }
    }
    const tuCfg = displayTripUpdatesConfig(CITY_CONFIG);
    if (tuCfg) {
      // The data-layer TU poll ingests into its own fenced map
      // (rows are read back through displayTuRowsForStop); the
      // stamped-fetch payload path is the fallback.
      const tuFn = dlFn('pollDisplayTripUpdates');
      let polled = false;
      if (tuFn) {
        try { await tuFn(deps.fetchImpl, Date.now()); polled = true; } catch { polled = false; }
      }
      if (!polled && tuCfg.url) {
        const payload = await fetchDisplayPayload(tuCfg.url);
        if (payload) out.displayTripUpdates = { payload, config: tuCfg };
      }
    }
    return out;
  };
  const pollLive = async () => {
    try {
      const withDisplay = displayVehiclesConfigured(CITY_CONFIG)
        ? dlFn('pollVehiclesWithDisplay') : null;
      const [v, tu] = await Promise.all([
        withDisplay ? withDisplay(deps.fetchImpl, Date.now()) : pollVehicles(deps.fetchImpl),
        pollTripUpdates(deps.fetchImpl),
      ]);
      const extra = await pollDisplay();
      // Display freshness records from the merged poll envelope:
      // byFeed generated_at per feed, records already merged.
      if (v && v.displayFeeds && !extra.displayVehicles) {
        extra.displayVehicles = Object.entries(v.displayFeeds).map(([feed, info]) => ({
          feed, merged: true,
          config: displayVehicleConfigs(CITY_CONFIG).find((d) => String(d.feed) === feed) || {},
          payload: {
            generated_at: info && info.generated_at,
            vehicles: (v.displayVehicles || []).filter((r) => String(r.feed || r.displayFeed || '') === feed),
          },
        }));
      }
      api.setData({ vehicles: v, tripUpdates: tu, vehiclesError: null, displayVehicles: extra.displayVehicles, displayTripUpdates: extra.displayTripUpdates });
      // CG-8 seam (planner-host F3): the host's per-poll live hook
      // is internally gated by its own live flags — inert when
      // they are off, and absent entirely on a pre-fold host.
      if (plannerHost && typeof plannerHost.onLivePoll === 'function') {
        try {
          const r = await plannerHost.onLivePoll((v && v.vehicles) || [], Date.now());
          if (r && r.replanned) api.setData({});
        } catch { /* live wiring never fails the poll */ }
      }
    } catch (e) {
      api.setData({ vehiclesError: e }); // last-good data stays up
    }
  };
  const pollAlertsCycle = async () => {
    try {
      const a = await pollAlerts(deps.fetchImpl);
      api.setData({ alerts: a });
    } catch { /* alerts failure renders through the region's own state */ }
  };
  await pollLive();
  await pollAlertsCycle();
  if (!deps.noTimers && typeof setInterval === 'function') {
    setInterval(pollLive, CITY_CONFIG.freshness.vehiclePollMs);
    setInterval(pollAlertsCycle, CITY_CONFIG.freshness.alertsPollMs);
  }
  return api;
}
