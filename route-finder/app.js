/* Route Finder — Live Transit Detroit (production, 2026-11-21).
 * Owner pick 2026-11-21 11:47 EST: Variant A "Hall Split" as written.
 * Planning: the production engine, reused by name — raptor-v2.js (RAPTOR over
 * planner-timetable-S1000182-S1000147.json: DDOT GTFS + SMART GTFS merged) and
 * live-fusion.js fuseJourneys() (Phase 2a live annotation: vehicles reporting
 * per route). Live data: live-data/vehicles.json (DDOT + QLINE) and
 * live-data/smart-display.json (SMART) from the production feeds (CORS *).
 * Honesty contract: a step is labeled LIVE only when its basis is a live
 * vehicle observation; timetable times are always labeled SCHEDULED.
 */
import * as Raptor from '../raptor-v2.js';
import { fuseJourneys } from '../live-fusion.js';

const TT_URL = '/planner/assets/planner-timetable-S1000182-S1000147.json';
const SIDECAR_URL = '/planner/assets/stops-sidecar.json';
const VEH_URL = '/live-data/vehicles.json';
const SMART_URL = '/live-data/smart-display.json';
const WALK_MPS = 1.4, SEED_RADIUS_M = 900, SEED_COUNT = 6;

const $ = id => document.getElementById(id);
const boardBody = $('boardBody'), arriveAt = $('arriveAt'), mapTag = $('mapTag'), srcLine = $('srcLine');

let TT = null, stops = [], stopByIdx = {}, landmarks = [];
let liveVehicles = [], liveStamp = null, liveTimer = null;
let origin = { lat: 42.4560, lon: -83.2107, label: 'Your location (default — Southfield; tap “Use my location” or type a place)' };
let destination = null; // {lat, lon, label}
let currentJourneys = [], currentSel = 0;

function havM(a, b) {
  const R0 = 6371000, p = Math.PI / 180;
  const dLa = (b.lat - a.lat) * p, dLo = (b.lon - a.lon) * p;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dLo / 2) ** 2;
  return 2 * R0 * Math.asin(Math.sqrt(h));
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function clock(sec) { return Raptor.fmtClockSec(((Math.round(sec) % 86400) + 86400) % 86400); }

/* ---------- place resolution (on-device only; no third-party geocoder) ---------- */
function searchPlaces(q) {
  q = q.trim().toLowerCase(); if (q.length < 2) return [];
  const out = [];
  for (const lm of landmarks) if (lm.name.toLowerCase().includes(q)) out.push({ kind: 'Place', label: lm.name, lat: lm.lat, lon: lm.lon });
  if (out.length < 8) {
    const toks = q.split(/\s+/).filter(Boolean);
    for (const s of stops) {
      const n = s.name.toLowerCase();
      if (toks.every(t => n.includes(t))) { out.push({ kind: 'Stop', label: s.name, lat: s.lat, lon: s.lon, stopIdx: s.idx }); if (out.length >= 8) break; }
    }
  }
  return out;
}
function wireSuggest(input, box, pick) {
  function show() {
    const hits = searchPlaces(input.value);
    if (!hits.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.innerHTML = hits.map((h, i) => `<button type="button" data-i="${i}"><span class="kind">${h.kind}</span>${esc(h.label)}</button>`).join('');
    box.hidden = false;
    box.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { pick(hits[+b.dataset.i]); box.hidden = true; }));
  }
  input.addEventListener('input', show);
  input.addEventListener('focus', show);
  document.addEventListener('click', e => { if (!box.contains(e.target) && e.target !== input) box.hidden = true; });
}

/* ---------- seeds & destination stop ---------- */
function seedsFor(pt) {
  return stops.map(s => ({ s, d: havM(pt, s) })).filter(x => x.d <= SEED_RADIUS_M)
    .sort((a, b) => a.d - b.d).slice(0, SEED_COUNT)
    .map(x => ({ stop: x.s.idx, walk: Math.max(60, Math.round(x.d / WALK_MPS)) }));
}
function nearestStop(pt) {
  let best = null, bd = Infinity;
  for (const s of stops) { const d = havM(pt, s); if (d < bd) { bd = d; best = s; } }
  return { stop: best, distM: bd };
}

