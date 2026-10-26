// city-config.mjs — The per-city configuration object, as the page's own.
// DENVER/AURORA BUILD (Board 52). Label: UNVERIFIED / legacy-unsigned.
//
// This module IS the LT-F5(d) configuration object for Denver/Aurora:
// one object carrying everything city-specific — identity,
// agencies/feeds, layer groups, geometry/stops asset paths, and
// planner policy constants. Every other module consumes
// configuration from here and from nowhere else; no city fact is
// hardcoded in a feature module.
//
// Denver and Aurora are ONE project (PRD-015 §9): one RTD feed set,
// one configuration, joint figures throughout. Nothing in this file
// splits the two cities.
//
// EVERY VALUE CITES ITS SOURCE in a trailing comment. Records of
// truth, in precedence order for this city:
//   [A3]  expansion workspace access-staging/registers/denver.md (A3 custody record)
//   [PRD] files/prd (PRD-015; Aurora at PRD-015 §9 / PRD-032)
//   [A2]  files/prd/a2-validation-denver-2026-10-22.md
//   [BLD] this build's records (build record 2026-10-26)
//   [B65] Board 65 measured baseline (LT-MC classification)
// A value with no record behind it is recorded as UNDECIDED / null
// (LT-F6: no invented figures; LT-F7: honest null).

import { BUILD_STAMP } from './stamp.mjs';

