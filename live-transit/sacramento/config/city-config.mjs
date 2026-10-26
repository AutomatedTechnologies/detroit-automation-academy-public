// city-config.mjs — The per-city configuration object, as the page's own.
// SACRAMENTO BUILD (Board 54). Label: UNVERIFIED / legacy-unsigned.
//
// This module IS the LT-F5(d) configuration object for Sacramento:
// one object carrying everything city-specific — identity,
// agencies/feeds, layer groups, geometry/stops asset paths, and
// planner policy constants. Every other module consumes
// configuration from here and from nowhere else; no city fact is
// hardcoded in a feature module.
//
// EVERY VALUE CITES ITS SOURCE in a trailing comment. Records of
// truth, in precedence order for this city:
//   [A3]  expansion workspace access-staging/registers/sacramento.md (A3 custody record)
//   [PRD] files/prd (PRD-024)
//   [A2]  files/prd/a2-validation-sacramento-2026-10-22.md
//   [BLD] this build's records (build record 2026-10-26)
// A value with no record behind it is recorded as UNDECIDED / null
// (LT-F6: no invented figures; LT-F7: honest null).

import { BUILD_STAMP } from './stamp.mjs';

export const CITY_CONFIG = Object.freeze({
  // ---- Identity -------------------------------------------------------
  city: Object.freeze({
    slug: 'sacramento', //                                     [LT-F5(d)] city/slug
    name: 'Sacramento', //                                    [PRD §1]
    state: 'CA', //                                            [PRD §1]
    prd: 'PRD-024', //                                         [PRD §1]
    board: 54, // Board 54 "Live Transit — Sacramento"          [PRD §1]
    canonicalPath: '/live-transit/sacramento/', // LT-KAES-01 directory URL
    timezone: 'America/Los_Angeles', // city-local; program records render America/Detroit per LT-D3
  }),

  // ---- Build ----------------------------------------------------------
  build: Object.freeze({
    stamp: BUILD_STAMP, // single governing stamp, defined ONLY in ./stamp.mjs (LT-KAES-04)
    stage: 'sacramento-build-staging', // local only; NOT a production build (launch gate: Board 54 item 7)
  }),

  // ---- Agency & license -------------------------------------------------
  agency: Object.freeze({
    id: 'sacrt',
    name: 'Sacramento Regional Transit District', //           [PRD §2]
    publisherHost: 'apps.sacrt.com', // static portal channel; RT on bustime.sacrt.com [A2/A3]
    // License: SacRT GIS Data Portal GTFS terms, A1 PASS
    // 2026-10-22 — non-exclusive, limited, revocable grant to
    // use, reproduce and redistribute SacRT Data with no
    // computation bar, no derivative-use bar, and no
    // non-commercial restriction; the page presents the static
    // GTFS and the GTFS-RT set together under the same grant.
    // The only commercial restriction attaches to SacRT's
    // trademarks and copyrighted materials, not to the data.  [A3 terms basis]
    licenseVerdict: 'PASS',
    licenseInstrument: 'SacRT GIS Data Portal — GTFS terms (sacrt.com/gtfs/, redirects to sacrt.com/transit-data-portal/)',
    // Branding constraint (LT-F4 surface rule): SacRT trademarks
    // and copyrighted materials may not be used in association
    // with the Data — Sacramento surfaces carry NO SacRT logos
    // or branding; the agency is named in attribution prose
    // only.                                                   [A3 / PRD §5]
    trademarkBar: true,
    // Key posture: KEYLESS end-to-end, confirmed by MEASUREMENT
    // at A2 (all four feeds served complete parseable responses
    // to keyless requests). No credential exists for this city;
    // nothing is stored anywhere; nothing to rotate. Custody
    // record is a recorded no-key state.                      [A3 custody statement]
    keyPosture: 'keyless',
    custodyRecord: 'access-staging/registers/sacramento.md A3 (expansion workspace)',
    excludedSources: Object.freeze([
      // The Mobility Database catalog static URL serves an
      // EXPIRED January_2025 artifact (validity ended
      // 2025-04-05) — never a source for this city; the ingest
      // gate refuses it by construction.               [A2/A3]
      'sacrt.com/wp-content/uploads/google_transit.zip (Mobility Database mdb-2137, inactive)',
    ]),
    // Display-only fence: NONE. The SacRT grant permits use,
    // reproduction and redistribution of the full feed set;
    // no display-only feed exists in this city.               [A3]
    displayOnlyFeeds: Object.freeze([]),
  }),

  // ---- Feeds ------------------------------------------------------------
  feeds: Object.freeze({
    // GTFS static — ONE zip (LT-F5(b) single-feed project), from
    // the agency PORTAL channel only (the catalog trap is a
    // build rule for this city).                              [A3]
    static: Object.freeze([
      Object.freeze({
        id: 'sacrt-static',
        family: 'sacrt',
        url: 'https://apps.sacrt.com/gtfs/srtd/google_transit.zip',
        feedVersion: 'SEP26 GTFS', //                          [build-time re-fetch 2026-10-26]
        validity: Object.freeze({ start: '2026-08-09', end: '2027-01-02' }), // [feed_info.txt]
        bytes: 2661261, //                                     [build-time re-fetch 2026-10-26]
        md5: 'f46cc44b64e01afbb48cbb4e5d85be7b', // build-time re-fetch 2026-10-26 — byte-identical to the A2 artifact: the agency's current vintage is the A2 vintage [BLD]
      }),
    ]),
    // GTFS-RT — three endpoints, one family, collected as three
    // separate legs (LT-D2 fault isolation) on the agency's
    // BusTracker host — the set the portal describes.         [A2 §3]
    realtime: Object.freeze([
      Object.freeze({ id: 'sacrt-vp', family: 'sacrt', kind: 'vehicle-positions',
        url: 'https://bustime.sacrt.com/gtfsrt/vehicles' }),
      Object.freeze({ id: 'sacrt-tu', family: 'sacrt', kind: 'trip-updates',
        url: 'https://bustime.sacrt.com/gtfsrt/trips' }),
      Object.freeze({ id: 'sacrt-sa', family: 'sacrt', kind: 'service-alerts',
        url: 'https://bustime.sacrt.com/gtfsrt/alerts' }),
    ]),
    // Measured realtime facts (design inputs, never assumptions —
    // LT-D2). The three feeds share one generation timestamp per
    // cycle; regeneration ~60-90 s. VP is the LT-N10 population:
    // a substantial descriptor-absent minority (A2: 78-81% with
    // TripDescriptor; build census 2026-10-26: 121/146 = 82.9%
    // descriptor-present, all carrying trip_id, the remainder
    // descriptor-absent in full). TU is 100% TripDescriptor.   [A2 / BLD census]
    measured: Object.freeze({
      vpRegenerationSec: Object.freeze([60, 90]), //           [A2 cadence sample]
      tripDescriptorCoverage: 0.829, // descriptor presence on VP entities, build census 2026-10-26 (121/146); A2: 0.78-0.81 [A2 / BLD]
      tripIdCoverage: 0.829, // trip_id presence on VP entities, build census 2026-10-26 (121/146) [BLD]
    }),
  }),

  // ---- Layer groups (LT-S4.1: groups mirror the city's structure,
  // from configuration; LT-KAES-38: a group defaults ON only by a
  // recorded decision IN CONFIGURATION; a stored rider preference
  // overrides the configured default — LT-KAES-37). Sacramento =
  // one agency, two modes. ---------------------------------------
  layerGroups: Object.freeze([
    // Route census at build: bus 61 routes (type 3) /
    // light rail 3 routes (type 0).                           [BLD gtfs routes.txt]
    Object.freeze({ id: 'bus', label: 'Bus', defaultOn: true, storageKey: 'sac-layer-bus' }),
    Object.freeze({ id: 'rail', label: 'Light Rail', defaultOn: true, storageKey: 'sac-layer-rail' }),
  ]),

  // ---- Geometry & assets (paths relative to the city directory;
  // the build publishes under the same canonical tree, LT-KAES-01).
  assets: Object.freeze({
    // Basemap: TIGER/Line 2025 Sacramento County (06067) ROADS,
    // tiered arrays, 26,594 ways / 62,828 segments, A4 PASS
    // 17/17 (LT-G16); in-extent coverage 100.000% (Placer/Yolo
    // border stops are extent residuals of record).    [PRD §3]
    streets: 'sacramento-streets.json',
    // Route geometry — LT-KAES-12 / LT-G2: one routes-3d per
    // agency feed; Sacramento has exactly one feed. Compiled at
    // build under Pipeline v2 (eps 2.0 m, fold guard severe=0,
    // 64 routes / 158 paths).                                 [BLD geometry-verification.json]
    routesByFeed: Object.freeze({
      sacrt: 'sacrt-routes-3d.json',
    }),
    // Basemap layers beyond streets (LT-KAES-13 complete layer
    // set): water = TIGER/Line 2025 AREAWATER+LINEARWATER
    // (Sacramento 06067 + Placer 06061 + Yolo 06113);
    // landmarks = OSM named building footprints via Overpass
    // (Detroit method); street names = TIGER/Line 2025 ROADS
    // FULLNAME anchors (same counties).                      [BLD]
    water: 'sacramento-water.json',
    landmarks: 'sacramento-landmarks.json',
    streetNames: 'sacramento-street-names.json',
    stops: 'sacrt-stops.json', // 2,822 stop records {id,n,x,z,r} compiled at build [BLD]
    provenanceManifest: 'sacrt-provenance-manifest.json', // 158 path records, LT-G10 field set [BLD]
    // Planner assets (hosted bundle identities): the T6
    // generalized-compiler asset for the build-time-refetched
    // vintage; identity carries the feed version (LT-KAES-28).
    plannerTimetable: 'planner-timetable-SEP26 GTFS.json',
    plannerTimetableMd5: '958451ada1e8c6287467556a47f71a7a', //  [BLD planner compile 2026-10-26]
    plannerStops: 'planner-stops.json',
    // Published live-data family (LT-KAES-21).
    liveData: Object.freeze({
      vehicles: 'data/vehicles.json', // canonical envelope, LT-KAES-24
      alerts: 'data/alerts.json', //     LT-KAES-34 build half
      tripUpdates: 'data/trip-updates.json', // full TU family file, LT-KAES-21
      tripUpdatesDir: 'data/tu/', //     per-route derivative tree, LT-KAES-45 (≤25,000 B per file)
    }),
    // Places dataset (LT-KAES-35 / LT-S9): NO dataset is
    // published for Sacramento — partner inventory is a
    // commercial step and no record may be invented (LT-F6/F7);
    // the layer lazy-fetches this path on first enable and fails
    // honestly ("unavailable") until a dataset exists.        [BLD]
    places: 'data/places.json',
    // Projection origin — measured centroid of all SacRT GTFS
    // stops with coordinates (A4 staging; re-measured identical
    // on the build-time fresh fetch, 2,822 stops). One shared
    // plane per city (Standard S10 / LT-G3).                  [PRD §3]
    projection: Object.freeze({ lat0: 38.582705, lon0: -121.405992 }),
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
      // Sacramento as platform policy — no Sacramento-specific
      // decision was taken or required. Enforcement point:
      // modules/planner-host.mjs.
      walkOnlyPresentation: 'B',
      walkOnlyDecision: Object.freeze({
        id: 'D1',
        branch: 'B',
        rule: 'walk-only presented only when no transit journey exists in the window',
        decidedBy: 'Justin',
        decidedAt: '2026-10-23 23:07 EDT',
        source: 'Detroit shipped planner + PHL rebuild D1 record (files/phl-decommission-2026-10-24.md); platform policy of record for Sacramento',
      }),
    }),
    // Sacramento's calibrated constants — adopted BY MEASUREMENT
    // on Sacramento data (90-configuration sweep, 2026-10-26),
    // never transferred from another city (LT-N8).   [BLD calibration]
    constants: Object.freeze({
      adoptedSet: 'W0-default-T35-P15',
      distanceWeights: Object.freeze({
        corridor: 0.35, walkBurden: 0.2, transferDelta: 0.2,
        modeMix: 0.15, transferStopDisplacement: 0.1,
      }),
      nearDuplicateThreshold: 0.35,
      reliabilityTransferPenaltyMin: 15,
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
      goldenPairs: 'SAC1–SAC10', // G1 corpus; Ruling 5 at 0 s (LT-N11)
    }),
    // Density descriptors — calibration inputs measured from
    // Sacramento's own GTFS (LT-N7; measured at build
    // 2026-10-26, PRD §4).                                 [BLD descriptors]
    density: Object.freeze({
      d1StopsPerKm2: 2.25, // convex-hull service-area basis, 1,253.5 km²
      d1WalkProximityShare: 0.9894,
      d2PairsSharingStop: 0.1314,
      d3HeadwayMediansMin: Object.freeze({ peak: 30, midday: 30, evening: 30, weekend: 45 }),
      d4Top1Share: 0.0, // measure-d4-g3 at build [BLD — set at D4 measurement]
      d4Top3Share: 0.0, // measure-d4-g3 at build [BLD — set at D4 measurement]
    }),
  }),

  // ---- Commercial position (LT-F1) ---------------------------------------
  commercial: Object.freeze({
    ridersPay: false, // Riders never pay. AUTOMATEDTECHNOLOGIES collects, directly. [LT-F1]
    adsOnMap: false, // No ads on the map. Ever. (LT-F2 — per-city, survives configuration)
    // Places per-layer price: NO Sacramento price exists —
    // Justin's per-city decision (LT-S9.3). No figure is
    // invented here; the layer does not wait for the price
    // (LT-KAES-35). Consumer-investment line: a partner invests
    // the (unset) layer price + listing preparation; riders
    // invest nothing (layer is default-off and labeled).       [BLD]
    placesPrice: null,
    placesPriceState: 'UNDECIDED',
  }),

  // ---- Persisted rider state (LT-KAES-37) --------------------------------
  storageKeys: Object.freeze({
    launcherSheet: 'sac-fv-sheet', // first-view sheet state (LT-S1.2 dedicated key)
    panel: 'sac-panel', //            tool-panel geometry
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
