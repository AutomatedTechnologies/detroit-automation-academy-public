/* phl-planner.js — Philadelphia scheduled trip planner page module.
 * Board 48 item 6, PHL build tranche 1 (2026-10-23).
 * Label: UNVERIFIED / legacy-unsigned (P31 signing tooling down).
 *
 * Consumes the verified integration-staging bundle byte-identically
 * (planner-lib/: set-resolution engine + selection/signature/
 * archetypes/loader at Philadelphia's calibrated constants
 * W0-default-T35-P15, frequency-aware selection bound) and the
 * full-window SEPTA set asset (planner-timetable-v202609271-
 * v202609271.json, MD5 c27c0d1326b4cbbd5718b5a78d1a423b).
 * Scheduled data only — no live re-ranking (gate package §2/R3).
 *
 * D1 — WALK-ONLY PRESENTATION: DECIDED, branch (b) (Justin,
 * 2026-10-23 23:07 EDT, via the coordinator's options widget;
 * gate package §3 D1). Walk-only results are presented only when
 * no transit journey exists in the selection window. The
 * selection module flags a walk-only fastest result
 * (presentationFlags.walkOnlyFastest) and decides nothing; every
 * rendering path for that case funnels through
 * resolveWalkOnlyPresentation() below — the single decision
 * point. (Build history: while the constant was 'UNDECIDED' this
 * page was a staging build — it rendered the transit archetypes,
 * withheld the walk-only card, marked the result set
 * data-d1="pending", and the pre-push gate GATE-D1 failed the
 * ship. Justin's pick lifted the stop; the constant was set to
 * 'B' in the ship step of 2026-10-23 and the harness gate line
 * re-run on these final bytes.)
 */
import * as ENGINE from './planner-lib/raptor-v2-set.js';
import * as LOADER from './planner-lib/loader.mjs';
import * as SELECTION from './planner-lib/selection.mjs';
import { journeySignature, journeyKey } from './planner-lib/signature.mjs';

export const PLANNER_STAMP = '20261023-2339';
export const TIMETABLE_URL = 'planner-timetable-v202609271-v202609271.json';
export const STOPS_URL = 'planner-stops.json';
export const WALK_TOLERANCE_M = 400; // LT-S7.2/S7.3 + LT-N10 walk model

/* === D1 DECISION POINT — the ONLY place this choice lives. ===
 * Branches (gate package §3 D1):
 *   'A' present walk-only results as journeys, labeled as walking
 *   'B' present walk-only only when no transit journey exists
 *   'C' suppress walk-only from archetype presentation entirely
 * DECIDED: 'B' — Justin, 2026-10-23 23:07 EDT. ('UNDECIDED' was
 * the staging value: withhold the walk-only card, render the
 * transit archetypes, mark the result set pending. NOT a branch;
 * the ship gate fails while it stands.) */
export const WALK_ONLY_PRESENTATION = 'B';
export function resolveWalkOnlyPresentation(result) {
  const flag = !!(result && result.presentationFlags &&
    result.presentationFlags.walkOnlyFastest);
  if (!flag) return { walkOnlyFastest: false, showWalkOnly: false, pending: false };
  if (WALK_ONLY_PRESENTATION === 'A') return { walkOnlyFastest: true, showWalkOnly: true, pending: false };
  if (WALK_ONLY_PRESENTATION === 'B') {
    const hasTransit = result.freq.archetypes.some((a) => (a.routes || []).length > 0);
    return { walkOnlyFastest: true, showWalkOnly: !hasTransit, pending: false };
  }
  if (WALK_ONLY_PRESENTATION === 'C') return { walkOnlyFastest: true, showWalkOnly: false, pending: false };
  return { walkOnlyFastest: true, showWalkOnly: false, pending: true };
}

