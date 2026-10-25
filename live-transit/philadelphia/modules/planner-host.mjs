// modules/planner-host.mjs — R4 IMPLEMENTATION: planner host.
// PHL REBUILD R4 (planner rebuild). Label: UNVERIFIED /
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
//   asset   planner/assets/planner-timetable-v202609271-
//           v202609271.json MD5 c27c0d13…, service_model "set"
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
// files/phl-rebuild-r4-planner-2026-10-24.md). The shipped page
// cost ≈ 2 × (plan + planRange[≤240 plan() calls]) per plan —
// PHL1 107 s / PHL5 13 s / PHL11 749 s / Paoli 21 s (VM Node).
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

export function createPlannerHost() {
  const state = {
    ready: false, loadError: null,
    assetData: null, meta: null, pairing: null,
    ttFull: null, headwayMin: null, stops: null,
    assetUrl: null, routes: new Map(), dayCache: new Map(),
    memo: new Map(), lastCapture: null,
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
        ENGINE.servicesFor(state.ttFull, ymdOf(d), d.getDay(), f).forEach((s) => active.add(s));
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
      SELECTION.assertPhlConstants();
      const cfg = plannerConstants();
      const drift = [];
      for (const k of Object.keys(SELECTION.PHL_CONSTANTS.distanceWeights)) {
        if (cfg.distanceWeights[k] !== SELECTION.PHL_CONSTANTS.distanceWeights[k]) drift.push('distanceWeights.' + k);
      }
      if (cfg.nearDuplicateThreshold !== SELECTION.PHL_CONSTANTS.nearDuplicateThreshold) drift.push('nearDuplicateThreshold');
      if (cfg.reliabilityTransferPenaltyMin !== SELECTION.PHL_CONSTANTS.reliabilityTransferPenaltyMin) drift.push('reliabilityTransferPenaltyMin');
      if (cfg.reliabilityHeadwayCapMin !== SELECTION.PHL_CONSTANTS.reliabilityHeadwayCapMin) drift.push('reliabilityHeadwayCapMin');
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
      const facade = {
        plan(ttArg, seeds, toIdxArg, whenArg, o) {
          capture.calls.plan++;
          const r = ENGINE.plan(ttArg, seeds, toIdxArg, whenArg, o);
          capture.baseline = r;
          return r;
        },
        planRange(ttArg, seeds, toIdxArg, a, b, o) {
          capture.calls.planRange++;
          const r = ENGINE.planRange(ttArg, seeds, toIdxArg, a, b, o);
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
      if (useMemo) state.memo.set(memoKey, out);
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

export function getDefaultHost() { return defaultHost; }
