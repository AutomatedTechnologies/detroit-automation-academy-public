// stamp.mjs — Unified build stamp governance (LT-KAES-04).
// PHL REBUILD R1 foundation. Label: UNVERIFIED / legacy-unsigned.
//
// KAES-04 normative position: ONE build stamp governs a city
// application — it appears as a constant in the app, is echoed in
// every versioned asset reference, and governs every data fetch the
// page makes; any change to a stamped asset bumps the stamp
// atomically in the same deploy. (Detroit reference: a single
// STAMP constant governs every ?v= and every asset/data fetch.
// The outgoing PHL build violated this: a short per-city sequence
// stamped only phl.js and no stamp governed its data fetches.)
//
// THIS FILE IS THE ONLY PLACE THE STAMP VALUE IS DEFINED.
// Every other module imports BUILD_STAMP from here; the shell page
// (index.html) echoes the same literal in its local ?v= references,
// and harness/verify-foundation.mjs fails if the two drift, if any
// other module hardcodes a stamp literal, or if any local asset
// reference in the shell carries a different stamp.
//
// The R1 value is a LOCAL SCAFFOLD stamp. It is not a production
// stamp and must never be served: the rebuilt product ships on
// Justin's word at certification-readiness, and the shipping
// tranche assigns the production stamp in the city's sequence at
// that time (LT-KAES-46 / LT-P1 ritual).

export const BUILD_STAMP = '20261025-2101';

/** Append the governing stamp to a same-origin asset/data URL. */
export function withStamp(url) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}v=${BUILD_STAMP}`;
}

/**
 * Estate shared-asset stamps (LT-KAES-03 — Estate Chrome Currency).
 * These are NOT the city build stamp: shared estate assets carry
 * their own stamps, and a city page must pin the CURRENT ones.
 * Values are the current stamps measured from served Detroit bytes
 * in the 2026-10-23 architectural comparison (§1 item 3 / KAES-03
 * reference position). The outgoing PHL page pinned the stylesheet
 * at the stale stamp 20261018-1404 — that is the defect this table
 * exists to prevent. When an estate stamp moves, LT-P1(4) requires
 * the bump to ship site-wide in the same deploy; this table and
 * index.html move together, and the harness checks they agree.
 */
export const ESTATE_STAMPS = Object.freeze({
  stylesheet: '20261019-1228', // /styles.css — Detroit app reference stamp
  nav: '20261023-0221', //        /nav.js
  measure: '20261023-o2', //      /assets/measure.js
});

/**
 * Estate scripts the reference application does NOT load
 * (LT-KAES-03: a city never loads an estate script the reference
 * application does not load, without a recorded reason). The
 * outgoing PHL page loaded /script.js; Detroit's app does not.
 * The harness asserts the shell contains none of these.
 */
export const FORBIDDEN_ESTATE_SCRIPTS = Object.freeze(['/script.js']);
