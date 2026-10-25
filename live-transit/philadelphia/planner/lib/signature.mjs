// Journey signature + distinctness distance.
// Implements section 3 of ../navigation-model-design.md (DESIGN) as an
// offline analysis layer over journeys the production engine produced.
// Nothing here modifies a journey; it only reads leg structure.
//
// DESIGN GAP (recorded, not silently redesigned): design section 3.1
// specifies each walk segment's DISTANCE and duration. The production
// engine's walk legs carry duration (secs) and endpoint stop indices
// only, and the merged timetable asset carries no stop coordinates --
// walk distance is not derivable from the design's stated inputs.
// This implementation therefore records duration only and leaves
// distance null. See ../README.md "Design gaps".

// Uncalibrated harness defaults (design section 3.2: every weight is
// TO BE CALIBRATED; the values below are the harness's stated defaults,
// in the design's priority order -- they are not design constants).
export const DISTANCE_WEIGHTS = {
  corridor: 0.35,
  walkBurden: 0.2,
  transferDelta: 0.2,
  modeMix: 0.15,
  transferStopDisplacement: 0.1,
};
export const INTERCHANGE_WALK_WEIGHT = 1.5; // design 3.2: interchange walks weigh more
export const NEAR_DUPLICATE_THRESHOLD = 0.35; // TO BE CALIBRATED (design 4.3)

function directionOf(leg) {
  const t = leg.tripRef || {};
  if (t.h) return t.h;
  if (Array.isArray(t.stops) && t.stops.length > 1) {
    return `stops:${t.stops[0]}>${t.stops[t.stops.length - 1]}`;
  }
  return 'unknown';
}

function patternPos(leg, stopIdx) {
  const stops = (leg.tripRef && leg.tripRef.stops) || [];
  return stops.indexOf(stopIdx);
}

// Reduce one engine journey to its design section 3.1 signature.
export function journeySignature(j) {
  const legs = j.legs || [];
  const busLegs = legs.filter((l) => l.type === 'bus');
  const routeDirectionSeq = busLegs.map(
    (l) => `${l.routeId}|${directionOf(l)}`
  );
  const transferStops = busLegs.slice(0, -1).map((l) => l.alight);
  const modeSeq = legs.map((l) => (l.type === 'walk' ? 'walk' : 'transit'));

  const walkSegments = [];
  let seenBus = 0;
  legs.forEach((l, i) => {
    if (l.type === 'bus') {
      seenBus++;
      return;
    }
    if (l.type !== 'walk') return;
    const cls =
      seenBus === 0
        ? 'access'
        : seenBus >= busLegs.length
          ? 'egress'
          : 'interchange';
    walkSegments.push({
      position: cls,
      from: l.from,
      to: l.to,
      durationSec: l.secs || 0,
      distanceM: null, // design gap: not derivable from engine output
      legIndex: i,
    });
  });

  const walkSecTotal = walkSegments.reduce((s, w) => s + w.durationSec, 0);
  const interchangeSec = walkSegments
    .filter((w) => w.position === 'interchange')
    .reduce((s, w) => s + w.durationSec, 0);
  const walkBurden =
    walkSecTotal + (INTERCHANGE_WALK_WEIGHT - 1) * interchangeSec;

  return {
    routeDirectionSeq,
    transferStops,
    modeSeq,
    walkSegments,
    transfers: j.transfers,
    walkSecTotal,
    walkBurden, // interchange-weighted, seconds
    busLegCount: busLegs.length,
    arriveSec: j.arriveSec,
    departSec: j.departSec,
    // retained for displacement computation only (not signature identity):
    _busLegs: busLegs.map((l) => ({
      routeId: l.routeId,
      board: l.board,
      alight: l.alight,
      boardPos: patternPos(l, l.board),
      alightPos: patternPos(l, l.alight),
      patternStops: (l.tripRef && l.tripRef.stops) || [],
    })),
  };
}

function jaccardDivergence(setA, setB) {
  const a = new Set(setA);
  const b = new Set(setB);
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  a.forEach((x) => {
    if (b.has(x)) inter++;
  });
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : 1 - inter / union;
}

function lcsLen(a, b) {
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

function modeMixDivergence(a, b) {
  const m = Math.max(a.length, b.length);
  if (m === 0) return 0;
  return 1 - lcsLen(a, b) / m;
}

// Stops-away between two journeys' i-th transfer stops, measured on the
// pattern of the bus leg each boards next, when both board the same
// route (the only case where "stops away along the shared corridor" is
// defined). Returns null when not comparable.
function transferDisplacement(sigA, sigB) {
  const n = Math.min(sigA.transferStops.length, sigB.transferStops.length);
  if (n === 0) return 0; // no transfers to displace (design 3.2: shared corridors only)
  const vals = [];
  for (let i = 0; i < n; i++) {
    const nextA = sigA._busLegs[i + 1];
    const nextB = sigB._busLegs[i + 1];
    if (!nextA || !nextB || nextA.routeId !== nextB.routeId) continue;
    const posA = nextA.patternStops.indexOf(sigA.transferStops[i]);
    const posB = nextB.patternStops.indexOf(sigB.transferStops[i]);
    if (posA < 0 || posB < 0) continue;
    vals.push(Math.min(1, Math.abs(posA - posB) / 10));
  }
  if (!vals.length) return 0;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

// Distinctness distance over signatures (design 3.2), weighted sum of
// normalized components. Times are excluded by construction.
export function distinctnessDistance(sigA, sigB) {
  const corridor = jaccardDivergence(
    sigA.routeDirectionSeq,
    sigB.routeDirectionSeq
  );
  const modeMix = modeMixDivergence(sigA.modeSeq, sigB.modeSeq);
  const transferDelta = Math.min(
    1,
    Math.abs(sigA.transfers - sigB.transfers) / 2
  );
  const wb = Math.max(sigA.walkBurden, sigB.walkBurden, 60);
  const walkBurden = Math.abs(sigA.walkBurden - sigB.walkBurden) / wb;
  const displacement = transferDisplacement(sigA, sigB);
  const components = {
    corridor,
    modeMix,
    transferDelta,
    walkBurden,
    transferStopDisplacement: displacement,
  };
  const distance =
    DISTANCE_WEIGHTS.corridor * corridor +
    DISTANCE_WEIGHTS.modeMix * modeMix +
    DISTANCE_WEIGHTS.transferDelta * transferDelta +
    DISTANCE_WEIGHTS.walkBurden * walkBurden +
    DISTANCE_WEIGHTS.transferStopDisplacement * displacement;
  return { distance, components };
}

// Identity key for candidate deduplication (same legs, boardings and
// arrival = the same journey, mirroring planRange's own dedupe rule).
export function journeyKey(j) {
  const legs = (j.legs || [])
    .map((l) =>
      l.type === 'bus'
        ? `B${l.routeId}@${Math.round(l.boardSec)}>${Math.round(l.alightSec)}`
        : `W${l.from}>${l.to}`
    )
    .join('|');
  return `${legs}#${Math.round(j.arriveSec)}`;
}
