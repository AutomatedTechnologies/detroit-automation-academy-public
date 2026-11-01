// modules/planner-host.mjs — R4 IMPLEMENTATION: planner host.
// Platform rebuild R4 (planner rebuild). Label: UNVERIFIED /
// legacy-unsigned. LOCAL BUILD ONLY — nothing here is deployed.
//
// R4 rebuilds the planner surface (LT-KAES-29) by HOSTING the
// verified staged engine bundle — it does not re-derive the
// engine. The bundle of record (hidden_files/integration-staging/,
// verification PASS 7/7, LT-N12) is copied BYTE-IDENTICALLY into
// planner/ at R4 build time (identities in planner/README.md,
// re-verified by MD5 in harness/verify-planner.mjs §A):
//   engine  planner/engine/raptor-v2-set.js  MD5 6746dfbc…
//   lib     planner/lib/{selection,signature,archetypes-v2,
//           loader}.mjs (pairing guard)
//   asset   planner/assets/planner-timetable-<feed-version>.json,
//           service_model "set" (the asset's identity and MD5 are
//           the city's config facts, assets.plannerTimetable*)
//
// D1(b) LIVES HERE. The policy constant is config's
// planner.policy.walkOnlyPresentation ('B', decided by Justin
// 2026-10-23 23:07 EDT — see city-config.mjs for the full citation)
// and this module is its SINGLE ENFORCEMENT POINT, mirroring
// resolveWalkOnlyPresentation() in the shipped planner page
// verbatim in semantics: every rendering path for a walk-only-
// fastest result funnels through resolveWalkOnlyPresentation();
// no other code decides it. The selection module FLAGS walk-only
// results (presentationFlags.walkOnlyFastest) and decides nothing.
//
// LATENCY MITIGATION (R4 first-class component; design record in
// the R4 planner design record (2026-10-24)). The shipped page
// cost ≈ 2 × (plan + planRange[≤240 plan() calls]) per plan —
// Golden-pair measurements on the densest launch city ran to
// 749 s per plan before mitigation (VM Node).
// The mitigation is three exact-preserving layers, none of which
// touches a bundle byte or a computed value:
//   M1 SINGLE ENUMERATION. planTrip runs selection.planQuery
//      ONCE, through a recording facade over the engine: the
//      facade passes plan/planRange through to the real engine
//      and captures the returned baseline journeys + range
//      departures — the very enumeration planQuery performs.
//      Leg detail is matched from THAT capture (the shipped page
//      re-ran the identical enumeration a second time in
//      enumerateCandidates()). planTrip's meta.engineCalls
//      {plan:1, planRange:1} is the structural proof.
//   M2 DAY-COMPILED TIMETABLE (the compiled-window layer). For a
//      query on service day D the host derives, in memory, a
//      timetable whose trips are filtered to the services the
//      engine's OWN servicesFor() resolves active on D-1/D/D+1
//      (all feeds) — exactly the trips the engine could ever
//      catch or name for a D query (plan rounds read the D/D-1
//      sets; the strip's next-departure advance also reads D+1).
//      Services, exceptions, routes and transfers are carried
//      unchanged, so service resolution is identical; the
//      derived object is served to the engine's own
//      loadTimetable under a per-day URL. Measured on this VM:
//      Wednesday keeps 14,659/38,150 trips; one PHL11 plan()
//      2,053 ms (full) -> 612 ms (day), strip departures
//      field-for-field identical. The canonical asset remains
//      the bundle's; the derivation is a pure function of
//      (asset, date), recorded per plan in meta. Any derivation
//      failure falls back to the full timetable (ttBasis
//      'full-fallback') — correctness never depends on M2.
//   M3 EXACT MEMOIZATION + WORKER HOSTING. Identical
//      (from, to, departAfter) queries return the recorded
//      result (meta.memoized). The host module is DOM-free and
//      runs unchanged inside a Web Worker / worker_thread via
//      planner/worker-entry.mjs, so a long plan never blocks
//      the client; the worker path returns identical records.
// Reliability headways are ALWAYS built from the canonical
// asset's full trip list (the recorded calibration basis) —
// never from a day-filtered subset.

import { CITY_CONFIG } from '../config/city-config.mjs';
import { stampedFetch } from '../platform/loader.mjs';
import * as ENGINE from '../planner/engine/raptor-v2-set.js';
import * as SELECTION from '../planner/lib/selection.mjs';
import * as LOADER from '../planner/lib/loader.mjs';
import { journeyKey, journeySignature } from '../planner/lib/signature.mjs';
import { applyTripFusion } from '../planner/lib/live-fusion.mjs';

/* F3 FOLD (Cities V2 core fold, CG-7/CG-8; build record F0 contract,
 * schema v2.2). Everything below in this header is CONFIG-GATED and
 * OPTIONAL: with no fold fields in the city config, every exported
 * function's behaviour is the pre-fold behaviour — the selection
 * path below is taken exactly as before, no opts object is passed
 * to any engine call, and the engine's live-delay entry point is
 * never called.
 *   planner.presentation  absent | 'selection' -> planTripAsync
 *                         selection path (unchanged). 'direct' ->
 *                         plan on the FULL timetable asset via the
 *                         engine's plan(), journeys presented
 *                         UNFILTERED (no selection / archetypes /
 *                         D1); record shape = engine journey
 *                         records (see planDirectAsync).
 *   planner.budgetMs      { plan, replan } — a numeric value is
 *                         passed as { budgetMs: value } into the
 *                         corresponding engine plan() call(s) in
 *                         BOTH modes; null/absent passes NO opts.
 *   planner.live          { matcher, fusion, guidance, replan }
 *                         booleans, all false when absent — see
 *                         onLivePoll / runMatcher.
 *   assets.routesRegistry presence enables the covered-stop bridge
 *                         for registry indices beyond planner
 *                         coverage (registry stop coordinates are
 *                         injected via setRegistryStops /
 *                         loadPlanner options; the registry boot
 *                         itself is the surfaces tranche's). */

export const WALK_ONLY_PRESENTATION = CITY_CONFIG.planner.policy.walkOnlyPresentation;

/**
 * The D1 decision point. Pure.
 * Input:  { walkOnlyFastest: boolean, hasTransitJourney: boolean }
 *         (derived by the host from the selection result: the flag
 *         is selection's presentationFlags.walkOnlyFastest; a
 *         transit journey exists iff any archetype carries >= 1
 *         transit leg — branch (b)'s exact test in the shipped page)
 * Output: { walkOnlyFastest, showWalkOnly, pending }
 * Branch 'B' (DECIDED): show the walk-only result ONLY when no
 * transit journey exists in the window. Branches 'A'/'C' are
 * retained so the decided branch is legible against its
 * alternatives; any other value composes as pending — the state
 * the ship gate failed on while D1 was undecided.
 */
export function resolveWalkOnlyPresentation({ walkOnlyFastest, hasTransitJourney }) {
  if (!walkOnlyFastest) return { walkOnlyFastest: false, showWalkOnly: false, pending: false };
  if (WALK_ONLY_PRESENTATION === 'A') return { walkOnlyFastest: true, showWalkOnly: true, pending: false };
  if (WALK_ONLY_PRESENTATION === 'B') {
    return { walkOnlyFastest: true, showWalkOnly: !hasTransitJourney, pending: false };
  }
  if (WALK_ONLY_PRESENTATION === 'C') return { walkOnlyFastest: true, showWalkOnly: false, pending: false };
  return { walkOnlyFastest: true, showWalkOnly: false, pending: true };
}

/** Planner constants as configured — asserted against the bundle's
 *  frozen lib values by the bundle's own constants gate at load
 *  time (LT-N12 check 3: a page build cannot drift them). */
export function plannerConstants() {
  return CITY_CONFIG.planner.constants;
}

/** Deep-link prefill contract (LT-S7.2), declared for R4:
 *  ?plan&to=<lat>,<lon>&label=<text>[&from=...][&fromlabel=...];
 *  labels display-only (control chars stripped, <= 80 chars);
 *  malformed pieces ignored piece by piece; no plan params ==
 *  baseline behaviour. Out-of-coverage endpoints resolve per
 *  LT-S7.3 (nearest covered stop within the 400 m walk tolerance,
 *  else a refusal naming the coverage boundary). */
