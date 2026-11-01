// Philadelphia planner selection — integration staging module
// (Board 48 item 6, integration step 2026-10-23).
//
// This is the experiment's selection pipeline, packaged as the
// module a Philadelphia page build would consume:
//   candidate enumeration  plan() at the instant UNION
//                          planRange(+120 min), deduped on legs+arrival
//   reliability pricing    v2 (lib/archetypes-v2.mjs) — corridor
//                          merged-stream median-gap headway
//   selection bound        FREQUENCY-AWARE (design-addendum
//                          Addendum 3): window = max(+30 min,
//                          departure of the earliest candidate whose
//                          addition to the flat pool adds a
//                          representative), hard cap +120 min
//   constants              PHL_CONSTANTS below — Philadelphia's
//                          calibrated constants W0-default-T35-P15
//                          (files/calibration-2026-10-23.md),
//                          asserted against the lib values before
//                          any selection runs (the constants gate).
//
// The selection logic is the tranche-3 / calibration machinery's,
// moved — not rewritten: summarizeMode, the flat/frequency-aware
// pool construction, the trigger test, and the aggregates are the
// freqbound runner's code paths with the runner's file I/O and
// cross-check scaffolding removed. Verification
// (verification/verify-bundle.mjs) proves the staged module
// reproduces the recorded experiment output field-for-field on
// every Philadelphia golden pair.
//
// Correctness contract (ruling 5, structural, 0 s tolerance): the
// fastest representative's arrival equals the plan() baseline
// exactly on every pair; any nonzero delta is reported in the
// result (ruling5Violation), never absorbed.
//
// PHL11 / walk-only: this module does NOT decide the walk-only
// presentation question (Justin's, at page-build time). A fastest
// representative with zero transit legs is flagged in
// presentationFlags and returned like any other result.

import {
  journeySignature,
  journeyKey,
  NEAR_DUPLICATE_THRESHOLD,
  DISTANCE_WEIGHTS,
} from './signature.mjs';
import {
  buildHeadwayLookup,
  reliabilityScore,
  selectArchetypes,
  RELIABILITY_TRANSFER_PENALTY_MIN,
  HEADWAY_SINGLE_TRIP_CAP_MIN,
} from './archetypes-v2.mjs';

export const PHL_CONSTANTS = {
  distanceWeights: {
    corridor: 0.35,
    walkBurden: 0.2,
    transferDelta: 0.2,
    modeMix: 0.15,
    transferStopDisplacement: 0.1,
  },
  nearDuplicateThreshold: 0.35,
  reliabilityTransferPenaltyMin: 15,
  reliabilityHeadwayCapMin: 60,
};

export const SELECTION_MODE = 'frequency-aware';
export const FLAT_BOUND_SEC = 30 * 60;
export const WINDOW_MIN = 120;
export const CAP_SEC = WINDOW_MIN * 60;

// The constants gate: lib values must equal the adopted constants
// before any selection runs (the runners' gate, kept in the module
// so a page build cannot drift from the calibrated record).
export function assertPhlConstants() {
  const drift = [];
  for (const k of Object.keys(PHL_CONSTANTS.distanceWeights)) {
    if (DISTANCE_WEIGHTS[k] !== PHL_CONSTANTS.distanceWeights[k])
      drift.push(`weight ${k}: lib ${DISTANCE_WEIGHTS[k]} != adopted ${PHL_CONSTANTS.distanceWeights[k]}`);
  }
  if (NEAR_DUPLICATE_THRESHOLD !== PHL_CONSTANTS.nearDuplicateThreshold)
    drift.push(`threshold: lib ${NEAR_DUPLICATE_THRESHOLD} != adopted ${PHL_CONSTANTS.nearDuplicateThreshold}`);
  if (RELIABILITY_TRANSFER_PENALTY_MIN !== PHL_CONSTANTS.reliabilityTransferPenaltyMin)
    drift.push(`penalty: lib ${RELIABILITY_TRANSFER_PENALTY_MIN} != adopted ${PHL_CONSTANTS.reliabilityTransferPenaltyMin}`);
  if (HEADWAY_SINGLE_TRIP_CAP_MIN !== PHL_CONSTANTS.reliabilityHeadwayCapMin)
    drift.push(`cap: lib ${HEADWAY_SINGLE_TRIP_CAP_MIN} != adopted ${PHL_CONSTANTS.reliabilityHeadwayCapMin}`);
  if (drift.length) {
    const err = new Error('CONSTANTS GATE FAILED — ' + drift.join('; '));
    err.code = 'CONSTANTS_GATE';
    throw err;
  }
  return true;
}

const sorted = (a) => a.slice().sort((x, y) => x - y);
const median = (a) =>
  a.length
    ? a.length % 2
      ? a[Math.floor(a.length / 2)]
      : (a[a.length / 2 - 1] + a[a.length / 2]) / 2
    : null;

