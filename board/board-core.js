/* board-core.js — Departure Board computation core (Project 29 successor,
 * web first slice). Pure functions, no DOM: the page (index.html) renders
 * what this module computes, and the verification harness imports the same
 * module in Node.
 *
 * Parity contract (design note §4): DDOT departures are a line-for-line
 * port of computeStopArrivals in live-transit.js (build 20261019-2200),
 * with the two Project-13 UI gates omitted (a fresh app profile passes
 * every route through both) and the live-delay shift behind the
 * delayState parameter — null in this slice, because tripDelayState is
 * produced only inside the map's 3D polling loop and is published
 * nowhere (design note §6). serviceFor / the timetable index come from
 * the app's own raptor.js, injected as R — imported, never re-implemented.
 */

export function detroitParts(whenMs) {
  var o = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Detroit', year: 'numeric', month: 'numeric', day: 'numeric',
    weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23'
  }).formatToParts(new Date(whenMs)).forEach(function (p) { o[p.type] = p.value; });
  return {
    ymd: o.year + String(o.month).padStart(2, '0') + String(o.day).padStart(2, '0'),
    dow: { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[o.weekday],
    sec: (+o.hour) * 3600 + (+o.minute) * 60 + (+o.second)
  };
}

/* Feed `updated_at` stamps are Detroit-local NAIVE strings
 * ("2026-11-08T06:44:00", no offset). `new Date()` parses those in the
 * CLIENT's timezone, so a visitor off America/Detroit ages every fix by
 * their offset from Detroit and fresh buses fail the 15-minute
 * liveness gate in liveEndpointForRoute. Parse naive stamps as
 * America/Detroit wall time; stamps carrying an explicit offset or Z
 * keep native parsing. Detroit's offset for a wall time is resolved
 * through detroitParts (already pinned to America/Detroit): read the
 * guess instant's Detroit wall reading back and shift by the
 * difference; iterating settles ordinary cases in two passes. */
export function feedStampMs(stamp) {
  if (stamp == null) return NaN;
  if (typeof stamp === 'number') return stamp;
  var s = String(stamp).trim();
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) return new Date(s).getTime();
  var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(s);
  if (!m) return new Date(s).getTime();
  var wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), +(m[7] || 0));
  var t = wall;
  for (var i = 0; i < 3; i++) {
    var dp = detroitParts(t);
    var reading = Date.UTC(+dp.ymd.slice(0, 4), +dp.ymd.slice(4, 6) - 1, +dp.ymd.slice(6, 8)) + dp.sec * 1000;
    var nt = wall - (reading - t);
    if (nt === t) break;
    t = nt;
  }
  return t;
}

/* The app's projection (live-transit.js project()): meters about the
 * shared origin carried identically by all three registry files. */
export function makeProj(projection) {
  var DEG = Math.PI / 180;
  return {
    lat0: projection.lat0, lon0: projection.lon0,
    mLat: 111320, mLon: 111320 * Math.cos(projection.lat0 * DEG)
  };
}
export function projectLatLon(proj, lat, lon) {
  return [(lon - proj.lon0) * proj.mLon, -(lat - proj.lat0) * proj.mLat];
}
export function unproject(proj, x, z) {
  return { lat: proj.lat0 - z / proj.mLat, lon: proj.lon0 + x / proj.mLon };
}

/* The merged stop registry, built exactly as the app's boot merge:
 * DDOT stops, then SMART, then QLINE (indices are load-bearing — the
 * timetable's stop index space is the DDOT segment). SMART routes are
 * recolored uniformly to SMART #808080, as the app's merge does. */