export const DEEP_LINK_CONTRACT = Object.freeze({
  params: Object.freeze(['plan', 'to', 'label', 'from', 'fromlabel']),
  maxLabelChars: 80,
  walkToleranceM: CITY_CONFIG.planner.walkModel.edgeRadiusM,
});

/* ------------------------------------------------------------------ *
 * Host implementation (R4). One host = one loaded planner. The
 * module-level loadPlanner()/planTrip() below delegate to a default
 * host so the R1 contract signatures hold; createPlannerHost() is
 * exported for the harness and the worker entry, which need
 * isolated instances.
 * ------------------------------------------------------------------ */

const WALK_TOLERANCE_M = CITY_CONFIG.planner.walkModel.edgeRadiusM;

/* Normalized fold config (F3). Pure over the passed config object
 * so harnesses can exercise the normalization itself; the host
 * reads the module-level FOLD derived from CITY_CONFIG. */
export function plannerFoldConfig(cfg) {
  const p = (cfg && cfg.planner) || {};
  const b = p.budgetMs || {};
  const l = p.live || {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  // F8 fence: display-only feed ids from every fold declaration —
  // agency.displayOnlyFeeds, the display-vehicle entries, and the
  // display trip-updates source (all optional / absent-safe).
  const displayOnlyFeeds = new Set();
  const agency = (cfg && cfg.agency) || {};
  if (Array.isArray(agency.displayOnlyFeeds)) {
    for (const d of agency.displayOnlyFeeds) if (d != null) displayOnlyFeeds.add(String(d));
  }
  const liveData = ((cfg && cfg.assets) || {}).liveData || {};
  if (Array.isArray(liveData.displayVehicles)) {
    for (const e of liveData.displayVehicles) {
      if (e && e.feed != null) displayOnlyFeeds.add(String(e.feed));
    }
  }
  if (liveData.displayTripUpdates && liveData.displayTripUpdates.feed != null) {
    displayOnlyFeeds.add(String(liveData.displayTripUpdates.feed));
  }
  return {
    presentation: p.presentation === 'direct' ? 'direct' : 'selection',
    budgetMs: { plan: num(b.plan), replan: num(b.replan) },
    live: {
      matcher: l.matcher === true,
      fusion: l.fusion === true,
      guidance: l.guidance === true,
      replan: l.replan === true,
    },
    routesRegistry: !!((cfg && cfg.assets) || {}).routesRegistry,
    displayOnlyFeeds,
  };
}

const FOLD = plannerFoldConfig(CITY_CONFIG);

/* F8 fence predicate: a vehicle record is display-only when the
 * data layer tagged it so (displayOnly / displayFeed — the primary
 * signal), or when its feed is a configured display-only feed
 * (covers hand-fed arrays carrying no tags). Pure over the record
 * plus the configured feed set (default: this host's FOLD set). */
export function isDisplayVehicle(v, displayOnlyFeeds) {
  if (!v) return false;
  if (v.displayOnly === true || v.displayFeed != null) return true;
  const set = displayOnlyFeeds || FOLD.displayOnlyFeeds;
  return v.feed != null && !!set && set.has(String(v.feed));
}

/* Walk-model arithmetic (census B6): every seed/bridge walk in the
 * fold paths is max(perEdgeFloorSec, round(distanceM / speedMps))
 * over the configured walk model — the monolith's seed arithmetic
 * with its literals replaced by the config values. */
const WALK_MODEL = (() => {
  const wm = CITY_CONFIG.planner.walkModel || {};
  return {
    edgeRadiusM: typeof wm.edgeRadiusM === 'number' ? wm.edgeRadiusM : WALK_TOLERANCE_M,
    speedMps: typeof wm.speedMps === 'number' && wm.speedMps > 0 ? wm.speedMps : 1.4,
    perEdgeFloorSec: typeof wm.perEdgeFloorSec === 'number' ? wm.perEdgeFloorSec : 60,
  };
})();

function walkSecFor(distanceM, wm) {
  const m = wm || WALK_MODEL;
  return Math.max(m.perEdgeFloorSec, Math.round(distanceM / m.speedMps));
}

/** Virtual-origin multi-seed (census P6): up to 12 nearest stops
 *  within the walk model's edge radius of a lat/lon, each seed's
 *  walk by the walk-model arithmetic, sorted by walk. `stops` is
 *  any stop list carrying { lat, lon } (an entry's own idx field
 *  wins; otherwise its array position is the stop index). Pure. */
export function seedsForLatLon(lat, lon, stops, wm) {
  const m = wm || WALK_MODEL;
  const seeds = [];
  const list = stops || [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s || s.lat == null || s.lon == null) continue;
    const d = haversineM(lat, lon, s.lat, s.lon);
    if (d <= m.edgeRadiusM) {
      seeds.push({ stop: typeof s.idx === 'number' ? s.idx : i, walk: walkSecFor(d, m) });
    }
  }
  seeds.sort((a, b) => a.walk - b.walk);
  return seeds.slice(0, 12);
}

/** Covered-stop bridge (census P5): a stop index at or beyond the
 *  planner asset's coverage (nStops) maps to the nearest covered
 *  stop within the walk model's edge radius, with the walk-model
 *  walk arithmetic; an in-coverage index maps to itself at walk 0.
 *  Returns { stop, walkSec, distanceM } or null when no covered
 *  stop is within radius (the caller produces the refusal).
 *  `originStop` carries the out-of-coverage stop's { lat, lon };
 *  `coveredStops` is the covered stop list (planner index space).
 *  Pure. */
export function coveredStopFor(idx, nStops, originStop, coveredStops, wm) {
  if (idx == null || idx < 0) return null;
  if (idx < nStops) return { stop: idx, walkSec: 0, distanceM: 0 };
  if (!originStop || originStop.lat == null || originStop.lon == null) return null;
  const m = wm || WALK_MODEL;
  let best = -1, bestM = Infinity;
  for (const s of coveredStops || []) {
    if (!s || s.lat == null || s.lon == null) continue;
    const si = typeof s.idx === 'number' ? s.idx : null;
    if (si == null || si >= nStops) continue;
    const d = haversineM(originStop.lat, originStop.lon, s.lat, s.lon);
    if (d < bestM) { bestM = d; best = si; }
  }
  if (best < 0 || bestM > m.edgeRadiusM) return null;
  return { stop: best, walkSec: walkSecFor(bestM, m), distanceM: bestM };
}

/** Journey identity for selection preservation across re-plans
 *  (the monolith's signature: bus legs by route + board/alight
 *  stop, walk legs collapsed). Pure. */
export function journeySig(j) {
  return ((j && j.legs) || []).map((l) =>
    l.type === 'bus' ? ('b' + l.routeId + '@' + l.board + '>' + l.alight) : 'w').join('|');
}

/* Live-adjusted leg time (guidance): refresh the plan-time delay
 * on a leg with the current matcher state. The stored delaySec is
 * the MEASURED delay; leg times carry it projected at 0.6
 * persistence — the engine's own projection factor for its leg
 * times, applied here to the host's retained state. */
const DELAY_PROJECTION = 0.6;

export function liveLegTime(leg, which, delayState) {
  const base = which === 'board' ? leg.boardSec : leg.alightSec;
  if (!leg.tripRef) return base;
  const st = delayState ? delayState.get(leg.tripRef) : null;
  if (st && !st.disrupted) {
    return base - (leg.delaySec || 0) * DELAY_PROJECTION + st.delaySec * DELAY_PROJECTION;
  }
  return base;
}

/** Missed-transfer test (the monolith's check, delay-state passed
 *  in): a connection is missed when the live-adjusted board time
 *  of the next bus leg precedes the live-adjusted alight time of
 *  the previous leg plus the journey's own intervening walk plus
 *  a 60 s buffer. Returns { leg1, leg2, alightStop } or null. */
export function checkMissedTransfer(journey, delayState) {
  const busLegs = ((journey && journey.legs) || []).filter((l) => l.type === 'bus');
  for (let i = 0; i + 1 < busLegs.length; i++) {
    const leg1 = busLegs[i], leg2 = busLegs[i + 1];
    const alight1 = liveLegTime(leg1, 'alight', delayState);
    const board2 = liveLegTime(leg2, 'board', delayState);
    let walkSec = 0, inWalk = false;
    for (const l of journey.legs) {
      if (l === leg1) { inWalk = true; continue; }
      if (l === leg2) break;
      if (inWalk && l.type === 'walk') walkSec += l.secs || 0;
    }
    if (board2 < alight1 + walkSec + 60) {
      return { leg1, leg2, alightStop: leg1.alight };
    }
  }
  return null;
}

