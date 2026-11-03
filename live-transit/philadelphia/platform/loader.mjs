// platform/loader.mjs — Disciplined asset loading (LT-KAES-05).
// PHL REBUILD R1 foundation. Label: UNVERIFIED / legacy-unsigned.
//
// KAES-05 normative position: a city application loads under ONE
// declared strategy — module scripts with declared imports
// (importmap where a vendored library requires it), feature engines
// as loadable modules, and runtime fetches made `no-store` against
// the governing stamp. Undeclared classic-script sprawl is not a
// conforming load path. (Detroit reference: importmap -> Three.js,
// one ES-module application script, runtime dynamic imports for
// feature engines, ~20 runtime fetches all cache:'no-store'. The
// outgoing PHL build: three classic scripts in document order and
// ad-hoc fetches — the GAP this module replaces.)
//
// THE LOADER CONTRACT (every later tranche builds against this):
//   1. Static code loads ONLY as ES modules with declared imports.
//      The shell's importmap (index.html) is the single declaration
//      of the vendored rendering library (Three.js) for R3.
//   2. Feature engines (planner, Ride Along, live-delay fusion)
//      load ONLY via dynamic import() through loadFeature() below,
//      lazily, on first use of the feature — never as <script> tags.
//   3. EVERY runtime data/asset fetch goes through stampedFetch():
//      cache:'no-store' + the governing BUILD_STAMP appended.
//      No module calls global fetch() directly — the harness greps
//      for it. (LT-KAES-04: the stamp governs every data fetch.)
//   4. A failed load surfaces as a typed LoadError; surfaces render
//      the LT-KAES-40 load-error state from it. Loading never fails
//      silently into a blank map.

import { withStamp } from '../config/stamp.mjs';

export class LoadError extends Error {
  constructor(url, status, message) {
    super(message || `load failed: ${url} (HTTP ${status})`);
    this.name = 'LoadError';
    this.url = url;
    this.status = status;
  }
}

/**
 * The ONLY fetch path for runtime assets/data in the rebuilt
 * client. `fetchImpl` is injectable for harnesses; production
 * callers pass nothing.
 */
export async function stampedFetch(url, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') throw new LoadError(url, 0, 'no fetch implementation available');
  const stamped = withStamp(url);
  const res = await f(stamped, { cache: 'no-store' });
  if (!res.ok) throw new LoadError(url, res.status);
  return res;
}

export async function stampedJson(url, fetchImpl) {
  const res = await stampedFetch(url, fetchImpl);
  return res.json();
}

/**
 * Lazy feature-engine loading (KAES-05/06): feature modules are
 * loadable modules, imported on first use. `specifier` is resolved
 * by the page's module graph; in this scaffold the known features
 * are declared so a typo fails here, not at runtime in production.
 */
export const FEATURE_MODULES = Object.freeze({
  planner: '../modules/planner-host.mjs',
  surfaces: '../modules/surfaces.mjs',
});

export async function loadFeature(name, importImpl) {
  const spec = FEATURE_MODULES[name];
  if (!spec) throw new LoadError(name, 0, `unknown feature module: ${name}`);
  const imp = importImpl || ((s) => import(s));
  return imp(new URL(spec, import.meta.url).href);
}