/* ---------- step grammar ---------- */
function stepsFor(j) {
  const fused = fuseJourneys([j], liveVehicles)[0];
  const liveCount = {};
  fused.legs.forEach(l => { if (l.type === 'bus') liveCount[l.routeId] = l.liveVehicles || 0; });
  const steps = []; const legs = j.legs;
  let pendingWalk = 0;
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i];
    if (l.type === 'walk') { pendingWalk += l.secs; continue; }
    if (l.type === 'bus') {
      if (pendingWalk > 0) {
        const first = steps.length === 0;
        steps.push({ verb: 'Walk', text: `${Math.max(1, Math.round(pendingWalk / 60))} min to ${stopByIdx[l.board].name}`, basis: 'SCHEDULED', cls: 'sched', note: first ? 'walk estimate' : 'transfer walk' });
        pendingWalk = 0;
      }
      const t = l.tripRef, ns = t.stops.indexOf(l.alight) - t.stops.indexOf(l.board);
      const lc = liveCount[l.routeId] || 0;
      let basis, cls;
      if (l.provenance === 'live') { basis = 'LIVE'; cls = 'live'; }
      else if (lc > 0) { basis = `SCHEDULED · ${lc} LIVE ON ROUTE`; cls = 'sched'; }
      else { basis = 'SCHEDULED'; cls = 'sched'; }
      steps.push({ verb: 'Board', text: `Route ${l.routeId} ${l.routeName}${l.headsign ? ' toward ' + l.headsign : ''} at ${stopByIdx[l.board].name} — ${clock(l.boardSec)}`, basis, cls, note: l.disrupted ? 'trip reported disrupted' : '' });
      steps.push({ verb: 'Ride', text: `${ns} stops · ${Math.max(1, Math.round((l.alightSec - l.boardSec) / 60))} min — get off at ${stopByIdx[l.alight].name}, ${clock(l.alightSec)}`, basis: 'SCHEDULED', cls: 'sched', note: l.interp ? 'intermediate times interpolated' : '' });
    }
  }
  const lastBus = [...legs].reverse().find(l => l.type === 'bus');
  if (lastBus && destination) {
    const dM = havM(stopByIdx[lastBus.alight], destination);
    if (dM > 40) steps.push({ verb: 'Walk', text: `${Math.max(1, Math.round(dM / WALK_MPS / 60))} min (${Math.round(dM)} m) to ${destination.label}`, basis: 'SCHEDULED', cls: 'sched', note: 'walk estimate' });
    else steps.push({ verb: 'Arrive', text: `${destination.label} — you are at your stop, ${clock(j.arriveSec)}`, basis: 'SCHEDULED', cls: 'sched', note: '' });
  }
  return steps;
}

function renderJourney(j, idx) {
  currentSel = idx;
  const steps = stepsFor(j);
  arriveAt.textContent = 'ARRIVE ' + j.arriveClock.toUpperCase();
  let html = `<p class="summary"><b>${j.departClock} → ${j.arriveClock}</b> · ${j.durationMin} min · ${j.transfers} transfer${j.transfers === 1 ? '' : 's'} · ${j.walkMin} min walking</p>`;
  html += '<ol class="steps">' + steps.map(s =>
    `<li><span class="n" aria-hidden="true"></span><span class="step-main"><span class="verb">${esc(s.verb)}</span> — ${esc(s.text)}${s.note ? ` <span style="color:var(--ink-400)">(${esc(s.note)})</span>` : ''}</span><span class="basis ${s.cls}">${esc(s.basis)}</span></li>`).join('') + '</ol>';
  html += `<p class="honesty">Times marked LIVE come from a vehicle reporting now. SCHEDULED times are the published timetable. “Live on route” counts vehicles reporting on that route this minute — it confirms the route is running, it is not a promise about your bus.</p>`;
  if (currentJourneys.length > 1) {
    html += '<div class="alts"><h3>OTHER WAYS</h3>' + currentJourneys.map((a, i) =>
      i === idx ? '' : `<button type="button" data-alt="${i}">${a.departClock} → ${a.arriveClock} · ${a.durationMin} min · ${a.transfers} transfer${a.transfers === 1 ? '' : 's'} · ${a.walkMin} min walking</button>`).join('') + '</div>';
  }
  boardBody.innerHTML = html;
  boardBody.querySelectorAll('[data-alt]').forEach(b => b.addEventListener('click', () => { renderJourney(currentJourneys[+b.dataset.alt], +b.dataset.alt); drawMap(); }));
  drawMap();
}