function headsignMatch(dest, h) {
  if (!dest || !h) return false;
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const d = norm(dest), hh = norm(h);
  if (!d || !hh) return false;
  if (hh.indexOf(d) >= 0 || d.indexOf(hh) >= 0) return true;
  return d.split(' ')[0] === hh.split(' ')[0];
}

/** Per-leg live guidance derivation (host-level; surfaces render
 *  it — the surfaces tranche owns consumption). ctx:
 *  { delayState (Map trip -> state), vehicles (canonical live
 *  records), stops (planner stop list), nowSec (local seconds of
 *  day) }. Returns a guidance object, the string 'passed' when the
 *  leg's vehicle has passed the alight stop, or null when there is
 *  no live evidence for the leg (no guidance, no fiction).
 *  Position basis is the trip's own stop sequence: the vehicle's
 *  progress is its nearest stop on the trip — the neutral
 *  substitute for the monolith's route-shape arc position. */
export function guidanceForLeg(leg, ctx) {
  if (!leg || !leg.tripRef || !ctx) return null;
  const delayState = ctx.delayState;
  const st = delayState ? delayState.get(leg.tripRef) : null;
  if (!st || st.disrupted) return null;
  const stops = ctx.stops || [];
  const trip = leg.tripRef;
  if (st.layover) {
    const term = stops[trip.stops[0]];
    return {
      kind: 'board', layover: true,
      text: 'Route ' + leg.routeId + ' — your bus is at ' +
        (term ? (term.name || 'the terminal') : 'the terminal') + ' and leaves at ' +
        ENGINE.fmtClockSec((trip.depL2 || trip.dep)[0]) + '.',
    };
  }
  const veh = (ctx.vehicles || []).find((v) => String(v.vehicle_id) === String(st.vehicleId));
  if (!veh || veh.lat == null || veh.lon == null) return null;
  const boardIdx = trip.stops.indexOf(leg.board);
  const alightIdx = trip.stops.indexOf(leg.alight);
  if (boardIdx < 0 || alightIdx < 0) return null;
  let vehIdx = -1, vehBestM = Infinity;
  trip.stops.forEach((sIdx, i) => {
    const s = stops[sIdx];
    if (!s || s.lat == null) return;
    const d = haversineM(veh.lat, veh.lon, s.lat, s.lon);
    if (d < vehBestM) { vehBestM = d; vehIdx = i; }
  });
  if (vehIdx < 0) return null;
  const stopName = (idx) => {
    const s = stops[idx];
    return s ? (s.name || ('stop ' + idx)) : ('stop ' + idx);
  };
  if (vehIdx < boardIdx) {
    const bs = stops[leg.board];
    if (!bs) return null;
    const distM = haversineM(veh.lat, veh.lon, bs.lat, bs.lon);
    const speedMps = typeof veh.speed_mph === 'number' && veh.speed_mph > 0
      ? veh.speed_mph * 0.44704 : 1.5;
    const eta = distM / Math.max(speedMps, 1.5);
    if (eta <= 150) {
      return {
        kind: 'board', etaSec: Math.round(eta),
        text: 'Route ' + leg.routeId + ' reaches ' + stopName(leg.board) +
          ' in ~' + Math.round(eta) + 's — be ready to board.',
      };
    }
    return null;
  }
  const left = alightIdx - vehIdx;
  if (left < 0) return 'passed';
  if (left <= 1) {
    return {
      kind: 'alight', urgent: true, stopsLeft: left,
      text: 'Route ' + leg.routeId + ' arriving at ' + stopName(leg.alight) +
        ' — get off at the next stop.',
    };
  }
  return {
    kind: 'riding', stopsLeft: left,
    text: 'Route ' + leg.routeId + ' — ' + left + ' stops to ' + stopName(leg.alight) + '.',
  };
}

/** Whole-journey guidance derivation (host-level export for the
 *  surfaces tranche): missed transfer first (highest priority),
 *  then the first leg with live guidance; 'arrived' requires
 *  positive evidence — the final leg's vehicle passed the alight
 *  stop, or the live-adjusted final alight time is more than
 *  120 s in the past. No evidence -> null (silence is honest). */
export function deriveGuidance(journey, ctx) {
  if (!journey || !ctx) return null;
  const busLegs = (journey.legs || []).filter((l) => l.type === 'bus');
  if (!busLegs.length) return null;
  const missed = checkMissedTransfer(journey, ctx.delayState);
  if (missed) {
    return {
      kind: 'missed', urgent: true, alightStop: missed.alightStop,
      text: 'Missed the Route ' + missed.leg2.routeId + ' connection.',
    };
  }
  let finalPassed = false;
  for (let i = 0; i < busLegs.length; i++) {
    const g = guidanceForLeg(busLegs[i], ctx);
    if (g === 'passed') { if (i === busLegs.length - 1) finalPassed = true; continue; }
    if (g) return g;
  }
  if (finalPassed) return { kind: 'done', text: 'You have arrived.' };
  const lastLeg = busLegs[busLegs.length - 1];
  if (typeof ctx.nowSec === 'number' &&
      ctx.nowSec > liveLegTime(lastLeg, 'alight', ctx.delayState) + 120) {
    return { kind: 'done', text: 'You have arrived.' };
  }
  return null;
}

export function cleanLabel(s) {
  // LT-S7.2: labels are display-only; control chars stripped, <=80.
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, DEEP_LINK_CONTRACT.maxLabelChars);
}

function haversineM(aLat, aLon, bLat, bLon) {
  const R = 6371000, t = Math.PI / 180;
  const dLat = (bLat - aLat) * t, dLon = (bLon - aLon) * t;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * t) * Math.cos(bLat * t) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function ymdOf(d) {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/* Archetype -> leg-detail matching, the shipped page's function
 * (presentation layer): match on arrival, transfers, total walk,
 * and the route-direction sequence. */
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

/* The candidate list the shipped page built by RE-ENUMERATING
 * (enumerateCandidates), rebuilt here from the facade capture of
 * planQuery's own single enumeration (M1). The dedupe rule, the
 * normalization frames, and the candidate shape are the page's,
 * unchanged; only the source of the journeys differs — the same
 * deterministic enumeration, observed once instead of run twice. */
export function candidatesFromCapture(capture, departAfterIso) {
  const when = new Date(departAfterIso);
  const frameMid = new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime();
  const byKey = new Map();
  const add = (journey, arriveSecNorm, departSecNorm) => {
    const key = journeyKey(journey).split('#')[0] + '#' + Math.round(arriveSecNorm);
    if (!byKey.has(key)) byKey.set(key, { journey, arriveSec: arriveSecNorm, departSecNorm });
  };
  for (const j of (capture.baseline && capture.baseline.journeys) || []) add(j, j.arriveSec, j.departSec);
  for (const d of (capture.range && capture.range.departures) || []) {
    add(d.journey, (d.arriveMs - frameMid) / 1000, (d.leaveMs - frameMid) / 1000);
  }
  return [...byKey.values()].map((c) => {
    const sig = journeySignature(c.journey);
    return { ...c, sig, transfers: c.journey.transfers, walkSecTotal: sig.walkSecTotal };
  });
}

/* Endpoint spec for the direct planner (F3): a bare stop index, a
 * { stop } / { registryIdx } object, or a { lat, lon } point.
 * Returns { stop } | { lat, lon } | null. */
function normEndpointSpec(spec) {
  if (typeof spec === 'number' && Number.isFinite(spec)) return { stop: spec };
  if (spec && typeof spec === 'object') {
    if (typeof spec.stop === 'number') return { stop: spec.stop };
    if (typeof spec.registryIdx === 'number') return { stop: spec.registryIdx };
    if (typeof spec.lat === 'number' && typeof spec.lon === 'number') {
      return { lat: spec.lat, lon: spec.lon };
    }
  }
  return null;
}

/* Matcher support (F3 / CG-8). The monolith matcher measures a
 * vehicle against its trip's expected position on the route shape
 * arc; the neutral substitute is the trip's own stop polyline —
 * cumulative haversine distance along the trip's stop sequence,
 * interpolated by the trip's scheduled times. No geometry asset,
 * no city data: timetable trips + the planner stop list only. */
function tripStopArc(trip, stops) {
  const dep = trip.depL2 || trip.dep, arr = trip.arrL2 || trip.arr;
  const pts = [];
  let acc = 0, prev = null;
  for (let j = 0; j < trip.stops.length; j++) {
    const s = stops[trip.stops[j]];
    if (!s || s.lat == null || s.lon == null) continue;
    if (prev) acc += haversineM(prev.lat, prev.lon, s.lat, s.lon);
    pts.push({ stopIdx: trip.stops[j], s: acc, dep: dep[j], arr: arr[j] });
    prev = s;
  }
  if (pts.length < 2) return null;
  for (let k = 1; k < pts.length; k++) if (pts[k].s <= pts[k - 1].s) return null;
  return pts;
}

function tripExpectedAt(pts, nowSec) {
  const first = pts[0], last = pts[pts.length - 1];
  const vref = (a, b) => {
    const dt = b.dep - a.dep, ds = b.s - a.s;
    return (dt > 0 && ds > 0) ? ds / dt : 8;
  };
  let expIdx = -1;
  for (let e = 0; e < pts.length; e++) if (pts[e].dep <= nowSec) expIdx = e;
  if (nowSec < first.dep) return { sE: first.s, vRef: vref(first, pts[1]), pts, expIdx: -1 };
  if (nowSec > last.arr) return null;
  for (let m = 0; m + 1 < pts.length; m++) {
    const a = pts[m], b = pts[m + 1];
    if (nowSec >= a.dep && nowSec <= b.dep) {
      const f = b.dep > a.dep ? (nowSec - a.dep) / (b.dep - a.dep) : 0;
      return { sE: a.s + f * (b.s - a.s), vRef: vref(a, b), pts, expIdx };
    }
  }
  return { sE: last.s, vRef: vref(pts[pts.length - 2], last), pts, expIdx };
}

/* Project a lat/lon onto the stop polyline: returns the arc
 * position (metres along the trip) of the nearest point. */
function projectOntoArc(lat, lon, stops, pts) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 111320;
  let bestS = pts[0].s, bestD = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const A = stops[pts[i].stopIdx], B = stops[pts[i + 1].stopIdx];
    const ax = (A.lon - lon) * kx, ay = (A.lat - lat) * ky;
    const bx = (B.lon - lon) * kx, by = (B.lat - lat) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < bestD) { bestD = d; bestS = pts[i].s + t * (pts[i + 1].s - pts[i].s); }
  }
  return bestS;
}

