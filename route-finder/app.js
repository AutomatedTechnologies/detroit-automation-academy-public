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
    `<li><span class="n" aria-hidden="true"></span><span class="step-main"><span class="verb">${esc(s.verb)}</span> — ${esc(s.text)}${s.note ? ` <span style="color:var(--faint)">(${esc(s.note)})</span>` : ''}</span><span class="basis ${s.cls}">${esc(s.basis)}</span></li>`).join('') + '</ol>';
  html += `<p class="honesty">Times marked LIVE come from a vehicle reporting now. SCHEDULED times are the published timetable. “Live on route” counts vehicles reporting on that route this minute — it confirms the route is running, it is not a promise about your bus.</p>`;
  if (currentJourneys.length > 1) {
    html += '<div class="alts"><h3>OTHER WAYS</h3>' + currentJourneys.map((a, i) =>
      i === idx ? '' : `<button type="button" data-alt="${i}">${a.departClock} → ${a.arriveClock} · ${a.durationMin} min · ${a.transfers} transfer${a.transfers === 1 ? '' : 's'} · ${a.walkMin} min walking</button>`).join('') + '</div>';
  }
  boardBody.innerHTML = html;
  boardBody.querySelectorAll('[data-alt]').forEach(b => b.addEventListener('click', () => { renderJourney(currentJourneys[+b.dataset.alt], +b.dataset.alt); drawMap(); }));
  drawMap();
}

/* ---------- the hybrid map (canvas; estate geometry = the stop sidecar + live feeds) ---------- */
const map = $('map'), mctx = map.getContext('2d');
function drawMap() {
  const dpr = window.devicePixelRatio || 1;
  const w = map.clientWidth, h = map.clientHeight; if (!w || !h) return;
  map.width = w * dpr; map.height = h * dpr; mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mctx.clearRect(0, 0, w, h); mctx.fillStyle = '#e9e9e9'; mctx.fillRect(0, 0, w, h);
  const pts = [{ lat: origin.lat, lon: origin.lon }];
  if (destination) pts.push({ lat: destination.lat, lon: destination.lon });
  const j = currentJourneys[currentSel];
  const routeStops = [], routeIds = new Set();
  if (j) j.legs.forEach(l => { if (l.type === 'bus') { routeIds.add(String(l.routeId)); const t = l.tripRef; const a = t.stops.indexOf(l.board), b = t.stops.indexOf(l.alight); for (let k = a; k <= b; k++) { const s = stopByIdx[t.stops[k]]; if (s) { routeStops.push(s); pts.push(s); } } } });
  liveVehicles.forEach(v => { if (routeIds.has(String(v.route_id))) pts.push(v); });
  if (pts.length < 3) { // metro frame before any route
    pts.push({ lat: 42.58, lon: -83.30 }, { lat: 42.20, lon: -82.90 });
  }
  let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
  pts.forEach(p => { la0 = Math.min(la0, p.lat); la1 = Math.max(la1, p.lat); lo0 = Math.min(lo0, p.lon); lo1 = Math.max(lo1, p.lon); });
  const padLa = (la1 - la0) * 0.12 + 0.004, padLo = (lo1 - lo0) * 0.12 + 0.004;
  la0 -= padLa; la1 += padLa; lo0 -= padLo; lo1 += padLo;
  const X = lon => (lon - lo0) / (lo1 - lo0) * w, Y = lat => h - (lat - la0) / (la1 - la0) * h;
  // all live vehicles, faint (not-in-service vehicles are never drawn)
  mctx.fillStyle = '#b9b9b9';
  liveVehicles.forEach(v => { if (v.service_status === 'not_in_service') return; mctx.beginPath(); mctx.arc(X(v.lon), Y(v.lat), 2, 0, 7); mctx.fill(); });
  // route path
  if (routeStops.length > 1) {
    mctx.strokeStyle = '#111'; mctx.lineWidth = 3; mctx.beginPath();
    routeStops.forEach((s, i) => { i ? mctx.lineTo(X(s.lon), Y(s.lat)) : mctx.moveTo(X(s.lon), Y(s.lat)); });
    mctx.stroke();
    mctx.fillStyle = '#fff';
    routeStops.forEach(s => { mctx.beginPath(); mctx.arc(X(s.lon), Y(s.lat), 3.5, 0, 7); mctx.fill(); mctx.strokeStyle = '#111'; mctx.lineWidth = 1.5; mctx.stroke(); });
  }
  // route vehicles, solid with route label
  mctx.font = 'bold 11px system-ui, sans-serif'; mctx.textAlign = 'center';
  liveVehicles.forEach(v => { if (v.service_status === 'not_in_service') return; if (!routeIds.has(String(v.route_id))) return; const x = X(v.lon), y = Y(v.lat); mctx.fillStyle = '#111'; mctx.beginPath(); mctx.arc(x, y, 6, 0, 7); mctx.fill(); mctx.fillStyle = '#111'; mctx.fillText(String(v.route_id), x, y - 10); });
  // origin / destination
  function mark(p, label, fill) { const x = X(p.lon), y = Y(p.lat); mctx.fillStyle = fill; mctx.beginPath(); mctx.arc(x, y, 7, 0, 7); mctx.fill(); mctx.strokeStyle = '#111'; mctx.lineWidth = 2; mctx.stroke(); mctx.fillStyle = '#111'; mctx.font = 'bold 12px system-ui, sans-serif'; mctx.fillText(label, x, y - 12); }
  mark(origin, 'YOU', '#fff');
  if (destination) mark(destination, 'DESTINATION', '#111');
  mapTag.textContent = liveStamp
    ? `LIVE MAP — ${liveVehicles.length} vehicles reporting · ${new Date(liveStamp).toLocaleTimeString()}${j ? ' · your route in black' : ''}`
    : 'LIVE MAP — feed unavailable; steps are timetable only';
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
