// modules/app.mjs — Main application module (LT-KAES-06).
// PHL REBUILD R1 foundation. Label: UNVERIFIED / legacy-unsigned.
//
// KAES-06: the city client is a MODULE SYSTEM — a main application
// module plus separately loadable feature modules — never a
// single-file script. This module is the main module: it owns boot
// order and wiring, and nothing else. Feature behaviour lives in
// the tranche modules behind their contracts:
//
//   config/city-config.mjs  the LT-F5(d) object (everything city-specific)
//   config/stamp.mjs        the one governing stamp (KAES-04)
//   platform/projector.mjs  shared-platform seam (KAES-07)
//   platform/picking.mjs    interaction geometry (KAES-14 / LT-G14)
//   platform/loader.mjs     the only load/fetch path (KAES-05)
//   modules/data-layer.mjs  R2 contract (published files, classification)
//   modules/renderer.mjs    R3 contract (WebGL 3D, camera, picking)
//   modules/planner-host.mjs R4 contract (engine host, D1(b) point)
//   modules/surfaces.mjs    R5 contract (cards, Ride Along, browse…)
//   modules/ops.mjs         R6 contract (verification hooks, heal order)
//
// Boot sequence (the order is part of the contract):
//   1. read config + assert the constants the boot depends on
//   2. install ops hooks (so even a failed boot is assertable)
//   3. load geometry + stops through the loader (stamped, no-store)
//   4. create the renderer, fit to the basemap extent
//   5. mount surfaces; start the vehicle/alert polls at the
//      configured cadences (config.freshness)
//   6. planner + Ride Along load LAZILY via loadFeature (KAES-05)
// createApp() performs steps 1–2 (the parts R1 owns) and returns
// the wiring context; steps 3–6 run in surfaces.bootBrowser,
// which the browser entry below dynamic-imports (R5 wiring).

import { CITY_CONFIG } from '../config/city-config.mjs';
import { BUILD_STAMP } from '../config/stamp.mjs';
import { installOpsHooks } from './ops.mjs';

export const APP_MODULES = Object.freeze([
  'config', 'data-layer', 'renderer', 'planner-host', 'surfaces', 'ops',
]);

export function createApp() {
  const state = { booted: false, assetsLoaded: false, firstDataAt: null };
  const ctx = {
    config: CITY_CONFIG,
    stamp: BUILD_STAMP,
    state,
    ops: installOpsHooks(state),
  };
  state.booted = true;
  return ctx;
}

// Browser entry: the shell loads this module with type="module".
// Under Node (the harness) nothing auto-boots.
if (typeof document !== 'undefined') {
  const ctx = createApp();
  document.documentElement.dataset.ltStamp = ctx.stamp;
  // R5 wiring: the surfaces boot (renderer + geometry + polls)
  // lives in modules/surfaces.mjs behind the loader's feature
  // path; a boot failure renders the LT-KAES-40 load-error
  // overlay from inside bootBrowser, never a blank map.
  import('./surfaces.mjs')
    .then((S) => S.bootBrowser({ onRetryBoot: () => window.location.reload() }))
    .catch(() => { /* bootBrowser surfaces its own failures */ });
}
