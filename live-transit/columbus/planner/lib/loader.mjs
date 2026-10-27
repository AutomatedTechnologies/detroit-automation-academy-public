// Loader pairing guard — Philadelphia planner integration staging
// (Board 48 item 6, integration step 2026-10-23).
//
// The pairing rule (engine-generalization design §1.3 + the Detroit
// cutover package's step 1, applied here at staging): an asset whose
// meta declares service_model "set" MUST be planned by an engine
// exposing servicesFor(). Under a legacy engine the same asset would
// silently plan only a subset of concurrent services — the failure
// the set model exists to remove. This loader refuses that pairing
// loudly, before any planning happens. A legacy (unmarked) asset
// under the set engine is permitted: on Detroit-shaped data the set
// resolver returns exactly the legacy pick on every date (proven by
// the 308-cell audit, consolidation G3).
//
// LOCAL/STAGING ONLY. Nothing here is deployed; the production
// loader change for Detroit is step 1 of the gated cutover package
// (Board 47 item 7), a separate decision.

export class PairingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PairingError';
    this.code = 'ASSET_ENGINE_PAIRING';
  }
}

export function assertPairing(engineModule, assetMeta) {
  const model = assetMeta && assetMeta.service_model;
  if (model === 'set' && typeof engineModule.servicesFor !== 'function') {
    throw new PairingError(
      'asset declares service_model "set" but the loaded engine exposes no servicesFor(); ' +
        'refusing to plan a subset of concurrent services'
    );
  }
  return { serviceModel: model || 'legacy', paired: true };
}

// Load an asset through the engine's own loadTimetable, after the
// pairing check. The meta is read first (a HEAD-like fetch of the
// asset JSON) so a mispairing fails before the engine indexes
// anything. `fetchImpl` defaults to the global fetch (the harness
// shims it in Node; the browser uses its own).
export async function loadPlannerAsset(engineModule, url, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  const res = await f(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('timetable fetch failed: HTTP ' + res.status);
  const data = await res.json();
  const pairing = assertPairing(engineModule, data.meta);
  const tt = await engineModule.loadTimetable(url);
  return { tt, meta: data.meta, pairing };
}