export function summarizeMode(sel, lookup, poolSize, baselineBest) {
  const reps = sel.representatives;
  const bestRetained = reps.length
    ? Math.min(...reps.map((r) => r.arriveSec))
    : null;
  const suppressedRecs = sel.suppressed
    .map((s) => lookup[s.index])
    .filter(Boolean);
  const bestSuppressed = suppressedRecs.length
    ? Math.min(...suppressedRecs.map((c) => c.arriveSec))
    : null;
  return {
    archetypeCount: reps.length,
    archetypes: reps.map((r) => ({
      labels: sel.labels.get(r.index),
      arriveSec: r.arriveSec,
      departOffsetSec:
        r.departSecNorm !== null && r.querySec !== null
          ? Math.round(r.departSecNorm - r.querySec)
          : null,
      transfers: r.transfers,
      walkSecTotal: r.walkSecTotal,
      routes: r.sig.routeDirectionSeq,
    })),
    suppressed: sel.suppressed.length,
    suppressedRateOfPool: poolSize ? sel.suppressed.length / poolSize : 0,
    unselectedDistinct: sel.unselectedDistinct.length,
    arrivalCostPerArchetypeSec: reps
      .map((r) => r.arriveSec - bestRetained)
      .filter((x) => x > 0),
    arrivalCostBestSuppressedVsRetainedSec:
      bestSuppressed !== null && bestRetained !== null
        ? bestSuppressed - bestRetained
        : null,
    fastestVsBaselineDeltaSec:
      bestRetained !== null && baselineBest !== null
        ? bestRetained - baselineBest
        : null,
    ruling5Violation:
      baselineBest !== null &&
      (bestRetained === null || bestRetained - baselineBest !== 0),
    has2PlusArchetypes: reps.length >= 2,
  };
}

export function aggregateMode(records, poolKey, modeKey) {
  const rs = records.map((r) => r[modeKey]);
  const totPool = records.reduce((s, r) => s + r[poolKey], 0);
  const totSupp = rs.reduce((s, m) => s + m.suppressed, 0);
  const archCounts = rs.map((m) => m.archetypeCount);
  const allCosts = rs.flatMap((m) => m.arrivalCostPerArchetypeSec);
  const withCand = records.filter((r) => r.candidates > 0);
  return {
    odPairs: records.length,
    poolTotal: totPool,
    totalSuppressed: totSupp,
    nearDuplicateSuppressionRate: totPool ? totSupp / totPool : 0,
    archetypeCountDistribution: archCounts.reduce((m, n) => {
      m[n] = (m[n] || 0) + 1;
      return m;
    }, {}),
    archetypeCountMean:
      archCounts.reduce((s, n) => s + n, 0) / Math.max(1, archCounts.length),
    arrivalCostPerArchetypeSec: {
      n: allCosts.length,
      min: allCosts.length ? Math.min(...allCosts) : null,
      median: median(sorted(allCosts)),
      max: allCosts.length ? Math.max(...allCosts) : null,
    },
    sharePairsWith2PlusArchetypes:
      rs.filter((m) => m.has2PlusArchetypes).length /
      Math.max(1, records.length),
    shareNonEmptyPairsWith2PlusArchetypes:
      withCand.filter((r) => r[modeKey].has2PlusArchetypes).length /
      Math.max(1, withCand.length),
    pairsBelow2ArchetypesAmongNonEmpty: withCand
      .filter((r) => !r[modeKey].has2PlusArchetypes)
      .map((r) => r.id),
    fastestVsBaselineDeltasSec: rs.map((m) => m.fastestVsBaselineDeltaSec),
    ruling5Violations: records
      .filter((r) => r[modeKey].ruling5Violation)
      .map((r) => r.id),
  };
}

const labelSet = (sel) => {
  const s = new Set();
  for (const labs of sel.labels.values()) for (const l of labs) s.add(l);
  return s;
};

const headwayCache = new WeakMap();
export function headwayLookupFor(rawTrips) {
  if (!headwayCache.has(rawTrips)) {
    headwayCache.set(rawTrips, buildHeadwayLookup(rawTrips));
  }
  return headwayCache.get(rawTrips);
}

