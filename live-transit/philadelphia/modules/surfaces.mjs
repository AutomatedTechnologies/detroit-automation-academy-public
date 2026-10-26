// modules/surfaces.mjs — feature surfaces (LT-KAES-30…36/40/41/47).
// PHL REBUILD R5 implementation, on the R1 contract. Label:
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
// Text + label helpers (Standards S2/S3 live here for PHL surfaces)
// ------------------------------------------------------------------

/** Escape a string for HTML text/attribute contexts. */
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Repair 2026-10-25 (literal entities): SEPTA's GTFS-RT alert
 * text arrives entity-encoded at the source ("Washington Ave
 * &amp; Moyamensing Ave", "&ldquo;...&rdquo;") and the pipeline
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
    launcher: 'open',
    places: { enabled: false, status: 'off', places: [], note: null, fetches: 0 },
    planner: {
      fromIdx: null, toIdx: null, fromLabel: '', toLabel: '',
      busy: false, result: null, error: null, loaded: false,
    },
    browse: { routeQuery: '', stopQuery: '', stopGroups: [] },
    tt: { status: 'idle', tripIndexById: new Map(), sidecarByGeom: new Map() },
  };

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

  function statusModel() {
    const stats = renderer ? renderer.stats() : null;
    const markers = stats ? stats.markers : 0;
    const unassigned = stats ? stats.unassignedMarkers : 0;
    let text;
    if (!state.vehicles) text = 'Loading live vehicles…';
    else if (markers === 0) text = 'No vehicles live right now';
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
    n.innerHTML = `<h2>Service alerts (${list.length})</h2>` + list.map((a) => `
      <article class="lt-alert">
        <h3>${esc(a.header)}</h3>
        ${a.routes.length ? `<p class="lt-alert-routes">Affects: ${esc(a.routes.join(', '))}</p>` : '<p class="lt-alert-routes">System-wide</p>'}
        <p>${esc(a.description)}</p>
        ${a.url ? `<p><a href="${esc(a.url)}" rel="noopener">Details</a></p>` : ''}
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
  function setData({ vehicles, alerts, tripUpdates, vehiclesError } = {}) {
    if (vehicles !== undefined) state.vehicles = vehicles;
    if (alerts !== undefined) state.alerts = alerts;
    if (tripUpdates !== undefined) state.tripUpdates = tripUpdates;
    if (vehiclesError !== undefined) state.vehiclesError = vehiclesError;
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
      const veh = tu.vehicle_id ? state.vehiclesByKey.get(`${tu.agency || 'septa'}|${tu.vehicle_id}`) : null;
      live.push({
        routeId: route ? route.id : tu.route_id,
        routeLabel: route ? routeLabel(route) : String(tu.route_id || ''),
        headsign: headsignForTrip(tu.trip_id) || (veh && veh.destination) || (route ? route.name : null),
        timeMs, kind: 'live',
        vehicleId: tu.vehicle_id || null,
        agency: tu.agency || 'septa',
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
    const rawId = stop.id.split(':')[1];
    const alerts = [];
    for (const a of activeAlerts(atMs)) {
      let scope = null;
      for (const e of a.informed_entities || []) {
        if (e.stop_id && e.stop_id === rawId) { scope = 'This stop'; break; }
        if (e.route_id && (stop.r || []).includes(e.route_id)) scope = 'This route';
        if (!e.route_id && !e.stop_id && !scope) scope = 'System-wide';
      }
      if (scope) alerts.push({ header: a.header || '', scope });
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
    // Places row (LT-S5.1 / LT-S9): only where the layer exists
    // (enabled) and has data near this stop.
    let places = null;
    if (state.places.enabled && state.places.status === 'ready' && renderer) {
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
      scheduledArrivals: scheduled.map((r) => ({ ...r, whenText: fmtArrival(r.timeMs, atMs) })),
      timetablePending: state.tt.status !== 'ready',
      alerts, boardingRows, directionRows, places,
    };
  }

  // ---------- vehicle card (LT-KAES-31 / LT-S3.2) -------------------

  function buildVehicleCardModel(record) {
    const route = routeOf(record);
    const genMs = state.vehicles ? Date.parse(state.vehicles.generated_at) : NaN;
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
    }
    if (!model) { n.style.display = 'none'; n.innerHTML = ''; return; }
    n.style.display = 'block';
    n.innerHTML = model.kind === 'stop' ? renderStopCard(model)
      : model.kind === 'vehicle' ? renderVehicleCard(model)
        : renderRouteCard(model);
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
    const n = el('lt-info');
    if (n) { n.style.display = 'none'; n.innerHTML = ''; }
  }

  /** The real pick handler: canvas taps (browser) and harness
   *  picks both land here. null = clean no-op (LT-G14). */
  function handlePick(pick) {
    if (!pick) return { ok: false, reason: 'no-hit' };
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
    return { ok: false, reason: 'unknown-pick' };
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

  function renderBrowse() {
    const n = el('lt-browse-panel');
    if (!n) return;
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
          <span class="lt-route-meta">${esc(r.group)} · ${r.live} live</span>
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
    if (storage) {
      const g = config.layerGroups.find((x) => x.id === groupId);
      if (g) storage.setItem(g.storageKey, on ? '1' : '0');
    }
    if (renderer) renderer.setGroupVisibility(groupId, on);
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
  }

  // ---------- Ride Along surface (LT-KAES-32 / LT-S6) ---------------

  function boardVehicle(agency, vehicleId) {
    const rec = state.vehiclesByKey.get(`${agency}|${vehicleId}`);
    if (!rec) return { ok: false, reason: 'not-reporting' };
    const r = rideAlong.board(rec);
    if (r.ok) {
      renderRideAlong();
      if (state.card) renderCard();
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
    const markers = stats ? stats.markers : 0;
    const routesTotal = stats ? stats.routesTotal : 0;
    const alerts = state.alerts ? activeAlerts(now()).length : 0;
    const pm = rideAlong.pickerModel((state.vehicles && state.vehicles.vehicles) || []);
    const meta = host && host.state && host.state.meta;
    return {
      collapsed: state.launcher === 'collapsed',
      tiles: [
        {
          id: 'live-map', label: 'Live map',
          proof: state.vehicles
            ? (markers === 0 ? 'No vehicles live right now' : `${markers} vehicle${markers === 1 ? '' : 's'} live right now`)
            : 'Loading live vehicles…',
        },
        {
          id: 'plan', label: 'Plan a trip',
          proof: meta ? `From the published timetable (feed ${meta.feed_version})` : 'From the published timetable',
        },
        {
          id: 'ride-along', label: 'Ride Along',
          proof: pm.boardable.length ? `${pm.boardable.length} vehicle${pm.boardable.length === 1 ? '' : 's'} reporting` : 'No vehicles reporting right now',
        },
        { id: 'all-routes', label: 'All routes', proof: `${routesTotal} SEPTA routes` },
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
    n.innerHTML = `<div class="lt-launcher-head">
        <strong>Start here</strong>
        <button type="button" data-action="launcher-toggle" aria-expanded="true">Collapse</button>
      </div>
      <div class="lt-tiles">${m.tiles.map((t) => `
        <button type="button" class="lt-tile" data-action="launcher-tile" data-tile="${esc(t.id)}">
          <span class="lt-tile-label">${esc(t.label)}</span>
          <span class="lt-tile-proof">${esc(t.proof)}</span>
        </button>`).join('')}
      </div>`;
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

  async function onPlacesToggle(on) {
    state.places.enabled = !!on;
    if (!on) { state.places.status = 'off'; renderPlaces(); return; }
    // Session-only (LT-S9.2): the enabled state lives in memory —
    // nothing about Places is ever written to storage.
    if (state.places.status === 'ready') { renderPlaces(); return; }
    state.places.status = 'loading';
    renderPlaces();
    state.places.fetches++;
    try {
      const dataset = await stampedJson(config.assets.places, fetchImpl);
      const list = Array.isArray(dataset) ? dataset : dataset.places;
      if (!Array.isArray(list)) throw new Error('places dataset has no places list');
      state.places.places = list.filter((p) => p && typeof p.name === 'string');
      state.places.coverage = dataset.coverage || null;
      state.places.attribution = dataset.attribution || null;
      state.places.status = 'ready';
    } catch (e) {
      state.places.status = 'unavailable';
      state.places.note = 'Places is unavailable right now. It will retry the next time you turn it on.';
    }
    renderPlaces();
    if (state.card) renderCard();
  }

  function renderPlaces() {
    const n = el('lt-places');
    if (!n) return;
    const p = state.places;
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
    const feedLine = meta ? `now · feed ${esc(meta.feed_version)}` : 'now · published timetable (loads on first use)';
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
          box.innerHTML = groups.map((g) => `
            <p class="lt-stop-group"><strong>${esc(g.name)}</strong><br>${g.stops.map((s) =>
              `<button type="button" data-action="plan-pick" data-which="${which}" data-idx="${s.idx}">${esc(s.name)}</button>`).join(' ')}</p>`).join('');
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
      const legs = (journey.legs || []).map((leg) => {
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
    else if (action === 'ride-exit') { rideAlong.exit(); renderRideAlong(); if (state.card) renderCard(); }
    else if (action === 'ride-open') { const n = el('lt-ride-along'); if (n && n.scrollIntoView) n.scrollIntoView(); }
    else if (action === 'launcher-toggle') onLauncherToggle();
    else if (action === 'launcher-tile') onLauncherTile(d.tile);
    else if (action === 'places-toggle') onPlacesToggle(d.on === '1');
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

  const api = {
    mount, setData, handlePick, openCard, closeCard,
    onGroupToggle, onRouteVisibility, onRouteSolo, onRouteShowAll,
    boardVehicle, onLauncherToggle, onLauncherTile, onNearMe,
    onPlacesToggle, onPlanRun, applyDeepLink, ensureTimetable,
    showLoadError, clearLoadError,
    models: {
      status: statusModel, stopCard: buildStopCardModel,
      vehicleCard: buildVehicleCardModel, routeCard: buildRouteCardModel,
      alerts: alertsModel, launcher: launcherModel, browse: browseModel,
      stopSearchGroups, scheduledDeparturesAt,
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
  const live = m.liveArrivals.map((r) => `
    <li><strong>${esc(r.routeLabel)}</strong>${r.headsign ? ` — ${esc(r.headsign)}` : ''}
      · ${esc(r.whenText)} <span class="lt-live">LIVE</span>
      ${r.vehicleId ? `<button type="button" data-action="board-vehicle" data-agency="${esc(r.agency)}" data-vehicle-id="${esc(r.vehicleId)}">Ride vehicle ${esc(r.vehicleId)}</button>` : ''}
    </li>`).join('');
  const sched = m.scheduledArrivals.map((r) => `
    <li><strong>${esc(r.routeLabel)}</strong>${r.headsign ? ` — ${esc(r.headsign)}` : ''}
      · ${esc(r.whenText)} <span class="lt-sched">scheduled</span></li>`).join('');
  return `<article class="lt-card lt-stop-card">
    <h2>${esc(m.stopName)}</h2>
    <p class="lt-card-sub">${esc(m.routesLine)}</p>
    ${m.alerts.length ? `<div class="lt-card-alerts">${m.alerts.map((a) => `<p>⚠ ${esc(a.header)} <span class="lt-scope">(${esc(a.scope)})</span></p>`).join('')}</div>` : ''}
    <h3>Next arrivals</h3>
    ${live ? `<ul class="lt-arrivals">${live}</ul>` : '<p>No live arrivals in the next 90 minutes.</p>'}
    ${sched ? `<ul class="lt-arrivals lt-scheduled">${sched}</ul>` : ''}
    ${m.timetablePending ? '<p class="lt-note">Scheduled times load with the timetable…</p>' : ''}
    ${m.boardingRows.length ? `<h3>Live on these routes</h3>
      <ul class="lt-boarding">${m.boardingRows.map((r) => `
        <li><button type="button" data-action="board-vehicle" data-agency="${esc(r.agency)}" data-vehicle-id="${esc(r.vehicleId)}">${esc(r.routeLabel)} — vehicle ${esc(r.vehicleId)}</button>${r.headsign ? ` to ${esc(r.headsign)}` : ''}${r.distanceM != null ? ` · ${r.distanceM} m away` : ''}</li>`).join('')}
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
      </ul>` : '<p>No vehicles live on this route right now.</p>'}
    <p><button type="button" data-action="route-solo" data-route="${esc(m.routeId)}">Show only this route</button>
    <button type="button" data-action="card-close">Close</button></p>
  </article>`;
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
    const [streets, bus, rail, stops, water, landmarks, names] = await Promise.all([
      stampedJson(paths.streets, deps.fetchImpl),
      stampedJson(paths.routesByFeed.bus, deps.fetchImpl),
      stampedJson(paths.routesByFeed.rail, deps.fetchImpl),
      stampedJson(paths.stops, deps.fetchImpl),
      stampedJson(paths.water, deps.fetchImpl),
      stampedJson(paths.landmarks, deps.fetchImpl),
      stampedJson(paths.streetNames, deps.fetchImpl),
    ]);
    await renderer.loadGeometry({
      streets, routesByFeed: { bus, rail }, stops, water, landmarks, names,
    });
  } catch (e) {
    api.showLoadError(e);
    return api;
  }
  const pollLive = async () => {
    try {
      const [v, tu] = await Promise.all([
        pollVehicles(deps.fetchImpl), pollTripUpdates(deps.fetchImpl),
      ]);
      api.setData({ vehicles: v, tripUpdates: tu, vehiclesError: null });
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
