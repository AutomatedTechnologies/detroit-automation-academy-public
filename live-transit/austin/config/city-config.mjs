// city-config.mjs — The per-city configuration object, as the page's own.
// AUSTIN BUILD (Board 53). Label: UNVERIFIED / legacy-unsigned.
//
// This module IS the LT-F5(d) configuration object for Austin:
// one object carrying everything city-specific — identity,
// agencies/feeds, layer groups, geometry/stops asset paths, and
// planner policy constants. Every other module consumes
// configuration from here and from nowhere else; no city fact is
// hardcoded in a feature module.
//
// EVERY VALUE CITES ITS SOURCE in a trailing comment. Records of
// truth, in precedence order for this city:
//   [A3]  expansion workspace files/a3/a3-record-austin-2026-10-22.md
//   [PRD] expansion workspace files/prd/PRD-010-austin.md
//   [A2]  expansion workspace files/prd/a2-validation-austin-2026-10-22.md
//   [BLD] this build's records (build record 2026-10-26)
// A value with no record behind it is recorded as UNDECIDED / null
// (LT-F6: no invented figures; LT-F7: honest null).

import { BUILD_STAMP } from './stamp.mjs';

export const CITY_CONFIG = Object.freeze({
  // ---- Identity -------------------------------------------------------
  city: Object.freeze({
    slug: 'austin', //                                         [LT-F5(d)] city/slug
    name: 'Austin', //                                         [PRD §1]
    state: 'TX', //                                            [PRD §1]
    prd: 'PRD-010', //                                         [PRD §1]
    board: 53, // Board 53 "Live Transit — Austin"             [PRD §1]
    canonicalPath: '/live-transit/austin/', // LT-KAES-01 directory URL
    timezone: 'America/Chicago', // city-local; program records render America/Detroit per LT-D3
  }),

  // ---- Build ----------------------------------------------------------
  build: Object.freeze({
    stamp: BUILD_STAMP, // single governing stamp, defined ONLY in ./stamp.mjs (LT-KAES-04)
    stage: 'austin-build-staging', // local only; NOT a production build (launch gate: Board 53 item 7)
  }),

  // ---- Agency & license -------------------------------------------------
  agency: Object.freeze({
    id: 'capmetro',
    name: 'Capital Metropolitan Transportation Authority', //  [PRD §2]
    publisherHost: 'data.texas.gov', // the agency-designated publication channel: CapMetro's own developer page links developers to the State of Texas Socrata portal for static + realtime (A2); capmetro.org itself 403s the /data/*.pb pattern its documentation shows [A2 §2]
    // License: CapMetro Open Data License Agreement, A1 PASS
    // 2026-10-22 — open-use grant expressly including DERIVATIVE
    // works and computation over the Data, with attribution; one
    // instrument governs static and realtime (the grant attaches
    // to the Socrata-published data per the A3 channelling basis).
    //                                                  [A3 terms basis]
    licenseVerdict: 'PASS',
    licenseInstrument: 'CapMetro Open Data License Agreement (capmetro.org/developertools?terms=gtfs)',
    // Branding constraint (LT-F4 surface rule): the license bars
    // use of CMTA trademarks and logos in association with the
    // Data — Austin surfaces carry NO CapMetro logos or branding
    // and imply no endorsement; the agency is named in
    // attribution prose only.                               [A3 / PRD §5]
    trademarkBar: true,
    // Key posture: KEYLESS end-to-end. No credential exists for
    // this city; nothing is stored anywhere; nothing to rotate.
    // Custody record is FINAL — a recorded no-key state.       [A3 custody statement]
    keyPosture: 'keyless',
    custodyRecord: 'files/a3/a3-record-austin-2026-10-22.md A3 (expansion workspace)',
    excludedSources: Object.freeze([]), // no mirror is cataloged for CapMetro [A3]
    // Display-only fence: NONE. The CapMetro grant covers use,
    // reproduction and redistribution incl. derivatives; no
    // display-only feed exists in this city.                  [A3]
    displayOnlyFeeds: Object.freeze([]),
  }),

  // ---- Feeds ------------------------------------------------------------
  feeds: Object.freeze({
    // GTFS static — ONE zip (LT-F5(b) single-feed project), via
    // the agency-designated Socrata channel.                  [A3]
    static: Object.freeze([
      Object.freeze({
        id: 'capmetro-static',
        family: 'capmetro',
        url: 'https://data.texas.gov/download/r4v4-vz24/application/zip',
        feedVersion: '261007_1345', //                           [build-time re-fetch 2026-10-26]
        validity: Object.freeze({ start: '2026-10-07', end: '2027-01-09' }), // [feed_info.txt]
        bytes: 33283207, //                                      [build-time re-fetch 2026-10-26]
        md5: '2071ad430f107ac2ef2aad2e425dfaed', // build-time re-fetch 2026-10-26 — BYTE-IDENTICAL to the A2 artifact (same vintage served at build time; a current-vintage fetch, not a carried copy) [BLD]
      }),
    ]),
    // Realtime — three endpoints, one family, collected as three
    // separate legs (LT-D2 fault isolation), all served from the
    // A3-recorded Socrata datasets. VP and TU are standard
    // GTFS-RT protobuf. The alerts leg is NOT GTFS-RT in any
    // serialization: it is a Socrata JSON record book, adapted
    // by the pipeline's record-book adapter (ALT-1 class);
    // `format` states the divergence in the open.            [A2 §2 / A3]
    realtime: Object.freeze([
      Object.freeze({ id: 'capmetro-vp', family: 'capmetro', kind: 'vehicle-positions', format: 'gtfs-rt-protobuf',
        url: 'https://data.texas.gov/download/eiei-9rpf/application%2Foctet-stream' }),
      Object.freeze({ id: 'capmetro-tu', family: 'capmetro', kind: 'trip-updates', format: 'gtfs-rt-protobuf',
        url: 'https://data.texas.gov/download/rmk2-acnw/application%2Foctet-stream' }),
      Object.freeze({ id: 'capmetro-sa', family: 'capmetro', kind: 'service-alerts', format: 'json-record-book',
        url: 'https://data.texas.gov/download/9zu9-jwr2/text%2Fplain' }),
    ]),
    // Measured realtime facts (design inputs, never assumptions —
    // LT-D2). ~60 s cycle per envelope; TU header trails VP by
    // ~3-64 s (A2 measured 31-47 s; build samples measured 3 s
    // and 64 s). VP descriptor structure is the LT-N10 population
    // of record: ~63-64% of entities carry a TripDescriptor, and
    // a present descriptor ALWAYS carries a trip_id; the
    // remainder carry no descriptor at all — no start_date-only
    // or route_id fallback population exists in this feed.
    // Alerts book: 146 records at build time (135 at A2).
    //                                                  [A2 / BLD censuses]
    measured: Object.freeze({
      vpRegenerationSec: Object.freeze([55, 65]), //           [A2 cadence sample]
      tripDescriptorCoverage: 0.684, // descriptor presence on VP entities, build live run 2026-10-26 (258/377); A2 baseline 0.63-0.64, freshest-envelope A2 poll 0.681 [A2 / BLD]
      tripIdCoverage: 0.684, // trip_id presence == descriptor presence in this feed (build census 258/377; A2 censuses agree) [A2 / BLD]
    }),
  }),

  // ---- Layer groups (LT-S4.1: groups mirror the city's structure,
  // from configuration; LT-KAES-38: a group defaults ON only by a
  // recorded decision IN CONFIGURATION; a stored rider preference
  // overrides the configured default — LT-KAES-37). Austin =
  // one agency, two modes. ---------------------------------------
  layerGroups: Object.freeze([
    // Route census at build: bus 69 routes (type 3) /
    // rail 1 route (type 0: route 550 Metro Rail Red Line).
    //                                                  [BLD gtfs routes.txt]
    Object.freeze({ id: 'bus', label: 'Bus', defaultOn: true, storageKey: 'aus-layer-bus' }),
    Object.freeze({ id: 'rail', label: 'Rail', defaultOn: true, storageKey: 'aus-layer-rail' }),
  ]),

  // ---- Geometry & assets (paths relative to the city directory;
  // the build publishes under the same canonical tree, LT-KAES-01).
  assets: Object.freeze({
    // Basemap: TIGER/Line 2025, Travis (48453) + Williamson
    // (48491) counties, tiered arrays, 36,702 ways / 114,346
    // segments, A4 PASS 17/17 (LT-G16).                         [PRD §3]
    streets: 'austin-streets.json',
    // Route geometry — LT-KAES-12 / LT-G2: one routes-3d per
    // agency feed; Austin has exactly one feed. Compiled at
    // build under Pipeline v2 (eps 2.0 m, fold guard severe=0;
    // route/path/stop counts in geometry-verification.json).   [BLD]
    routesByFeed: Object.freeze({
      capmetro: 'capmetro-routes-3d.json',
    }),
    // Basemap layers beyond streets (LT-KAES-13 complete layer
    // set): water = TIGER/Line 2025 AREAWATER+LINEARWATER
    // (Travis 48453, Williamson 48491, Hays 48209 — the counties
    // the stop extent touches); landmarks = OSM named building
    // footprints via Overpass (Detroit method); street names =
    // TIGER/Line 2025 ROADS FULLNAME anchors (same counties).   [BLD]
    water: 'austin-water.json',
    landmarks: 'austin-landmarks.json',
    streetNames: 'austin-street-names.json',
    stops: 'capmetro-stops.json', // 2,346 stop records {id,n,x,z,r} compiled at build [BLD]
    provenanceManifest: 'capmetro-provenance-manifest.json', // per-path records, LT-G10 field set [BLD]
    // Planner assets (hosted bundle identities): the T6
    // generalized-compiler asset for the build-time-refetched
    // vintage; identity carries the feed version (LT-KAES-28).
    plannerTimetable: 'planner-timetable-261007_1345.json',
    plannerTimetableMd5: '712c490a2640ccb4f9be59287957bd01', //  [BLD]
    plannerStops: 'planner-stops.json',
    // Published live-data family (LT-KAES-21).
    liveData: Object.freeze({
      vehicles: 'data/vehicles.json', // canonical envelope, LT-KAES-24
      alerts: 'data/alerts.json', //     LT-KAES-34 build half
      tripUpdates: 'data/trip-updates.json', // full TU family file, LT-KAES-21
      tripUpdatesDir: 'data/tu/', //     per-route derivative tree, LT-KAES-45 (≤25,000 B per file)
    }),
    // Places dataset (LT-KAES-35 / LT-S9): NO dataset is
    // published for Austin — partner inventory is a commercial
    // step and no record may be invented (LT-F6/F7); the layer
    // lazy-fetches this path on first enable and fails honestly
    // ("unavailable") until a dataset exists.                 [BLD]
    places: 'data/places.json',
    // Projection origin — measured centroid of all CapMetro GTFS
    // stops with coordinates (build 2026-10-26, all 2,346 stops).
    // One shared plane per city (Standard S10 / LT-G3).         [BLD]
    projection: Object.freeze({ lat0: 30.292504, lon0: -97.737214 }),
  }),

  // ---- Freshness & cadence ---------------------------------------------
  freshness: Object.freeze({
    vehiclePollMs: 60000, // 60 s vehicle poll (LT-S3.1)
    alertsPollMs: 120000, // 120 s alerts poll (LT-S3.1 reference value)
    degradedAfterMs: 900000, // LT-S8.2 staleness threshold (Detroit reference value, platform-adopted)
    watchdogDispatchAgeSec: 420, // VM-held cadence (LT-KAES-18 / LT-D7)
    backstopAgeSec: 1200,
    minDispatchIntervalSec: 300,
  }),

  // ---- Planner policy ----------------------------------------------------
  planner: Object.freeze({
    policy: Object.freeze({
      // D1(b) — the platform policy of record: walk-only is
      // presented ONLY when no transit journey exists in the
      // window. Origin: the shipped Detroit planner; decided by
      // Justin 2026-10-23 23:07 EDT for the rebuilt estate
      // (recorded in the PHL rebuild foundation) and carried to
      // Austin as platform policy — no Austin-specific decision
      // was taken or required. Enforcement point:
      // modules/planner-host.mjs. AUS10 in the golden set is this
      // build's walk-boundary exercise of the policy.
      walkOnlyPresentation: 'B',
      walkOnlyDecision: Object.freeze({
        id: 'D1',
        branch: 'B',
        rule: 'walk-only presented only when no transit journey exists in the window',
        decidedBy: 'Justin',
        decidedAt: '2026-10-23 23:07 EDT',
        source: 'Detroit shipped planner + PHL rebuild D1 record (files/phl-decommission-2026-10-24.md); platform policy of record for Austin',
      }),
    }),
    // Austin's calibrated constants — adopted BY MEASUREMENT on
    // Austin data (90-configuration sweep, 2026-10-26; validation
    // gate passed field-for-field, ruling-5 kills 0), never
    // transferred from another city (LT-N8). Austin's measured
    // winner equals the platform default set.                  [BLD calibration]
    constants: Object.freeze({
      adoptedSet: 'W0-default-T35-P15',
      distanceWeights: Object.freeze({
        corridor: 0.35, walkBurden: 0.2, transferDelta: 0.2,
        modeMix: 0.15, transferStopDisplacement: 0.1,
      }),
      nearDuplicateThreshold: 0.35,
      reliabilityTransferPenaltyMin: 15, // Austin sweep winner (== platform default) [BLD calibration]
      reliabilityHeadwayCapMin: 60, //    platform form constant (LT-N6)
      selectionMode: 'frequency-aware', // Addendum 3 bound is the binding mode
      enumerationCapMin: 120, //          hard enumeration cap (LT-N9)
      flatFloorSec: 1800, //              +30 min flat floor (LT-N9)
    }),
    // Walk model — platform constants (LT-N10).
    walkModel: Object.freeze({
      edgeRadiusM: 400,
      speedMps: 1.4,
      perEdgeFloorSec: 60,
      maxWalkSecsPerRound: 1800, // MAX_WALK_SECS — the cap that keeps a transit planner from degenerating into walking directions
    }),
    // Engine pairing (LT-N12): the set-model engine, hosted
    // byte-identically (KAES-07 anti-fork); the loader pairing
    // guard refuses a "set" asset under an engine without
    // servicesFor().
    engine: Object.freeze({
      serviceModel: 'set',
      requiredExport: 'servicesFor',
      stagedMd5: '6746dfbc3aae7c531e42206478d572da',
      goldenPairs: 'AUS1–AUS10', // G1 corpus; Ruling 5 at 0 s (LT-N11)
    }),
    // Density descriptors — calibration inputs measured from
    // Austin's own GTFS (LT-N7; measured at build 2026-10-26,
    // PRD §4). D1's hull basis is the convex hull of all stop
    // coordinates (1,894.1 km²).                                [BLD descriptors]
    density: Object.freeze({
      d1StopsPerKm2: 1.24, // convex-hull service-area basis, 1,894.1 km²
      d1WalkProximityShare: 0.9787,
      d2PairsSharingStop: 0.2174,
      d3HeadwayMediansMin: Object.freeze({ peak: 30, midday: 30, evening: 30, weekend: 30 }),
      d4Top1Share: 0.5, // measure-d4-g3 at build: 2 transfer events over the golden baseline journeys (thin sample — most golden pairs are direct rides; sample stated in the build record) [BLD]
      d4Top3Share: 1.0, //     measure-d4-g3 at build (same sample) [BLD]
    }),
  }),

  // ---- Commercial position (LT-F1) ---------------------------------------
  commercial: Object.freeze({
    ridersPay: false, // Riders never pay. AUTOMATEDTECHNOLOGIES collects, directly. [LT-F1]
    adsOnMap: false, // No ads on the map. Ever. (LT-F2 — per-city, survives configuration)
    // Places per-layer price: NO Austin price exists — Justin's
    // per-city decision (LT-S9.3). No figure is invented here;
    // the layer does not wait for the price (LT-KAES-35).
    // Consumer-investment line: a partner invests the (unset)
    // layer price + listing preparation; riders invest nothing
    // (layer is default-off and labeled).                      [BLD]
    placesPrice: null,
    placesPriceState: 'UNDECIDED',
  }),

  // ---- Persisted rider state (LT-KAES-37) --------------------------------
  storageKeys: Object.freeze({
    launcherSheet: 'aus-fv-sheet', // first-view sheet state (LT-S1.2 dedicated key)
    panel: 'aus-panel', //            tool-panel geometry
  }),
});

/** Required top-level keys — the harness asserts this exact set exists. */
export const REQUIRED_CONFIG_KEYS = Object.freeze([
  'city', 'build', 'agency', 'feeds', 'layerGroups',
  'assets', 'freshness', 'planner', 'commercial', 'storageKeys',
]);

/** Resolve a layer group's boot state: stored preference wins (KAES-37/38). */
export function layerDefaultOn(group, storedValue) {
  if (storedValue === '0') return false;
  if (storedValue === '1') return true;
  return group.defaultOn === true;
}