export function buildRegistry(ddot, smart, qline) {
  var stops = [], routesById = {}, routeNames = {}, smartRouteIds = {};
  function addRoutes(data, seg) {
    (data.routes || []).forEach(function (r) {
      var rec = { id: String(r.id), name: r.name || String(r.id),
                  color: seg === 'smart' ? '#313131' : (r.color || '#f2f2f2'), seg: seg,
                  paths: Array.isArray(r.paths) ? r.paths : null };
      routesById[rec.id] = rec;
      routeNames[rec.id] = rec.name;
      if (seg === 'smart') smartRouteIds[rec.id] = true;
    });
  }
  function addStops(data, seg) {
    (data.stops || []).forEach(function (s) {
      var rec = { id: s.id, n: s.n || '', x: s.x, z: s.z, r: (s.r || []).map(String),
                  pm: !!s.pm, seg: seg, idx: stops.length };
      /* FULL INTEGRATION #13 (2026-11-11): the 46 SMARTGTFS stops the
         2026-11-05 registry tranche appended to the QLINE file are
         SMART stops — segment follows the record, not the source
         file, so they take the SMART branch (live times) instead of
         presenting as QLINE. No index moves: idx is assigned in the
         same merge order as before. */
      if (seg !== 'smart' && typeof s.id === 'string' && s.id.indexOf('SMARTGTFS:') === 0) rec.seg = 'smart';
      stops.push(rec);
    });
  }
  addRoutes(ddot, 'ddot'); addStops(ddot, 'ddot');
  if (smart && Array.isArray(smart.routes) && smart.routes.length) { addRoutes(smart, 'smart'); addStops(smart, 'smart'); }
  if (qline && Array.isArray(qline.routes) && qline.routes.length) { addRoutes(qline, 'qline'); addStops(qline, 'qline'); }
  return { stops: stops, routesById: routesById, routeNames: routeNames, smartRouteIds: smartRouteIds };
}

/* routeLabel, transcribed from live-transit.js. */
export function routeLabel(routeNames, rid) {
  var name = routeNames[rid];
  if (!name) return String(rid);
  if (name === rid) return name;
  if (/^\d+$/.test(rid)) return name + ' - ' + rid;
  return name;
}

export function nearestStop(stops, proj, lat, lon) {
  var p = projectLatLon(proj, lat, lon);
  var best = null, bd = Infinity;
  for (var i = 0; i < stops.length; i++) {
    var s = stops[i];
    if (s.x == null || s.z == null) continue;
    var d = Math.hypot(s.x - p[0], s.z - p[1]);
    if (d < bd) { bd = d; best = s; }
  }
  return best ? { stop: best, distM: bd } : null;
}

/* The board's catchment radius (J directive, 2026-11-08): when the
 * rider locates, every stop within this radius of the rider is on
 * the board — the nearest is shown first, the rest one tap away. */
export var BOARD_RADIUS_M = 500;

/* All stops within radiusM of a lat/lon (default BOARD_RADIUS_M),
 * nearest first: [{stop, distM}]. Same projected-metre distance as
 * nearestStop, so the two always agree on the nearest stop. */
export function stopsWithinRadius(stops, proj, lat, lon, radiusM) {
  var r = (radiusM == null ? BOARD_RADIUS_M : radiusM);
  var p = projectLatLon(proj, lat, lon);
  var out = [];
  for (var i = 0; i < stops.length; i++) {
    var s = stops[i];
    if (s.x == null || s.z == null) continue;
    var d = Math.hypot(s.x - p[0], s.z - p[1]);
    if (d <= r) out.push({ stop: s, distM: d });
  }
  out.sort(function (a, b) { return a.distM - b.distM; });
  return out;
}

/* FIX-B U2 (2026-11-11): tokenised stop search. The query and stop
 * names are normalised the same way (case, punctuation, and street
 * suffixes — Dr/Drive, St/Street, Ave/Avenue, …), split into tokens,
 * and a stop matches when EVERY query token appears in its name, in
 * any order — so "North Park & Providence", "Providence & North Park"
 * and "North Park Providence Dr" all find the same stop. An exact
 * stop-id match (full id or the part after the agency prefix) also
 * qualifies. Registry order and the caller's cap are preserved. */
var SUFFIX_EXPAND = { dr: 'drive', st: 'street', ave: 'avenue', av: 'avenue',
  blvd: 'boulevard', rd: 'road', ln: 'lane', ct: 'court', pl: 'place',
  hwy: 'highway', ter: 'terrace', cir: 'circle', sq: 'square' };
