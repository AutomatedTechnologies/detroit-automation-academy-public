// city-config.mjs — The per-city configuration object, as the page's own.
// CINCINNATI BUILD (Board 51). Label: UNVERIFIED / legacy-unsigned.
//
// This module IS the LT-F5(d) configuration object for Cincinnati:
// one object carrying everything city-specific — identity,
// agencies/feeds, layer groups, geometry/stops asset paths, and
// planner policy constants. Every other module consumes
// configuration from here and from nowhere else; no city fact is
// hardcoded in a feature module.
//
// EVERY VALUE CITES ITS SOURCE in a trailing comment. Records of
// truth, in precedence order for this city:
//   [A3]  expansion workspace a3-custody-records-2026-10-23.md §10
//   [PRD] files/PRD-039-cincinnati.md (PRD-039)
//   [A2]  files/prd/a2-validation-cincinnati-2026-10-22.md
//   [BLD] this build's records (build record 2026-10-26)
//   [B65] Board 65 measured baseline (LT-MC classification)
// A value with no record behind it is recorded as UNDECIDED / null
// (LT-F6: no invented figures; LT-F7: honest null).

import { BUILD_STAMP } from './stamp.mjs';

export const CITY_CONFIG = Object.freeze({
  // ---- Identity -------------------------------------------------------
  city: Object.freeze({
    slug: 'cincinnati', //                                     [LT-F5(d)] city/slug
    name: 'Cincinnati', //                                     [PRD §1]
    state: 'OH', //                                            [PRD §1]
    prd: 'PRD-039', //                                         [PRD §1]
    board: 51, // Board 51 "Live Transit — Cincinnati"          [PRD §1]
    canonicalPath: '/live-transit/cincinnati/', // LT-KAES-01 directory URL
    timezone: 'America/New_York', // city-local; program records render America/Detroit per LT-D3
  }),

  // ---- Build ----------------------------------------------------------
  build: Object.freeze({
    stamp: BUILD_STAMP, // single governing stamp, defined ONLY in ./stamp.mjs (LT-KAES-04)
    stage: 'cincinnati-build-staging', // local only; NOT a production build (launch gate: Board 51 item 7)
  }),

  // ---- Agency & license -------------------------------------------------
  agency: Object.freeze({
    id: 'sorta',
    name: 'Southwest Ohio Regional Transit Authority', // [PRD §2]
    publisherHost: 'www.go-metro.com', // agency-direct only  [A3]
    // License: SORTA GTFS Developer License Agreement, A1 PASS
    // 2026-10-22 — use / reproduce / redistribute + modification
    // and combination expressly granted; no purpose or commercial
    // limit stated; revocable by the publisher (retention risk
    // recorded at A1).                                       [A3 terms basis]
    licenseVerdict: 'PASS',
    licenseInstrument: 'SORTA GTFS Developer License Agreement (go-metro.com/about/developer-data)',
    // Branding constraint (LT-F4 surface rule): SORTA/Metro
    // trademarks and copyrighted materials may not be used in
    // association with the Data without written approval —
    // Cincinnati surfaces carry NO SORTA branding or logos and
    // imply no endorsement; the agency is named in attribution
    // prose only.                                             [A3 / PRD §5]
    trademarkBar: true,
    // Key posture: KEYLESS end-to-end. No credential exists for
    // this city; nothing is stored anywhere; nothing to rotate.
    // Custody record is FINAL.                                [A3 custody statement]
    keyPosture: 'keyless',
    custodyRecord: 'a3-custody-records-2026-10-23.md §10 (expansion workspace)',
    excludedSources: Object.freeze([]), // no mirror is cataloged for SORTA [A3]
    // Display-only fence: NONE. The SORTA licence grants
    // computation and redistribution; no display-only feed
    // exists in this city.                                   [A3]
    displayOnlyFeeds: Object.freeze([]),
  }),

  // ---- Feeds ------------------------------------------------------------
  feeds: Object.freeze({
    // GTFS static — ONE zip (LT-F5(b) single-feed city).   [A3]
    static: Object.freeze([
      Object.freeze({
        id: 'sorta-static',
        family: 'sorta',
        // The developer page's GTFS-section link is the pinned
        // source of record; a second, older-generation zip is
        // posted on the same page and is NOT used.        [A2 §2]
        url: 'https://www.go-metro.com/wp-content/uploads/2024/12/google_transit-1.zip',
        feedVersion: 'gtfs_20261004-20261205_20260929', //      [A2 / build-time fetch 2026-10-26]
        validity: Object.freeze({ start: '2026-10-04', end: '2026-12-05' }), // [feed_info.txt]
        bytes: 6766627, //                                     [A2 / build-time fetch]
        md5: '38de391a4735e9b356f30ccf322982a6', // build-time re-fetch 2026-10-26 byte-identical to the A2 artifact [BLD]
      }),
    ]),
    // GTFS-RT — three endpoints, one family, collected as three
    // separate legs (LT-D2 fault isolation). The combined
    // trapezerealtimefeed.pb is a true same-generation union
    // (A2-measured) and is not a source.                   [A2 §3]
    realtime: Object.freeze([
      Object.freeze({ id: 'sorta-vp', family: 'sorta', kind: 'vehicle-positions',
        url: 'https://tmgtfsprd.sorttrpcloud.com/TMGTFSRealTimeWebService/vehicle/vehiclepositions.pb' }),
      Object.freeze({ id: 'sorta-tu', family: 'sorta', kind: 'trip-updates',
        url: 'https://tmgtfsprd.sorttrpcloud.com/TMGTFSRealTimeWebService/tripupdate/tripupdates.pb' }),
      Object.freeze({ id: 'sorta-sa', family: 'sorta', kind: 'service-alerts',
        url: 'https://tmgtfsprd.sorttrpcloud.com/TMGTFSRealTimeWebService/alert/alerts.pb' }),
    ]),
    // Measured realtime facts (design inputs, never assumptions —
    // LT-D2). All four endpoints share one synchronized ~60 s
    // generation cycle; header age at fetch 2–14 s.         [A2]
    measured: Object.freeze({
      vpRegenerationSec: Object.freeze([55, 65]), //           [A2 cadence sample]
      tripDescriptorCoverage: 1.0, // 100% on VP and TU legs, every A2 poll; re-proven at build (191/191, 193/193 TRIP-MATCHED) [A2 / BLD]
    }),
  }),

  // ---- Layer groups (LT-S4.1: groups mirror the city's structure,
  // from configuration; LT-KAES-38: a group defaults ON only by a
  // recorded decision IN CONFIGURATION; a stored rider preference
  // overrides the configured default — LT-KAES-37). Cincinnati =
  // one agency, two modes. ---------------------------------------
  layerGroups: Object.freeze([
    // Route census at build: bus 52 routes (type 3) /
    // streetcar 1 route (type 0, route 100).                   [BLD gtfs routes.txt]
    Object.freeze({ id: 'bus', label: 'Bus', defaultOn: true, storageKey: 'cin-layer-bus' }),
    Object.freeze({ id: 'streetcar', label: 'Streetcar', defaultOn: true, storageKey: 'cin-layer-streetcar' }),
  ]),

  // ---- Geometry & assets (paths relative to the city directory;
  // the build publishes under the same canonical tree, LT-KAES-01).
  assets: Object.freeze({
    // Basemap: TIGER/Line 2025, three OH counties, tiered arrays,
    // 24,282 ways / 77,002 segments, A4 PASS 17/17 (LT-G16).   [PRD §3]
    streets: 'cincinnati-streets.json',
    // Route geometry — LT-KAES-12 / LT-G2: one routes-3d per
    // agency feed; Cincinnati has exactly one feed. Compiled at
    // build under Pipeline v2 (eps 2.0 m, fold guard severe=0,
    // 53 routes / 207 paths).                                  [BLD geometry-verification.json]
    routesByFeed: Object.freeze({
      sorta: 'sorta-routes-3d.json',
    }),
    // Basemap layers beyond streets (LT-KAES-13 complete layer
    // set): water = TIGER/Line 2025 AREAWATER+LINEARWATER (same
    // three counties); landmarks = OSM named building footprints
    // via Overpass (Detroit method); street names = TIGER/Line
    // 2025 ROADS FULLNAME anchors (same shapefiles as A4).     [BLD]
    water: 'cincinnati-water.json',
    landmarks: 'cincinnati-landmarks.json',
    streetNames: 'cincinnati-street-names.json',
    stops: 'sorta-stops.json', // 3,513 stop records {id,n,x,z,r} compiled at build [BLD]
    provenanceManifest: 'sorta-provenance-manifest.json', // 207 path records, LT-G10 field set [BLD]
    // Planner assets (hosted bundle identities): the T6
    // generalized-compiler asset for the build-time-fetched
    // vintage; identity carries the feed version (LT-KAES-28).
    plannerTimetable: 'planner-timetable-gtfs_20261004-20261205_20260929.json',
    plannerTimetableMd5: 'd7e2da4cbd4f7ca0890d97f930e5071e', //  [BLD]
    plannerStops: 'planner-stops.json',
    // Published live-data family (LT-KAES-21).
    liveData: Object.freeze({
      vehicles: 'data/vehicles.json', // canonical envelope, LT-KAES-24
      alerts: 'data/alerts.json', //     LT-KAES-34 build half
      tripUpdates: 'data/trip-updates.json', // full TU family file, LT-KAES-21
      tripUpdatesDir: 'data/tu/', //     per-route derivative tree, LT-KAES-45 (≤25,000 B per file)
    }),
    // Places dataset (LT-KAES-35 / LT-S9): NO dataset is
    // published for Cincinnati — partner inventory is a
    // commercial step and no record may be invented (LT-F6/F7);
    // the layer lazy-fetches this path on first enable and fails
    // honestly ("unavailable") until a dataset exists.         [BLD]
    places: 'data/places.json',
    // Projection origin — measured centroid of all SORTA GTFS
    // stops with coordinates (A4 staging). One shared plane per
    // city (Standard S10 / LT-G3).                             [PRD §3]
    projection: Object.freeze({ lat0: 39.162447, lon0: -84.498704 }),
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
      // Cincinnati as platform policy — no Cincinnati-specific
      // decision was taken or required. Enforcement point:
      // modules/planner-host.mjs.
      walkOnlyPresentation: 'B',
      walkOnlyDecision: Object.freeze({
        id: 'D1',
        branch: 'B',
        rule: 'walk-only presented only when no transit journey exists in the window',
        decidedBy: 'Justin',
        decidedAt: '2026-10-23 23:07 EDT',
        source: 'Detroit shipped planner + PHL rebuild D1 record (files/phl-decommission-2026-10-24.md); platform policy of record for Cincinnati',
      }),
    }),
    // Cincinnati's calibrated constants — adopted BY MEASUREMENT
    // on Cincinnati data (90-configuration sweep, 2026-10-26;
    // validation gate passed field-for-field, ruling-5 kills 0),
    // never transferred from another city (LT-N8).           [BLD calibration]
    constants: Object.freeze({
      adoptedSet: 'W0-default-T35-P10', // winner: weights W0, threshold 0.35, penalty 10 — penalty 10 beat 15/20 on median distinctness cost (258 s vs 451 s) at equal coverage (5 pairs ≥2 archetypes) and equal mean archetypes (1.9) [BLD results-cincinnati-calibration-2026-10-26.json]
      distanceWeights: Object.freeze({
        corridor: 0.35, walkBurden: 0.2, transferDelta: 0.2,
        modeMix: 0.15, transferStopDisplacement: 0.1,
      }),
      nearDuplicateThreshold: 0.35,
      reliabilityTransferPenaltyMin: 10, // Cincinnati-adopted (platform default 15) [BLD calibration]
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
      goldenPairs: 'CIN1–CIN10', // G1 corpus; Ruling 5 at 0 s (LT-N11)
    }),
    // Density descriptors — calibration inputs measured from
    // Cincinnati's own GTFS (LT-N7; measured at build
    // 2026-10-26, PRD §4). D4's sample is the 10-pair golden
    // set's baseline journeys (4 transfer events — small
    // sample, stated in PRD §4).                               [BLD descriptors]
    density: Object.freeze({
      d1StopsPerKm2: 3.35, // convex-hull service-area basis, 1,048.3 km²
      d1WalkProximityShare: 0.9949,
      d2PairsSharingStop: 0.3926,
      d3HeadwayMediansMin: Object.freeze({ peak: 30, midday: 35, evening: 33, weekend: 45 }),
      d4Top1Share: 0.25,
      d4Top3Share: 0.75,
    }),
  }),

  // ---- Commercial position (LT-F1) ---------------------------------------
  commercial: Object.freeze({
    ridersPay: false, // Riders never pay. AUTOMATEDTECHNOLOGIES collects, directly. [LT-F1]
    adsOnMap: false, // No ads on the map. Ever. (LT-F2 — per-city, survives configuration)
    // Places per-layer price: NO Cincinnati price exists —
    // Justin's per-city decision (LT-S9.3). No figure is
    // invented here; the layer does not wait for the price
    // (LT-KAES-35). Consumer-investment line: a partner invests
    // the (unset) layer price + listing preparation; riders
    // invest nothing (layer is default-off and labeled).   [BLD]
    placesPrice: null,
    placesPriceState: 'UNDECIDED',
  }),

  // ---- Persisted rider state (LT-KAES-37) --------------------------------
  storageKeys: Object.freeze({
    launcherSheet: 'cin-fv-sheet', // first-view sheet state (LT-S1.2 dedicated key)
    panel: 'cin-panel', //            tool-panel geometry
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
