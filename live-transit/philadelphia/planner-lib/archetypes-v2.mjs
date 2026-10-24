// Archetype selection + near-duplicate suppression — RELIABILITY V2.
// Board 47 item 7, tranche 2 (engine-generalization design §3).
//
// This file is lib/archetypes.mjs (v1) with EXACTLY ONE substitution:
// the headway lookup behind reliabilityScore prices each bus leg by
// the combined departure stream of its board->alight corridor
// (design §3) instead of by the leg's own pattern alone. Selection,
// suppression, constants, and the score's form are byte-for-byte the
// v1 code. The v1 lookup survives below as buildHeadwayLookupV1 for
// before/after attribution; no runner imports it.
//
// Design §3 specification, as implemented:
//   P(leg)  = every pattern (route + stop sequence, the harness's
//             established pattern identity) whose stop sequence
//             contains leg.board before leg.alight.
//   H2(leg) = median inter-departure gap of the merged departure
//             stream at leg.board across all patterns in P(leg),
//             capped at 60 min; a stream with a single departure
//             prices at the cap (60), as v1 treats a one-trip pattern.
//   R2(j)   = sum over bus legs of H2(leg) + 15 * transfers
//             (v1's form, cap, and transfer penalty unchanged).
// Where |P(leg)| = 1 the merged stream IS that pattern's stream, so
// v2 reduces to pricing the leg by its own pattern's stream — there
// is no trunk test and no mode switch (design §3.4).
//
// Frame note (recorded, not silent): like v1's lookup, this lookup is
// built once from the asset's full trip set and pools every trip of
// each pattern; it receives no query date. Design §3.1 phrases P(leg)
// over "the queried service day's resolved service set" — under the
// set-resolution engine (§1) the resolved set determines which trips
// the planner returns, while the harness's pricing frame has always
// been the asset-wide pattern stream (v1 identical). The §3
// experiment's control condition — R2 substituted for R, everything
// else identical — fixes this frame; changing it would confound the
// substitution being tested.
import {
  distinctnessDistance,
  NEAR_DUPLICATE_THRESHOLD,
} from './signature.mjs';

// ---------------------------------------------------------------------
// Reliability constants (design-addendum Addendum 2): unchanged from
// v1 — penalty 15 min per transfer, headway cap 60 min.
// ---------------------------------------------------------------------
export const RELIABILITY_TRANSFER_PENALTY_MIN = 15;
export const HEADWAY_SINGLE_TRIP_CAP_MIN = 60;

function medianOfSorted(sortedArr) {
  const n = sortedArr.length;
  if (!n) return null;
  return n % 2
    ? sortedArr[Math.floor(n / 2)]
    : (sortedArr[n / 2 - 1] + sortedArr[n / 2]) / 2;
}

function patternIndex(rawTrips) {
  const patterns = new Map(); // key -> { stops, trips }
  for (const t of rawTrips) {
    const key = `${t.r}|${t.stops.join(',')}`;
    let p = patterns.get(key);
    if (!p) {
      p = { stops: t.stops, trips: [] };
      patterns.set(key, p);
    }
    p.trips.push(t);
  }
  return patterns;
}

// ---------------------------------------------------------------------
// V2 headway lookup (design §3). Returns headwayMin(leg) in minutes,
// with a .corridor(board, alight) diagnostics hook attached (pattern
// count, stream size, median gap) — selection never reads the hook.
// ---------------------------------------------------------------------
export function buildHeadwayLookup(rawTrips) {
  const patterns = patternIndex(rawTrips);
  const byBoardStop = new Map(); // stop idx -> [pattern records]
  for (const p of patterns.values()) {
    for (const s of new Set(p.stops)) {
      if (!byBoardStop.has(s)) byBoardStop.set(s, []);
      byBoardStop.get(s).push(p);
    }
  }
  const corridorMemo = new Map();
  function corridor(board, alight) {
    const key = `${board}>${alight}`;
    if (corridorMemo.has(key)) return corridorMemo.get(key);
    const stream = [];
    let pCount = 0;
    for (const p of byBoardStop.get(board) || []) {
      const posB = p.stops.indexOf(board);
      if (posB < 0) continue;
      const posA = p.stops.lastIndexOf(alight);
      if (posA <= posB) continue;
      pCount++;
      for (const t of p.trips) stream.push(t.dep[posB]);
    }
    stream.sort((a, b) => a - b);
    let value;
    if (stream.length <= 1) {
      value = {
        minutes: HEADWAY_SINGLE_TRIP_CAP_MIN,
        pCount,
        streamSize: stream.length,
        medianGapSec: null,
      };
    } else {
      const gaps = [];
      for (let i = 1; i < stream.length; i++)
        gaps.push(stream[i] - stream[i - 1]);
      gaps.sort((a, b) => a - b);
      const med = medianOfSorted(gaps);
      value = {
        minutes: Math.min(HEADWAY_SINGLE_TRIP_CAP_MIN, med / 60),
        pCount,
        streamSize: stream.length,
        medianGapSec: med,
      };
    }
    corridorMemo.set(key, value);
    return value;
  }
  function headwayMin(leg) {
    const t = leg.tripRef;
    if (!t || !Array.isArray(t.stops)) return HEADWAY_SINGLE_TRIP_CAP_MIN;
    if (t.stops.indexOf(leg.board) < 0) return HEADWAY_SINGLE_TRIP_CAP_MIN;
    if (leg.alight === undefined || leg.alight === null)
      return HEADWAY_SINGLE_TRIP_CAP_MIN;
    return corridor(leg.board, leg.alight).minutes;
  }
  headwayMin.corridor = corridor;
  return headwayMin;
}

