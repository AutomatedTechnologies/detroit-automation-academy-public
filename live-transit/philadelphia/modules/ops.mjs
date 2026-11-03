// modules/ops.mjs — R6 CONTRACT: ops hooks (client-visible half).
// PHL REBUILD R1 foundation — interface skeleton. Label:
// UNVERIFIED / legacy-unsigned.
//
// R6 (ops parity) stands up the server-side ops chain; this module
// declares the CLIENT-VISIBLE ops contracts the page itself must
// honour, so R6's verification set has something stable to assert
// against:
//   - Hourly production verification set (LT-KAES-42): page/boot/
//     stamp assertions, every live-data file's freshness, silo/fence
//     assertions. The page side of that contract is: the app
//     exposes its governing BUILD_STAMP and boot state on
//     window.__LT_OPS__ (below), and every published file carries
//     the envelope the data layer validates.
//   - Self-heal independence (LT-KAES-43): the heal dependency is
//     DECLARED, in order, never discovered by failure. The defect
//     case: on 2026-10-23 the PHL heal failed because Detroit's
//     egress forwarder (127.0.0.1:8888) was down and had to be
//     restored first — an ordering discovered by failure. The
//     declared order for the rebuilt chain is recorded here and
//     R6 writes the ensure path to match:
//       1. egress forwarder 127.0.0.1:8888 (shared infrastructure)
//       2. feed-chain timers/units for this city
//       3. watchdog hook verification (verify, never trust timers)
//   - Telemetry (LT-KAES-44, ADAPTABLE): Philadelphia has no
//     consuming surface yet, so production is DEFERRED — R6 files
//     the decision record either way; the deferral is recorded in
//     the R1 design note, not silent. If a consuming surface exists
//     by R6 claim time, R6 builds the product under the fence
//     discipline (agency-direct feeds only — trivially satisfied
//     here: no fenced feed exists, LT-KAES-27 N-A).
//   - Deploy path (LT-KAES-46): same repo, same Pages workflow,
//     explicit allowlist; page changes ride the city stamp
//     sequence (config/stamp.mjs), data commits ride the chain's
//     cadence. No staging sites, no push-triggered hosted builds.

import { BUILD_STAMP } from '../config/stamp.mjs';

export const HEAL_DEPENDENCY_ORDER = Object.freeze([
  'egress-forwarder-127.0.0.1:8888',
  'phl-feed-chain-timers',
  'phl-watchdog-hook-verification',
]);

export const TELEMETRY_STATE = Object.freeze({
  product: 'deferred', // KAES-44 adaptation — no consuming surface yet
  decisionRecordDue: 'R6', // R6 files the decision record either way
});

/** Boot/stamp assertion surface for the hourly verification set. */
export function opsBootReport(state) {
  return {
    stamp: BUILD_STAMP,
    booted: !!(state && state.booted),
    assetsLoaded: !!(state && state.assetsLoaded),
    firstDataAt: (state && state.firstDataAt) || null,
  };
}

/** Install window.__LT_OPS__ (browser only; no-op elsewhere). */
export function installOpsHooks(state) {
  if (typeof window !== 'undefined') {
    window.__LT_OPS__ = Object.freeze(opsBootReport(state));
  }
  return opsBootReport(state);
}