// Plan one golden/OD query through the full Philadelphia selection
// pipeline. R = engine module (set-resolution), tt = loaded
// timetable (via lib/loader.mjs), headwayMin = v2 lookup for the
// asset's trips. Returns the experiment record's per-query shape,
// plus presentationFlags (the module's one addition: it flags,
// never decides, the walk-only case).
export function planQuery(R, tt, headwayMin, q) {
  assertPhlConstants();
  const when = new Date(q.depart_after);
  const seeds = [{ stop: q.origin.page_idx, walk: 0 }];
  const baseline = R.plan(tt, seeds, q.destination.page_idx, when);
  const range = R.planRange(
    tt,
    seeds,
    q.destination.page_idx,
    when,
    new Date(when.getTime() + WINDOW_MIN * 60000)
  );
  const frameMid = new Date(
    when.getFullYear(),
    when.getMonth(),
    when.getDate()
  ).getTime();
  const querySec = (when.getTime() - frameMid) / 1000;

  const byKey = new Map();
  const addCand = (journey, arriveSecNorm, departSecNorm) => {
    const key =
      journeyKey(journey).split('#')[0] + '#' + Math.round(arriveSecNorm);
    if (byKey.has(key)) return;
    byKey.set(key, { journey, arriveSec: arriveSecNorm, departSecNorm });
  };
  for (const j of baseline.journeys || []) addCand(j, j.arriveSec, j.departSec);
  for (const d of range.departures || []) {
    addCand(
      d.journey,
      (d.arriveMs - frameMid) / 1000,
      (d.leaveMs - frameMid) / 1000
    );
  }

  const candidates = [...byKey.values()].map((c, i) => {
    const sig = journeySignature(c.journey);
    sig.arriveSec = c.arriveSec;
    return {
      index: i,
      journey: c.journey,
      sig,
      arriveSec: c.arriveSec,
      departSecNorm: c.departSecNorm,
      querySec,
      transfers: c.journey.transfers,
      walkSecTotal: sig.walkSecTotal,
      walkBurden: sig.walkBurden,
      reliability: reliabilityScore(c.journey, sig, headwayMin),
    };
  });

  const baselineBest = (baseline.journeys || []).length
    ? Math.min(...baseline.journeys.map((j) => j.arriveSec))
    : null;

  const offset = (c) => c.departSecNorm - querySec;

  // --- flat mode (the +30 floor; also the trigger test's base pool)
  const poolFlat = candidates.filter(
    (c) => offset(c) >= 0 && offset(c) <= FLAT_BOUND_SEC
  );
  const selFlat = selectArchetypes(poolFlat);
  const flat = summarizeMode(selFlat, candidates, poolFlat.length, baselineBest);

  // --- frequency-aware mode (Addendum 3)
  const outSorted = candidates
    .filter((c) => offset(c) > FLAT_BOUND_SEC && offset(c) <= CAP_SEC)
    .slice()
    .sort((a, b) => a.departSecNorm - b.departSecNorm || a.index - b.index);
  const labelsFlat = labelSet(selFlat);
  let trigger = null;
  let triggerTest = null;
  for (const c of outSorted) {
    const selTest = selectArchetypes([...poolFlat, c]);
    if (selTest.representatives.length > selFlat.representatives.length) {
      trigger = c;
      triggerTest = selTest;
      break;
    }
  }
  const windowSec = trigger
    ? Math.min(offset(trigger), CAP_SEC)
    : FLAT_BOUND_SEC;
  const poolFreq = trigger
    ? candidates.filter((c) => offset(c) >= 0 && offset(c) <= offset(trigger) + 1e-9)
    : poolFlat;
  const selFreq = selectArchetypes(poolFreq);
  const freq = summarizeMode(selFreq, candidates, poolFreq.length, baselineBest);

  const triggerInfo = trigger
    ? {
        candidateIndex: trigger.index,
        departOffsetSec: Math.round(offset(trigger)),
        routes: trigger.sig.routeDirectionSeq,
        arriveSec: trigger.arriveSec,
        representativesBefore: selFlat.representatives.length,
        representativesWithTriggerAlone: triggerTest.representatives.length,
        labelsAddedInTriggerTest: [...labelSet(triggerTest)].filter(
          (l) => !labelsFlat.has(l)
        ),
      }
    : null;

  // Presentation flags — flagged, never decided (PHL11 is Justin's).
  const fastestRep =
    selFreq.representatives.find((r) =>
      (selFreq.labels.get(r.index) || []).includes('fastest')
    ) || null;

  return {
    id: q.id,
    kind: q.kind,
    expect: q.expect,
    origin: q.origin.name,
    destination: q.destination.name,
    departAfter: q.depart_after,
    candidates: candidates.length,
    baselineJourneys: (baseline.journeys || []).length,
    baselineBestArriveSec: baselineBest,
    rangeMeta: range.meta
      ? { calls: range.meta.calls, truncated: range.meta.truncated }
      : null,
    departureAnomalies: candidates.filter((c) => offset(c) < 0).length,
    flatPool: poolFlat.length,
    freqPool: poolFreq.length,
    selectionWindowSec: Math.round(windowSec),
    windowExtendedPastFlat: windowSec > FLAT_BOUND_SEC,
    windowExtensionSec: Math.round(windowSec - FLAT_BOUND_SEC),
    trigger: triggerInfo,
    flat,
    freq,
    presentationFlags: {
      walkOnlyFastest: fastestRep ? fastestRep.sig.busLegCount === 0 : false,
      walkOnlyDecision:
        'UNDECIDED — Justin (PHL11), at page-build time; flagged here, neither filtered nor relabeled',
    },
  };
}
