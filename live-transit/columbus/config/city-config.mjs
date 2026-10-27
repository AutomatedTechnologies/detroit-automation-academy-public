// city-config.mjs — The per-city configuration object, as the page's own.
// COLUMBUS BUILD (Board 56). Label: UNVERIFIED / legacy-unsigned.
//
// This module IS the LT-F5(d) configuration object for Columbus:
// one object carrying everything city-specific — identity,
// agencies/feeds, layer groups, geometry/stops asset paths, and
// planner policy constants. Every other module consumes
// configuration from here and from nowhere else; no city fact is
// hardcoded in a feature module.
//
// EVERY VALUE CITES ITS SOURCE in a trailing comment. Records of
// truth, in precedence order for this city:
//   [A3]  expansion workspace access-staging/registers/columbus.md (A3 custody record)
//   [PRD] files/prd (PRD-012)
//   [A2]  files/prd/a2-validation-columbus-2026-10-22.md
//   [BLD] this build's records (build record 2026-10-26)
// A value with no record behind it is recorded as UNDECIDED / null
// (LT-F6: no invented figures; LT-F7: honest null).
//
// STATIC-ONLY CITY (charter, LT-F7): COTA publishes NO populated
// GTFS-Realtime VP/TU in any regime. The configuration therefore
// declares the measured-empty live layer as this city's state —
// the page presents the static network, the timetable planner,
// and the populated alerts feed, and labels the vehicle layer
// with the agency's non-publication, never with a live claim.

import { BUILD_STAMP } from './stamp.mjs';