export function normalizeSearchText(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/)
    .filter(Boolean).map(function (t) { return SUFFIX_EXPAND[t] || t; }).join(' ');
}
export function searchStops(stops, q, limit) {
  var raw = String(q || '').trim().toLowerCase();
  if (!raw) return [];
  var tokens = normalizeSearchText(raw).split(' ').filter(Boolean);
  if (!tokens.length) return [];
  var out = [];
  for (var i = 0; i < stops.length && out.length < (limit || 12); i++) {
    var s = stops[i];
    if (String(s.id).toLowerCase() === raw || smartStopKey(s.id).toLowerCase() === raw) { out.push(s); continue; }
    if (!s.n) continue;
    var name = ' ' + normalizeSearchText(s.n) + ' ';
    var ok = true;
    for (var t = 0; t < tokens.length; t++) if (name.indexOf(tokens[t]) < 0) { ok = false; break; }
    if (ok) out.push(s);
  }
  return out;
}

/* FIX-B U4 (2026-11-11): route-first search. A query matches a route
 * when it IS the route id, or when every query token appears in the
 * route's name (same normalisation as stop search). Exact-id matches
 * sort first. Returns [{id, name, seg, label}]. */
export function searchRoutes(reg, q, limit) {
  var raw = String(q || '').trim().toLowerCase();
  if (!raw || !reg || !reg.routesById) return [];
  var tokens = normalizeSearchText(raw).split(' ').filter(Boolean);
  var exact = [], named = [];
  Object.keys(reg.routesById).forEach(function (id) {
    var rec = reg.routesById[id];
    var item = { id: rec.id, name: rec.name, seg: rec.seg, label: routeLabel(reg.routeNames, rec.id) };
    if (String(rec.id).toLowerCase() === raw) { exact.push(item); return; }
    if (!tokens.length) return;
    var name = ' ' + normalizeSearchText(rec.name) + ' ';
    var ok = true;
    for (var t = 0; t < tokens.length; t++) if (name.indexOf(tokens[t]) < 0) { ok = false; break; }
    if (ok) named.push(item);
  });
  return exact.concat(named).slice(0, limit || 3);
}

/* FIX-B U4: a route's stops in pattern order. With a loaded DDOT
 * timetable, stops come from the route's patterns (one group per
 * direction, headsign from the pattern's trips, longest pattern kept
 * per direction); without one (SMART/QLINE), registry order filtered
 * to the route. Returns [{head, stops:[stopRec]}]. */
export function routeStopGroups(reg, tt, rid) {
  if (!reg || !reg.stops) return [];
  rid = String(rid);
  var groups = [];
  if (tt && Array.isArray(tt.patterns) && Array.isArray(tt.routes)) {
    var byHead = {};
    tt.patterns.forEach(function (pat) {
      var rec = tt.routes[pat.route];
      if (!rec || String(rec.id) !== rid) return;
      var head = '';
      for (var i = 0; i < (pat.trips || []).length && !head; i++) head = pat.trips[i].h || '';
      if (!head && pat.stops && pat.stops.length) {
        var term = reg.stops[pat.stops[pat.stops.length - 1]];
        head = term ? (term.n || '') : '';
      }
      if (!byHead[head] || pat.stops.length > byHead[head].length) byHead[head] = pat.stops;
    });
    Object.keys(byHead).forEach(function (head) {
      var stops = byHead[head].map(function (idx) { return reg.stops[idx]; }).filter(Boolean);
      if (stops.length) groups.push({ head: head, stops: stops });
    });
    if (groups.length) return groups;
  }
  var stops = reg.stops.filter(function (s) { return (s.r || []).map(String).indexOf(rid) >= 0; });
  return stops.length ? [{ head: '', stops: stops }] : [];
}

/* FIX-B U1 (2026-11-11): positions age from the consumed file's
 * generated_at. Bands mirror the task spec for the board: fresh at
 * or under 7.5 minutes, delayed beyond it. (SMART's separate 15-min
 * drop lives in smartDepartures / SMART_TU_STALE_MS, unchanged.)
 * Returns null when generated_at is missing or unparseable — a
 * delayed claim is never fabricated without a last-update time. */