function matcherZero() {
  return {
    t: 0, fixes: 0, ghostRoute: 0, noCandidates: 0, noExpected: 0,
    gate: 0, score: 0, margin: 0, shadowed: 0, matched: 0, disrupted: 0,
    candGateEarly: 0, candGateLate: 0, candAdmitted: 0,
    delayN: 0, delaySum: 0, delayHist: [0, 0, 0, 0, 0, 0, 0, 0],
    tripsLive: 0, tripsDisrupted: 0, tripsLayover: 0,
  };
}

export function createPlannerHost() {
  const state = {
    ready: false, loadError: null,
    assetData: null, meta: null, pairing: null,
    ttFull: null, headwayMin: null, stops: null,
    assetUrl: null, routes: new Map(), dayCache: new Map(),
    memo: new Map(), lastCapture: null,
    // F3 fold state — populated only on gated paths.
    registryStops: null,
    tripDelayState: new Map(), lastVehicles: null,
    lastJourneys: null, lastSelIndex: 0, lastPlanContext: null,
    lastDirectResult: null, directResults: new Map(), lastSelectionResult: null,
    lastSelectionKey: null, lastGuidance: null,
    matcherLast: null, matcherCum: null, liveDelayCalls: 0,
    routeIdxById: null, arcCache: new WeakMap(),
  };

  /* Serve registered in-memory asset objects to the engine's own
   * loadTimetable call (the shipped page's scoped-shim pattern,
   * kept): the pairing guard has already run on the parsed meta
   * before the engine indexes anything, and the asset is fetched
   * exactly once, through the stamped loader path. */
  async function engineLoad(url) {
    const f = host.fetchImpl || globalThis.fetch;
    const shim = async (u, opts) => {
      const key = String(u);
      if (state.routes.has(key)) {
        const data = state.routes.get(key);
        return { ok: true, status: 200, json: async () => data };
      }
      return f(u, opts);
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = shim;
    try {
      return await ENGINE.loadTimetable(url);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  /* M2: derive (once per service day) the day-compiled timetable. */
  async function dayTimetable(when) {
    const key = String(ymdOf(when));
    if (state.dayCache.has(key)) return state.dayCache.get(key);
    const feeds = [...new Set(state.ttFull.services.map((s) => s.feed || 0))];
    const active = new Set();
    for (const off of [-1, 0, 1]) {
      const d = new Date(when.getTime() + off * 86400000);
      for (const f of feeds) {
        // Repair 2026-10-25: ymd must be a STRING — the engine's
        // exception test is the strict compare `e.date !== ymd`
        // (its own internal callers pass fmtYMD strings), so the
        // numeric ymdOf silently skipped every calendar_dates
        // exception: services that run only via an exception
        // (added: 1) never entered the day compilation.
        ENGINE.servicesFor(state.ttFull, String(ymdOf(d)), d.getDay(), f).forEach((s) => active.add(s));
      }
    }
    const trips = state.assetData.trips.filter((t) => active.has(t.s));
    const derived = { ...state.assetData, trips };
    const url = state.assetUrl.split('#')[0] + '#day-' + key;
    state.routes.set(url, derived);
    const tt = await engineLoad(url);
    const entry = { tt, ymd: key, tripsKept: trips.length, tripsTotal: state.assetData.trips.length };
    state.dayCache.set(key, entry);
    return entry;
  }

  const host = {
    state,
    fetchImpl: null,

    /** Load engine + timetable through the pairing guard.
     *  options: { assetUrl, stopsUrl, fetchImpl } — asset/stops are
     *  fetched through the KAES-05 stamped loader path; fetchImpl
     *  is injectable for harnesses and workers. */
    async loadPlanner(options = {}) {
      const assetUrl = options.assetUrl;
      const stopsUrl = options.stopsUrl;
      if (!assetUrl || !stopsUrl) throw new Error('loadPlanner: assetUrl and stopsUrl are required');
      host.fetchImpl = options.fetchImpl || null;
      // F3: registry stop coordinates for the covered-stop bridge
      // (census P5) may ride the load options; setRegistryStops()
      // is the post-load equivalent for the registry boot.
      if (Array.isArray(options.registryStops)) state.registryStops = options.registryStops;
      state.assetUrl = assetUrl;
      const stopsRes = await stampedFetch(stopsUrl, host.fetchImpl || undefined);
      state.stops = await stopsRes.json();
      const res = await stampedFetch(assetUrl, host.fetchImpl || undefined);
      const data = await res.json();
      state.assetData = data;
      state.meta = data.meta;
      // Pairing guard BEFORE the engine indexes anything (LT-N12).
      state.pairing = LOADER.assertPairing(ENGINE, data.meta);
      state.routes.set(assetUrl, data);
      state.ttFull = await engineLoad(assetUrl);
      // Reliability basis: the canonical asset's FULL trip list.
      state.headwayMin = SELECTION.headwayLookupFor(data.trips);
      // Constants gates: bundle lib vs adopted (bundle's own gate)
      // and config vs bundle (the host's addition — LT-N12 check 3
      // extended to the LT-F5(d) object).
      SELECTION.assertCityConstants();
      const cfg = plannerConstants();
      const drift = [];
      for (const k of Object.keys(SELECTION.CITY_CONSTANTS.distanceWeights)) {
        if (cfg.distanceWeights[k] !== SELECTION.CITY_CONSTANTS.distanceWeights[k]) drift.push('distanceWeights.' + k);
      }
      if (cfg.nearDuplicateThreshold !== SELECTION.CITY_CONSTANTS.nearDuplicateThreshold) drift.push('nearDuplicateThreshold');
      if (cfg.reliabilityTransferPenaltyMin !== SELECTION.CITY_CONSTANTS.reliabilityTransferPenaltyMin) drift.push('reliabilityTransferPenaltyMin');
      if (cfg.reliabilityHeadwayCapMin !== SELECTION.CITY_CONSTANTS.reliabilityHeadwayCapMin) drift.push('reliabilityHeadwayCapMin');
      if (drift.length) {
        const err = new Error('CONFIG CONSTANTS DRIFT — ' + drift.join('; '));
        err.code = 'CONSTANTS_GATE';
        throw err;
      }
      state.ready = true;
      return state;
    },

    /** Plan one query through the hosted engine + selection.
     *  Async because M2 day derivation loads through the engine's
     *  async loader. query: optional { id, kind, expect }
     *  descriptor carried into the selection record (defaults: the
     *  page's PAGE descriptor). opts: { ttBasis: 'day' (default)
     *  | 'full', useMemo: true }. Semantics identical to the
     *  shipped page's planTrip, plus the D1 presentation filter
     *  applied to `presented` and the mitigation meta. */
    async planTripAsync(fromIdx, toIdx, departAfterIso, query = {}, opts = {}) {
      if (!state.ready) return { ok: false, reason: 'not-ready' };
      if (fromIdx === toIdx) return { ok: false, reason: 'same-stop' };
      // F3 / CG-7: direct presentation delegates wholesale — the
      // selection pipeline below is not entered at all. The direct
      // record shape (engine journeys) replaces the selection
      // record shape for this call; see planDirectAsync.
      if (FOLD.presentation === 'direct') {
        return host.planDirectAsync({ stop: fromIdx }, { stop: toIdx }, departAfterIso, {});
      }
      const useMemo = opts.useMemo !== false;
      const memoKey = fromIdx + '|' + toIdx + '|' + departAfterIso + '|' + (opts.ttBasis || 'day');
      if (useMemo && state.memo.has(memoKey)) {
        const hit = state.memo.get(memoKey);
        return { ...hit, meta: { ...hit.meta, memoized: true, planMs: 0 } };
      }
      const t0 = Date.now();
      const when = new Date(departAfterIso);
      let tt = state.ttFull;
      let ttBasis = 'full';
      let dayInfo = null;
      if ((opts.ttBasis || 'day') === 'day') {
        try {
          dayInfo = await dayTimetable(when);
          tt = dayInfo.tt;
          ttBasis = 'day';
        } catch (e) {
          tt = state.ttFull;
          ttBasis = 'full-fallback';
        }
      }
      const capture = { baseline: null, range: null, calls: { plan: 0, planRange: 0 } };
      // F3 budget plumbing (selection mode): the selection lib is
      // frozen and calls the facade with NO opts; when a budget is
      // configured (or a re-plan override is in flight) the facade
      // supplies { budgetMs } itself. With no budget configured the
      // facade passes the caller's opts through untouched — the
      // pre-fold call shape exactly.
      const budgetPlan = typeof opts.budgetMsOverride === 'number'
        ? opts.budgetMsOverride : FOLD.budgetMs.plan;
      const facade = {
        plan(ttArg, seeds, toIdxArg, whenArg, o) {
          capture.calls.plan++;
          const r = (o == null && typeof budgetPlan === 'number')
            ? ENGINE.plan(ttArg, seeds, toIdxArg, whenArg, { budgetMs: budgetPlan })
            : ENGINE.plan(ttArg, seeds, toIdxArg, whenArg, o);
          capture.baseline = r;
          return r;
        },
        planRange(ttArg, seeds, toIdxArg, a, b, o) {
          capture.calls.planRange++;
          const r = (o == null && typeof budgetPlan === 'number')
            ? ENGINE.planRange(ttArg, seeds, toIdxArg, a, b, { budgetMs: budgetPlan })
            : ENGINE.planRange(ttArg, seeds, toIdxArg, a, b, o);
          capture.range = r;
          return r;
        },
      };
      const q = {
        id: query.id || 'HOST', kind: query.kind || 'host-query', expect: query.expect || 'any',
        // Record labels only — planning reads page_idx alone. The
        // overrides exist so verification can carry the golden
        // corpus's own origin/destination labels into the record
        // it compares (the shipped page used the sidecar names).
        origin: { name: query.originName || state.stops[fromIdx].name, page_idx: fromIdx },
        destination: { name: query.destinationName || state.stops[toIdx].name, page_idx: toIdx },
        depart_after: departAfterIso,
      };
      const result = SELECTION.planQuery(facade, tt, state.headwayMin, q);
      state.lastCapture = capture;
      // F3 budget rollback (selection mode): the baseline plan hit
      // its budget — return the retained previous result rather
      // than presenting an empty plan as if none existed (the
      // monolith's rollback semantics, census P4). Only reachable
      // when a budget was actually supplied to the engine.
      // F8: the rollback fires ONLY for the same query — the
      // retained result is tagged with its query key and a budget
      // hit on a different query never presents it.
      const selKey = fromIdx + '|' + toIdx + '|' + (opts.ttBasis || 'day');
      if (typeof budgetPlan === 'number' && capture.baseline &&
          capture.baseline.meta && capture.baseline.meta.reason === 'budget' &&
          state.lastSelectionResult && state.lastSelectionKey === selKey) {
        return {
          ...state.lastSelectionResult,
          meta: { ...state.lastSelectionResult.meta, budgetRollback: true, planMs: Date.now() - t0 },
        };
      }
      const candidates = candidatesFromCapture(capture, departAfterIso);
      const matched = matchArchetypes(result, candidates);
      // D1(b) — the single enforcement point. hasTransitJourney is
      // branch (b)'s exact test from the shipped page: any
      // archetype carrying >= 1 transit leg (routes non-empty).
      const walkOnlyFastest = result.presentationFlags.walkOnlyFastest === true;
      const hasTransitJourney = result.freq.archetypes.some((a) => (a.routes || []).length > 0);
      const d1 = resolveWalkOnlyPresentation({ walkOnlyFastest, hasTransitJourney });
      const presented = matched.filter(({ arch }) => {
        const isWalkOnly = (arch.routes || []).length === 0;
        return !(isWalkOnly && !d1.showWalkOnly);
      });
      const out = {
        ok: true, result, matched, presented, d1,
        candidates: candidates.length,
        meta: {
          planMs: Date.now() - t0,
          ttBasis,
          dayYmd: dayInfo ? dayInfo.ymd : null,
          tripsKept: dayInfo ? dayInfo.tripsKept : state.assetData.trips.length,
          tripsTotal: state.assetData.trips.length,
          engineCalls: { ...capture.calls },
          memoized: false,
        },
      };
      // F3 retention + live bookkeeping — only on gated configs.
      // F8: retention is tagged with this query's key (see above),
      // and a budget-hit query does NOT displace the retained
      // result (its baseline is not a successful result — the
      // direct mode's non-budget-only retention, mirrored).
      if (typeof budgetPlan === 'number' &&
          !(capture.baseline && capture.baseline.meta && capture.baseline.meta.reason === 'budget')) {
        state.lastSelectionResult = out;
        state.lastSelectionKey = fromIdx + '|' + toIdx + '|' + (opts.ttBasis || 'day');
      }
      if (FOLD.live.matcher || FOLD.live.fusion || FOLD.live.guidance || FOLD.live.replan) {
        state.lastPlanContext = { mode: 'selection', fromIdx, toIdx, departAfterIso };
        state.lastJourneys = presented.map((p) => p.journey).filter(Boolean);
        state.lastSelIndex = 0;
        if (FOLD.live.fusion && state.lastVehicles) {
          applyTripFusion(state.lastJourneys, state.lastVehicles);
        }
      }
      if (useMemo) state.memo.set(memoKey, out);
      return out;
    },

    /* F3: registry stop coordinates for the covered-stop bridge.
     * The registry boot (surfaces tranche) supplies the merged
     * registry's stop list in registry index order; entries carry
     * { lat, lon } (an idx field is honoured when present). */
    setRegistryStops(stops) {
      state.registryStops = Array.isArray(stops) ? stops : null;
      return state.registryStops;
    },

    /* F3 / census P5: covered-stop resolution for one index.
     * In-coverage -> identity at walk 0. Beyond coverage -> the
     * bridge over the planner stop list, or null. Only meaningful
     * when the routes registry is configured; callers gate on it. */
    coveredStopIdx(idx) {
      if (!state.ttFull) return null;
      if (idx != null && idx < state.ttFull.nStops) {
        return { stop: idx, walkSec: 0, distanceM: 0 };
      }
      const origin = (state.registryStops && state.registryStops[idx]) ||
        (state.stops && state.stops[idx]) || null;
      return coveredStopFor(idx, state.ttFull.nStops, origin, state.stops);
    },

    /** F3 / CG-7: DIRECT presentation. Plans on the FULL timetable
     *  asset via the engine's plan() and presents its journeys
     *  UNFILTERED — no selection, no archetypes, no D1. Endpoints
     *  (normEndpointSpec): a stop index, a registry index (bridged
     *  when the registry is configured), or a lat/lon point
     *  (virtual-origin multi-seed for origins; nearest covered
     *  stop for destinations). An unresolvable endpoint returns
     *  the host's refusal shape ({ ok:false, reason:
     *  'out-of-coverage', endpoint }). Budget: opts.budgetMs wins
     *  when the key is present (a re-plan passes the replan value,
     *  possibly null); otherwise the configured plan budget; a
     *  non-number passes NO opts object to the engine. On a budget
     *  result the retained result OF THE SAME QUERY (per-query map,
     *  F8) is returned when one exists (rollback), else the budget
     *  result as-is. */
    async planDirectAsync(fromSpec, toSpec, departAfterIso, opts = {}) {
      if (!state.ready) return { ok: false, reason: 'not-ready' };
      const t0 = Date.now();
      const tt = state.ttFull;
      const from = normEndpointSpec(fromSpec);
      const to = normEndpointSpec(toSpec);
      if (!from || !to) return { ok: false, reason: 'bad-endpoint' };
      const refusal = (endpoint, extra) => ({ ok: false, reason: 'out-of-coverage', endpoint, ...(extra || {}) });
      const searchSpace = (FOLD.routesRegistry && state.registryStops)
        ? state.registryStops : state.stops;
      // --- origin seeds
      let seeds = null, originBridge = null;
      if (from.lat != null) {
        seeds = [];
        for (const s of seedsForLatLon(from.lat, from.lon, searchSpace)) {
          if (s.stop < tt.nStops) { seeds.push(s); continue; }
          if (!FOLD.routesRegistry) continue;
          const b = host.coveredStopIdx(s.stop);
          if (b) seeds.push({ stop: b.stop, walk: s.walk + b.walkSec });
        }
        seeds.sort((a, b) => a.walk - b.walk);
        seeds = seeds.slice(0, 12);
        if (!seeds.length) return refusal('origin');
      } else if (from.stop < tt.nStops) {
        seeds = [{ stop: from.stop, walk: 0 }];
      } else {
        if (!FOLD.routesRegistry) return refusal('origin', { stop: from.stop });
        const b = host.coveredStopIdx(from.stop);
        if (!b) return refusal('origin', { stop: from.stop });
        originBridge = { from: from.stop, to: b.stop, distanceM: Math.round(b.distanceM) };
        seeds = [{ stop: b.stop, walk: b.walkSec }];
      }
      // --- destination
      let dest = null, destBridge = null;
      if (to.lat != null) {
        let bestIdx = null, bestM = Infinity;
        (searchSpace || []).forEach((s, i) => {
          if (!s || s.lat == null || s.lon == null) return;
          const d = haversineM(to.lat, to.lon, s.lat, s.lon);
          if (d < bestM) { bestM = d; bestIdx = typeof s.idx === 'number' ? s.idx : i; }
        });
        if (bestIdx == null || bestM > WALK_MODEL.edgeRadiusM) {
          return refusal('destination', { distanceM: bestIdx == null ? null : Math.round(bestM) });
        }
        if (bestIdx < tt.nStops) dest = bestIdx;
        else if (FOLD.routesRegistry) {
          const b = host.coveredStopIdx(bestIdx);
          if (!b) return refusal('destination', { stop: bestIdx });
          destBridge = { from: bestIdx, to: b.stop, distanceM: Math.round(b.distanceM) };
          dest = b.stop;
        } else return refusal('destination', { stop: bestIdx });
      } else if (to.stop < tt.nStops) {
        dest = to.stop;
      } else {
        if (!FOLD.routesRegistry) return refusal('destination', { stop: to.stop });
        const b = host.coveredStopIdx(to.stop);
        if (!b) return refusal('destination', { stop: to.stop });
        destBridge = { from: to.stop, to: b.stop, distanceM: Math.round(b.distanceM) };
        dest = b.stop;
      }
      if (seeds.length === 1 && seeds[0].stop === dest && seeds[0].walk === 0) {
        return { ok: false, reason: 'same-stop' };
      }
      const when = new Date(departAfterIso);
      // F8: per-query retention key — the RESOLVED computation
      // identity (seeds + dest). Depart time is deliberately
      // excluded: replanLive re-plans the same endpoints at a new
      // instant and must hit the same key.
      const directKey = JSON.stringify({
        seeds: seeds.map((s) => s.stop + ':' + s.walk), dest,
      });
      const budget = ('budgetMs' in opts) ? opts.budgetMs : FOLD.budgetMs.plan;
      const res = (typeof budget === 'number')
        ? ENGINE.plan(tt, seeds, dest, when, { budgetMs: budget })
        : ENGINE.plan(tt, seeds, dest, when);
      // Rollback: a budget result never displaces retained results,
      // and rolls back ONLY to the retained result of THIS query;
      // with no retained result for this key the budget result is
      // returned as-is (below).
      if (res.meta && res.meta.reason === 'budget') {
        const retained = state.directResults ? state.directResults.get(directKey) : null;
        if (retained) {
          return {
            ...retained, budgetRollback: true,
            meta: { ...retained.meta, reason: 'budget', budgetRollback: true },
          };
        }
      }
      const journeys = res.journeys || [];
      if (FOLD.live.fusion && state.lastVehicles) applyTripFusion(journeys, state.lastVehicles);
      const out = {
        ok: true, presentation: 'direct',
        journeys, presented: journeys, seeds, dest,
        bridges: { origin: originBridge, destination: destBridge },
        engineMeta: res.meta || null,
        meta: {
          planMs: Date.now() - t0, ttBasis: 'full', presentation: 'direct',
          reason: (res.meta && res.meta.reason) || null,
        },
      };
      if (!(res.meta && res.meta.reason === 'budget')) {
        state.lastDirectResult = out;
        // F8: retain per query key, FIFO-capped at 8.
        if (state.directResults) {
          if (state.directResults.has(directKey)) state.directResults.delete(directKey);
          state.directResults.set(directKey, out);
          while (state.directResults.size > 8) {
            state.directResults.delete(state.directResults.keys().next().value);
          }
        }
        state.lastPlanContext = { mode: 'direct', fromSpec, toSpec, departAfterIso };
        state.lastJourneys = journeys;
        state.lastSelIndex = 0;
      }
      return out;
    },

    /* F3 / CG-8: the vehicle-to-trip matcher. One call = one live
     * poll cycle. Semantics ported from the monolith matcher
     * (census CG-8) onto the neutral stop-polyline basis above:
     * candidate trips = the vehicle's route's trips in today's or
     * yesterday's active service set inside their assignment
     * window; fix-age gate 150,000 ms; headsign agreement bonus;
     * dual stop-index gate; clear margin or no match; 4,000 m
     * credibility bound; delay = position-implied, disrupted when
     * delaySec < -300 || delaySec > 1800 (flagged, never shifted);
     * same-vehicle matches smooth 50/50; three quiet polls revert
     * a trip to scheduled; a dwelling unbound vehicle binds its
     * origin trip as a layover (identity only, delay 0). Ends by
     * handing the delay map to the engine — setLiveDelays on the
     * full timetable and every cached day timetable, so both
     * planning bases see the same live state. Service resolution
     * is the monolith's SINGULAR feed-0 servicesFor form (today
     * and yesterday): the fold's recorded deviation 'service
     * resolution generalized over feeds' is REVERTED by the F8
     * fix release as the fence restoration — display-only feeds'
     * trips are structurally never matcher candidates, and
     * display vehicles are filtered out at entry (below), so
     * display data never enters computation. (Day-compilation /
     * planning keeps all feeds; only live matching is fenced.)
     * Returns this poll's stats; the
     * cumulative pair is read via getMatcherStats() and the
     * global __flMatcherStats hook, mirroring the monolith. */
    runMatcher(vehicles, nowMs) {
      if (!state.ready || !state.ttFull) return null;
      const tt = state.ttFull;
      const t = typeof nowMs === 'number' ? nowMs : Date.now();
      // F8 fence: display vehicles are filtered out at entry —
      // no fix count, no candidate match, no layover bind below.
      const eligible = (Array.isArray(vehicles) ? vehicles : [])
        .filter((v) => !isDisplayVehicle(v));
      const stats = matcherZero();
      stats.t = t;
      if (!state.routeIdxById) {
        const m = {};
        tt.routes.forEach((r, i) => { m[String(r.id)] = i; });
        state.routeIdxById = m;
      }
      const dNow = new Date(t), dPrev = new Date(t - 86400000);
      const secOf = (d) => d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
      const nowSec = secOf(dNow);
      // F8 fence: SINGULAR feed-0 service sets (monolith form).
      const svcToday = new Set(ENGINE.servicesFor(tt, String(ymdOf(dNow)), dNow.getDay(), 0));
      const svcPrev = new Set(ENGINE.servicesFor(tt, String(ymdOf(dPrev)), dPrev.getDay(), 0));
      const candCache = new Map();
      const candsFor = (ridx) => {
        if (candCache.has(ridx)) return candCache.get(ridx);
        const out = [];
        for (const pat of tt.patterns) {
          if (pat.route !== ridx) continue;
          for (const trip of pat.trips) {
            const frames = [];
            if (svcToday.has(trip.s)) frames.push(nowSec);
            if (svcPrev.has(trip.s)) frames.push(nowSec + 86400);
            for (const nf of frames) {
              if (nf >= trip.dep[0] - 1800 && nf <= trip.arr[trip.arr.length - 1] + 300) {
                out.push({ trip, nowEff: nf });
                break;
              }
            }
          }
        }
        candCache.set(ridx, out);
        return out;
      };
      const matches = [];
      for (const v of eligible) {
        if (!v || v.lat == null || v.lon == null) continue;
        // Gate on the fix's own age, not poll receipt.
        const fixAgeMs = v.updated_at ? (t - new Date(v.updated_at).getTime()) : 0;
        if (fixAgeMs > 150000) continue;
        stats.fixes++;
        const ridx = state.routeIdxById[String(v.route_id)];
        if (ridx == null) { stats.ghostRoute++; continue; }
        const cands = candsFor(ridx);
        if (!cands.length) { stats.noCandidates++; continue; }
        let best = null, second = null, anyExp = false;
        for (const c of cands) {
          let pts = state.arcCache.get(c.trip);
          if (pts === undefined) {
            pts = tripStopArc(c.trip, state.stops);
            state.arcCache.set(c.trip, pts);
          }
          if (!pts) continue;
          const exp = tripExpectedAt(pts, c.nowEff);
          if (!exp) continue;
          anyExp = true;
          const sV = projectOntoArc(v.lat, v.lon, state.stops, pts);
          let vehIdx = -1;
          for (let q = 0; q < pts.length; q++) {
            if (pts[q].s <= sV + 30) vehIdx = q; else break;
          }
          const gate = vehIdx - exp.expIdx;
          const tImp = -(sV - exp.sE) / Math.max(exp.vRef, 2);
          if ((gate > 1 && tImp < -300) || (gate < -8 && tImp > 1800)) {
            if (gate > 1 && tImp < -300) stats.candGateEarly++; else stats.candGateLate++;
            continue;
          }
          stats.candAdmitted++;
          const score = Math.abs(sV - exp.sE) - (headsignMatch(v.destination, c.trip.h) ? 500 : 0);
          if (!best || score < best.score) {
            second = best;
            best = { trip: c.trip, score, sE: exp.sE, vRef: exp.vRef, sV, frameShift: c.nowEff - nowSec };
          } else if (!second || score < second.score) {
            second = { trip: c.trip, score };
          }
        }
        if (!anyExp) stats.noExpected++;
        else if (!best) stats.gate++;
        else if (best.score >= 4000) stats.score++;
        else if (second && (second.score - best.score) <= 300) stats.margin++;
        if (!best || best.score >= 4000) continue;
        if (second && (second.score - best.score) <= 300) continue;
        const delaySec = Math.round(-(best.sV - best.sE) / Math.max(best.vRef, 2));
        const disrupted = delaySec < -300 || delaySec > 1800;
        matches.push({
          trip: best.trip, vehicleId: v.vehicle_id,
          delaySec: disrupted ? 0 : delaySec, disrupted, score: best.score,
          frameShift: best.frameShift || 0,
          fixStamp: v.updated_at ? new Date(v.updated_at).getTime() : 0,
        });
      }
      // One vehicle per trip: best score wins.
      const byTrip = new Map();
      for (const m of matches) {
        const cur = byTrip.get(m.trip);
        if (!cur || m.score < cur.score) byTrip.set(m.trip, m);
      }
      stats.shadowed += matches.length - byTrip.size;
      const matchedTrips = new Set(byTrip.keys());
      byTrip.forEach((m, trip) => {
        stats.matched++;
        if (m.disrupted) stats.disrupted++;
        else {
          stats.delayN++;
          stats.delaySum += m.delaySec;
          const b = m.delaySec;
          stats.delayHist[b < -120 ? 0 : b < -30 ? 1 : b < 30 ? 2 : b < 120 ? 3 :
            b < 300 ? 4 : b < 600 ? 5 : b < 1200 ? 6 : 7]++;
        }
        const st = state.tripDelayState.get(trip);
        if (m.disrupted) {
          state.tripDelayState.set(trip, { delaySec: 0, vehicleId: m.vehicleId, misses: 0, disrupted: true, fixStamp: m.fixStamp, frameShift: m.frameShift || 0 });
        } else if (!st || st.vehicleId !== m.vehicleId || st.disrupted || st.layover) {
          state.tripDelayState.set(trip, { delaySec: m.delaySec, vehicleId: m.vehicleId, misses: 0, disrupted: false, fixStamp: m.fixStamp, frameShift: m.frameShift || 0 });
        } else {
          st.delaySec = Math.round(st.delaySec * 0.5 + m.delaySec * 0.5);
          st.fixStamp = m.fixStamp;
          st.misses = 0;
          st.frameShift = m.frameShift || 0;
        }
      });
      state.tripDelayState.forEach((st, trip) => {
        if (!matchedTrips.has(trip)) {
          st.misses++;
          if (st.misses >= 3) state.tripDelayState.delete(trip);
        }
      });
      // Layover binding: a dwelling unbound vehicle at a trip's
      // origin inside its window binds the trip — identity only.
      state.tripDelayState.forEach((st, trip) => {
        if (!st.layover) return;
        const veh = eligible.find((v) => String(v.vehicle_id) === String(st.vehicleId));
        const o = veh && state.stops[trip.stops[0]];
        if (veh && o && veh.lat != null &&
            haversineM(veh.lat, veh.lon, o.lat, o.lon) <= 250 &&
            nowSec + (st.frameShift || 0) <= trip.dep[0] + 1800) st.misses = 0;
      });
      const heldIds = new Set();
      state.tripDelayState.forEach((st) => heldIds.add(String(st.vehicleId)));
      for (const v of eligible) {
        if (!v || v.lat == null || heldIds.has(String(v.vehicle_id))) continue;
        if (typeof v.speed_mph !== 'number' || v.speed_mph > 2) continue;
        const fixAge = v.updated_at ? (t - new Date(v.updated_at).getTime()) : Infinity;
        if (!(fixAge <= 300000)) continue;
        const ridx = state.routeIdxById[String(v.route_id)];
        if (ridx == null) continue;
        const cands = candsFor(ridx).slice().sort((a, b) => a.trip.dep[0] - b.trip.dep[0]);
        for (const c of cands) {
          if (state.tripDelayState.has(c.trip)) continue;
          const o = state.stops[c.trip.stops[0]];
          if (!o || o.lat == null) continue;
          if (haversineM(v.lat, v.lon, o.lat, o.lon) > 200) continue;
          state.tripDelayState.set(c.trip, {
            delaySec: 0, vehicleId: v.vehicle_id, misses: 0, disrupted: false,
            layover: true, frameShift: c.nowEff - nowSec,
            fixStamp: v.updated_at ? new Date(v.updated_at).getTime() : 0,
          });
          break;
        }
      }
      const delayMap = new Map();
      state.tripDelayState.forEach((st, trip) => {
        if (st.disrupted) stats.tripsDisrupted++;
        if (st.layover) stats.tripsLayover++;
        delayMap.set(trip, { delaySec: st.delaySec, disrupted: st.disrupted, vehicleId: st.vehicleId, fixStamp: st.fixStamp || 0 });
      });
      stats.tripsLive = state.tripDelayState.size;
      ENGINE.setLiveDelays(tt, delayMap, t);
      state.liveDelayCalls++;
      for (const e of state.dayCache.values()) ENGINE.setLiveDelays(e.tt, delayMap, t);
      state.matcherLast = stats;
      if (!state.matcherCum) {
        const c = matcherZero();
        c.t = stats.t;
        state.matcherCum = c;
      }
      const cum = state.matcherCum;
      for (const k of Object.keys(stats)) {
        if (k === 't' || k === 'delayHist' || k === 'tripsLive' ||
            k === 'tripsDisrupted' || k === 'tripsLayover') continue;
        cum[k] += stats[k];
      }
      stats.delayHist.forEach((n, i) => { cum.delayHist[i] += n; });
      cum.tripsLive = stats.tripsLive;
      cum.tripsDisrupted = stats.tripsDisrupted;
      cum.tripsLayover = stats.tripsLayover;
      try {
        globalThis.__flMatcherStats = () => host.getMatcherStats();
      } catch { /* the hook is diagnostic only */ }
      return stats;
    },

    /* Matcher stats read-back: { last, cum } copies, mirroring
     * the monolith's window hook (also installed on the global
     * object by runMatcher). */
    getMatcherStats() {
      const copy = (o) => (o ? { ...o, delayHist: o.delayHist.slice() } : null);
      return { last: copy(state.matcherLast), cum: copy(state.matcherCum) };
    },

    /* F3: surfaces record the journeys currently presented (and
     * the selected index) so fusion/guidance/re-plan act on what
     * the rider sees. The plan methods already record their own
     * output; this is the surfaces-side override. */
    notePresented(journeys, selIndex) {
      state.lastJourneys = Array.isArray(journeys) ? journeys : null;
      state.lastSelIndex = typeof selIndex === 'number' ? selIndex : 0;
    },

    /* F3 / CG-8: per-poll re-plan of the retained plan context at
     * the replan budget. Direct contexts re-plan directly;
     * selection contexts re-run planTripAsync memo-free with the
     * replan budget as the facade override. A budget-exhausted
     * re-plan keeps the current results (the plan methods' own
     * rollback) and reports replanned:false. Selection among the
     * new journeys is the surface's call — journeySig() above is
     * the identity it preserves by. */
    async replanLive(nowMs) {
      const ctx = state.lastPlanContext;
      if (!ctx) return { ok: false, reason: 'no-plan-context' };
      const t = typeof nowMs === 'number' ? nowMs : Date.now();
      const iso = new Date(t).toISOString();
      if (ctx.mode === 'direct') {
        const out = await host.planDirectAsync(ctx.fromSpec, ctx.toSpec, iso,
          { budgetMs: FOLD.budgetMs.replan });
        return { ok: !!(out && out.ok), replanned: !(out && out.budgetRollback), result: out };
      }
      const out = await host.planTripAsync(ctx.fromIdx, ctx.toIdx, iso, {},
        { useMemo: false, budgetMsOverride: FOLD.budgetMs.replan });
      return { ok: !!(out && out.ok), replanned: !(out && out.meta && out.meta.budgetRollback), result: out };
    },

    /* F3 / CG-8: guidance derivation for a journey (default: the
     * retained selected journey) against the host's live state.
     * Surfaces render the result; see deriveGuidance(). */
    guidanceForJourney(journey) {
      const j = journey ||
        (state.lastJourneys && state.lastJourneys[state.lastSelIndex]) || null;
      if (!j) return null;
      const now = new Date();
      return deriveGuidance(j, {
        delayState: state.tripDelayState,
        vehicles: state.lastVehicles || [],
        stops: state.stops || [],
        nowSec: now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds(),
      });
    },

    /** F3 / CG-8: the host-side per-poll entry the surfaces live
     *  poll calls (each stage gated independently):
     *    live.matcher  -> runMatcher + setLiveDelays hand-off
     *    live.fusion   -> annotate the retained journeys
     *    live.replan   -> re-plan the retained context at the
     *                     replan budget
     *    live.guidance -> derive + retain guidance for the
     *                     retained selected journey
     *  With every live flag off this records the vehicle set and
     *  does nothing else. Returns { ok, matcher, fusion,
     *  replanned, guidance }. */
    async onLivePoll(vehicles, nowMs) {
      const t = typeof nowMs === 'number' ? nowMs : Date.now();
      // F8 fence: partition at entry — lastVehicles holds ONLY
      // computation-eligible (non-display) vehicles, so fusion
      // and guidance never see display vehicles either.
      state.lastVehicles = (Array.isArray(vehicles) ? vehicles : [])
        .filter((v) => !isDisplayVehicle(v));
      const out = { ok: true, matcher: null, fusion: false, replanned: false, guidance: null };
      if (FOLD.live.matcher) out.matcher = host.runMatcher(state.lastVehicles, t);
      if (FOLD.live.fusion && state.lastJourneys && state.lastJourneys.length) {
        applyTripFusion(state.lastJourneys, state.lastVehicles);
        out.fusion = true;
      }
      if (FOLD.live.replan) {
        const r = await host.replanLive(t);
        out.replanned = !!(r && r.ok && r.replanned);
        out.replan = r;
      }
      if (FOLD.live.guidance && state.lastJourneys && state.lastJourneys.length) {
        out.guidance = host.guidanceForJourney();
        state.lastGuidance = out.guidance;
      }
      return out;
    },

    /* Stop search (LT-S4.4): display groups by name; every
     * distinct stop is retained and the picked stop is the exact
     * record. The shipped page's semantics, re-derived. */
    searchStops(queryText, limit) {
      const q = String(queryText || '').trim().toLowerCase();
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
    },

    /* Nearest covered stop to a lat/lon (LT-S7.3: within the walk
     * tolerance it maps to that stop; beyond it, refusal names the
     * coverage boundary — never a generic empty result). */
    resolveLatLon(lat, lon) {
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
    },

    /* Deep-link prefill (LT-S7.2 via DEEP_LINK_CONTRACT): parses
     * the query string piece by piece; malformed pieces are
     * ignored piece by piece; resolves endpoints per LT-S7.3 and
     * cleans labels via cleanLabel(). Returns { applied, from?,
     * to?, labels } — DOM application is the surfaces tranche's. */
    parseDeepLink(search) {
      const params = new URLSearchParams(search || '');
      const out = { applied: [], labels: {} };
      const resolve = (key, labelKey, target) => {
        const raw = params.get(key);
        if (!raw) return;
        const bits = raw.split(',');
        const lat = Number(bits[0]), lon = Number(bits[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        const r = host.resolveLatLon(lat, lon);
        const label = cleanLabel(params.get(labelKey) || '');
        if (label) out.labels[target] = label;
        if (!r.ok) {
          out.applied.push(target + ':out-of-coverage');
          out[target] = { ok: false, reason: r.reason, nearest: r.nearest, distanceM: r.distanceM };
          return;
        }
        out.applied.push(target + ':' + r.stop.idx);
        out[target] = { ok: true, stop: r.stop, distanceM: r.distanceM };
      };
      if (params.has('plan') || params.has('to') || params.has('from')) {
        resolve('from', 'fromlabel', 'from');
        resolve('to', 'label', 'to');
      }
      return out;
    },
  };

  return host;
}

const defaultHost = createPlannerHost();

/** Load engine + timetable through the pairing guard. R4. */
export async function loadPlanner(options) {
  return defaultHost.loadPlanner(options);
}

/** Plan one query through the hosted engine + selection. R4.
 *  Async (M2 day derivation loads through the engine's async
 *  loader); semantics are the shipped page's planTrip plus the
 *  D1-filtered `presented` list and mitigation meta. */
export async function planTrip(fromIdx, toIdx, departAfterIso, query, opts) {
  return defaultHost.planTripAsync(fromIdx, toIdx, departAfterIso, query, opts);
}

/** F3 / CG-7: direct presentation on the default host. See
 *  planDirectAsync for the endpoint specs and record shape. */
export async function planDirect(fromSpec, toSpec, departAfterIso, opts) {
  return defaultHost.planDirectAsync(fromSpec, toSpec, departAfterIso, opts);
}

/** F3 / CG-8: per-poll live entry on the default host (matcher /
 *  fusion / re-plan / guidance, each stage config-gated). */
export async function onLivePoll(vehicles, nowMs) {
  return defaultHost.onLivePoll(vehicles, nowMs);
}

export function getDefaultHost() { return defaultHost; }