export const CITY_CONFIG = Object.freeze({
  // ---- Identity -------------------------------------------------------
  city: Object.freeze({
    slug: 'columbus', //                                       [LT-F5(d)] city/slug
    name: 'Columbus', //                                       [PRD §1]
    state: 'OH', //                                            [PRD §1]
    prd: 'PRD-012', //                                         [PRD §1]
    board: 56, // Board 56 "Live Transit — Columbus"           [PRD §1]
    canonicalPath: '/live-transit/columbus/', // LT-KAES-01 directory URL
    timezone: 'America/New_York', // city-local; program records render America/Detroit per LT-D3
  }),

  // ---- Build ----------------------------------------------------------
  build: Object.freeze({
    stamp: BUILD_STAMP, // single governing stamp, defined ONLY in ./stamp.mjs (LT-KAES-04)
    stage: 'columbus-build-staging', // local only; NOT a production build (launch gate: Board 56 item 7)
  }),

  // ---- Agency & license -------------------------------------------------
  agency: Object.freeze({
    id: 'cota',
    name: 'Central Ohio Transit Authority', //                 [PRD §2]
    publisherHost: 'www.cota.com', // static on cota.com; RT on realtime.cota.com (TMGTFS) [PRD §2 / A2]
    // License: COTA GTFS Terms of Use + Developer License,
    // A1 PASS 2026-10-22 — the COTA Data page "Terms of
    // Agreement" grants use, reproduction and redistribution
    // of COTA Data with no computation bar; data is provided
    // "as is" and COTA may alter or discontinue it at any time.
    //                                                    [PRD §2]
    licenseVerdict: 'PASS',
    licenseInstrument: 'COTA GTFS Terms of Use + Developer License (cota.com/data, "Terms of Agreement")',
    // Branding constraint (LT-F4 surface rule): the only
    // commercial restriction in the instrument attaches to
    // COTA's trademarks and copyrighted materials — Columbus
    // surfaces carry NO COTA logos or branding; the agency is
    // named in attribution prose only.                    [PRD §2]
    trademarkBar: true,
    // Key posture: KEYLESS, agency-direct. A3 custody complete
    // 2026-10-23; every endpoint returned HTTP 200 keyless on
    // every A2 poll and on the build-time fresh probe. No
    // credential exists for this city.                   [A3 / A2]
    keyPosture: 'keyless',
    custodyRecord: 'access-staging/registers/columbus.md A3 (expansion workspace)',
    excludedSources: Object.freeze([]), // none recorded for this city [A3]
    // Display-only fence: NONE. The COTA grant permits use,
    // reproduction and redistribution of the full feed set; no
    // display-only feed exists in this city.               [PRD §6]
    displayOnlyFeeds: Object.freeze([]),
  }),

  // ---- Feeds ------------------------------------------------------------
  feeds: Object.freeze({
    // GTFS static — ONE zip (LT-F5(b) single-feed project), from
    // the agency-designated channel (COTA Data page).    [PRD §2]
    static: Object.freeze([
      Object.freeze({
        id: 'cota-static',
        family: 'cota',
        url: 'http://www.cota.com/data/cota.gtfs.zip',
        feedVersion: '2026-SEP-07-BB_20260924', //             [build-time fresh fetch 2026-10-26]
        validity: Object.freeze({ start: '2026-09-07', end: '2027-01-03' }), // [feed_info.txt]
        bytes: 4013293, //                                     [build-time fresh fetch 2026-10-26]
        md5: '8cef70976a7302fbeea6d760ea8a3b5d', // build-time fresh fetch — byte-identical to the A2 artifact: the agency's current vintage is the A2 vintage [BLD]
      }),
    ]),
    // GTFS-RT — three endpoints, one family, collected as three
    // separate legs (LT-D2 fault isolation) on the agency's
    // TMGTFS host, all keyless.                          [A2]
    realtime: Object.freeze([
      Object.freeze({ id: 'cota-vp', family: 'cota', kind: 'vehicle-positions',
        url: 'http://realtime.cota.com/TMGTFSRealTimeWebService/Vehicle/VehiclePositions.pb' }),
      Object.freeze({ id: 'cota-tu', family: 'cota', kind: 'trip-updates',
        url: 'http://realtime.cota.com/TMGTFSRealTimeWebService/TripUpdate/TripUpdates.pb' }),
      Object.freeze({ id: 'cota-sa', family: 'cota', kind: 'service-alerts',
        url: 'http://realtime.cota.com/TMGTFSRealTimeWebService/Alert/Alerts.pb' }),
    ]),
    // Measured realtime facts (design inputs, never assumptions —
    // LT-D2). VP and TU serve 13-byte header-only envelopes —
    // valid GTFS-RT 2.0, ZERO entities — in every sampled
    // regime: A2 evening, overnight, and true peak samples,
    // with headers advancing exactly +60 s per poll and header
    // age 14–19 s; the alerts leg served 6 current alerts in
    // the same minutes. The build cycles (2026-10-26)
    // re-measured the identical state (VP 13 B / TU 13 B /
    // alerts populated, 6). TripDescriptor coverage is
    // therefore 0 of 0 — recorded UNMEASURED, never a 0% rate
    // (charter constraint 1 / LT-F7).           [A2 / BLD cycles]
    measured: Object.freeze({
      headerAdvanceSec: 60, // header timestamps advance +60 s per poll [A2 cadence sample]
      vpEntities: 0, // zero-entity header-only envelopes, all regimes [A2 / BLD]
      tuEntities: 0, // zero-entity header-only envelopes, all regimes [A2 / BLD]
      tripDescriptorCoverage: null, // UNMEASURED — 0 of 0; no rate exists [LT-F7]
    }),
  }),

  // ---- Layer groups (LT-S4.1: groups mirror the city's structure,
  // from configuration; LT-KAES-38: a group defaults ON only by a
  // recorded decision IN CONFIGURATION; a stored rider preference
  // overrides the configured default — LT-KAES-37). Columbus =
  // one agency, one mode: all 43 routes are type-3 bus in this
  // vintage (3 published routes — 152 AirConnect, 201/202
  // SmartRide New Albany — carry no trips in the window).  [BLD gtfs]
  layerGroups: Object.freeze([
    Object.freeze({ id: 'bus', label: 'Bus', defaultOn: true, storageKey: 'cb-layer-bus' }),
  ]),

  // ---- Geometry & assets (paths relative to the city directory;
  // the build publishes under the same canonical tree, LT-KAES-01).
  assets: Object.freeze({
    // Basemap: TIGER/Line 2025 ROADS, Franklin (39049) +
    // Delaware (39041) counties, tiered arrays, 28,799 ways /
    // 74,622 segments, A4 format check PASS 17/17 (LT-G16);
    // in-extent stop coverage 100.000% (2,974/2,974; the 3
    // Licking County campus stops are the recorded A4 residual
    // and sit at the staged extent edge).                [A4 record]
    streets: 'columbus-streets.json',
    // Route geometry — LT-KAES-12 / LT-G2: one routes-3d per
    // agency feed; Columbus has exactly one feed. Compiled at
    // build under Pipeline v2 (eps 2.0 m, fold guard severe=0,
    // 43 routes / 141 paths).                             [BLD geometry-verification.json]
    routesByFeed: Object.freeze({
      cota: 'cota-routes-3d.json',
    }),
    // Basemap layers beyond streets (LT-KAES-13 complete layer
    // set): water = TIGER/Line 2025 AREAWATER+LINEARWATER
    // (Franklin 39049 + Delaware 39041; FIPS verified on named
    // features — Scioto River, Olentangy River present in
    // 39049 in both files); landmarks = OSM named building
    // footprints via Overpass (Detroit method), downtown core;
    // street names = TIGER/Line 2025 ROADS FULLNAME anchors
    // (39049 + 39041).                                      [BLD]
    water: 'columbus-water.json',
    landmarks: 'columbus-landmarks.json',
    streetNames: 'columbus-street-names.json',
    stops: 'cota-stops.json', // 2,977 stop records {id,n,x,z,r} compiled at build [BLD]
    provenanceManifest: 'cota-provenance-manifest.json', // 141 per-path records, LT-G10 field set [BLD]
    // Planner assets (hosted bundle identities): the T6
    // generalized-compiler asset for the build-time-fetched
    // vintage; identity carries the feed version (LT-KAES-28).
    plannerTimetable: 'planner-timetable-2026-SEP-07-BB_20260924.json',
    plannerTimetableMd5: '12d6aa91a04d6a1c5955faaa7583d194', //        [BLD planner compile 2026-10-26]
    plannerStops: 'planner-stops.json',
    // Published live-data family (LT-KAES-21). For this
    // static-only city the family carries the measured state:
    // vehicles/trip-updates envelopes at count 0 with per-source
    // ok state (the agency's empty publication, LT-F7) and the
    // populated alerts envelope.
    liveData: Object.freeze({
      vehicles: 'data/vehicles.json', // canonical envelope, LT-KAES-24
      alerts: 'data/alerts.json', //     LT-KAES-34 build half
      tripUpdates: 'data/trip-updates.json', // full TU family file, LT-KAES-21
      tripUpdatesDir: 'data/tu/', //     per-route derivative tree, LT-KAES-45 (≤25,000 B per file)
    }),
    // Places dataset (LT-KAES-35 / LT-S9): NO dataset is
    // published for Columbus — partner inventory is a
    // commercial step and no record may be invented (LT-F6/F7);
    // the layer lazy-fetches this path on first enable and fails
    // honestly ("unavailable") until a dataset exists.        [BLD]
    places: 'data/places.json',
    // Projection origin — measured centroid of all COTA GTFS
    // stops with coordinates (A4 staging; re-measured identical
    // on the build-time fresh fetch, 2,977 stops). One shared
    // plane per city (Standard S10 / LT-G3).                  [A4 record]
    projection: Object.freeze({ lat0: 39.991108, lon0: -82.988116 }),
  }),

  // ---- Freshness & cadence ---------------------------------------------
  // Platform values. NOTE: no standing publish chain is armed
  // for this static-only city in this build — the launch tranche
  // files the chain disposition; the page-side constants govern
  // how the published family is read whenever it is served.
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
      // Columbus as platform policy — no Columbus-specific
      // decision was taken or required. Enforcement point:
      // modules/planner-host.mjs.
      walkOnlyPresentation: 'B',
      walkOnlyDecision: Object.freeze({
        id: 'D1',
        branch: 'B',
        rule: 'walk-only presented only when no transit journey exists in the window',
        decidedBy: 'Justin',
        decidedAt: '2026-10-23 23:07 EDT',
        source: 'Detroit shipped planner + PHL rebuild D1 record (files/phl-decommission-2026-10-24.md); platform policy of record for Columbus',
      }),
    }),
    // Columbus's calibrated constants — adopted BY MEASUREMENT
    // on Columbus data (90-configuration sweep, 2026-10-26),
    // never transferred from another city (LT-N8).   [BLD calibration]
    constants: Object.freeze({
      adoptedSet: 'W0-default-T35-P15', // Columbus's own 90-configuration sweep winner 2026-10-26 (ruling-5 kills 0)
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
      goldenPairs: 'CB1–CB10', // G1 corpus; Ruling 5 at 0 s (LT-N11)
    }),
    // Density descriptors — calibration inputs measured from
    // Columbus's own GTFS (LT-N7; measured at build
    // 2026-10-26).                                       [BLD descriptors]
    density: Object.freeze({
      d1StopsPerKm2: 3.06, // convex-hull service-area basis, 971.4 km²
      d1WalkProximityShare: 0.9966,
      d2PairsSharingStop: 0.6192,
      d3HeadwayMediansMin: Object.freeze({ peak: 30, midday: 30, evening: 30, weekend: 60 }),
      d4Top1Share: 0.2857, // measure-d4-g3 at build — THIN sample: 7 transfer events across 14 baseline journeys
      d4Top3Share: 0.5714, // same thin sample
    }),
  }),

  // ---- Commercial position (LT-F1) ---------------------------------------
  commercial: Object.freeze({
    ridersPay: false, // Riders never pay. AUTOMATEDTECHNOLOGIES collects, directly. [LT-F1]
    adsOnMap: false, // No ads on the map. Ever. (LT-F2 — per-city, survives configuration)
    // Places per-layer price: NO Columbus price exists —
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
    launcherSheet: 'cb-fv-sheet', // first-view sheet state (LT-S1.2 dedicated key)
    panel: 'cb-panel', //            tool-panel geometry
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
