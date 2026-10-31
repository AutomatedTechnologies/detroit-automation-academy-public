// renderer/motion.mjs — vehicle motion stack (CG-9 fold).
// Pure, no THREE, no DOM: Node-importable for scene-model tests.
//
// Port of the monolith motion semantics (census CG-9, monolith line
// evidence M:8525-9054 / M:9540-9620), gated by the CALLER on
// cfg.motion.empirical — this module is never consulted when the
// gate is off, so glyphs draw exactly as published.
//
// Constants are the monolith's, verbatim:
//   PREDICT_HORIZON_S 150  — never dead-reckon on an older fix
//   SNAP_DIST_M       200  — along-track divergence = teleport
//   OFFSHAPE_M        150  — cross-track beyond this = raw fix, hold
//   KALMAN_R          225  — GPS measurement variance (15 m sigma)
//   KALMAN_Q_POS      2.0  — process-noise density, position
//   KALMAN_Q_VEL      0.5  — process-noise density, velocity
//   DELAY_PROJECTION  0.6  — delay projection factor (exported for
//                            surfaces' suggestion consumers)
//   REVERT_TAU_S      45   — reported-speed trust time constant
//   LOCAL_FRESH_MS    2 h  — local speedmap observation freshness
//
// L2 BASELINE: applyEmpiricalBaseline below is the monolith's
// DISABLED form (M:9496-9509): it leaves depL2/arrL2 null on every
// trip and returns 0. Timing cells load ONLY as the empiricalSpeed
// motion prior. Do not "enable" it here — the disablement is the
// measured decision (held-out replay: scheduled-only won).

export const MOTION = Object.freeze({
  PREDICT_HORIZON_S: 150,
  SNAP_DIST_M: 200,
  OFFSHAPE_M: 150,
  DELAY_PROJECTION: 0.6,
  KALMAN_R: 225,
  KALMAN_Q_POS: 2.0,
  KALMAN_Q_VEL: 0.5,
  MPH_TO_MPS: 0.44704,
  REVERT_TAU_S: 45,
  LOCAL_FRESH_MS: 2 * 3600 * 1000,
  SPEEDMAP_SAVE_MS: 5 * 60 * 1000,
});

// ---------- route-shape arcs (monolith shapeArcs/pointAt/nearestOnArc) ----

/** One arc per path: cumulative lengths over projected [x, z] points. */
export function buildArc(pts) {
  if (!pts || pts.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return { pts, cum, len: cum[cum.length - 1] };
}

export function buildArcs(paths) {
  const arcs = [];
  for (const pts of paths || []) {
    const a = buildArc(pts);
    if (a) arcs.push(a);
  }
  return arcs.length ? arcs : null;
}

/** Point at arc-length s, with unit direction. */
export function pointAtArc(arc, s) {
  const cs = Math.max(0, Math.min(arc.len, s));
  const cum = arc.cum, pts = arc.pts;
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= cs) lo = mid; else hi = mid; }
  const segLen = (cum[hi] - cum[lo]) || 1;
  const t = (cs - cum[lo]) / segLen;
  const ax = pts[lo][0], az = pts[lo][1];
  const dx = pts[hi][0] - ax, dz = pts[hi][1] - az;
  const dl = Math.hypot(dx, dz) || 1;
  return { x: ax + dx * t, z: az + dz * t, dx: dx / dl, dz: dz / dl };
}

/** Nearest point on one arc: {s, dist, dx, dz}. */
export function nearestOnArc(arc, x, z) {
  const pts = arc.pts, cum = arc.cum;
  let bDist = Infinity, bS = 0, bDx = 1, bDz = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0], az = pts[i][1];
    const dx = pts[i + 1][0] - ax, dz = pts[i + 1][1] - az;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
    if (d < bDist) {
      bDist = d; bS = cum[i] + Math.sqrt(l2) * t;
      const dl = Math.sqrt(l2) || 1; bDx = dx / dl; bDz = dz / dl;
    }
  }
  return { s: bS, dist: bDist, dx: bDx, dz: bDz };
}