export var POSITIONS_DELAYED_MS = 7.5 * 60 * 1000;
export function positionsAge(generatedAt, nowMs) {
  var genMs = generatedAt == null ? NaN
    : (typeof generatedAt === 'number' ? generatedAt : new Date(generatedAt).getTime());
  if (isNaN(genMs)) return null;
  var ageMs = Math.max(0, nowMs - genMs);
  return { genMs: genMs, ageMs: ageMs, ageMin: Math.floor(ageMs / 60000),
           delayed: ageMs > POSITIONS_DELAYED_MS };
}
/* The map's degradation headline, verbatim form (live-transit.js
 * svcHeadline 'stale'): "Live positions delayed — last update
 * {time}, {N} minutes ago." */
export function delayedPositionsText(age) {
  if (!age) return '';
  return 'Live positions delayed — last update ' + formatClock12Detroit(age.genMs) +
    ', ' + age.ageMin + (age.ageMin === 1 ? ' minute' : ' minutes') + ' ago.';
}

export function findStopById(stops, id) {
  id = String(id == null ? '' : id);
  for (var i = 0; i < stops.length; i++) if (String(stops[i].id) === id) return stops[i];
  return null;
}

export function stopServedBySmart(smartRouteIds, st) {
  if (!st || !st.r || !st.r.length) return false;
  for (var i = 0; i < st.r.length; i++) if (smartRouteIds[String(st.r[i])]) return true;
  return false;
}

/* DDOT departures at a timetable stop index — the computeStopArrivals
 * port. delayState: a Map(trip -> {delaySec, vehicleId, disrupted}) in
 * the app's shape, or null (this slice: no live shift; design note §6).
 * Returns {state: 'loading'|'na'|'nosvc'|'ready', rows:[{rid, head,
 * eta (Detroit service-day seconds, possibly > 86400-frame shifted
 * into today), live, bus}]} exactly as the app's function shapes them. */
export function computeDdotDepartures(R, tt, stopData, idx, nowMs, delayState) {
  var DELAY_PROJECTION = 0.6; // rank 5 — the app's constant
  var out = { state: 'ready', rows: [] };
  if (!tt || !R || !R.serviceFor) { out.state = 'loading'; return out; }
  if (idx == null || idx < 0 || idx >= tt.nStops) { out.state = 'na'; return out; }
  var dp = detroitParts(nowMs);
  var dpPrev = detroitParts(nowMs - 86400000);
  var svc = R.serviceFor(tt, dp.ymd, dp.dow);
  var prevSvc = R.serviceFor(tt, dpPrev.ymd, dpPrev.dow);
  if (svc < 0 && prevSvc < 0) { out.state = 'nosvc'; return out; }
  var nowSec = dp.sec;
  var pats = tt.stopPat[idx] || [];
  var rows = [];
  for (var q = 0; q < pats.length; q++) {
    var pat = tt.patterns[pats[q][0]];
    var pos = pats[q][1];
    for (var ti = 0; ti < pat.trips.length; ti++) {
      var t = pat.trips[ti];
      var shift = 0;
      if (t.s !== svc) { if (t.s !== prevSvc) continue; shift = -86400; }
      var arr = t.arrL2 || t.arr;
      var eta = arr[pos] + shift;
      if (eta < nowSec - 30 || eta > nowSec + 3 * 3600) continue;
      var dstate = delayState ? delayState.get(t) : null;
      var isLive = !!(dstate && dstate.vehicleId && !dstate.disrupted);
      if (isLive) {
        eta += dstate.delaySec * DELAY_PROJECTION;
        if (eta < nowSec - 30) continue;
      }
      var head = t.h || '';
      if (!head && pat.stops && pat.stops.length) {
        var term = stopData && stopData[pat.stops[pat.stops.length - 1]];
        head = term ? (term.n || '') : '';
      }
      var routeRec = tt.routes ? tt.routes[pat.route] : null;
      var rowRid = routeRec ? routeRec.id : pat.route;
      rows.push({ rid: rowRid, head: head, eta: eta, live: isLive, bus: isLive ? dstate.vehicleId : null });
    }
  }
  rows.sort(function (a, b) { return a.eta - b.eta; });
  out.rows = rows.slice(0, 5);
  return out;
}