/* ---------- the map — BACK TO FORMULA rebuild (2026-11-21, owner S4 FAIL) ----------
 * Requirement, re-derived: a rider sees where they are, where their bus
 * runs, and where their trip goes, in Detroit, at a glance. The formula is
 * the flagship's, inherited — not a parallel invention. live-transit.js
 * (3D) and live-transit-2d.html (the 2D floor view) render this same
 * geography from estate-held files in one projected-meter space; this
 * renderer uses the same sources, the same projection, the same drawing
 * conventions (network under everything, labels de-collided in priority
 * order, direct-cut framing):
 *   projection — lat0/lon0, 111320 m/deg (live-transit.js `proj`)
 *   streets — ../assets/detroit-streets.json: TIGER/Line 2025 tier segment
 *     quads (live-transit.js buildStreets splitTier/addTier)
 *   street names — ../assets/detroit-street-names.json anchors (flagship
 *     label rule: major names, deduped, nearest win, capped)
 *   network — ../first-look-geo-2d.json: the floor view's distilled GTFS
 *     shape geometry — every route's true path + named stops
 *     (decodePath/decodeSource conventions from live-transit-2d.html)
 * Departure Hall adaptation: the flagship's dark ground becomes Hall
 * paper; street tiers render as gray washes, the network in ink, the
 * rider's journey solid black on a white casing. Zero third-party loads —
 * every byte is estate-held. */
const PROJ = { lat0: 42.381161, lon0: -83.148531, mLat: 111320 };
PROJ.mLon = 111320 * Math.cos(PROJ.lat0 * Math.PI / 180);
const GEO_URL = '../first-look-geo-2d.json';
const STREETS_URL = '../assets/detroit-streets.json';
const STREET_NAMES_URL = '../assets/detroit-street-names.json';

let geoRoutes = [], geoByKey = {}, geoStops = [], streetTiers = null, streetNameAnchors = [];
function projPt(lat, lon) { return [(lon - PROJ.lon0) * PROJ.mLon, -(lat - PROJ.lat0) * PROJ.mLat]; }
function decodePath(flat) {
  const pts = [[flat[0], flat[1]]];
  for (let i = 2; i < flat.length; i += 2) pts.push([pts[pts.length - 1][0] + flat[i], pts[pts.length - 1][1] + flat[i + 1]]);
  return pts;
}
async function loadGeoAssets() {
  try {
    const [geo, streets, names] = await Promise.all([
      fetch(GEO_URL).then(r => { if (!r.ok) throw new Error('geo'); return r.json(); }),
      fetch(STREETS_URL).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(STREET_NAMES_URL).then(r => r.ok ? r.json() : null).catch(() => null)
    ]);
    for (const src of (geo.sources || [])) {
      const key = src.key;
      for (const r of (src.routes || [])) {
        const rec = { key: key + '|' + r.id, id: String(r.id), name: r.name || '', agency: key, paths: r.paths.map(decodePath) };
        geoRoutes.push(rec); geoByKey[rec.key] = rec;
      }
      if (src.path) {
        const rec = { key: key + '|PM', id: 'PM', name: 'People Mover', agency: key, paths: [decodePath(src.path)] };
        geoRoutes.push(rec); geoByKey[rec.key] = rec;
      }
      for (const s of (src.stops || [])) geoStops.push({ n: s[0], x: s[1], z: s[2], r: s[3] ? s[3].split(',') : [] });
    }
    if (streets) streetTiers = streets;
    if (names && names.labels) streetNameAnchors = names.labels;
  } catch (e) { /* geography failed to load: drawMap degrades to markers + journey stop-sequence */ }
  drawMap();
}
function geoRouteFor(leg) {
  const ag = (leg.agency || '').toLowerCase();
  return geoByKey[ag + '|' + leg.routeId] || geoByKey['ddot|' + leg.routeId] || geoByKey['smart|' + leg.routeId] || null;
}
function longestPath(rec) {
  let best = rec.paths[0], bl = -1;
  for (const p of rec.paths) { let L = 0; for (let i = 1; i < p.length; i++) { const dx = p[i][0] - p[i - 1][0], dz = p[i][1] - p[i - 1][1]; L += dx * dx + dz * dz; } if (L > bl) { bl = L; best = p; } }
  return best;
}
/* the part of a route's true shape between two stops: nearest vertices on
 * the best-fitting path, with the stops themselves as endpoints */