/**
 * Map-match a fix to (path, arc-length). Bearing disambiguates
 * overlapping opposite-direction paths; the previous match lends
 * continuity. Bearing is compass degrees in projected space
 * (x east, z = negated latitude, so the unit vector is
 * [sin(b), -cos(b)]).
 */
export function matchFix(arcs, x, z, bearingDeg, prev) {
  if (!arcs) return null;
  let bwx = 0, bwz = 0;
  const hasB = typeof bearingDeg === 'number' && Number.isFinite(bearingDeg);
  if (hasB) {
    const br = (bearingDeg * Math.PI) / 180;
    bwx = Math.sin(br); bwz = -Math.cos(br);
  }
  let best = null;
  for (let pi = 0; pi < arcs.length; pi++) {
    const nb = nearestOnArc(arcs[pi], x, z);
    const dot = hasB ? (bwx * nb.dx + bwz * nb.dz) : 0;
    const score0 = nb.dist - 80 * Math.max(0, dot);
    let score = score0;
    if (prev && prev.pathIdx === pi && Math.abs(nb.s - prev.s) < 400) score -= 50;
    if (!best || score < best.score) {
      best = { score, pathIdx: pi, s: nb.s, dist: nb.dist, arc: arcs[pi] };
    }
  }
  return best;
}

// ---------- Kalman tracker (monolith busTrackers state + update) ----------

export function createTracker(id, routeId) {
  return {
    id, routeId,
    arc: null, pathIdx: -1, s: 0,
    speedMps: 0, fixT: 0, fixObsT: 0,
    lastX: null, lastZ: null,
    matchS: null, matchPath: -1, seg: null, segPath: -1,
    // Kalman state [kS arc position, kV velocity] + covariance.
    kS: 0, kV: 0, kP: MOTION.KALMAN_R, kPv: 25, kPvS: 0, kInit: false,
  };
}

/**
 * Feed one map-match into the tracker (monolith reconcile, M:9562+).
 * match: result of matchFix, or null (off-shape / no shape).
 * instMps: feed-reported speed in m/s, or null.
 * Returns 'snap' | 'update' | 'init' | 'raw'.
 */
export function observeFix(tr, match, instMps, nowMs) {
  if (instMps != null && Number.isFinite(instMps) && instMps >= 0) tr.speedMps = instMps;
  tr.fixT = nowMs; tr.fixObsT = nowMs;
  if (!match || match.dist > MOTION.OFFSHAPE_M) {
    tr.arc = null; tr.matchS = null; tr.matchPath = -1;
    return 'raw'; // detour / unmatched: render the raw fix, hold still
  }
  let how;
  if (tr.arc && tr.pathIdx === match.pathIdx && tr.kInit) {
    const delta = match.s - tr.kS;
    if (Math.abs(delta) > MOTION.SNAP_DIST_M) {
      // Outlier gate: snap + reinitialise the filter.
      tr.kS = match.s; tr.kV = instMps != null ? instMps : tr.speedMps;
      tr.kP = MOTION.KALMAN_R; tr.kPv = 25; tr.kPvS = 0;
      how = 'snap';
    } else {
      // Kalman update, H = [1, 0], R = GPS variance.
      const Sk = tr.kP + MOTION.KALMAN_R;
      const kk0 = tr.kP / Sk, kk1 = tr.kPvS / Sk;
      tr.kS += kk0 * delta;
      tr.kV += kk1 * delta;
      const nkP = tr.kP - kk0 * tr.kP;
      const nkPvS = tr.kPvS - kk0 * tr.kPvS;
      tr.kPv = tr.kPv - kk1 * tr.kPvS;
      tr.kP = nkP; tr.kPvS = nkPvS;
      how = 'update';
    }
    if (tr.arc) tr.kS = Math.max(0, Math.min(tr.arc.len, tr.kS));
    tr.s = tr.kS;
  } else {
    tr.kS = match.s; tr.kV = instMps != null ? instMps : tr.speedMps;
    tr.kP = MOTION.KALMAN_R; tr.kPv = 25; tr.kPvS = 0;
    tr.kInit = true;
    tr.s = match.s;
    how = 'init';
  }
  tr.arc = match.arc; tr.pathIdx = match.pathIdx;
  tr.matchS = match.s; tr.matchPath = match.pathIdx;
  return how;
}