// ---------------------------------------------------------------------
// V1 headway lookup — the original lib/archetypes.mjs implementation,
// retained verbatim (renamed) for before/after attribution only.
// score(journey) under v1 = sum over bus legs of the min gap to a
// neighbouring departure within the leg's own pattern (minutes,
// single-trip patterns at the 60 cap) + 15 * transfers.
// ---------------------------------------------------------------------
export function buildHeadwayLookupV1(rawTrips) {
  const patterns = new Map();
  for (const t of rawTrips) {
    const key = `${t.r}|${t.stops.join(',')}`;
    if (!patterns.has(key)) patterns.set(key, []);
    patterns.get(key).push(t);
  }
  return function headwayMin(leg) {
    const t = leg.tripRef;
    if (!t || !Array.isArray(t.stops)) return HEADWAY_SINGLE_TRIP_CAP_MIN;
    const key = `${t.r}|${t.stops.join(',')}`;
    const trips = patterns.get(key) || [t];
    const pos = t.stops.indexOf(leg.board);
    if (pos < 0) return HEADWAY_SINGLE_TRIP_CAP_MIN;
    const deps = trips.map((x) => x.dep[pos]).sort((a, b) => a - b);
    const mine = t.dep[pos];
    let prev = null;
    let next = null;
    for (const d of deps) {
      if (d < mine) prev = d;
      if (d > mine && next === null) next = d;
    }
    const gaps = [];
    if (prev !== null) gaps.push(mine - prev);
    if (next !== null) gaps.push(next - mine);
    if (!gaps.length) return HEADWAY_SINGLE_TRIP_CAP_MIN;
    return Math.min(...gaps) / 60;
  };
}

// Per-leg attribution: both prices plus the corridor facts behind the
// v2 price. Used by tranche diagnostics; not by selection.
export function buildReliabilityDiagnostics(rawTrips) {
  const h1 = buildHeadwayLookupV1(rawTrips);
  const h2 = buildHeadwayLookup(rawTrips);
  return function diagnose(leg) {
    const base = { h1Min: h1(leg), h2Min: h2(leg) };
    const t = leg.tripRef;
    if (!t || !Array.isArray(t.stops) || leg.alight === undefined || leg.alight === null)
      return { ...base, patterns: null, streamSize: null, medianGapSec: null };
    const c = h2.corridor(leg.board, leg.alight);
    return {
      ...base,
      patterns: c.pCount,
      streamSize: c.streamSize,
      medianGapSec: c.medianGapSec,
    };
  };
}

export function reliabilityScore(journey, sig, headwayMin) {
  let sum = 0;
  for (const l of journey.legs) {
    if (l.type === 'bus') sum += headwayMin(l);
  }
  return sum + RELIABILITY_TRANSFER_PENALTY_MIN * journey.transfers;
}

// Deterministic comparator chains. Design 4.1 states per-archetype
// tie-breaks (earliest arrival); design 4.4 fixes the general
// precedence: earliest arrival, then fewest transfers, then least
// walking. Primary key first, then that precedence (skipping the
// primary when it repeats).
function chain(...keys) {
  return (a, b) => {
    for (const k of keys) {
      if (a[k] !== b[k]) return a[k] - b[k];
    }
    return a.index - b.index; // keep engine order on a full tie
  };
}

const ARCHETYPES = [
  {
    name: 'fastest',
    pick: (cs) =>
      cs.slice().sort(chain('arriveSec', 'transfers', 'walkSecTotal'))[0],
  },
  {
    name: 'fewest-transfers',
    pick: (cs) =>
      cs.slice().sort(chain('transfers', 'arriveSec', 'walkSecTotal'))[0],
  },
  {
    name: 'least-walking',
    pick: (cs) =>
      cs.slice().sort(chain('walkBurden', 'arriveSec', 'transfers'))[0],
  },
  {
    name: 'direct',
    // Design 4.1 archetype 4: a single-corridor/direct candidate
    // (one transit leg). Unfilled when no such candidate exists.
    pick: (cs) => {
      const direct = cs.filter((c) => c.sig.busLegCount === 1);
      if (!direct.length) return null;
      return direct
        .slice()
        .sort(chain('arriveSec', 'walkSecTotal'))[0];
    },
  },
  {
    name: 'highest-reliability',
    pick: (cs) =>
      cs.slice().sort(chain('reliability', 'arriveSec', 'transfers'))[0],
  },
];

// Select archetype representatives and suppress near-duplicates.
// candidates: [{ index, journey, sig, reliability }]
// Returns design section 4 outputs + section 8.2 raw material.
export function selectArchetypes(candidates, threshold = NEAR_DUPLICATE_THRESHOLD) {
  if (!candidates.length) {
    return { representatives: [], suppressed: [], unselectedDistinct: [], labels: new Map() };
  }
  const labels = new Map(); // candidate index -> [archetype names]
  const repIdx = new Set();
  for (const arch of ARCHETYPES) {
    const winner = arch.pick(candidates);
    if (!winner) continue;
    repIdx.add(winner.index);
    if (!labels.has(winner.index)) labels.set(winner.index, []);
    labels.get(winner.index).push(arch.name);
  }
  const representatives = candidates.filter((c) => repIdx.has(c.index));
  const suppressed = [];
  const unselectedDistinct = [];
  for (const c of candidates) {
    if (repIdx.has(c.index)) continue;
    let minDist = Infinity;
    let nearest = null;
    for (const r of representatives) {
      const { distance } = distinctnessDistance(c.sig, r.sig);
      if (distance < minDist) {
        minDist = distance;
        nearest = r.index;
      }
    }
    const rec = { index: c.index, minDistToRep: minDist, nearestRep: nearest };
    if (minDist < threshold) suppressed.push(rec);
    else unselectedDistinct.push(rec);
  }
  return { representatives, suppressed, unselectedDistinct, labels };
}