const state = {
  tt: null, meta: null, pairing: null, headwayMin: null,
  stops: null, rawTrips: null, ready: false, loadError: null,
  from: null, to: null, // {idx, name, feed, stop_id, viaLabel?}
};

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
export function cleanLabel(s) {
  // LT-S7.2: labels are display-only; control chars stripped, <=80 chars.
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
}
function haversineM(aLat, aLon, bLat, bLon) {
  const R = 6371000, t = Math.PI / 180;
  const dLat = (bLat - aLat) * t, dLon = (bLon - aLon) * t;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * t) * Math.cos(bLat * t) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* Nearest covered stop to a lat/lon (LT-S7.3: within the walk
 * tolerance it maps to that stop; beyond it, refusal names the
 * coverage boundary — never a generic empty result). */
export function resolveLatLon(lat, lon) {
  if (!state.stops) return { ok: false, reason: 'stops-not-loaded' };
  let best = null, bestM = Infinity;
  for (const s of state.stops) {
    const d = haversineM(lat, lon, s.lat, s.lon);
    if (d < bestM) { bestM = d; best = s; }
  }
  if (!best) return { ok: false, reason: 'no-stops' };
  if (bestM > WALK_TOLERANCE_M) {
    return { ok: false, reason: 'out-of-coverage', nearest: best, distanceM: Math.round(bestM) };
  }
  return { ok: true, stop: best, distanceM: Math.round(bestM) };
}

/* Stop search (LT-S4.4): display groups by name; every distinct
 * stop is retained and the picked stop is the exact record. */
export function searchStops(query, limit) {
  const q = String(query || '').trim().toLowerCase();
  if (!q || !state.stops) return [];
  const hits = [];
  for (const s of state.stops) {
    if (s.name.toLowerCase().includes(q)) hits.push(s);
    if (hits.length >= (limit || 60)) break;
  }
  const groups = new Map();
  for (const s of hits) {
    if (!groups.has(s.name)) groups.set(s.name, []);
    groups.get(s.name).push(s);
  }
  return [...groups.entries()].map(([name, stops]) => ({ name, stops }));
}

export function feedName(feed) { return feed === 1 ? 'Regional Rail' : 'Bus / trolley / subway'; }

/* Candidate enumeration identical to selection.planQuery's, kept
 * here so archetype summaries can be matched back to full leg
 * detail for display. planQuery remains the authoritative
 * selection (labels, Ruling 5 deltas, flags). */
export function enumerateCandidates(R, tt, q) {
  const when = new Date(q.depart_after);
  const seeds = [{ stop: q.origin.page_idx, walk: 0 }];
  const baseline = R.plan(tt, seeds, q.destination.page_idx, when);
  const range = R.planRange(tt, seeds, q.destination.page_idx, when,
    new Date(when.getTime() + SELECTION.WINDOW_MIN * 60000));
  const frameMid = new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime();
  const byKey = new Map();
  const add = (journey, arriveSecNorm, departSecNorm) => {
    const key = journeyKey(journey).split('#')[0] + '#' + Math.round(arriveSecNorm);
    if (!byKey.has(key)) byKey.set(key, { journey, arriveSec: arriveSecNorm, departSecNorm });
  };
  for (const j of baseline.journeys || []) add(j, j.arriveSec, j.departSec);
  for (const d of range.departures || []) {
    add(d.journey, (d.arriveMs - frameMid) / 1000, (d.leaveMs - frameMid) / 1000);
  }
  return [...byKey.values()].map((c) => {
    const sig = journeySignature(c.journey);
    return { ...c, sig, transfers: c.journey.transfers, walkSecTotal: sig.walkSecTotal };
  });
}

export function matchArchetypes(result, candidates) {
  return result.freq.archetypes.map((arch) => {
    const cand = candidates.find((c) =>
      Math.round(c.arriveSec) === Math.round(arch.arriveSec) &&
      c.transfers === arch.transfers &&
      c.walkSecTotal === arch.walkSecTotal &&
      JSON.stringify(c.sig.routeDirectionSeq) === JSON.stringify(arch.routes || []));
    return { arch, journey: cand ? cand.journey : null };
  });
}

/* The page's single planning entry. Returns everything the
 * renderer needs; never throws for rider-shaped problems. */
