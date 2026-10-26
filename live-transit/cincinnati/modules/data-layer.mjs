// modules/data-layer.mjs — data layer (client side).
// R1 foundation contract; R2 implementation landed 2026-10-24
// (loaders + classification below; the server pipeline lives in
// ../pipeline/). Label: UNVERIFIED / legacy-unsigned.
//
// R2 (data pipeline) implements the collector/publisher chain
// (LT-KAES-08 shared wire code, LT-KAES-19 raw-bundle/transform
// separation, LT-KAES-16 complete leg set, LT-KAES-20 fault
// isolation, LT-KAES-18 cadence as adapted). THIS module is the
// client-side half of that contract: the published-file shapes the
// page consumes, and the loaders that consume them. The collector
// itself is server-side R2 work and never ships to the page.
//
// Published contracts R2 must produce and this layer consumes:
//   vehicles — canonical envelope (LT-KAES-24):
//     { generated_at, count, vehicles[], sources{} } with records
//     { agency, route_id, vehicle_id, lat, lon, bearing, speed_mph,
//       destination, updated_at }; a field the source does not
//     carry renders ABSENT (LT-F7) — never dropped from the schema,
//     never synthesized. (Outgoing envelope {city, fetched_at,
//     feeds{}} with records {entity, route, trip, label, lat, lon,
//     bearing, ts} is the GAP being replaced.)
//   alerts — { generated_at, alerts[] }; generated_at advances only
//     on real re-collection under the bulletin sub-cadence
//     (LT-KAES-34 build half / LT-S8.1).
//   per-route trip-update derivatives under data/tu/, each
//     <= 25,000 B, index-verified (LT-KAES-45).
//   per-source state in the vehicles envelope: sources.{bus,rail}
//     each { ok, ...batch counters } — a failed leg is VISIBLE in
//     the product, never silent (LT-KAES-20 / RC7).
//
// Client behaviours fixed here as contract:
//   - Trip-matching classification runs before any live surface
//     (LT-KAES-25 / LT-N10): every record classifies TRIP-MATCHED,
//     ROUTE-MATCHED (surfaced, never silently dropped), or
//     UNASSIGNED (verified descriptor-less). A LIVE-EMPTY feed
//     composes as UNMEASURED with feed state attached (LT-F7).
//   - Unresolved-route records draw no marker, are not counted,
//     are not pickable (RC8) — enforced by the renderer from the
//     classification, not re-decided per surface.
//   - Display separation (LT-KAES-23, ADAPTABLE): split points
//     follow this city's feed structure — bus and rail stay
//     separate through storage and computation and join only at
//     render (LT-F5(b)). Philadelphia has NO display-only feed
//     (LT-KAES-27 N-A), so no fence split exists here.

import { CITY_CONFIG } from '../config/city-config.mjs';
import { stampedJson } from '../platform/loader.mjs';

export const VEHICLE_RECORD_FIELDS = Object.freeze([
  'agency', 'route_id', 'vehicle_id', 'lat', 'lon',
  'bearing', 'speed_mph', 'destination', 'updated_at',
]);

export const CLASSIFICATION = Object.freeze({
  TRIP_MATCHED: 'TRIP-MATCHED',
  ROUTE_MATCHED: 'ROUTE-MATCHED',
  UNASSIGNED: 'UNASSIGNED',
});

/** Validate a published vehicles document against KAES-24. Pure. */
export function validateVehicleEnvelope(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object') return ['envelope is not an object'];
  if (typeof doc.generated_at !== 'string') problems.push('missing generated_at');
  if (!Array.isArray(doc.vehicles)) problems.push('vehicles is not an array');
  if (typeof doc.count !== 'number') problems.push('missing numeric count');
  if (Array.isArray(doc.vehicles) && typeof doc.count === 'number'
      && doc.count !== doc.vehicles.length) {
    problems.push(`count ${doc.count} != vehicles.length ${doc.vehicles.length}`);
  }
  if (!doc.sources || typeof doc.sources !== 'object') {
    problems.push('missing sources{} per-source state (KAES-20)');
  } else {
    for (const family of ['bus', 'rail']) {
      const s = doc.sources[family];
      if (!s || typeof s.ok !== 'boolean') problems.push(`sources.${family}.ok missing/not boolean`);
    }
  }
  return problems;
}