export const CITY_CONFIG = Object.freeze({
  // ---- Identity -------------------------------------------------------
  city: Object.freeze({
    slug: 'denver', //                                         [LT-F5(d)] city/slug
    name: 'Denver & Aurora', //                                [PRD §1/§9]
    state: 'CO', //                                            [PRD §1]
    prd: 'PRD-015', //                                         [PRD §1]
    board: 52, // Board 52 "Live Transit — Denver/Aurora"       [PRD §1]
    canonicalPath: '/live-transit/denver/', // LT-KAES-01 directory URL
    timezone: 'America/Denver', // city-local; program records render America/Detroit per LT-D3
  }),

  // ---- Build ----------------------------------------------------------
  build: Object.freeze({
    stamp: BUILD_STAMP, // single governing stamp, defined ONLY in ./stamp.mjs (LT-KAES-04)
    stage: 'denver-build-staging', // local only; NOT a production build (launch gate: Board 52 item 7)
  }),

  // ---- Agency & license -------------------------------------------------
  agency: Object.freeze({
    id: 'rtd',
    name: 'Regional Transportation District', //               [PRD §2]
    publisherHost: 'open-data.rtd-denver.com', // canonical host; the www host's RT redirector 404s [A2/A3]
    // License: RTD GTFS Realtime License Agreement, A1 PASS
    // 2026-10-22 — §3 grants use, reproduction and redistribution
    // of the Data with no computation bar and no non-commercial
    // restriction on the data; one instrument governs both the
    // static and realtime legs (A2 scope note CLOSED 2026-10-22).
    // The commercial restrictions attach to RTD's trademarks and
    // copyrighted materials, not to the data (§4/§8).          [A3 terms basis]
    licenseVerdict: 'PASS',
    licenseInstrument: 'RTD GTFS Realtime License Agreement (rtd-denver.com/open-records/open-spatial-information/gtfs-realtime-license-agreement)',
    // Branding constraint (LT-F4 surface rule): RTD trademarks
    // and copyrighted materials may not be used in association
    // with the Data (§4); linking must not imply RTD sponsorship
    // or endorsement (§8) — Denver surfaces carry NO RTD logos
    // or branding and imply no endorsement; the agency is named
    // in attribution prose only.                               [A3 / PRD §5]
    trademarkBar: true,
    // Key posture: KEYLESS end-to-end. No credential exists for
    // this city; nothing is stored anywhere; nothing to rotate.
    // Custody record is FINAL — a recorded no-key state.       [A3 custody statement]
    keyPosture: 'keyless',
    custodyRecord: 'access-staging/registers/denver.md A3 (expansion workspace)',
    excludedSources: Object.freeze([]), // no mirror is cataloged for RTD [A3]
    // Display-only fence: NONE. The RTD licence grants use,
    // reproduction and redistribution; no display-only feed
    // exists in this city.                                     [A3]
    displayOnlyFeeds: Object.freeze([]),
  }),

  // ---- Feeds ------------------------------------------------------------
  feeds: Object.freeze({
    // GTFS static — ONE zip (LT-F5(b) single-feed project).    [A3]
    static: Object.freeze([
      Object.freeze({
        id: 'rtd-static',
        family: 'rtd',
        // The agency's download path resolves to this API URL
        // (www files path 308/307-redirects here); the canonical
        // resolved URL is the source of record.              [A2 §2 / A3]
        url: 'https://nodejs-prod.rtd-denver.com/api/download/gtfs/google_transit.zip',
        feedVersion: 'Sep26-37303-16-17-20261023-150015', //   [build-time re-fetch 2026-10-26]
        validity: Object.freeze({ start: '2026-09-27', end: '2027-01-02' }), // [feed_info.txt]
        bytes: 10796642, //                                    [build-time re-fetch 2026-10-26]
        md5: '76e27644f889554a6282c6109c4a85d7', // build-time re-fetch 2026-10-26 — a same-window successor vintage to the A2 artifact (68239fc0…, +1 stop / +1 trip) [BLD]
      }),
    ]),
    // GTFS-RT — three endpoints, one family, collected as three
    // separate legs (LT-D2 fault isolation), all on the canonical
    // host. The TU filename is SINGULAR (TripUpdate.pb); the
    // plural 404s on this host.                               [A2 §3]
    realtime: Object.freeze([
      Object.freeze({ id: 'rtd-vp', family: 'rtd', kind: 'vehicle-positions',
        url: 'https://open-data.rtd-denver.com/files/gtfs-rt/rtd/VehiclePosition.pb' }),
      Object.freeze({ id: 'rtd-tu', family: 'rtd', kind: 'trip-updates',
        url: 'https://open-data.rtd-denver.com/files/gtfs-rt/rtd/TripUpdate.pb' }),
      Object.freeze({ id: 'rtd-sa', family: 'rtd', kind: 'service-alerts',
        url: 'https://open-data.rtd-denver.com/files/gtfs-rt/rtd/Alerts.pb' }),
    ]),
    // Measured realtime facts (design inputs, never assumptions —
    // LT-D2). ~60 s cadence on all legs; alerts book 113 at A2
    // and again at build. VP descriptor structure is the LT-N10
    // population: ~99% carry a TripDescriptor, ~85% a trip_id;
    // the rest are start_date-only or descriptor-absent and
    // carry NO route_id (design correction of record).         [A2 / BLD census]
    measured: Object.freeze({
      vpRegenerationSec: Object.freeze([55, 65]), //           [A2 cadence sample]
      tripDescriptorCoverage: 0.993, // descriptor presence on VP entities, build census 2026-10-26 (535/539); A2: 0.989–0.991 [A2 / BLD]
      tripIdCoverage: 0.833, // trip_id presence on VP entities, build census 2026-10-26 (449/539); A2 replay: 0.849 (457/538) [A2 / BLD]
    }),
  }),

  // ---- Layer groups (LT-S4.1: groups mirror the city's structure,
  // from configuration; LT-KAES-38: a group defaults ON only by a
  // recorded decision IN CONFIGURATION; a stored rider preference
  // overrides the configured default — LT-KAES-37). Denver =
  // one agency, two modes. ---------------------------------------
  layerGroups: Object.freeze([
    // Route census at build: bus 120 routes (type 3) /
    // rail 10 routes (6 light rail type 0 + 4 commuter rail
    // type 2).                                                 [BLD gtfs routes.txt]
    Object.freeze({ id: 'bus', label: 'Bus', defaultOn: true, storageKey: 'den-layer-bus' }),
    Object.freeze({ id: 'rail', label: 'Rail', defaultOn: true, storageKey: 'den-layer-rail' }),
  ]),

  // ---- Geometry & assets (paths relative to the city directory;
  // the build publishes under the same canonical tree, LT-KAES-01).
  assets: Object.freeze({
    // Basemap: TIGER/Line 2025, seven CO counties (RTD district),
    // tiered arrays, 67,970 ways / 221,855 segments, A4 PASS
    // 17/17 (LT-G16).                                          [PRD §3]
    streets: 'denver-streets.json',
    // Route geometry — LT-KAES-12 / LT-G2: one routes-3d per
    // agency feed; Denver has exactly one feed. Compiled at
    // build under Pipeline v2 (eps 2.0 m, fold guard severe=0,
    // 130 routes / 485 paths).                                 [BLD geometry-verification.json]
    routesByFeed: Object.freeze({
      rtd: 'rtd-routes-3d.json',
    }),
    // Basemap layers beyond streets (LT-KAES-13 complete layer
    // set): water = TIGER/Line 2025 AREAWATER+LINEARWATER (same
    // seven counties); landmarks = OSM named building footprints
    // via Overpass (Detroit method); street names = TIGER/Line
    // 2025 ROADS FULLNAME anchors (same shapefiles as A4).     [BLD]
    water: 'denver-water.json',
    landmarks: 'denver-landmarks.json',
    streetNames: 'denver-street-names.json',
    stops: 'rtd-stops.json', // 8,162 stop records {id,n,x,z,r} compiled at build [BLD]
    provenanceManifest: 'rtd-provenance-manifest.json', // 485 path records, LT-G10 field set [BLD]
    // Planner assets (hosted bundle identities): the T6
    // generalized-compiler asset for the build-time-refetched
    // vintage; identity carries the feed version (LT-KAES-28).
    plannerTimetable: 'planner-timetable-Sep26-37303-16-17-20261023-150015.json',
    plannerTimetableMd5: '330e87fc0979d51cfdbb1137b67c519d', //  [BLD]
    plannerStops: 'planner-stops.json',
    // Published live-data family (LT-KAES-21).
    liveData: Object.freeze({
      vehicles: 'data/vehicles.json', // canonical envelope, LT-KAES-24
      alerts: 'data/alerts.json', //     LT-KAES-34 build half
      tripUpdates: 'data/trip-updates.json', // full TU family file, LT-KAES-21
      tripUpdatesDir: 'data/tu/', //     per-route derivative tree, LT-KAES-45 (≤25,000 B per file)
    }),
    // Places dataset (LT-KAES-35 / LT-S9): NO dataset is
    // published for Denver — partner inventory is a commercial
    // step and no record may be invented (LT-F6/F7); the layer
    // lazy-fetches this path on first enable and fails honestly
    // ("unavailable") until a dataset exists.                 [BLD]
    places: 'data/places.json',
    // Projection origin — measured centroid of all RTD GTFS
    // stops with coordinates (A4 staging). One shared plane per
    // city (Standard S10 / LT-G3).                             [PRD §3]
    projection: Object.freeze({ lat0: 39.781193, lon0: -105.00133 }),
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
      // Denver as platform policy — no Denver-specific decision
      // was taken or required. Enforcement point:
      // modules/planner-host.mjs.
      walkOnlyPresentation: 'B',
      walkOnlyDecision: Object.freeze({
        id: 'D1',
        branch: 'B',
        rule: 'walk-only presented only when no transit journey exists in the window',
        decidedBy: 'Justin',
        decidedAt: '2026-10-23 23:07 EDT',
        source: 'Detroit shipped planner + PHL rebuild D1 record (files/phl-decommission-2026-10-24.md); platform policy of record for Denver/Aurora',
      }),
    }),
    // Denver's calibrated constants — adopted BY MEASUREMENT on
    // Denver data (90-configuration sweep, 2026-10-26; validation
    // gate passed field-for-field, ruling-5 kills 0), never
    // transferred from another city (LT-N8). The Denver winner
    // equals the platform default set.                         [BLD calibration]
    constants: Object.freeze({
      adoptedSet: 'W0-default-T35-P15',
      distanceWeights: Object.freeze({
        corridor: 0.35, walkBurden: 0.2, transferDelta: 0.2,
        modeMix: 0.15, transferStopDisplacement: 0.1,
      }),
      nearDuplicateThreshold: 0.35,
      reliabilityTransferPenaltyMin: 15, // Denver sweep winner (== platform default) [BLD calibration]
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
      goldenPairs: 'DEN1–DEN10', // G1 corpus; Ruling 5 at 0 s (LT-N11)
    }),
    // Density descriptors — calibration inputs measured from
    // Denver's own GTFS (LT-N7; measured at build 2026-10-26,
    // PRD §4). D1's hull basis includes the interregional stops
    // (the hull spans the full RTD service reach; the figure is
    // stated on that basis, as Cincinnati's was on its own).   [BLD descriptors]
    density: Object.freeze({
      d1StopsPerKm2: 0.18, // convex-hull service-area basis, 44,890.4 km² (hull stretched by interregional stops — basis stated)
      d1WalkProximityShare: 0.9913,
      d2PairsSharingStop: 0.0931,
      d3HeadwayMediansMin: Object.freeze({ peak: 30, midday: 30, evening: 30, weekend: 60 }),
      d4Top1Share: 0.6667, // measure-d4-g3 at build: 3 transfer events over the golden baseline journeys (thin sample — most golden pairs are direct rides; sample stated in the build record) [BLD]
      d4Top3Share: 1.0, //     measure-d4-g3 at build (same sample) [BLD]
    }),
  }),

  // ---- Commercial position (LT-F1) ---------------------------------------
  commercial: Object.freeze({
    ridersPay: false, // Riders never pay. AUTOMATEDTECHNOLOGIES collects, directly. [LT-F1]
    adsOnMap: false, // No ads on the map. Ever. (LT-F2 — per-city, survives configuration)
    // Places per-layer price: NO Denver price exists — Justin's
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
    launcherSheet: 'den-fv-sheet', // first-view sheet state (LT-S1.2 dedicated key)
    panel: 'den-panel', //            tool-panel geometry
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