/**
 * Dead-reckoning predict step (monolith updateBusMotion, M:8841+).
 * Mutates the tracker; returns the predicted {x, z, dx, dz} on the
 * arc, or null when prediction does not apply (no arc, filter not
 * initialised, or the fix is past PREDICT_HORIZON_S — past the
 * horizon the caller holds the marker at the last matched fix).
 * empiricalVelocity: the empirical prior speed for the current
 * segment (m/s) or null; the prior only ever revises DOWNWARD.
 */
export function predictStep(tr, dtS, nowMs, empiricalVelocity) {
  if (!tr.arc || !tr.kInit) return null;
  const anchor = tr.fixObsT != null && tr.fixObsT !== 0 ? tr.fixObsT : tr.fixT;
  const ageS = (nowMs - anchor) / 1000;
  if (!(ageS < MOTION.PREDICT_HORIZON_S)) return null;
  if (!(dtS > 0)) return pointAtArc(tr.arc, tr.s);
  const v0 = tr.speedMps;
  const vPrior = (empiricalVelocity != null && empiricalVelocity < v0) ? empiricalVelocity : v0;
  tr.kV += (vPrior - tr.kV) * (1 - Math.exp(-dtS / MOTION.REVERT_TAU_S));
  tr.kS += tr.kV * dtS;
  const p00 = tr.kP, p01 = tr.kPvS, p11 = tr.kPv;
  tr.kP = p00 + 2 * dtS * p01 + dtS * dtS * p11 + MOTION.KALMAN_Q_POS * dtS;
  tr.kPvS = p01 + dtS * p11;
  tr.kPv = p11 + MOTION.KALMAN_Q_VEL * dtS;
  if (Math.abs(tr.kV) > 0.3 || tr.kP > MOTION.KALMAN_R * 4) {
    tr.s = Math.max(0, Math.min(tr.arc.len, tr.kS));
  }
  return pointAtArc(tr.arc, tr.s);
}

/** The last matched fix position on the arc (the stale hold point). */
export function staleFixPoint(tr) {
  if (!tr) return null;
  if (tr.arc && tr.matchS != null && tr.matchPath === tr.pathIdx) {
    const pt = pointAtArc(tr.arc, tr.matchS);
    return { x: pt.x, z: pt.z, s: tr.matchS };
  }
  if (tr.lastX != null && tr.lastZ != null) return { x: tr.lastX, z: tr.lastZ, s: null };
  return null;
}

// ---------- empirical speed prior: timing cells + local speedmap ----------

/** Timing-cells document -> the flat cell map (envelope `segments`). */
export function parseTimingCells(doc) {
  if (doc && doc.segments && typeof doc.segments === 'object') return doc.segments;
  if (doc && typeof doc === 'object' && !Array.isArray(doc)
      && Object.values(doc).some((v) => v && typeof v === 'object' && 'mean_s' in v)) return doc;
  return null;
}

/**
 * Day-bucket for the timing-cell key, in the CONFIGURED timezone
 * (the monolith's bucket shape, generalised from its one city):
 * 'sat' | 'sun' | 'wkd_am' | 'wkd_mid' | 'wkd_pm' | 'wkd_eve' |
 * 'wkd_night'.
 */