function subPath(rec, aPt, bPt) {
  let best = null;
  for (const p of rec.paths) {
    let ia = 0, ib = 0, da = Infinity, db = Infinity;
    p.forEach((v, i) => {
      const d1 = (v[0] - aPt[0]) ** 2 + (v[1] - aPt[1]) ** 2; if (d1 < da) { da = d1; ia = i; }
      const d2 = (v[0] - bPt[0]) ** 2 + (v[1] - bPt[1]) ** 2; if (d2 < db) { db = d2; ib = i; }
    });
    if (!best || da + db < best.cost) best = { cost: da + db, p, ia, ib };
  }
  if (!best) return [aPt, bPt];
  const seg = best.p.slice(Math.min(best.ia, best.ib), Math.max(best.ia, best.ib) + 1);
  if (best.ia > best.ib) seg.reverse();
  return [aPt, ...seg, bPt];
}

const map = $('map'), mctx = map.getContext('2d');
function drawMap() {
  const dpr = window.devicePixelRatio || 1;
  const w = map.clientWidth, h = map.clientHeight; if (!w || !h) return;
  map.width = w * dpr; map.height = h * dpr; mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mctx.clearRect(0, 0, w, h); mctx.fillStyle = '#e9e9e9'; mctx.fillRect(0, 0, w, h);
  const j = currentJourneys[currentSel];

  /* ---- journey geometry first (framing needs it) ---- */
  const originPt = projPt(origin.lat, origin.lon);
  const destPt = destination ? projPt(destination.lat, destination.lon) : null;
  const legDraws = []; // {sub:[pts], boardPt, alightPt, boardStop, alightStop, rec, routeId}
  const journeyRouteIds = new Set();
  if (j) {
    for (const l of j.legs) {
      if (l.type !== 'bus') continue;
      journeyRouteIds.add(String(l.routeId));
      const bs = stopByIdx[l.board], as = stopByIdx[l.alight];
      if (!bs || !as) continue;
      const bPt = projPt(bs.lat, bs.lon), aPt = projPt(as.lat, as.lon);
      const rec = geoRouteFor(l);
      legDraws.push({ sub: rec ? subPath(rec, bPt, aPt) : [bPt, aPt], boardPt: bPt, alightPt: aPt, boardStop: bs, alightStop: as, rec, routeId: String(l.routeId), routeName: l.routeName || '' });
    }
  }

  /* ---- framing: direct cut, no animation (floor-view convention) ---- */
  let cx, cz, scale;
  if (legDraws.length || destPt) {
    const pts = [originPt]; if (destPt) pts.push(destPt);
    legDraws.forEach(d => { d.sub.forEach(p => pts.push(p)); });
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    pts.forEach(p => { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); });
    cx = (x0 + x1) / 2; cz = (z0 + z1) / 2;
    scale = Math.min(w / Math.max(900, (x1 - x0) * 1.22), h / Math.max(900, (z1 - z0) * 1.22));
    scale = Math.min(scale, w / 2200); // never tighter than a 2.2 km frame
  } else {
    cx = originPt[0]; cz = originPt[1]; scale = w / 9500; // rider's Detroit: ~9.5 km across
  }
  scale = Math.max(scale, w / 46000); // never wider than the metro frame
  const span = w / scale;
  const vx0 = cx - w / 2 / scale - 300, vx1 = cx + w / 2 / scale + 300;
  const vz0 = cz - h / 2 / scale - 300, vz1 = cz + h / 2 / scale + 300;
  const X = x => (x - cx) * scale + w / 2, Y = z => (z - cz) * scale + h / 2;
  const inView = (x, z, m) => x >= vx0 - (m || 0) && x <= vx1 + (m || 0) && z >= vz0 - (m || 0) && z <= vz1 + (m || 0);

  /* ---- 1. streets (TIGER tiers, clipped segment quads) ---- */
  if (streetTiers) {
    const tiers = [['local', '#dedede', 1, 11500], ['arterial', '#c7c7c7', 1.7, 1e9], ['freeway', '#b0b0b0', 2.8, 1e9]];
    for (const [name, style, width, maxSpan] of tiers) {
      const arr = streetTiers[name]; if (!arr || span > maxSpan) continue;
      mctx.strokeStyle = style; mctx.lineWidth = width; mctx.beginPath();
      for (let i = 0; i + 3 < arr.length; i += 4) {
        const x1 = arr[i], z1 = arr[i + 1], x2 = arr[i + 2], z2 = arr[i + 3];
        if ((x1 < vx0 && x2 < vx0) || (x1 > vx1 && x2 > vx1) || (z1 < vz0 && z2 < vz0) || (z1 > vz1 && z2 > vz1)) continue;
        mctx.moveTo(X(x1), Y(z1)); mctx.lineTo(X(x2), Y(z2));
      }
      mctx.stroke();
    }
  }

  /* ---- 2. the network: every route's true GTFS shape ---- */
  if (geoRoutes.length) {
    mctx.strokeStyle = 'rgba(17,17,17,0.20)'; mctx.lineWidth = 1.3; mctx.beginPath();
    for (const rec of geoRoutes) for (const p of rec.paths) {
      let started = false;
      for (const v of p) { if (!inView(v[0], v[1], 1500)) { started = false; continue; } if (!started) { mctx.moveTo(X(v[0]), Y(v[1])); started = true; } else mctx.lineTo(X(v[0]), Y(v[1])); }
    }
    mctx.stroke();
  }

  /* ---- 3. stops: small squares, distinct from vehicles; selective by span ---- */
  if (geoStops.length && span <= 11500) {
    const inV = geoStops.filter(s => inView(s.x, s.z));
    const stride = Math.max(1, Math.floor(inV.length / 2600));
    mctx.fillStyle = '#7d7d7d';
    for (let i = 0; i < inV.length; i += stride) mctx.fillRect(X(inV[i].x) - 1.6, Y(inV[i].z) - 1.6, 3.2, 3.2);
  }

  /* ---- 4. vehicles (not-in-service vehicles are never drawn) ---- */
  const veh = liveVehicles.filter(v => v.service_status !== 'not_in_service');
  mctx.textAlign = 'center';
  for (const v of veh) {
    const p = projPt(v.lat, v.lon); if (!inView(p[0], p[1])) continue;
    if (journeyRouteIds.has(String(v.route_id))) continue; // drawn solid below
    mctx.fillStyle = '#666'; mctx.beginPath(); mctx.arc(X(p[0]), Y(p[1]), 3.4, 0, 7); mctx.fill();
  }

  /* ---- 5. the journey: walk dashes, shape subpaths, stops, vehicles ---- */
  if (legDraws.length) {
    mctx.strokeStyle = '#111'; mctx.lineWidth = 1.6; mctx.setLineDash([5, 5]); mctx.beginPath();
    let prev = originPt;
    for (const d of legDraws) {
      const dx = d.boardPt[0] - prev[0], dz = d.boardPt[1] - prev[1];
      if (dx * dx + dz * dz > 3600) { mctx.moveTo(X(prev[0]), Y(prev[1])); mctx.lineTo(X(d.boardPt[0]), Y(d.boardPt[1])); }
      prev = d.alightPt;
    }
    if (destPt) { const dx = destPt[0] - prev[0], dz = destPt[1] - prev[1]; if (dx * dx + dz * dz > 3600) { mctx.moveTo(X(prev[0]), Y(prev[1])); mctx.lineTo(X(destPt[0]), Y(destPt[1])); } }
    mctx.stroke(); mctx.setLineDash([]);
    for (const d of legDraws) {
      mctx.strokeStyle = '#fff'; mctx.lineWidth = 7.5; mctx.beginPath();
      d.sub.forEach((p, i) => { i ? mctx.lineTo(X(p[0]), Y(p[1])) : mctx.moveTo(X(p[0]), Y(p[1])); });
      mctx.stroke();
      mctx.strokeStyle = '#111'; mctx.lineWidth = 4; mctx.beginPath();
      d.sub.forEach((p, i) => { i ? mctx.lineTo(X(p[0]), Y(p[1])) : mctx.moveTo(X(p[0]), Y(p[1])); });
      mctx.stroke();
    }
    // intermediate stops of the ridden trips
    if (j) for (const l of j.legs) {
      if (l.type !== 'bus') continue;
      const t = l.tripRef, a = t.stops.indexOf(l.board), b = t.stops.indexOf(l.alight);
      for (let k = a + 1; k < b; k++) { const s = stopByIdx[t.stops[k]]; if (!s) continue; const p = projPt(s.lat, s.lon); mctx.fillStyle = '#fff'; mctx.beginPath(); mctx.arc(X(p[0]), Y(p[1]), 3.2, 0, 7); mctx.fill(); mctx.strokeStyle = '#111'; mctx.lineWidth = 1.4; mctx.stroke(); }
    }
    // vehicles on the journey's routes: solid, route-labeled
    mctx.font = 'bold 11px system-ui, sans-serif';
    for (const v of veh) {
      if (!journeyRouteIds.has(String(v.route_id))) continue;
      const p = projPt(v.lat, v.lon); if (!inView(p[0], p[1])) continue;
      mctx.fillStyle = '#111'; mctx.beginPath(); mctx.arc(X(p[0]), Y(p[1]), 6, 0, 7); mctx.fill();
      mctx.fillStyle = '#111'; mctx.fillText(String(v.route_id), X(p[0]), Y(p[1]) - 10);
    }
  }

  /* ---- 6. labels — street names, corridor chips, landmarks (de-collided) ---- */
  const placed = [];
  function placeLabel(text, x, y, font, color, chip) {
    mctx.font = font;
    const tw = mctx.measureText(text).width, bw = tw + (chip ? 14 : 6), bh = chip ? 20 : 15;
    let bx = x - bw / 2, by = y - bh - 6;
    for (let tries = 0; tries < 4; tries++) {
      const hit = placed.some(r => bx < r.x + r.w && r.x < bx + bw && by < r.y + r.h && r.y < by + bh);
      if (!hit) break; by += bh + 5;
    }
    if (placed.some(r => bx < r.x + r.w && r.x < bx + bw && by < r.y + r.h && r.y < by + bh)) return false;
    if (bx < -20 || by < -10 || bx > w + 20 || by > h + 10) return false;
    placed.push({ x: bx, y: by, w: bw, h: bh });
    if (chip) {
      mctx.fillStyle = '#111'; mctx.fillRect(bx, by, bw, bh);
      mctx.fillStyle = '#fff'; mctx.textAlign = 'center'; mctx.fillText(text, bx + bw / 2, by + bh / 2 + 4);
    } else {
      mctx.lineWidth = 3.5; mctx.strokeStyle = '#e9e9e9'; mctx.textAlign = 'center';
      mctx.strokeText(text, bx + bw / 2, by + bh / 2 + 4); mctx.fillStyle = color; mctx.fillText(text, bx + bw / 2, by + bh / 2 + 4);
    }
    return true;
  }
  if (span <= 20000 && streetNameAnchors.length) {
    const cand = [];
    for (const a of streetNameAnchors) {
      // flagship label rule (live-transit.js street labels): freeway/arterial
      // anchors (tier 0/1) at map spans, local anchors (tier 2) only close in
      if (a[3] >= 2 && span > 6000) continue;
      if (!inView(a[1], a[2])) continue;
      const d2 = (a[1] - cx) ** 2 + (a[2] - cz) ** 2;
      cand.push({ name: a[0], x: a[1], z: a[2], tier: a[3], d2 });
    }
    cand.sort((p, q) => (p.tier - q.tier) || (p.d2 - q.d2));
    const seen = new Set(); let n = 0;
    for (const c of cand) {
      if (n >= 14) break;
      const norm = c.name.replace(/^[NSEW]\s+/, '');
      if (seen.has(norm)) continue;
      if (placeLabel(c.name, X(c.x), Y(c.z) + 8, '600 11px system-ui, sans-serif', '#757575', false)) { seen.add(norm); n++; }
    }
  }
  const chipKeys = legDraws.length
    ? legDraws.map(d => ({ rec: d.rec, text: `${d.routeId} ${(d.routeName || '').toUpperCase()}`, at: d.sub[Math.floor(d.sub.length / 2)] }))
    : [['ddot|3', 0.55], ['ddot|4', 0.55], ['ddot|6', 0.55], ['ddot|8', 0.55], ['qline|QLINE', 0.42], ['peoplemover|PM', -1]].map(([k, f]) => {
        const rec = geoByKey[k]; if (!rec) return null;
        const p = longestPath(rec); if (!p || !p.length) return null;
        let at;
        if (f < 0) { at = p[0]; let bv = -Infinity; for (const v of p) { const val = v[0] - v[1]; if (val > bv) { bv = val; at = v; } } }
        else at = p[Math.floor(p.length * f)];
        return { rec, text: rec.id === 'PM' ? 'PEOPLE MOVER' : rec.id === 'QLINE' ? 'QLINE' : `${rec.id} ${(rec.name || '').toUpperCase()}`, at };
      }).filter(Boolean);
  if (span >= 4200) for (const c of chipKeys) {
    if (!c.at || !inView(c.at[0], c.at[1])) continue;
    placeLabel(c.text, X(c.at[0]), Y(c.at[1]), '700 11px system-ui, sans-serif', '#fff', true);
  }
  let lmN = 0;
  for (const lm of landmarks) {
    if (lmN >= 6) break;
    const p = projPt(lm.lat, lm.lon); if (!inView(p[0], p[1])) continue;
    mctx.fillStyle = '#fff'; mctx.beginPath(); mctx.arc(X(p[0]), Y(p[1]), 3, 0, 7); mctx.fill();
    mctx.strokeStyle = '#333'; mctx.lineWidth = 1.4; mctx.stroke();
    if (placeLabel(lm.name.split(',')[0], X(p[0]), Y(p[1]), '600 11px system-ui, sans-serif', '#333', false)) lmN++;
  }

  /* ---- 7. journey end markers + YOU + DESTINATION ---- */
  function endMark(pt, label) {
    mctx.fillStyle = '#111'; mctx.beginPath(); mctx.arc(X(pt[0]), Y(pt[1]), 7, 0, 7); mctx.fill();
    mctx.strokeStyle = '#fff'; mctx.lineWidth = 2.5; mctx.stroke();
    placeLabel(label, X(pt[0]), Y(pt[1]), '700 12px system-ui, sans-serif', '#111', false);
  }
  legDraws.forEach((d, i) => {
    const isTransfer = i > 0 && legDraws[i - 1].alightStop === d.boardStop;
    endMark(d.boardPt, (isTransfer ? 'TRANSFER · ' : 'BOARD ' + d.routeId + ' · ') + d.boardStop.name);
    if (i === legDraws.length - 1 || legDraws[i + 1].boardStop !== d.alightStop) endMark(d.alightPt, 'GET OFF · ' + d.alightStop.name);
  });
  // YOU
  mctx.fillStyle = '#fff'; mctx.beginPath(); mctx.arc(X(originPt[0]), Y(originPt[1]), 8, 0, 7); mctx.fill();
  mctx.strokeStyle = '#111'; mctx.lineWidth = 2.5; mctx.stroke();
  mctx.fillStyle = '#111'; mctx.beginPath(); mctx.arc(X(originPt[0]), Y(originPt[1]), 2.6, 0, 7); mctx.fill();
  placeLabel('YOU', X(originPt[0]), Y(originPt[1]), '700 12px system-ui, sans-serif', '#111', false);
  if (destPt) {
    mctx.fillStyle = '#111'; mctx.beginPath(); mctx.arc(X(destPt[0]), Y(destPt[1]), 8, 0, 7); mctx.fill();
    mctx.strokeStyle = '#fff'; mctx.lineWidth = 2.5; mctx.stroke();
    placeLabel((destination.label || 'DESTINATION').split(',')[0].slice(0, 30), X(destPt[0]), Y(destPt[1]), '700 12px system-ui, sans-serif', '#111', false);
  }
  mapTag.textContent = liveStamp
    ? `LIVE MAP — ${liveVehicles.length} vehicles reporting · ${new Date(liveStamp).toLocaleTimeString()}${j ? ' · your route in black' : ''}`
    : 'LIVE MAP — feed unavailable; steps are timetable only';
  /* UDLA-3 M3 state grammar (UDLA-2 section 5): no live stamp = not
   * established (feed loading, or pollLive could not read it) — the
   * tag takes the dashed frame. Rendering hook only: liveStamp is
   * computed exactly as before; copies unchanged. */
  mapTag.classList.toggle('pending', !liveStamp);
}