/* --- SMART live times from the per-route trip-updates derivative ---
 * Mirrors the app's ingestSmartTripUpdates + smartTuRowsForStop over
 * live-data/smart-tu/ files (the derivative carries departure-first
 * epochs and a gen+2h window — design note §4). derivByRoute: Map of
 * route id -> parsed derivative file. Returns null when no usable
 * payload exists (stale gen, the app's SMART_TU_STALE_MS rule), else
 * rows [{rid, trip, bus, time (epoch s), delay}] sorted, max 5. */
export var SMART_TU_STALE_MS = 15 * 60 * 1000;
export function smartStopKey(id) {
  var s = String(id == null ? '' : id);
  var i = s.lastIndexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}
export function smartDepartures(derivByRoute, smartRouteIds, st, indexGenSec, nowMs) {
  if (indexGenSec == null || isNaN(indexGenSec)) return null;
  if (nowMs - indexGenSec * 1000 > SMART_TU_STALE_MS) return null;
  if (!stopServedBySmart(smartRouteIds, st)) return null;
  var key = smartStopKey(st.id);
  var nowSec = nowMs / 1000;
  var rows = [];
  st.r.forEach(function (rid) {
    var f = derivByRoute.get(String(rid));
    if (!f || !Array.isArray(f.trips)) return;
    f.trips.forEach(function (tuple) {
      if (!tuple || tuple[4] === 'CANCELED') return;
      var ups = tuple[3] || [];
      for (var i = 0; i < ups.length; i++) {
        var u = ups[i];
        if (smartStopKey(u[0]) !== key) continue;
        var tm = u[1];
        if (tm == null || tm < nowSec - 30 || tm > nowSec + 3 * 3600) continue;
        rows.push({ rid: String(tuple[1] || rid), trip: tuple[0] || '', bus: null, time: tm, delay: (u[2] != null ? u[2] : null) });
      }
    });
  });
  rows.sort(function (a, b) { return a.time - b.time; });
  return rows.slice(0, 5);
}

/* QLINE live streetcars for a stop: vehicles.json agency 'qline',
 * nearest first, with straight-line distance and fix age. The app
 * publishes no QLINE arrival times; this is positions data, labeled. */
export function qlineStreetcars(vehicles, proj, st, nowMs) {
  var out = [];
  (vehicles || []).forEach(function (v) {
    if (!v || v.agency !== 'qline' || v.lat == null || v.lon == null) return;
    var p = projectLatLon(proj, v.lat, v.lon);
    out.push({
      vehicleId: v.vehicle_id || '', distM: Math.hypot(p[0] - st.x, p[1] - st.z),
      ageS: v.updated_at ? Math.max(0, Math.round((nowMs - feedStampMs(v.updated_at)) / 1000)) : null,
      destination: v.destination || ''
    });
  });
  out.sort(function (a, b) { return a.distM - b.distM; });
  return out;
}

/* The app's time-text rule (renderStopArrivals / SMART rows):
 * 'now' under 45 s, 'in Nm' through 90 min, else the clock string. */
export function timeText(dSec, clockStr) {
  if (dSec < 45) return 'now';
  if (dSec <= 5400) return 'in ' + Math.round(dSec / 60) + 'm';
  return clockStr;
}

/* formatClock12, transcribed (epoch ms -> viewer's clock; the page
 * pins America/Detroit, the service's own timezone). */
export function formatClock12Detroit(ms) {
  var parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Detroit', hour: 'numeric', minute: '2-digit', hour12: true
  }).formatToParts(new Date(ms));
  var h = '', m = '', ap = '';
  parts.forEach(function (p) {
    if (p.type === 'hour') h = p.value;
    if (p.type === 'minute') m = p.value;
    if (p.type === 'dayPeriod') ap = p.value;
  });
  return h + ':' + m + ' ' + ap;
}

