// city-config.mjs — The per-city configuration object, as the page's own.
// SAN DIEGO BUILD (Board 55). Label: UNVERIFIED / legacy-unsigned.
//
// This module IS the LT-F5(d) configuration object for San Diego:
// one object carrying everything city-specific — identity,
// agencies/feeds, layer groups, geometry/stops asset paths, and
// planner policy constants. Every other module consumes
// configuration from here and from nowhere else; no city fact is
// hardcoded in a feature module.
//
// EVERY VALUE CITES ITS SOURCE in a trailing comment. Records of
// truth, in precedence order for this city:
//   [A3]  expansion workspace access-staging/registers/san-diego.md (A3 custody record)
//   [PRD] files/prd (PRD-008)
//   [A2]  files/prd/a2-validation-san-diego-keyed-2026-10-23.md
//   [BLD] this build's records (build record 2026-10-26)
// A value with no record behind it is recorded as UNDECIDED / null
// (LT-F6: no invented figures; LT-F7: honest null).


// SCHEMA V2 (Cities V2, design iteration 2 §C): v1 sections carried
// verbatim; posture/ops/release added; agency.shortName added;
// build.stamp retired to the assembler-generated stamp module.
export const CITY_CONFIG = Object.freeze({
  // ---- Identity -------------------------------------------------------
  city: Object.freeze({
    slug: 'san-diego', //                                      [LT-F5(d)] city/slug
    name: 'San Diego', //                                      [PRD §1]
    state: 'CA', //                                            [PRD §1]
    prd: 'PRD-008', //                                         [PRD §1]
    board: 55, // Board 55 "Live Transit — San Diego"           [PRD §1]
    canonicalPath: '/live-transit/san-diego/', // LT-KAES-01 directory URL
    timezone: 'America/Los_Angeles', // city-local; program records render America/Detroit per LT-D3
  }),

  // ---- Build ----------------------------------------------------------
  build: Object.freeze({
    // stamp: RETIRED in schema v2 — BUILD_STAMP is assembler-generated (design C.1/D.3)
    stage: 'san-diego-build-staging', // local only; NOT a production build (launch gate: Board 55 item 7)
  }),

  // ---- Agency & license -------------------------------------------------
  agency: Object.freeze({
    id: 'mts',
    shortName: 'MTS', // NEW schema v2 — proof-string form (SF-2) [design C.1]
    name: 'San Diego Metropolitan Transit System', //          [PRD §2]
    publisherHost: 'www.sdmts.com', // static on sdmts.com; RT on realtime.sdmts.com (OneBusAway) [PRD §2 / A2]
    // License: MTS Developer License Agreement, A1 PASS
    // 2026-10-22 — the agreement expressly covers both the GTFS
    // Data and the Real-Time Updates, granting use, reproduction
    // and redistribution with no computation bar, no
    // derivative-use bar, and no non-commercial restriction.
    //                                                    [PRD §2]
    licenseVerdict: 'PASS',
    licenseInstrument: 'MTS Developer License Agreement (sdmts.com/business-center/app-developers)',
    // Branding constraint (LT-F4 surface rule): MTS trademarks
    // and copyrighted materials may not be used in association
    // with the GTFS Data or Updates — San Diego surfaces carry
    // NO MTS logos or branding; the agency is named in
    // attribution prose only.                             [PRD §2]
    trademarkBar: true,
    // Key posture: KEYED, vault-only. The MTS developer key is
    // held ONLY as the registered Secure Vault connection
    // custom.sdmts (A3 custody complete 2026-10-23); it is
    // presented server-side through the connector's surrogate
    // flow and never appears in any file, log, or client. VP/TU
    // are key-gated (keyless requests return HTTP 500, A2).
    //                                                    [A3 / A2]
    keyPosture: 'keyed-vault',
    custodyRecord: 'access-staging/registers/san-diego.md A3 (expansion workspace)',
    excludedSources: Object.freeze([
      // The published mecatran alerts URL 301-redirects
      // unconditionally to mna.mecatran.com, which is NOT a
      // registered host on the vault connection — the key cannot
      // be presented there and the redirect is never followed
      // with the credential attached. The pipeline instead reads
      // the agency's OneBusAway alerts endpoint on the registered
      // host (alerts-for-agency/MTS.pb) with the same key.
      //                                          [A2 keyed record]
      'app.mecatran.com/utw/ws/gtfsfeed/alerts/sdmts (301 -> mna.mecatran.com, unregistered host)',
    ]),
    // Display-only fence: NONE. The MTS grant permits use,
    // reproduction and redistribution of the full feed set; no
    // display-only feed exists in this city.               [PRD §6]
    displayOnlyFeeds: Object.freeze([]),
  }),

  // ---- Feeds ------------------------------------------------------------
  feeds: Object.freeze({
    // GTFS static — ONE zip (LT-F5(b) single-feed project), from
    // the agency-designated channel (MTS App Developers page).
    //                                                    [PRD §2]
    static: Object.freeze([
      Object.freeze({
        id: 'mts-static',
        family: 'mts',
        url: 'http://www.sdmts.com/google_transit_files/google_transit.zip',
        feedVersion: 'Generated on 20261006', //               [build-time re-fetch 2026-10-26]
        validity: Object.freeze({ start: '2026-09-06', end: '2027-01-30' }), // [feed_info.txt]
        bytes: 5240030, //                                     [build-time re-fetch 2026-10-26]
        md5: '91a7940debe99fd39b18a8bf1f081fa5', // build-time re-fetch 2026-10-26 — byte-identical to the A2 artifact: the agency's current vintage is the A2 vintage [BLD]
      }),
    ]),
    // GTFS-RT — three endpoints, one family, collected as three
    // separate legs (LT-D2 fault isolation) on the agency's
    // OneBusAway host, all keyed through the vault connection.
    //                                                    [A2]
    realtime: Object.freeze([
      Object.freeze({ id: 'mts-vp', family: 'mts', kind: 'vehicle-positions',
        url: 'https://realtime.sdmts.com/api/api/gtfs_realtime/vehicle-positions-for-agency/MTS.pb' }),
      Object.freeze({ id: 'mts-tu', family: 'mts', kind: 'trip-updates',
        url: 'https://realtime.sdmts.com/api/api/gtfs_realtime/trip-updates-for-agency/MTS.pb' }),
      Object.freeze({ id: 'mts-sa', family: 'mts', kind: 'service-alerts',
        url: 'https://realtime.sdmts.com/api/api/gtfs_realtime/alerts-for-agency/MTS.pb' }),
    ]),
    // Measured realtime facts (design inputs, never assumptions —
    // LT-D2). The OneBusAway endpoints serve a continuously
    // regenerated feed: header timestamps track wall time ~1:1
    // with header age ~0 at collection (A2 three-poll keyed pass).
    // VP is the LT-N10 population: 98.5% pooled TripDescriptor
    // coverage at A2 (1,253/1,272), every descriptor carrying
    // trip_id AND route_id; the descriptor-absent minority
    // carries position + vehicle timestamp but no descriptor.
    // TU is 100% TripDescriptor + trip_id.            [A2 / BLD census]
    measured: Object.freeze({
      vpRegenerationSec: Object.freeze([0, 5]), // header age at fetch ~0-3 s [A2 cadence sample]
      tripDescriptorCoverage: 0.985, // descriptor presence on VP entities, A2 pooled (1,253/1,272) [A2]
      tripIdCoverage: 0.985, // trip_id presence on VP entities, A2 pooled [A2]
    }),
  }),

  // ---- Layer groups (LT-S4.1: groups mirror the city's structure,
  // from configuration; LT-KAES-38: a group defaults ON only by a
  // recorded decision IN CONFIGURATION; a stored rider preference
  // overrides the configured default — LT-KAES-37). San Diego =
  // one agency, three modes. -------------------------------------
  layerGroups: Object.freeze([
    // Route census at build: bus 98 routes (type 3) / trolley
    // 5 routes (type 0: Blue, Copper, Green, Orange, Silver) /
    // ferry 1 route (type 4: Coronado Ferry).            [BLD gtfs routes.txt]
    Object.freeze({ id: 'bus', label: 'Bus', defaultOn: true, storageKey: 'sd-layer-bus' }),
    Object.freeze({ id: 'rail', label: 'Trolley', defaultOn: true, storageKey: 'sd-layer-rail' }),
    Object.freeze({ id: 'ferry', label: 'Ferry', defaultOn: true, storageKey: 'sd-layer-ferry' }),
  ]),

  // ---- Geometry & assets (paths relative to the city directory;
  // the build publishes under the same canonical tree, LT-KAES-01).
  assets: Object.freeze({
    // Basemap: TIGER/Line 2025 San Diego County (06073) ROADS,
    // tiered arrays, 51,379 ways / 197,299 segments, A4 format
    // check PASS 17/17 (LT-G16); in-extent stop coverage
    // 100.000% — the cleanest A4 result in the program.  [PRD §3]
    streets: 'san-diego-streets.json',
    // Route geometry — LT-KAES-12 / LT-G2: one routes-3d per
    // agency feed; San Diego has exactly one feed. Compiled at
    // build under Pipeline v2 (eps 2.0 m, fold guard severe=0,
    // 104 routes / 338 paths).                              [BLD geometry-verification.json]
    routesByFeed: Object.freeze({
      mts: 'mts-routes-3d.json',
    }),
    // Basemap layers beyond streets (LT-KAES-13 complete layer
    // set): water = TIGER/Line 2025 AREAWATER+LINEARWATER
    // (San Diego County 06073; labels verified on San Diego
    // Bay, Mission Bay, Pacific Ocean); landmarks = OSM named
    // building footprints via Overpass (Detroit method),
    // downtown core; street names = TIGER/Line 2025 ROADS
    // FULLNAME anchors (06073).                             [BLD]
    water: 'san-diego-water.json',
    landmarks: 'san-diego-landmarks.json',
    streetNames: 'san-diego-street-names.json',
    stops: 'mts-stops.json', // 4,359 stop records {id,n,x,z,r} compiled at build [BLD]
    provenanceManifest: 'mts-provenance-manifest.json', // 338 per-path records, LT-G10 field set [BLD]
    // Planner assets (hosted bundle identities): the T6
    // generalized-compiler asset for the build-time-refetched
    // vintage; identity carries the feed version (LT-KAES-28).
    plannerTimetable: 'planner-timetable-Generated on 20261006.json',
    plannerTimetableMd5: 'cba043c28ed709f48ae2528d76b8fa76', //        [BLD planner compile 2026-10-26]
    plannerStops: 'planner-stops.json',
    // Published live-data family (LT-KAES-21).
    liveData: Object.freeze({
      vehicles: 'data/vehicles.json', // canonical envelope, LT-KAES-24
      alerts: 'data/alerts.json', //     LT-KAES-34 build half
      tripUpdates: 'data/trip-updates.json', // full TU family file, LT-KAES-21
      tripUpdatesDir: 'data/tu/', //     per-route derivative tree, LT-KAES-45 (≤25,000 B per file)
    }),
    // Places dataset (LT-KAES-35 / LT-S9): NO dataset is
    // published for San Diego — partner inventory is a
    // commercial step and no record may be invented (LT-F6/F7);
    // the layer lazy-fetches this path on first enable and fails
    // honestly ("unavailable") until a dataset exists.        [BLD]
    places: 'data/places.json',
    // Projection origin — measured centroid of all MTS GTFS
    // stops with coordinates (A4 staging; re-measured identical
    // on the build-time fresh fetch, 4,359 stops). One shared
    // plane per city (Standard S10 / LT-G3).                  [PRD §3]
    projection: Object.freeze({ lat0: 32.752266, lon0: -117.07827 }),
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
    hosting: 'main-thread', // NEW schema v2 (WK-1) [design A.9/C.1]
    calibrationRecord: 'harness/results-sandiego-calibration-2026-10-26.json', // NEW — adopted-set citation pointer (SL-2)
    policy: Object.freeze({
      // D1(b) — the platform policy of record: walk-only is
      // presented ONLY when no transit journey exists in the
      // window. Origin: the shipped Detroit planner; decided by
      // Justin 2026-10-23 23:07 EDT for the rebuilt estate
      // (recorded in the PHL rebuild foundation) and carried to
      // San Diego as platform policy — no San Diego-specific
      // decision was taken or required. Enforcement point:
      // modules/planner-host.mjs.
      walkOnlyPresentation: 'B',
      walkOnlyDecision: Object.freeze({
        id: 'D1',
        branch: 'B',
        rule: 'walk-only presented only when no transit journey exists in the window',
        decidedBy: 'Justin',
        decidedAt: '2026-10-23 23:07 EDT',
        source: 'Detroit shipped planner + PHL rebuild D1 record (files/phl-decommission-2026-10-24.md); platform policy of record for San Diego',
      }),
    }),
    // San Diego's calibrated constants — adopted BY MEASUREMENT
    // on San Diego data (90-configuration sweep, 2026-10-26),
    // never transferred from another city (LT-N8).   [BLD calibration]
    constants: Object.freeze({
      adoptedSet: 'W0-default-T35-P15', // San Diego's own 90-configuration sweep winner, 2026-10-26
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
      goldenPairs: 'SD1–SD10', // G1 corpus; Ruling 5 at 0 s (LT-N11)
    }),
    // Density descriptors — calibration inputs measured from
    // San Diego's own GTFS (LT-N7; measured at build
    // 2026-10-26, PRD §4).                                 [BLD descriptors]
    density: Object.freeze({
      d1StopsPerKm2: 0.71, // convex-hull service-area basis, 6,171.3 km² (county-wide hull incl. rural east)
      d1WalkProximityShare: 0.9867,
      d2PairsSharingStop: 0.0584,
      d3HeadwayMediansMin: Object.freeze({ peak: 30, midday: 30, evening: 30, weekend: 30 }),
      d4Top1Share: 0.3333, // measure-d4-g3 at build — THIN sample: 3 transfer events across 12 baseline journeys (golden pairs are mostly direct rail rides on this radial trolley network)
      d4Top3Share: 1.0, // same thin sample
    }),
  }),

  // ---- Commercial position (LT-F1) ---------------------------------------
  commercial: Object.freeze({
    ridersPay: false, // Riders never pay. AUTOMATEDTECHNOLOGIES collects, directly. [LT-F1]
    adsOnMap: false, // No ads on the map. Ever. (LT-F2 — per-city, survives configuration)
    // Places per-layer price: NO San Diego price exists —
    // Justin's per-city decision (LT-S9.3). No figure is
    // invented here; the layer does not wait for the price
    // (LT-KAES-35). Consumer-investment line: a partner invests
    // the (unset) layer price + listing preparation; riders
    // invest nothing (layer is default-off and labeled).       [BLD]
    placesPrice: null,
    placesPriceState: 'UNDECIDED',
  }),

  // ---- Posture (NEW, schema v2 §C.2) -----------------------------------
  posture: Object.freeze({
    model: 'live', // live vehicle layer
    degradation: Object.freeze({
      evaluateLiveStaleness: true, // served behavior in ALL seven v1 builds (T1 reconciliation: Columbus U5-01 asserts stale envelopes ARE flagged; design C.2's short-circuit contradicted the harness — iteration 3 owns the re-spec)
    }),
    servicePresence: Object.freeze({
      rule: 'vehicles-or-unassigned-none', // San Diego C4, generalized [C.2]
      serviceHours: Object.freeze({ model: 'always', windows: Object.freeze([]) }),
      lowServiceShape: null,
    }),
    nonPublication: null,
  }),

  // ---- Ops (NEW, schema v2 §C.3) ----------------------------------------
  ops: Object.freeze({
    chainUnits: Object.freeze({
      cityTimerUnit: 'sd-publisher.timer', // OPS-1 destination (CV2-D13)
      watchdogHook: 'sd-watchdog.timer',
    }),
    telemetry: Object.freeze({
      state: 'undecided', // OPS-2 destination (CV2-D13)
      decisionRecord: null,
    }),
  }),

  // ---- Release (NEW, schema v2 §C.3) -------------------------------------
  release: Object.freeze({
    corePin: 't1-extract-1', // the T1-extracted core (CV2-1 cycle 2)
    canary: true, // standing release canary: San Diego (CV2-D11)
  }),

  // ---- Fares (NEW, optional, schema v2 §C.3) ------------------------------
  fares: Object.freeze({
    base: 2.5, dayCap: 6, currency: 'USD',
    source: 'city conformance record 2026-10-30 (MTS fares as served)', // LT-F6: a figure exists only with its citation
  }), // no fare figure on record for this city — the absence stands (LT-F6)

  // ---- Page shell prose (NEW, schema v2.1, T2) ----------------------------
  // The generated index.html’s per-city content (iteration-2 design A.10:
  // IH-1/IH-3/IH-5/IH-6 verbatim; A.12 terms presence declared). Extracted
  // byte-exact from the city’s served shell by tools/extract_page.mjs;
  // the T2 assembler inserts it into the platform page template.
  // Canonical URL is NOT stored — it derives from city.canonicalPath.
  page: Object.freeze({
    title: "San Diego — Live Transit · Detroit Automation Academy",
    metaDescription: "MTS buses, the Trolley, and the Coronado Ferry live on one map of San Diego — agency-direct data, published by AutomatedTechnologies.",
    h1: "San Diego — Live Transit",
    intro: "MTS buses, the Trolley, and the Coronado Ferry, live on one map of San Diego.\n    Data comes from MTS's own published feeds. There are no ads on this map. Ever.",
    statusText: "Loading live vehicles…",
    plannerLine: " — scheduled journeys across the San Diego region from the published timetable.",
    canvasAriaLabel: "Map of San Diego with live MTS vehicle positions",
    aboutCoverage: "The map covers San Diego County, California — the MTS service\n    area, from San Ysidro to Oceanside and east to El Cajon and Santee —\n    drawn from U.S. Census TIGER/Line 2025 roads. Route lines and stops\n    come from MTS's published GTFS. Vehicle positions come from MTS's\n    agency-direct GTFS-Realtime feeds, fetched and republished by\n    AutomatedTechnologies.",
    aboutLicense: "Live Transit San Diego is published by AutomatedTechnologies\n    d/b/a Detroit Automation Academy, from MTS's public data under the\n    MTS Developer License Agreement. This page makes no use of MTS\n    branding or logos and implies no sponsorship or endorsement.\n    Riders never pay for Live Transit.",
    terms: true, // terms.html present in this city’s tree — a decision on record (A.12), asserted by the contract gate
  }),

  // ---- Persisted rider state (LT-KAES-37) --------------------------------
  storageKeys: Object.freeze({
    launcherSheet: 'sd-fv-sheet', // first-view sheet state (LT-S1.2 dedicated key)
    panel: 'sd-panel', //            tool-panel geometry
  }),
});

/** Required top-level keys — the harness asserts this exact set exists. */
export const REQUIRED_CONFIG_KEYS = Object.freeze([
  'city', 'build', 'agency', 'feeds', 'layerGroups',
  'assets', 'freshness', 'planner', 'commercial', 'storageKeys',
  'posture', 'ops', 'release', 'page', // schema v2 + page (T2 v2.1); fares is optional
]);

/** Resolve a layer group's boot state: stored preference wins (KAES-37/38). */
export function layerDefaultOn(group, storedValue) {
  if (storedValue === '0') return false;
  if (storedValue === '1') return true;
  return group.defaultOn === true;
}