/** Validate a published alerts document (KAES-34 build half). Pure. */
export function validateAlertsEnvelope(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object') return ['alerts envelope is not an object'];
  if (typeof doc.generated_at !== 'string') problems.push('missing generated_at');
  if (!Array.isArray(doc.alerts)) problems.push('alerts is not an array');
  return problems;
}

// ---- R2 implementation (PHL REBUILD R2, 2026-10-24) ----
// The loaders consume exactly the published family the R2 server
// pipeline (../pipeline/) produces. Classification is computed
// server-side against the static trip/route sets and carried on
// each record; classifyRecords below is the client-side form of
// the same rule, applied to any record that arrives without a
// classification (and used by harnesses to re-derive counts).

/** Validate a published trip-updates document. Pure. */
export function validateTripUpdatesEnvelope(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object') return ['trip-updates envelope is not an object'];
  if (typeof doc.generated_at !== 'string') problems.push('missing generated_at');
  if (!Array.isArray(doc.trip_updates)) problems.push('trip_updates is not an array');
  if (typeof doc.count !== 'number') problems.push('missing numeric count');
  if (Array.isArray(doc.trip_updates) && typeof doc.count === 'number'
      && doc.count !== doc.trip_updates.length) {
    problems.push(`count ${doc.count} != trip_updates.length ${doc.trip_updates.length}`);
  }
  if (!doc.sources || typeof doc.sources !== 'object') {
    problems.push('missing sources{} per-source state (KAES-20)');
  } else {
    for (const family of ['bus', 'rail']) {
      const s = doc.sources[family];
      if (!s || typeof s.ok !== 'boolean') problems.push(`sources.${family}.ok missing/not boolean`);
    }
  }
  return problems;
}

/** Poll the canonical vehicles file on the configured cadence. */
export async function pollVehicles(fetchImpl) {
  const doc = await stampedJson(CITY_CONFIG.assets.liveData.vehicles, fetchImpl);
  const problems = validateVehicleEnvelope(doc);
  if (problems.length) {
    throw new Error(`vehicles envelope failed KAES-24 validation: ${problems.join('; ')}`);
  }
  return doc;
}

/** Poll the alerts file. R2 collection; R5 renders. */
export async function pollAlerts(fetchImpl) {
  const doc = await stampedJson(CITY_CONFIG.assets.liveData.alerts, fetchImpl);
  const problems = validateAlertsEnvelope(doc);
  if (problems.length) {
    throw new Error(`alerts envelope failed KAES-34 validation: ${problems.join('; ')}`);
  }
  return doc;
}

/** Poll the full trip-updates file (R5 consumer loader: stop-card
 *  arrivals + Ride Along times consume it through the same
 *  validated path as vehicles/alerts). */
export async function pollTripUpdates(fetchImpl) {
  const doc = await stampedJson(CITY_CONFIG.assets.liveData.tripUpdates, fetchImpl);
  const problems = validateTripUpdatesEnvelope(doc);
  if (problems.length) {
    throw new Error(`trip-updates envelope failed KAES-21 validation: ${problems.join('; ')}`);
  }
  return doc;
}

/**
 * Classify live records before any surface consumes them
 * (LT-KAES-25 / LT-N10). A record the pipeline already classified
 * keeps its classification; an unclassified record classifies by
 * the §5 rule on the fields it carries: trip_id present ->
 * TRIP-MATCHED, route_id present -> ROUTE-MATCHED, neither ->
 * UNASSIGNED (verified descriptor-less). Returns the records with
 * `classification` set plus reconciling counts; the counts always
 * sum to records.length.
 */
export function classifyRecords(records) {
  const counts = {
    [CLASSIFICATION.TRIP_MATCHED]: 0,
    [CLASSIFICATION.ROUTE_MATCHED]: 0,
    [CLASSIFICATION.UNASSIGNED]: 0,
  };
  const out = (records || []).map((r) => {
    let c = r.classification;
    if (!Object.values(CLASSIFICATION).includes(c)) {
      if (r.trip_id) c = CLASSIFICATION.TRIP_MATCHED;
      else if (r.route_id) c = CLASSIFICATION.ROUTE_MATCHED;
      else c = CLASSIFICATION.UNASSIGNED;
    }
    counts[c] += 1;
    return { ...r, classification: c };
  });
  return { records: out, counts, total: out.length };
}

/** The live-data paths this layer consumes — from config, only. */
export function liveDataPaths() {
  return CITY_CONFIG.assets.liveData;
}

export { stampedJson as _stampedJson }; // loader path is the only fetch path (KAES-05)
