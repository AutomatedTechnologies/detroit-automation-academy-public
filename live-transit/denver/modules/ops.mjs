// modules/ops.mjs — R6 CONTRACT: ops hooks (client-visible half).
// Core module (Cities V2). Label: UNVERIFIED / legacy-unsigned.
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
//     DECLARED, in order, never discovered by failure. (The defect
//     case of record, 2026-10-23: a city heal failed because
//     Detroit's egress forwarder (127.0.0.1:8888) was down and had
//     to be restored first — an ordering discovered by failure.)
//     The declared order's SHAPE is platform truth and lives here;
//     the per-city unit names are config data (ops.chainUnits,
//     CV2-D13) — a chainless (static-only) city declares nulls and
//     its order is the forwarder leg alone.
//   - Telemetry (LT-KAES-44, ADAPTABLE): each city's telemetry
//     state is its own config record (ops.telemetry, CV2-D13),
//     never an inherited sentence. A deferral is recorded in the
//     city's config, not silent.
//   - Deploy path (LT-KAES-46): same repo, same Pages workflow,
//     explicit allowlist; page changes ride the city stamp
//     sequence (config/stamp.mjs), data commits ride the chain's
//     cadence. No staging sites, no push-triggered hosted builds.

import { BUILD_STAMP } from '../config/stamp.mjs';
import { CITY_CONFIG } from '../config/city-config.mjs';

export const HEAL_DEPENDENCY_ORDER = Object.freeze([
  'egress-forwarder-127.0.0.1:8888',
  ...(CITY_CONFIG.ops.chainUnits.cityTimerUnit ? [CITY_CONFIG.ops.chainUnits.cityTimerUnit] : []),
  ...(CITY_CONFIG.ops.chainUnits.watchdogHook ? [CITY_CONFIG.ops.chainUnits.watchdogHook] : []),
]);

export const TELEMETRY_STATE = Object.freeze({
  product: CITY_CONFIG.ops.telemetry.state, // KAES-44 state, per-city (OPS-2)
  decisionRecordDue: CITY_CONFIG.ops.telemetry.decisionRecord,
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