export function planTrip(fromIdx, toIdx, departAfterIso) {
  if (!state.ready) return { ok: false, reason: 'not-ready' };
  if (fromIdx === toIdx) return { ok: false, reason: 'same-stop' };
  const q = {
    id: 'PAGE', kind: 'page', expect: 'any',
    origin: { name: state.stops[fromIdx].name, page_idx: fromIdx },
    destination: { name: state.stops[toIdx].name, page_idx: toIdx },
    depart_after: departAfterIso,
  };
  const result = SELECTION.planQuery(ENGINE, state.tt, state.headwayMin, q);
  const candidates = enumerateCandidates(ENGINE, state.tt, q);
  const matched = matchArchetypes(result, candidates);
  const d1 = resolveWalkOnlyPresentation(result);
  return { ok: true, result, matched, d1, candidates: candidates.length };
}

function fmtMin(sec) {
  const m = Math.round(sec / 60);
  return m <= 0 ? 'under 1 min' : m + ' min';
}
const LABELS = {
  'fastest': 'Fastest',
  'fewest-transfers': 'Fewest transfers',
  'least-walking': 'Least walking',
  'direct': 'Direct',
  'highest-reliability': 'Most reliable (scheduled)',
};

export function renderResultsHTML(plan, fromStop, toStop) {
  if (!plan.ok) {
    if (plan.reason === 'same-stop') {
      return '<p class="pl-msg">Origin and destination are the same stop. Pick two different stops.</p>';
    }
    return '<p class="pl-msg">The planner is still loading. Try again in a moment.</p>';
  }
  const { result, matched, d1 } = plan;
  if (!matched.length) {
    return '<p class="pl-msg">No scheduled journey was found between ' +
      esc(fromStop.name) + ' and ' + esc(toStop.name) +
      ' in the two hours after the chosen time. Both stops are inside the ' +
      'SEPTA coverage area — service may not run between them at that time.</p>';
  }
  const parts = [];
  parts.push('<div class="pl-results"' + (d1.pending ? ' data-d1="pending"' : '') + '>');
  for (const { arch, journey } of matched) {
    const isWalkOnly = (arch.routes || []).length === 0;
    if (isWalkOnly && !d1.showWalkOnly) continue; // D1 point: see header
    const labels = (arch.labels || []).map((l) => LABELS[l] || l).join(' · ');
    parts.push('<article class="pl-card">');
    parts.push('<h3>' + esc(labels || 'Journey') + '</h3>');
    parts.push('<p class="pl-sum">Arrive ' + esc(ENGINE.fmtClockSec(arch.arriveSec)) +
      ' · ' + (arch.transfers === 0 ? 'no transfers' : arch.transfers + (arch.transfers === 1 ? ' transfer' : ' transfers')) +
      ' · walking ' + esc(fmtMin(arch.walkSecTotal)) + '</p>');
    if (journey) {
      parts.push('<ol class="pl-legs">');
      for (const leg of journey.legs) {
        if (leg.type === 'walk') {
          const fromName = leg.from === -1 ? 'Your starting point'
            : (state.stops[leg.from] ? state.stops[leg.from].name : 'Stop');
          const toName = state.stops[leg.to] ? state.stops[leg.to].name : 'Stop';
          parts.push('<li>Walk from ' + esc(fromName) + ' to ' + esc(toName) +
            ' (' + esc(fmtMin(leg.secs || 0)) + ')</li>');
        } else {
          const b = state.stops[leg.board], a = state.stops[leg.alight];
          parts.push('<li><strong>' + esc(leg.routeId) + '</strong> ' +
            esc(leg.headsign || leg.routeName || '') + ' — board at ' +
            esc(b ? b.name : 'Stop') + ' at ' + esc(ENGINE.fmtClockSec(leg.boardSec)) +
            ', arrive ' + esc(a ? a.name : 'Stop') + ' at ' +
            esc(ENGINE.fmtClockSec(leg.alightSec)) + ' (scheduled)</li>');
        }
      }
      parts.push('</ol>');
    } else {
      parts.push('<p class="pl-msg">Journey detail unavailable for this result.</p>');
    }
    parts.push('</article>');
  }
  parts.push('<p class="pl-note">Scheduled times only, from SEPTA\'s published ' +
    'timetable (feed v202609271+v202609271; bus valid to Feb 20, 2027, ' +
    'Regional Rail to Nov 21, 2026). “Most reliable (scheduled)” ranks how ' +
    'well a journey recovers from a missed connection on the published ' +
    'schedule — it is not measured on-time performance.</p>');
  parts.push('</div>');
  return parts.join('');
}