/* ---------- live feed ---------- */
async function pollLive() {
  try {
    const [a, b] = await Promise.all([fetch(VEH_URL, { cache: 'no-store' }), fetch(SMART_URL, { cache: 'no-store' })]);
    const va = await a.json(), sb = await b.json();
    liveVehicles = (va.vehicles || []).concat(sb.vehicles || []);
    liveStamp = va.generated_at || sb.generated_at || new Date().toISOString();
    srcLine.textContent = `Data: live feeds generated ${new Date(liveStamp).toLocaleString()} (${(va.vehicles || []).length} DDOT/QLINE + ${(sb.vehicles || []).length} SMART vehicles) · timetable ${TT ? TT.meta.feeds.map(f => f.agency + ' ' + f.feed_version).join(' + ') : '…'} · Live counts are route-level, as labeled; vehicles without a trip assignment are not in service (deadheading) and are never counted as live.`;
  } catch (e) {
    liveStamp = null;
    srcLine.textContent = 'Data: live feed could not be read just now — steps below are timetable (SCHEDULED) only.';
  }
  drawMap();
}

/* ---------- find ---------- */
async function findRoute() {
  const btn = $('findBtn');
  if (!destination) { boardBody.innerHTML = '<p class="msg err">Pick a destination from the list — a place, a corner, or a stop. Free-typed street addresses are matched against the stop and place index on this device; nothing is sent to a geocoder.</p>'; return; }
  btn.disabled = true; btn.textContent = 'PLANNING…';
  try {
    if (!TT) TT = await Raptor.loadTimetable(TT_URL);
    const seeds = seedsFor(origin);
    const dest = nearestStop(destination);
    const res = Raptor.plan(TT, seeds, dest.stop.idx, new Date(), { budgetMs: 20000 });
    if (!res.journeys.length) {
      boardBody.innerHTML = `<p class="msg err">No route found from here to ${esc(destination.label)} right now (${esc(res.meta.reason || 'no service')}). The network thins out late — try again, or pick a destination nearer a main corridor.</p>`;
      arriveAt.textContent = ''; currentJourneys = []; drawMap(); return;
    }
    currentJourneys = res.journeys;
    renderJourney(res.journeys[0], 0);
  } catch (e) {
    boardBody.innerHTML = '<p class="msg err">The planner hit a problem reading the timetable. The live map still works; try FIND ROUTE again.</p>';
  } finally { btn.disabled = false; btn.textContent = 'FIND ROUTE'; }
}