/* --- Live endpoint selection for a route chip (board → map, §2) --------
 * A route chip resolves to ONE live endpoint: a vehicle record from
 * vehicles.json. Pure, deterministic — same feed in, same endpoint out.
 * Rules in order: route+agency match with a usable fix; fix age within
 * LIVE_ENDPOINT_STALE_MS; direction match (destination === the next
 * departure's headsign) outranks proximity; on the direction path, a
 * vehicle still short of the stop (approaching) outranks one past it;
 * ties break on fresher fix, then vehicle_id. Returns null when no
 * vehicle qualifies. (FULL INTEGRATION, 2026-11-11: SMART vehicles
 * ride vehicles.json with route_id + destination, so SMART chips
 * resolve through this same path.) */
export var LIVE_ENDPOINT_STALE_MS = 15 * 60 * 1000;

/* Along-line position of a projected point on one path (array of
 * [x, z] vertices): cumulative metres to the nearest point on the
 * path, or null for a degenerate path. The First Look line-up's
 * projection, in board-core's projected-metre space. */
export function alongLineM(path, x, z) {
  if (!path || path.length < 2) return null;
  var best = null, acc = 0;
  for (var i = 0; i + 1 < path.length; i++) {
    var ax = path[i][0], az = path[i][1], bx = path[i + 1][0], bz = path[i + 1][1];
    var dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
    var t = len > 0 ? ((x - ax) * dx + (z - az) * dz) / (len * len) : 0;
    t = Math.max(0, Math.min(1, t));
    var d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
    if (!best || d < best.d) best = { s: acc + len * t, d: d };
    acc += len;
  }
  return best;
}

/* The route's longest path — the direction spine the approach test
 * runs on (a route's paths are its direction shapes). */
export function longestPath(paths) {
  if (!paths || !paths.length) return null;
  var best = null, bl = -1;
  paths.forEach(function (p) {
    var l = 0;
    for (var i = 0; i + 1 < p.length; i++) l += Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
    if (l > bl) { bl = l; best = p; }
  });
  return best;
}

export function liveEndpointForRoute(vehicles, proj, paths, st, rid, wantHead, nowMs) {
  if (!vehicles || !st) return null;
  var spine = longestPath(paths);
  var stopAlong = spine ? alongLineM(spine, st.x, st.z) : null;
  var cands = [];
  vehicles.forEach(function (v) {
    if (!v || String(v.route_id) !== String(rid) || v.agency !== st.seg) return;
    if (v.lat == null || v.lon == null) return;
    var ageMs = v.updated_at ? nowMs - feedStampMs(v.updated_at) : Infinity;
    if (!(ageMs <= LIVE_ENDPOINT_STALE_MS)) return;
    var p = projectLatLon(proj, v.lat, v.lon);
    var along = spine ? alongLineM(spine, p[0], p[1]) : null;
    cands.push({
      vehicle: v, ageMs: ageMs,
      distM: Math.hypot(p[0] - st.x, p[1] - st.z),
      dirMatch: !!(wantHead && v.destination && String(v.destination) === String(wantHead)),
      passed: !!(along && stopAlong && along.s > stopAlong.s + 25),
      remainM: (along && stopAlong) ? stopAlong.s - along.s : null
    });
  });
  if (!cands.length) return null;
  cands.sort(function (a, b) {
    if (a.dirMatch !== b.dirMatch) return a.dirMatch ? -1 : 1;
    if (a.passed !== b.passed) return a.passed ? 1 : -1;
    if (!a.passed && a.remainM != null && b.remainM != null && a.remainM !== b.remainM) return a.remainM - b.remainM;
    if (a.distM !== b.distM) return a.distM - b.distM;
    if (a.ageMs !== b.ageMs) return a.ageMs - b.ageMs;
    return String(a.vehicle.vehicle_id).localeCompare(String(b.vehicle.vehicle_id));
  });
  var c = cands[0];
  return { vehicle: c.vehicle, distM: c.distM, ageS: Math.round(c.ageMs / 1000),
           dirMatch: c.dirMatch, passed: c.passed };
}