/* Load: single fetch of the 41.8 MB asset (the loader module's
 * loadPlannerAsset fetches twice — once for meta, once through the
 * engine — which would double a phone's download; the pairing
 * guard itself is preserved verbatim via LOADER.assertPairing
 * BEFORE the engine indexes anything). */
export async function loadPlanner(fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  const stopsRes = await f(STOPS_URL, { cache: 'no-store' });
  if (!stopsRes.ok) throw new Error('stops fetch failed: HTTP ' + stopsRes.status);
  state.stops = await stopsRes.json();
  const res = await f(TIMETABLE_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('timetable fetch failed: HTTP ' + res.status);
  const data = await res.json();
  state.meta = data.meta;
  state.rawTrips = data.trips;
  state.pairing = LOADER.assertPairing(ENGINE, data.meta); // throws PairingError
  const shim = async (url, opts) => {
    if (String(url).includes('planner-timetable-')) {
      return { ok: true, status: 200, json: async () => data };
    }
    return f(url, opts);
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = shim;
  try {
    state.tt = await ENGINE.loadTimetable(TIMETABLE_URL);
  } finally {
    globalThis.fetch = realFetch;
  }
  state.headwayMin = SELECTION.headwayLookupFor(state.rawTrips);
  SELECTION.assertPhlConstants();
  state.ready = true;
  return state;
}

/* ---- DOM wiring (browser + harness; no-ops without elements) ---- */
export const els = {};
function el(id) {
  if (typeof document === 'undefined' || !document.getElementById) return null;
  return document.getElementById(id);
}
function setStatus(msg) { if (els.status) els.status.textContent = msg; }

function renderSearch(target, groups) {
  const box = target === 'from' ? els.fromResults : els.toResults;
  if (!box) return;
  if (!groups.length) { box.innerHTML = '<p class="pl-msg">No stops match that search.</p>'; return; }
  const parts = [];
  for (const g of groups) {
    parts.push('<div class="pl-group"><p class="pl-gname">' + esc(g.name) + '</p>');
    for (const s of g.stops) {
      parts.push('<button type="button" class="pl-stop" data-target="' + target +
        '" data-idx="' + s.idx + '">' + esc(feedName(s.feed)) +
        ' · stop ' + esc(s.stop_id) + '</button>');
    }
    parts.push('</div>');
  }
  box.innerHTML = parts.join('');
  if (box.querySelectorAll) {
    box.querySelectorAll('.pl-stop').forEach((btn) => {
      btn.addEventListener('click', () => pickStop(target, Number(btn.getAttribute('data-idx'))));
    });
  }
}
export function pickStop(target, idx) {
  const s = state.stops[idx];
  if (!s) return;
  if (target === 'from') { state.from = s; if (els.fromLabel) els.fromLabel.textContent = s.name; }
  else { state.to = s; if (els.toLabel) els.toLabel.textContent = s.name; }
}
export function swapStops() {
  const t = state.from; state.from = state.to; state.to = t;
  if (els.fromLabel) els.fromLabel.textContent = state.from ? state.from.name : 'From';
  if (els.toLabel) els.toLabel.textContent = state.to ? state.to.name : 'Where to?';
}
export function currentDepartISO() {
  const d = els.date && els.date.value, t = els.time && els.time.value;
  if (d && t) return d + 'T' + t + ':00';
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate()) +
    'T' + p(now.getHours()) + ':' + p(now.getMinutes()) + ':00';
}
export function runPlan() {
  if (!state.from || !state.to) {
    if (els.results) els.results.innerHTML = '<p class="pl-msg">Pick an origin and a destination stop first.</p>';
    return null;
  }
  setStatus('Planning…');
  const plan = planTrip(state.from.idx, state.to.idx, currentDepartISO());
  if (els.results) els.results.innerHTML = renderResultsHTML(plan, state.from, state.to);
  setStatus(plan.ok ? 'Journeys found: ' + plan.matched.length + '.' : 'No journey found.');
  return plan;
}
/* Deep-link prefill (LT-S7.2 contract, adapted to this page):
 * ?plan&to=<lat>,<lon>&label=<text>[&from=…][&fromlabel=…] */
export function applyDeepLink(search) {
  const params = new URLSearchParams(search || '');
  const out = { applied: [] };
  const resolve = (key, labelKey, target) => {
    const raw = params.get(key);
    if (!raw) return;
    const bits = raw.split(',');
    const lat = Number(bits[0]), lon = Number(bits[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return; // malformed piece ignored
    const r = resolveLatLon(lat, lon);
    const label = cleanLabel(params.get(labelKey) || '');
    if (!r.ok) {
      if (els.results) {
        els.results.innerHTML = '<p class="pl-msg">That location is outside this ' +
          'planner\'s coverage: the nearest covered stop (' + esc(r.nearest ? r.nearest.name : '') +
          ') is about ' + esc(r.distanceM) + ' m away, beyond the 400 m walking ' +
          'coverage of the SEPTA stop network used here.</p>';
      }
      out.applied.push(target + ':out-of-coverage');
      return;
    }
    pickStop(target, r.stop.idx);
    if (label) {
      const lbl = target === 'from' ? els.fromLabel : els.toLabel;
      if (lbl) lbl.textContent = label;
    }
    out.applied.push(target + ':' + r.stop.idx);
  };
  if (params.has('plan') || params.has('to') || params.has('from')) {
    resolve('from', 'fromlabel', 'from');
    resolve('to', 'label', 'to');
  }
  return out;
}

export function wire() {
  for (const id of ['status', 'fromSearch', 'toSearch', 'fromResults', 'toResults',
    'fromLabel', 'toLabel', 'swap', 'planBtn', 'nowBtn', 'date', 'time', 'results']) {
    els[id] = el(id);
  }
  if (els.fromSearch) els.fromSearch.addEventListener('input', () =>
    renderSearch('from', searchStops(els.fromSearch.value)));
  if (els.toSearch) els.toSearch.addEventListener('input', () =>
    renderSearch('to', searchStops(els.toSearch.value)));
  if (els.swap) els.swap.addEventListener('click', swapStops);
  if (els.planBtn) els.planBtn.addEventListener('click', runPlan);
  if (els.nowBtn) els.nowBtn.addEventListener('click', () => {
    const now = new Date(), p = (n) => String(n).padStart(2, '0');
    if (els.date) els.date.value = now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate());
    if (els.time) els.time.value = p(now.getHours()) + ':' + p(now.getMinutes());
  });
  return els;
}

export const PHL_PLANNER = { state, planTrip, searchStops, resolveLatLon, applyDeepLink, wire, loadPlanner, renderResultsHTML, resolveWalkOnlyPresentation };
if (typeof window !== 'undefined') window.PHL_PLANNER = PHL_PLANNER;
if (typeof document !== 'undefined' && document.getElementById && document.getElementById('planBtn')) {
  wire();
  setStatus('Loading the SEPTA timetable (about 7 MB compressed)…');
  loadPlanner().then(() => {
    setStatus('Timetable ready — feed v202609271+v202609271. Pick two stops to plan.');
    if (typeof location !== 'undefined') applyDeepLink(location.search);
  }).catch((e) => {
    state.loadError = e;
    setStatus('The timetable could not be loaded (' + e.message + '). Reload to try again.');
  });
}
