// city-config.mjs — The per-city configuration object, as the page's own.
// PHL REBUILD R1 foundation. Label: UNVERIFIED / legacy-unsigned.
//
// This module IS the LT-F5(d) configuration object for Philadelphia
// (LT-KAES-38 / the form half of LT-KAES-48): one object carrying
// everything city-specific — identity, agencies/feeds, layer groups,
// geometry/stops asset paths, and planner policy constants. Every
// other rebuild module consumes configuration from here and from
// nowhere else; no city fact is hardcoded in a feature module.
//
// EVERY VALUE CITES ITS SOURCE in a trailing comment. Records of
// truth, in precedence order for this city:
//   [A3]  files/a3-custody-record-2026-10-23.md (FINAL custody record)
//   [PRD] files/PRD-006-philadelphia.md (PRD-006)
//   [A2]  files/a2-validation-2026-10-22.md (measured feed validation)
//   [STG] hidden_files/integration-staging/ (verified planner bundle)
//   [CMP] files/architectural-comparison-2026-10-23.md (served bytes)
// A value with no record behind it is recorded as UNDECIDED / null
// (LT-F6: no invented figures; LT-F7: honest null).

import { BUILD_STAMP } from './stamp.mjs';

export const CITY_CONFIG = Object.freeze({
  // ---- Identity -------------------------------------------------------
  city: Object.freeze({
    slug: 'philadelphia', //                                   [LT-F5(d)] city/slug
    name: 'Philadelphia', //                                   [PRD §1]
    state: 'PA', //                                            [PRD §1]
    prd: 'PRD-006', //                                         [PRD §1]
    board: 48, // Board 48 "Live Transit — Philadelphia"       [PRD §1]
    canonicalPath: '/live-transit/philadelphia/', // LT-KAES-01 directory URL [CMP §1.1]
    timezone: 'America/New_York', // city-local; program records render America/Detroit per LT-D3
  }),

  // ---- Build ----------------------------------------------------------
  build: Object.freeze({
    stamp: BUILD_STAMP, // single governing stamp, defined ONLY in ./stamp.mjs (LT-KAES-04)
    stage: 'rebuild-r1-scaffold', // local only; NOT a production build
  }),

  // ---- Agency & license -------------------------------------------------
  agency: Object.freeze({
    id: 'septa',
    name: 'Southeastern Pennsylvania Transportation Authority', // [PRD §2]
    publisherHost: 'www3.septa.org', // agency-direct only      [A3 posture of record]
    // License: SEPTA License Agreement (updated 18 Mar 2014), A1 PASS
    // 2026-10-22 — no computation bar, no derivative-use bar, no
    // non-commercial restriction on the data.                    [A3 terms basis]
    licenseVerdict: 'PASS',
    licenseInstrument: 'SEPTA License Agreement (2014-03-18)',
    // Branding constraint (LT-F4 surface rule): SEPTA trademarks and
    // copyrighted materials may not be used for any commercial or
    // profit-making use and may not be altered — Philadelphia
    // surfaces carry NO SEPTA branding.                          [A3 / PRD §5]
    trademarkBar: true,
    // Key posture: KEYLESS end-to-end. No credential exists for this
    // city; nothing is stored anywhere; nothing to rotate/expire.
    // Custody record is FINAL.                                   [A3 custody statement]
    keyPosture: 'keyless',
    custodyRecord: 'files/a3-custody-record-2026-10-23.md',
    // Standing exclusion: the Swiftly mirrors cataloged for SEPTA
    // (api.goswift.ly, mdb-1567…mdb-1570, deprecated) are excluded
    // from EVERY path — display, computation, telemetry, corpus. [A3 / PRD §2]
    excludedSources: Object.freeze(['api.goswift.ly']),
    // Display-only fence: NONE. Both SEPTA feeds are
    // computation-permitted agency-direct data (LT-KAES-27: N-A
    // for Philadelphia; activates only if a feed's terms change —
    // the A3 re-open conditions).                               [KAES-27]
    displayOnlyFeeds: Object.freeze([]),
  }),

  // ---- Feeds ------------------------------------------------------------
  feeds: Object.freeze({
    // GTFS static — two zips, kept separate end-to-end (LT-F5(b),
    // LT-D1). Download is agreement-gated, not credential-gated.  [A3]
    static: Object.freeze([
      Object.freeze({
        id: 'septa-bus-static',
        family: 'bus', // bus, trolley, subway/elevated, trolleybus [A3]
        url: 'https://www3.septa.org/developer/google_bus.zip', //  [A3 endpoints table]
        mobilityDb: 'mdb-502', //                                  [A3]
        feedVersion: 'v202609271', //                              [A3]
        validity: Object.freeze({ start: '2026-09-27', end: '2027-02-20' }), // [A3]
        bytes: 21287034, //                                        [A3 / A2]
        md5: '22901c5d45f9ab7ffa572bae173a833b', //                 [A3]
      }),
      Object.freeze({
        id: 'septa-rail-static',
        family: 'rail', // Regional Rail                           [A3]
        url: 'https://www3.septa.org/developer/google_rail.zip', // [A3]
        mobilityDb: 'mdb-503', //                                  [A3]
        feedVersion: 'v202609271', //                              [A3]
        // SHORTER window — this city's likeliest static failure
        // mode; refresh tranche due by 2026-11-14.               [A3 watch items]
        validity: Object.freeze({ start: '2026-09-27', end: '2026-11-21' }),
        bytes: 767481, //                                          [A3 / A2]
        md5: '01c96ba3040841a000809294d1e5f32d', //                 [A3]
      }),
    ]),
    // GTFS-RT — six endpoints, two families, each publishing VP/TU/SA.
    // The outgoing collector consumed ONLY the two VP legs; the TU
    // and SA legs are part of the foundation contract from day one
    // (LT-KAES-16 complete leg set; LT-KAES-34 build half). R2
    // implements collection; R1 fixes the endpoint set.         [A3 endpoints table]
    realtime: Object.freeze([
      // Surface + subway family (septa-pa-us)                     [A3]
      Object.freeze({ id: 'bus-vp', family: 'bus', kind: 'vehicle-positions',
        url: 'https://www3.septa.org/gtfsrt/septa-pa-us/Vehicle/rtVehiclePosition.pb' }),
      Object.freeze({ id: 'bus-tu', family: 'bus', kind: 'trip-updates',
        url: 'https://www3.septa.org/gtfsrt/septa-pa-us/Trip/rtTripUpdates.pb' }),
      Object.freeze({ id: 'bus-sa', family: 'bus', kind: 'service-alerts',
        url: 'https://www3.septa.org/gtfsrt/septa-pa-us/Service/rtServiceAlerts.pb' }),
      // Regional Rail family (septarail-pa-us)                    [A3]
      Object.freeze({ id: 'rail-vp', family: 'rail', kind: 'vehicle-positions',
        url: 'https://www3.septa.org/gtfsrt/septarail-pa-us/Vehicle/rtVehiclePosition.pb' }),
      Object.freeze({ id: 'rail-tu', family: 'rail', kind: 'trip-updates',
        url: 'https://www3.septa.org/gtfsrt/septarail-pa-us/Trip/rtTripUpdates.pb' }),
      Object.freeze({ id: 'rail-sa', family: 'rail', kind: 'service-alerts',
        url: 'https://www3.septa.org/gtfsrt/septarail-pa-us/Service/rtServiceAlerts.pb' }),
    ]),
    // Measured realtime facts (design inputs, never assumptions —
    // LT-D2). VP regenerates ~30–60 s both families.             [A2 / A3]
    measured: Object.freeze({
      vpRegenerationSec: Object.freeze([30, 60]), //               [A2 cadence sample]
      busTripDescriptorCoverage: 0.506, // ≈50.6% of bus VP records carry a TripDescriptor [A2]
      railTripDescriptorCoverage: 1.0, // 54/54 at A2 first poll   [A2]
    }),
  }),

  // ---- Layer groups (LT-S4.1: groups mirror the city's structure,
  // from configuration; LT-KAES-38: a group defaults ON only by a
  // recorded decision IN CONFIGURATION; a stored rider preference
  // overrides the configured default — LT-KAES-37). The outgoing
  // page booted all four groups checked UNCONDITIONALLY (KAES-38
  // PARTIAL); here the default is a config decision, stated. ------
  layerGroups: Object.freeze([
    // Route census at the served build: bus 149 / trolley 11 /
    // metro 5 / rail 13 = 178 routes.                             [CMP evidence base]
    Object.freeze({ id: 'bus', label: 'Bus', defaultOn: true, storageKey: 'phl-layer-bus' }),
    Object.freeze({ id: 'trolley', label: 'Trolley', defaultOn: true, storageKey: 'phl-layer-trolley' }),
    Object.freeze({ id: 'metro', label: 'Subway', defaultOn: true, storageKey: 'phl-layer-metro' }),
    Object.freeze({ id: 'rail', label: 'Regional Rail', defaultOn: true, storageKey: 'phl-layer-rail' }),
  ]),

  // ---- Geometry & assets (paths are relative to the city directory;
  // the rebuild publishes under the same canonical tree, LT-KAES-01).
  // Geometry data layer CONFORMS at Pipeline v2 (Finding B /
  // LT-KAES-11); R3 re-verifies and lands the renderer. ----------
  assets: Object.freeze({
    // Basemap: TIGER/Line 2025, five PA counties, tiered arrays,
    // DP 6/6/8 m, 64,678 ways / 198,177 segments, A4 PASS 17/17.  [PRD §3]
    streets: 'philadelphia-streets.json',
    // Route geometry — TARGET layout per LT-KAES-12 / LT-G2: one
    // <agency>-routes-3d.json PER AGENCY FEED. The outgoing build
    // published ONE combined septa-routes-3d.json (178 routes,
    // 572 paths) — that is the KAES-12 GAP; the per-feed split
    // lands with the R3 geometry publish. Both target paths are
    // declared here so R2/R3 build against the target, not the gap.
    routesByFeed: Object.freeze({
      bus: 'septa-bus-routes-3d.json',
      rail: 'septa-rail-routes-3d.json',
    }),
    legacyCombinedRoutes: 'septa-routes-3d.json', // outgoing only; retired by R3 split
    // Basemap layers beyond streets (LT-KAES-13 complete layer set),
    // staged by R3 from authoritative geometry: water = TIGER/Line
    // 2025 AREAWATER+LINEARWATER (5 counties); landmarks = OSM named
    // building footprints via Overpass (Detroit method); street
    // names = TIGER/Line 2025 ROADS FULLNAME anchors (same
    // shapefiles as the A4 streets). Build records: R3 delivery
    // note (tools/build-water.py, build-landmarks.py,
    // build-street-names.py in the rebuild tree).
    water: 'philadelphia-water.json',
    landmarks: 'philadelphia-landmarks.json',
    streetNames: 'philadelphia-street-names.json',
    stops: 'septa-stops.json', // 13,665 stop records {id,n,x,z,r} at the outgoing build [CMP]
    provenanceManifest: 'septa-provenance-manifest.json', // 572 path records; schema alignment to LT-G10 is R3 work (LT-KAES-26)
    // Planner assets (staged bundle identities — R4 hosts these;
    // the files themselves are NOT copied into this tree, see the
    // design note's salvage inventory).
    plannerTimetable: 'planner-timetable-v202609271u202611010-v202609271u202611010.json', // identity carries both feed vintages (LT-KAES-28)
    plannerTimetableMd5: '30d827d5e7932b92b9f0068fbadde738', //          [STG config]
    plannerStops: 'planner-stops.json',
    // Published live-data family (LT-KAES-21) — TARGET set. The
    // outgoing build published exactly one file (vehicles.json);
    // R2 publishes the family. Paths are the contract.
    liveData: Object.freeze({
      vehicles: 'data/vehicles.json', // canonical envelope, LT-KAES-24
      alerts: 'data/alerts.json', //     LT-KAES-34 build half
      tripUpdates: 'data/trip-updates.json', // full TU family file, LT-KAES-21 (added R5: the stop-card / Ride Along consumer path)
      tripUpdatesDir: 'data/tu/', //     per-route derivative tree, LT-KAES-45 (≤25,000 B per file)
    }),
    // Places dataset (LT-KAES-35 / LT-S9): the labeled layer's data
    // path. NO dataset is published for Philadelphia yet — partner
    // inventory is a commercial step and no record may be invented
    // (LT-F6/F7); the layer lazy-fetches this path on first enable
    // and fails honestly ("unavailable") until a dataset exists.
    // Added R5 with this citation.
    places: 'data/places.json',
    // Projection origin — measured centroid of all SEPTA GTFS
    // stops with coordinates (A4 staging). One shared plane per
    // city (Standard S10 / LT-G3).                               [PRD §3]
    projection: Object.freeze({ lat0: 40.016519, lon0: -75.197812 }),
  }),

  // ---- Freshness & cadence ---------------------------------------------
  freshness: Object.freeze({
    vehiclePollMs: 60000, // 60 s vehicle poll (LT-S3.1; both Detroit and outgoing PHL) [CMP §4.23]
    alertsPollMs: 120000, // 120 s alerts poll (LT-S3.1 reference value)
    // Degradation staleness threshold (LT-S8.2): a vehicles envelope
    // whose generated_at is older than this fires the stale state.
    // The Detroit reference value (SVC_STALE_MS, 15 min), adopted
    // for Philadelphia at R5 with this citation.
    degradedAfterMs: 900000,
    // VM-held cadence (LT-KAES-18 as adapted / LT-D7): dispatch
    // when served age exceeds 420 s; backstop 1,200 s; minimum
    // dispatch interval 300 s. The adaptation (workflow native
    // cron retained while the VM watchdog is the standing
    // mechanism) stays recorded per LT-D7. R6 owns the chain.
    watchdogDispatchAgeSec: 420,
    backstopAgeSec: 1200,
    minDispatchIntervalSec: 300,
  }),

  // ---- Planner policy (the planner itself is R4; its POLICY lives
  // in the foundation config from day one) -------------------------
  planner: Object.freeze({
    policy: Object.freeze({
      // D1(b) — DECIDED, carried into the rebuild VERBATIM.
      // Walk-only is presented ONLY when no transit journey exists
      // in the window. Decided by Justin on 2026-10-23 at 23:07 EDT
      // via the coordinator's options widget (queue record +
      // decommission record). This is a named, decided policy
      // constant — not a default, not a placeholder. R4's single
      // enforcement point is modules/planner-host.mjs, mirroring
      // resolveWalkOnlyPresentation() in the shipped planner.
      walkOnlyPresentation: 'B',
      walkOnlyDecision: Object.freeze({
        id: 'D1',
        branch: 'B',
        rule: 'walk-only presented only when no transit journey exists in the window',
        decidedBy: 'Justin',
        decidedAt: '2026-10-23 23:07 EDT',
        source: 'Priority 0 queue RUNNING record; files/phl-decommission-2026-10-24.md',
      }),
    }),
    // Philadelphia's calibrated constants — adopted BY MEASUREMENT
    // on Philadelphia data (a defended tie at the default set),
    // never transferred from Detroit (LT-N8: constants are city
    // property and do not travel).                               [PRD §4 calibration; STG]
    constants: Object.freeze({
      adoptedSet: 'W0-default-T35-P15', //                           [STG selection.constants]
      distanceWeights: Object.freeze({
        corridor: 0.35, walkBurden: 0.2, transferDelta: 0.2,
        modeMix: 0.15, transferStopDisplacement: 0.1,
      }), //                                                         [STG]
      nearDuplicateThreshold: 0.35, //                               [STG]
      reliabilityTransferPenaltyMin: 15, // platform form constant (LT-N6) [STG]
      reliabilityHeadwayCapMin: 60, //    platform form constant (LT-N6) [STG]
      selectionMode: 'frequency-aware', // Addendum 3 bound is the binding mode [STG]
      enumerationCapMin: 120, //          hard enumeration cap (LT-N9) [STG]
      flatFloorSec: 1800, //              +30 min flat floor (LT-N9) [STG]
    }),
    // Walk model — platform constants (LT-N10).
    walkModel: Object.freeze({
      edgeRadiusM: 400,
      speedMps: 1.4,
      perEdgeFloorSec: 60,
      maxWalkSecsPerRound: 1800, // MAX_WALK_SECS — the cap that keeps a transit planner from degenerating into walking directions
    }),
    // Engine pairing (LT-N12): the staged set-model engine; the
    // loader pairing guard refuses a "set" asset under an engine
    // without servicesFor(). Engine MD5 is the staged identity.   [STG]
    engine: Object.freeze({
      serviceModel: 'set',
      requiredExport: 'servicesFor',
      stagedMd5: '6746dfbc3aae7c531e42206478d572da',
      goldenPairs: 'PHL1–PHL11', // G1 corpus; Ruling 5 at 0 s (LT-N11)
    }),
    // Density descriptors — calibration inputs measured from
    // Philadelphia's own GTFS (LT-N7; all four required before
    // calibration, and satisfied for this city).                 [PRD §4]
    density: Object.freeze({
      d1BusStopsPerKm2: 3.99,
      d1RailStopsPerKm2: 0.05,
      d1WalkProximityShare: 0.669,
      d2PairsSharingStop: 0.08,
      d3HeadwayMediansMin: Object.freeze({ peak: 30, midday: 30, evening: 30, weekend: 45 }),
      d4Top1Share: 0.0118,
      d4Top3Share: 0.0315,
    }),
  }),

  // ---- Commercial position (LT-F1) -------------------------------------
  commercial: Object.freeze({
    ridersPay: false, // Riders never pay. AUTOMATEDTECHNOLOGIES collects, directly. [LT-F1]
    adsOnMap: false, // No ads on the map. Ever. (LT-F2 — per-city, survives configuration)
    // Places per-layer price: UNDECIDED — Justin's per-city
    // decision (LT-S9.3). No figure is invented here; the layer
    // does not wait for the price (LT-KAES-35).                  [PRD §8]
    placesPrice: null,
    placesPriceState: 'UNDECIDED',
  }),

  // ---- Persisted rider state (LT-KAES-37: dedicated per-feature
  // storage keys; a stored preference always wins over the
  // configured default). Layer-group keys live with their groups
  // above; feature keys are declared here so no module invents one.
  storageKeys: Object.freeze({
    launcherSheet: 'phl-fv-sheet', // first-view sheet state (LT-S1.2 dedicated key)
    panel: 'phl-panel', //            tool-panel geometry (R5)
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