/* ---------- boot ---------- */
(async function boot() {
  try {
    const [sc, gz] = await Promise.all([fetch(SIDECAR_URL).then(r => r.json()), fetch('./gazetteer.json').then(r => r.json())]);
    stops = Object.values(sc); stops.forEach(s => stopByIdx[s.idx] = s); landmarks = gz;
  } catch (e) { srcLine.textContent = 'Data: stop index failed to load — planning unavailable.'; return; }
  loadGeoAssets(); // flagship geography (streets + GTFS network); redraws when it lands
  wireSuggest($('fromInput'), $('fromSuggest'), hit => { origin = { lat: hit.lat, lon: hit.lon, label: hit.label }; $('fromInput').value = hit.label; drawMap(); });
  wireSuggest($('toInput'), $('toSuggest'), hit => { destination = { lat: hit.lat, lon: hit.lon, label: hit.label }; $('toInput').value = hit.label; drawMap(); });
  $('fromInput').addEventListener('input', () => { if ($('fromInput').value.trim() === '') { /* keep last origin */ } });
  $('locBtn').addEventListener('click', () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(pos => {
      origin = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Your location' };
      $('fromInput').value = 'Your location'; drawMap();
    }, () => { $('fromInput').value = origin.label; }, { timeout: 8000 });
  });
  $('findBtn').addEventListener('click', findRoute);
  $('toInput').addEventListener('keydown', e => { if (e.key === 'Enter') findRoute(); });
  window.addEventListener('resize', drawMap);
  Raptor.loadTimetable(TT_URL).then(t => { TT = t; }).catch(() => {});
  await pollLive();
  liveTimer = setInterval(pollLive, 60000);
  drawMap();
})();