export function bucketFor(nowMs, timeZone) {
  const d = new Date(nowMs);
  let wd = null, hr = null;
  try {
    new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined, weekday: 'short', hour: 'numeric', hourCycle: 'h23',
    }).formatToParts(d).forEach((p) => {
      if (p.type === 'weekday') wd = p.value;
      if (p.type === 'hour') hr = parseInt(p.value, 10);
    });
  } catch (e) { /* fall through with local fields */ }
  if (wd === null) { wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]; hr = d.getHours(); }
  if (wd === 'Sat') return 'sat';
  if (wd === 'Sun') return 'sun';
  if (hr >= 6 && hr < 9) return 'wkd_am';
  if (hr >= 9 && hr < 15) return 'wkd_mid';
  if (hr >= 15 && hr < 19) return 'wkd_pm';
  if (hr >= 19 && hr < 24) return 'wkd_eve';
  return 'wkd_night';
}

/**
 * Local speedmap: EMA per segment key, persisted under the
 * configured storage key. Storage is injected ({getItem, setItem})
 * so Node harnesses and the browser share the code; a null storage
 * keeps the map in memory only.
 */
export function createSpeedmap(storageKey, storage) {
  let segs = {};
  let saveT = 0;
  const store = storage && typeof storage.getItem === 'function' ? storage : null;
  if (store && storageKey) {
    try {
      const raw = store.getItem(storageKey);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && typeof d === 'object') segs = d;
      }
    } catch (e) { /* a corrupt map is an empty map */ }
  }
  return {
    key(routeId, seg) { return `${routeId}|${seg.from}|${seg.to}`; },
    observe(key, obsV, nowMs) {
      const e = segs[key];
      if (!e) segs[key] = { v: obsV, t: nowMs, n: 1 };
      else { e.v = e.v * 0.85 + obsV * 0.15; e.t = nowMs; e.n++; }
      if (store && storageKey && nowMs - saveT > MOTION.SPEEDMAP_SAVE_MS) {
        saveT = nowMs;
        try { store.setItem(storageKey, JSON.stringify(segs)); } catch (err) { /* in-memory only */ }
      }
    },
    /** Force a persist (renderer calls this on dispose / poll). */
    save(nowMs) {
      if (!store || !storageKey) return false;
      saveT = nowMs || Date.now();
      try { store.setItem(storageKey, JSON.stringify(segs)); return true; } catch (e) { return false; }
    },
    get(key, nowMs) {
      const loc = segs[key];
      if (loc && loc.v > 0.2 && (nowMs - loc.t) < MOTION.LOCAL_FRESH_MS) return loc.v;
      return null;
    },
    entries() { return segs; },
  };
}

/**
 * Empirical speed (m/s) for a route segment, or null when unknown.
 * Telemetry timing cells (mature, bucketed) outrank the local map.
 * seg: {from, to} stop-id pair (ids stringified into the key).
 */
export function empiricalSpeedFrom({ timingCells, speedmap, routeId, seg, bucket, nowMs }) {
  if (!seg || seg.from == null || seg.to == null) return null;
  const base = `${routeId}|${seg.from}|${seg.to}`;
  if (timingCells) {
    const cell = timingCells[`${base}|${bucket}`];
    if (cell && cell.n >= 3 && cell.mean_s > 0 && cell.dist_m > 0) {
      return cell.dist_m / cell.mean_s;
    }
  }
  if (speedmap) return speedmap.get(base, nowMs);
  return null;
}

/**
 * L2 baseline — DISABLED, exactly as in the monolith (see header).
 * Leaves depL2/arrL2 null on every trip so every consumer falls
 * back to scheduled times; returns 0 substitutions. Timing cells
 * still load for the motion prior above; no dep/arr offsets are
 * ever produced by this fold.
 */
export function applyEmpiricalBaseline(tt) {
  if (!tt || !Array.isArray(tt.patterns)) return 0;
  for (const pat of tt.patterns) {
    for (const t of pat.trips || []) { t.depL2 = null; t.arrL2 = null; }
  }
  return 0;
}
