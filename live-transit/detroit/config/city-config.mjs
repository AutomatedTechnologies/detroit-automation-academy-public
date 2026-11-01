// city-config.mjs — The per-city configuration object, as the page's own.
// DETROIT BUILD (Cities V2 T6.2). Label: UNVERIFIED / legacy-unsigned.
//
// This module IS the LT-F5(d) configuration object for Detroit:
// one object carrying everything city-specific — identity,
// agencies/feeds, layer groups, geometry/stops asset paths, and
// planner policy constants. Every other module consumes
// configuration from here and from nowhere else; no city fact is
// hardcoded in a feature module.
//
// EVERY VALUE CITES ITS SOURCE in a trailing comment. Records of
// truth for this city:
//   [PRD] files/prd/PRD-000-detroit.md (PRD-000, reference case)
//   [T6]  files/cities-v2-t6-build-record-2026-10-31.md (graph E1–E8)
//   [FOLD] files/cities-v2-core-fold-build-record-2026-10-31.md
//         (schema v2.2 contract; adopted-set disposition)
//   [CEN] hidden_files/cities-v2-t6/census/census-2026-10-31.md
//   [PIN] forge-line goal golden-corpus-2026-10-30/pin.json
//   [SRV] served bytes fetched 2026-10-31 this run: live-transit.html
//         94,357 B MD5 7501f2bbb56efb309bf571e5b2c5b4fc (refs H:<line>),
//         live-transit.js?v=20261031-0645 616,852 B MD5
//         59704d80a183d44807cca7959736a262 (refs M:<line>)
// A value with no record behind it is recorded as UNDECIDED / null
// (LT-F6: no invented figures; LT-F7: honest null).


// SCHEMA V2 + V2.2 FOLD FIELDS (Cities V2, design iteration 2 §C +
// core-fold contract table): v1 sections carried; posture/ops/
// release added; fold fields (planner.presentation/budgetMs/live,
// display feeds, routesRegistry, static/external layers, scene,
// motion, alertsFx, filters, betaFeatures, clientRecovery) present
// because Detroit's shipped page uses every one of those mechanisms.
export const CITY_CONFIG = Object.freeze({
  // ---- Identity -------------------------------------------------------
  city: Object.freeze({
    slug: 'detroit', //                                      [LT-F5(d)] city/slug
    name: 'Detroit', //                                      [PRD §1]
    state: 'MI', //                                          [PRD §1]
    prd: 'PRD-000', //                                       [PRD §1]
    board: 68, // Board 68 T6 = the Detroit migration item   [T6 header]
    // E2 ROOT-CITY EXCEPTION (coordinator disposition, T6 graph):
    // Detroit's canonical page IS the root /live-transit.html
    // (served canonical H:11 = https://www.detroitautomationacademy.com/live-transit.html);
    // the schema invariant /live-transit/<slug>/ does not hold for
    // the root city and validator G1 flags exactly this one field —
    // the filed exception; T6.3 owns the validator exception. A URL
    // move is Justin's call, outside the T6 envelope.        [T6 E2]
    canonicalPath: '/live-transit.html',
    timezone: 'America/Detroit', //                          [PRD §2 agency.txt both GTFS]
  }),

  // ---- Build ----------------------------------------------------------
  build: Object.freeze({
    // stamp: RETIRED in schema v2 — BUILD_STAMP comes from the
    // ship-tree base stamp file (T6.2 base pins '20261025-2057',
    // the monolith's internal asset stamp, census §C).
    stage: 'detroit-t6.2-base', // T6.2 staging only; NOT a production build (ship = T6.6, gated)
  }),

  // ---- Agency & license -------------------------------------------------
  agency: Object.freeze({
    // Detroit is a THREE-agency city; there is no single operating
    // agency. Agencies: DDOT, SMART, QLINE.                 [PRD §2]
    id: 'detroit',
    shortName: 'DDOT/SMART/QLINE', // proof-string form (SF-2)
    name: 'Detroit Department of Transportation (DDOT), Suburban Mobility Authority for Regional Transportation (SMART), and QLINE', // agency names: DDOT [GTFS agency.txt]; SMART full name [SRV H fine print, trademark notice]
    // Key posture: Project 30 keyless split — GitHub Actions
    // collects raw bundles (API keys never leave Actions), the VM
    // feed-publisher writes finished live-data files to the site
    // repo as single writer.                                [PRD §2]
    keyPosture: 'keyed-actions',
    custodyRecord: 'files/prd/PRD-000-detroit.md §2 (Project 30 keyless split)',
    // DDOT BusTime posture: documented default cap 10,000/day;
    // increase request (50,000 asked / 25,000 acceptable) sent
    // 2026-10-15, pending; current draw ≈2,040–2,400 calls/day.
    //                                                    [PRD §2/§8]
    licenseNotes: Object.freeze([
      'DDOT vehicle positions via Clever Devices BusTime API; daily transaction cap (documented default 10,000/day) [PRD §2]',
      'SMART live data via Swiftly is DISPLAY-ONLY under Swiftly license §4(vi) — it never enters computation, telemetry, or the data-lake corpus [PRD §2/§7]',
      'SMART scheduled service is in the planner from SMART\'s own published GTFS static [PRD §2]',
    ]),
    // Display-only fence (LT-F4 / T6 E7): the SMART Swiftly family
    // is display-only. The entry names the feed FAMILY 'smart',
    // which is a declared family below (validator G2 + F1 checks:
    // assets.liveData.displayVehicles/displayTripUpdates carry
    // feed 'smart', a member of this list).                  [PRD §2]
    displayOnlyFeeds: Object.freeze(['smart']),
  }),

  // ---- Feeds ------------------------------------------------------------
  feeds: Object.freeze({
    static: Object.freeze([
      Object.freeze({
        id: 'ddot-static',
        family: 'ddot',
        feedVersion: 'S1000182', //                            [feed_info.txt, ddot_gtfs_S1000182.zip]
        validity: Object.freeze({ start: '2026-09-07', end: '2027-02-07' }), // [feed_info.txt feed_start/end_date]
        bytes: 9369841, //                                     [zip on file, forge-line gtfs/]
        md5: '087181130349f913b5dcaeb8f6fb8db6', //            [PIN gtfsSourcesForG3IndependentRead feed 0]
      }),
      Object.freeze({
        id: 'smart-static',
        family: 'smart',
        feedVersion: 'S1000147', //                            [feed_info.txt, smart_gtfs_S1000147.zip]
        validity: Object.freeze({ start: '2026-09-07', end: '2027-01-03' }), // [feed_info.txt]
        bytes: 8057478, //                                     [zip on file, forge-line gtfs/]
        md5: '466e58d9f591baeaaadb5a3a72ed88c4', //            [PIN gtfsSourcesForG3IndependentRead feed 1]
      }),
      Object.freeze({
        id: 'qline-static',
        family: 'qline',
        // QLINE enters as a static geometry layer, not a planner
        // feed: provenance is the routes file's own meta (QLINE
        // GTFS published by Trillium, feed qline-mi-us, stops.txt
        // + shapes.txt, dated 2026-10-14). No feed_info validity
        // window is on record for it (LT-F7: honest nulls). [SRV qline-3d.json meta, fetched 2026-10-31]
        feedVersion: 'qline-mi-us',
        validity: Object.freeze({ start: null, end: null }),
        provenance: 'QLINE GTFS published by Trillium (feed qline-mi-us): stops.txt and shapes.txt [qline-3d.json meta, 2026-10-14]',
      }),
    ]),
    // GTFS-RT / realtime sources, collected keyless in GitHub
    // Actions (Project 30). No endpoint URL is stated in the
    // estate records consulted for DDOT BusTime or SMART Swiftly,
    // so no url field is carried (LT-F6/F7) — ids/families/kinds
    // are the recorded facts.                               [PRD §2; CEN §D]
    realtime: Object.freeze([
      Object.freeze({ id: 'ddot-vp', family: 'ddot', kind: 'vehicle-positions' }), // DDOT via Clever Devices BusTime API [PRD §2]
      Object.freeze({ id: 'ddot-sa', family: 'ddot', kind: 'service-alerts' }), // DDOT BusTime bulletins [SRV M alert block comment]
      Object.freeze({ id: 'smart-vp', family: 'smart', kind: 'vehicle-positions' }), // SMART via Swiftly, DISPLAY-ONLY §4(vi) [PRD §2]
      Object.freeze({ id: 'smart-tu', family: 'smart', kind: 'trip-updates' }), // SMART via Swiftly, DISPLAY-ONLY §4(vi) [PRD §2]
      Object.freeze({ id: 'qline-vp', family: 'qline', kind: 'vehicle-positions' }), // QLINE via its public GTFS-RT feed [SRV H fine print]
    ]),
  }),

  // ---- Layer groups -----------------------------------------------------
  // Groups mirror the city's structure FROM THE DATA FILES: the
  // three routes files carry five groups (DDOT file: ConnectTen /
  // Primary / Neighborhood service tiers; SMART file: SMART; QLINE
  // file: QLINE Streetcar) — ids/labels verbatim from the served
  // files' `groups` arrays (fetched 2026-10-31). Core renderer +
  // surfaces key group state on route.group, which takes exactly
  // these ids. All default ON (2026-10-31 direction: every group
  // starts on for a fresh profile, M:7816-7819).
  // Persistence: the monolith persists ONLY the SMART toggle
  // (lt-smart-on, M:7826/7842); every other group is session-only.
  // Fold semantics (core surfaces groupPersistEnabled): persist
  // === false => the toggle is NEVER WRITTEN to storage. (The core
  // boot/filter read path still reads each group's storageKey —
  // the non-SMART keys below are inert, never written by the
  // monolith or the bundle, so no stored value can exist for
  // them; read-vs-persist Δ recorded for T6.3 in the T6.2 report.)
  layerGroups: Object.freeze([
    Object.freeze({ id: 'connect-ten', label: 'ConnectTen', defaultOn: true, storageKey: 'det-layer-connect-ten', persist: false }), // [SRV ddot-routes-3d.json groups]
    Object.freeze({ id: 'primary', label: 'Primary', defaultOn: true, storageKey: 'det-layer-primary', persist: false }), // [SRV ddot-routes-3d.json groups]
    Object.freeze({ id: 'neighborhood', label: 'Neighborhood', defaultOn: true, storageKey: 'det-layer-neighborhood', persist: false }), // [SRV ddot-routes-3d.json groups]
    Object.freeze({ id: 'smart', label: 'SMART', defaultOn: true, storageKey: 'lt-smart-on', persist: true }), // [SRV smart-routes-3d.json groups; M:7826 lt-smart-on]
    Object.freeze({ id: 'qline', label: 'QLINE Streetcar', defaultOn: true, storageKey: 'det-layer-qline', persist: false }), // [SRV qline-3d.json groups]
  ]),

  // ---- Geometry & assets ------------------------------------------------
  // Paths are CONFIG-VERBATIM relative URLs resolved against the
  // DOCUMENT base; Detroit's document is the root /live-transit.html
  // (E2 root-city exception), so root-relative estate paths resolve
  // at root — the root data assets are referenced IN PLACE, never
  // copied into the bundle (T6 graph N7).                    [T6 E2]
  assets: Object.freeze({
    streets: 'assets/detroit-streets.json', //                 [SRV M:12149]
    streetNames: 'assets/detroit-street-names.json', //        [SRV M:12152]
    water: 'assets/detroit-water.json', //                     [SRV M:12478]
    landmarks: 'landmarks.json', //                            [SRV M:12489]
    // No standalone stops doc exists for Detroit: stops live
    // inside the three routes files. With routesRegistry present
    // the core boot SKIPS the assets.stops fetch (surfaces
    // bootBrowser: registry supersedes the standalone stops doc),
    // so the key is omitted rather than pointed at a 404. [CEN CG-3]
    routesByFeed: Object.freeze({
      ddot: 'ddot-routes-3d.json', //                          [SRV M:12144]
      smart: 'smart-routes-3d.json', //                        [SRV M:12158]
      qline: 'qline-3d.json', //                               [SRV M:12161]
    }),
    // CG-3 merged registry: the three files concatenated in this
    // order with fixed segments (DDOT 0–5123, SMART 5124–10560,
    // QLINE 10561–10582; total 10,583 = the registry). Stop
    // counts measured from the served files this run. SMART
    // routes are recoloured uniformly to SMART red at merge
    // (M:12184); the street-extension tier is shown only while
    // the SMART group is displayed (M:7719-7725, syncStreetExt) —
    // the gated DECISION is folded in core; the visual tier
    // itself is parked (fold record, CG-3 sub-item). [CEN CG-3]
    routesRegistry: Object.freeze({
      files: Object.freeze(['ddot-routes-3d.json', 'smart-routes-3d.json', 'qline-3d.json']),
      segments: Object.freeze([
        Object.freeze({ feed: 'ddot', stopCount: 5124 }), //  [SRV served file stops count]
        Object.freeze({ feed: 'smart', stopCount: 5437 }), // [SRV served file stops count]
        Object.freeze({ feed: 'qline', stopCount: 22 }), //   [SRV served file stops count]
      ]),
      recolor: Object.freeze({ smart: '#c30915' }), //        [SRV M:12184]
      streetExtGatedByGroup: 'smart', //                       [SRV M:7719-7725]
    }),
    provenanceManifest: 'geometry-manifest.json', // served 200 this run, 309,208 B, MD5 cb9121338ef3298b9b7ad8080057c5ca [SRV fetch 2026-10-31]
    // Planner assets: the merged DDOT+SMART timetable (the bundle
    // carries its own copy under planner/assets/, T6.2 base).
    plannerTimetable: 'planner-timetable-S1000182-S1000147.json', // [SRV M:4536]
    plannerTimetableMd5: '2d37c09898e3fef66862db8989ffda03', // [PIN asset md5; == golden-corpus build copy]
    // E4: Detroit declares the REAL sidecar the T6.2 base builds
    // from the asset (compiler-derived, verified 10,561 rows);
    // core surfaces hardcodes planner/assets/stops-sidecar.json
    // as the stopsUrl — this declaration names the same file.
    //                                                    [CEN §C E4]
    plannerStops: 'planner/assets/stops-sidecar.json',
    // Published live-data family (root live-data/, chain-owned —
    // never in the ship set, T6 N7/ES-3).
    liveData: Object.freeze({
      vehicles: 'live-data/vehicles.json', // canonical envelope; sources {ddot,smart,qline} ok [SRV H:1137 + M:9713; coordinator-verified]
      alerts: 'live-data/alerts.json', //                     [SRV M:10442]
      // BLOCKER (T6.3 / T6.3b chain tranche owns disposition):
      // NO KAES-21 trip-updates file exists for Detroit today —
      // live-data/trip-updates.json is 404 and the SMART file
      // below FAILS KAES-21 envelope validation (Swiftly shape).
      // This value names the family-pattern path the chain will
      // publish (honest empty-envelope publication, T6.4 harness
      // statement); it is NOT pointed at the SMART display file
      // (provenance fence, CEN §D).                          [T6 task record; CEN CG-2]
      tripUpdates: 'live-data/trip-updates.json',
      // CG-1 display-only SMART vehicles (fenced merge; feed must
      // be in agency.displayOnlyFeeds — 'smart' is). Stale gate =
      // monolith SMART_PAYLOAD_STALE_MS 15 min (M:1151). The
      // headsign sidecar currently 404s served; the fold's F2
      // headsign path is failure-tolerant (data-layer
      // ensureDisplayHeadsigns: any failure resolves an empty
      // contribution, never throws — verified T6.2), matching the
      // monolith's null-on-fail.                             [CEN CG-1]
      displayVehicles: Object.freeze([
        Object.freeze({ feed: 'smart', url: 'live-data/smart-display.json', staleMs: 900000, headsignsUrl: 'live-data/smart-headsigns.json' }),
      ]),
      // CG-2 display-only SMART trip updates (fenced reader for
      // stop arrivals; never merged into any planner-read state,
      // M:9731-9734). Stale gate SMART_TU_STALE_MS (CEN CG-2).
      displayTripUpdates: Object.freeze({ feed: 'smart', url: 'live-data/smart-trip-updates.json', staleMs: 900000 }),
    }),
    // Places dataset (LT-KAES-35): a REAL root dataset for
    // Detroit (42 points, H:857) — Starbucks / Planet Fitness
    // partnership placements, default OFF. placesMode 'layer3d'
    // = the Detroit 3D implementation (discs/pillars/badges),
    // not the fleet proximity list.                          [CEN CG-6]
    places: 'places.json',
    placesMode: 'layer3d',
    // Projection origin — read from the routes files at boot by
    // the monolith (M:12196-12201); value = the served files'
    // shared projection (identical in all three files). [SRV routes files]
    projection: Object.freeze({ lat0: 42.381161, lon0: -83.148531 }),
    // CG-12 extra land + fleet models.
    extraLand: Object.freeze(['assets/belle-isle.json']), //  [SRV M:12470]
    fleetModels: 'ddot-fleet.json', //                         [SRV M:12146]
    // CG-4 static layers: the People Mover elevated loop.
    // defaultOn FALSE — the served JS is authoritative
    // (pmVisible = false, "OFF by default: user enables via
    // pm-toggle"); the served HTML's aria-pressed="true" on
    // #pm-toggle contradicts it (monolith-internal Δ, CEN CG-4).
    staticLayers: Object.freeze([
      Object.freeze({ id: 'people-mover', label: 'People Mover loop', asset: 'peoplemover-3d.json', defaultOn: false, deckY: 140 }), // [SRV H:861 label; M:951-961 PM_DECK_Y = 140]
    ]),
    // CG-5 external layers: MoGo bikeshare GBFS. Toggle default
    // OFF (H:863 aria-pressed="false"); poll = MOGO_POLL_MS.
    externalLayers: Object.freeze([
      Object.freeze({ id: 'mogo', label: 'MoGo bikeshare', kind: 'gbfs', baseUrl: 'https://detroit.publicbikesystem.net/customer/gbfs/v3.0', pollMs: 60000, defaultOn: false }), // [SRV M:11026+ MOGO_GBFS_BASE / MOGO_POLL_MS = 60000]
    ]),
  }),

  // ---- Freshness & cadence ---------------------------------------------
  freshness: Object.freeze({
    vehiclePollMs: 60000, // 60 s vehicle poll (M: POLL_MS = 60000)
    alertsPollMs: 120000, // 120 s alerts poll (M: startAlertsPoll setInterval 120000)
    // Core semantics: envelope generated_at older than this =>
    // degraded (surfaces evaluateDegradation). Value = the
    // LT-S8.2 platform threshold (fleet reference, Detroit-derived)
    // == the monolith's SMART payload stale gate 900,000 ms.
    // The monolith's SVC_STALE_MS = 720,000 (M:9791) is a distinct
    // surface — the service-notice threshold — and has no config
    // field; recorded here so the two are never conflated. [CEN §C]
    degradedAfterMs: 900000,
    watchdogDispatchAgeSec: 420, // Detroit feed loop: 5-min bundle cadence + 420 s watchdog [loops-and-graphs SOP, Detroit feed loop]
  }),

  // ---- Planner policy ----------------------------------------------------
  planner: Object.freeze({
    // E5 branch (fold-adopted): Detroit's shipped presentation is
    // DIRECT — engine journeys rendered as returned, no archetype
    // selection layer (monolith M:5842-5859; CEN CG-7/§B P1).
    presentation: 'direct',
    // Monolith budgets: user plan {budgetMs: 750} with rollback
    // on meta.reason 'budget' (M:5842-5851); live re-plan
    // {budgetMs: 250} silent-keep (M:5898-5904).        [CEN P4]
    budgetMs: Object.freeze({ plan: 750, replan: 250 }),
    // CG-8 live wiring, all present in the shipped monolith:
    // matcher feeds setLiveDelays per poll (M:9218-9457), fusion
    // annotates journeys (M:5879-5888), guidance derives from
    // live state (M:5925-6075), re-plan runs per poll (M:5893).
    live: Object.freeze({ matcher: true, fusion: true, guidance: true, replan: true }),
    hosting: 'main-thread', //                                [design A.9/C.1]
    // Adopted-set citation pointer (SL-2): the fold build
    // record's disposition — Detroit adopts W0-default-T35-P15
    // as PLATFORM-DEFAULT ADOPTION (adoption ≠ measurement; no
    // Detroit calibration sweep for the selection layer exists
    // and none is implied; the set is DORMANT under 'direct').
    calibrationRecord: 'files/cities-v2-core-fold-build-record-2026-10-31.md (adopted-set disposition)',
    policy: Object.freeze({
      // D1(b) — the platform policy of record, ORIGINATING in
      // the shipped Detroit planner: walk-only is presented ONLY
      // when no transit journey exists in the window. Decided by
      // Justin 2026-10-23 23:07 EDT (recorded in the PHL rebuild
      // foundation; carried fleet-wide as platform policy).
      walkOnlyPresentation: 'B',
      walkOnlyDecision: Object.freeze({
        id: 'D1',
        branch: 'B',
        rule: 'walk-only presented only when no transit journey exists in the window',
        decidedBy: 'Justin',
        decidedAt: '2026-10-23 23:07 EDT',
        source: 'Detroit shipped planner (policy origin) + PHL rebuild D1 record (files/phl-decommission-2026-10-24.md)',
      }),
    }),
    // Platform-default adopted set (see calibrationRecord). The
    // weights below are the CORE SELECTION LIBRARY'S BUILT-IN
    // DEFAULTS, read from core planner/lib/selection.mjs
    // CITY_CONSTANTS placeholder block at T6.2 and proven equal
    // to the lib values the constants gate asserts (signature.mjs
    // DISTANCE_WEIGHTS / NEAR_DUPLICATE_THRESHOLD, archetypes-v2
    // RELIABILITY_TRANSFER_PENALTY_MIN / HEADWAY cap) — NOT copied
    // from any other city's config. Dormant under 'direct'.
    constants: Object.freeze({
      adoptedSet: 'W0-default-T35-P15', // PLATFORM-DEFAULT ADOPTION [FOLD disposition]
      distanceWeights: Object.freeze({
        corridor: 0.35, walkBurden: 0.2, transferDelta: 0.2,
        modeMix: 0.15, transferStopDisplacement: 0.1,
      }), //                                                     [core selection.mjs CITY_CONSTANTS]
      nearDuplicateThreshold: 0.35, //                          [core selection.mjs]
      reliabilityTransferPenaltyMin: 15, //                     [core selection.mjs]
      reliabilityHeadwayCapMin: 60, //                          [core selection.mjs]
      selectionMode: 'frequency-aware', // core SELECTION_MODE; dormant under 'direct'
      enumerationCapMin: 120, // core CAP_SEC = 120 min (LT-N9); dormant under 'direct'
      flatFloorSec: 1800, // core FLAT_BOUND_SEC (LT-N9); dormant under 'direct'
    }),
    // Walk model — monolith seeds: ≤400 m, walk = max(60,
    // round(d/1.4)) (M:5703-5711); engine cap MAX_WALK_SECS =
    // 1800 (engine L155).                                    [CEN B6]
    walkModel: Object.freeze({
      edgeRadiusM: 400,
      speedMps: 1.4,
      perEdgeFloorSec: 60,
      maxWalkSecsPerRound: 1800,
    }),
    // Engine pairing (LT-N12): the set-model engine, byte-
    // identical to the served raptor-v2.js (core pin
    // t1-extract-1+4143b18f).                                [PIN]
    engine: Object.freeze({
      serviceModel: 'set',
      requiredExport: 'servicesFor',
      stagedMd5: '6746dfbc3aae7c531e42206478d572da',
      goldenPairs: '11 golden OD pairs (golden-corpus-2026-10-30)', // [PRD §4; PIN]
    }),
    // Density descriptors — measured from Detroit's own GTFS +
    // merged asset 2026-10-22 (LT-N7 inputs).                [PRD §4]
    density: Object.freeze({
      d1StopsPerKm2: 3.87, // combined hull basis (DDOT 9.81 / SMART 1.99 per-feed) [PRD §4 D1 from stops.txt]
      d1WalkProximityShare: 0.9982, // 10,508 / 10,527 served stops with a walk-graph neighbor [PRD §4]
      d2PairsSharingStop: 0.1259, // 418 / 3,321 route pairs share a stop [PRD §4]
      d3HeadwayMediansMin: Object.freeze({ peak: 45, midday: 58, evening: 50, weekend: 60 }), // [PRD §4]
      d4Top1Share: 0.4, // 2 of 5 transfer events, thin sample (11 golden pairs) [PRD §4]
      d4Top3Share: 0.8, // same thin sample [PRD §4]
    }),
  }),

  // ---- Commercial position (LT-F1) ---------------------------------------
  commercial: Object.freeze({
    ridersPay: false, // Riders never pay. AUTOMATEDTECHNOLOGIES collects, directly. [LT-F1]
    adsOnMap: false, // No ads on the map. Ever. (LT-F2)
    // Places per-layer price: UNDECIDED — Justin's decision,
    // parked in PRD §8; the layer does not wait for the price.
    // Consumer-investment line: a partner invests the (unset)
    // layer price + listing preparation; riders invest nothing
    // (layer is default-off and labeled "Sponsored").   [PRD §5/§8]
    placesPrice: null,
    placesPriceState: 'UNDECIDED',
  }),

  // ---- Posture (schema v2 §C.2) -------------------------------------------
  posture: Object.freeze({
    model: 'live', // live vehicle layer [CEN B5]
    degradation: Object.freeze({
      evaluateLiveStaleness: true, // reconciled fleet baseline (served behavior)
    }),
    servicePresence: Object.freeze({
      rule: 'vehicles-or-unassigned-none', // C4 generalized [C.2]
      serviceHours: Object.freeze({ model: 'always', windows: Object.freeze([]) }),
      lowServiceShape: null,
    }),
    nonPublication: null,
  }),

  // ---- Ops (schema v2 §C.3) -----------------------------------------------
  ops: Object.freeze({
    chainUnits: Object.freeze({
      cityTimerUnit: 'feed-publisher.timer', // VM feed-publisher, single writer [PRD §2; hourly-check-554: "Timers feed-publisher + feed-driver active"]
      watchdogHook: 'feed-driver.timer', // feed-driver v3 [loops-and-graphs SOP, Detroit feed loop; hourly-check-554]
    }),
    telemetry: Object.freeze({
      state: 'live', // telemetry file publishes on the chain (data/latest.json; hourly-verified, 0 SMART by construction) [CEN CG-13]
      decisionRecord: null, // no single decision-record identifier on file (LT-F7)
    }),
    // CG-13 client recovery stack, all present in the monolith:
    // error log to sessionStorage 'fl-errlog' (M:94-206),
    // recovery ladder (ladderReload/recoverReload), frame
    // watchdog gap 5,000 ms (M:12738-12748), feed-history
    // instant paint from HISTORY_URL (M:12104-12130).
    clientRecovery: Object.freeze({
      errorLogKey: 'fl-errlog',
      ladder: true,
      frameWatchdogMs: 5000,
      historyUrl: 'https://raw.githubusercontent.com/smit4786/forge-line-transit-data/main/data/latest.json',
    }),
  }),

  // ---- Release (schema v2 §C.3) --------------------------------------------
  release: Object.freeze({
    corePin: 't1-extract-1', // core of record is t1-extract-1+4143b18f at T6.2 [FOLD outcomes]
    canary: false, // the ONE standing canary estate-wide is San Diego (CV2-D11)
  }),

  // ---- Fares (optional, schema v2 §C.3) -------------------------------------
  // A figure exists only with its citation (LT-F6): the DDOT
  // GTFS itself carries fare products. SMART's feed carries NO
  // fare data (FARES-ABSENT, compiler capability census) — no
  // SMART figure is asserted here. dayCap: no daily-cap product
  // is carried in the feed (the $5 reg_24HR product is a 24-hour
  // pass, not a cap) => null, honest.
  fares: Object.freeze({
    base: 2, dayCap: null, currency: 'USD',
    source: 'DDOT GTFS S1000182 fare_attributes.txt: fare_id regular, price 2.00 USD (compiler capability census, T6.2 work/compiler-out/build-record.json)',
  }),

  // ---- Scene / motion / alert FX / filters / beta (schema v2.2 fold) --------
  scene: Object.freeze({
    // Water colours asserted by hourly-check-554 against the
    // monolith: deep 0x0f2233, neon 0x00e5ff (decimals here).
    waterColors: Object.freeze({ deep: 991795, neon: 58879 }), // 0x0f2233 / 0x00e5ff [CEN CG-12]
    stopLodDistM: 26000, // STOP_LOD_DIST = 26000 (M)          [CEN CG-12]
    streetView: true, // enterStreetView/exitStreetView (M:1911-2333) [CEN CG-12]
    // Camera memory exists (camMem, M:2141-2166) but is
    // IN-MEMORY ONLY — no storage key exists in the served JS
    // (grep: no localStorage camera key) => null.             [CEN CG-12]
    cameraMemoryKey: null,
  }),
  motion: Object.freeze({
    empirical: true, // empiricalSpeed + timing cells + local speedmap (M:8850-9054) [CEN CG-9]
    timingCellsUrl: 'https://raw.githubusercontent.com/smit4786/forge-line-transit-data/main/data/timing/segments.json', // [SRV M:9037 fetchTimingCells]
    speedmapStorageKey: 'fl-speedmap-v1', //                   [SRV M:8988-8994]
  }),
  alertsFx: Object.freeze({
    mapFx: true, // 3D glyphs / pulse rings / detour ribbons (M:9986-10300+) [CEN CG-11]
  }),
  filters: Object.freeze({
    perRouteChips: true, // per-route chips in the filter panel [CEN CG-10]
    // CURRENT production default (20261031-0645 ship): hideIdle
    // FALSE — filterState initial (M:7555) and the all-groups-on
    // ship record; census CG-10 predates that ship, served JS
    // wins. (The served HTML's hide-idle toggle aria-pressed
    // predates the same ship; JS state is authoritative.)
    hideIdle: false,
    hideIdleExemptRoutes: Object.freeze(['QLINE']), // M:7587-7590: rid !== 'QLINE' guard [CEN CG-10]
    nearMeRouteFilter: true, // near-me route filter w/ snapshot-restore (M:7610-7629) [CEN CG-10]
  }),
  betaFeatures: Object.freeze({
    // First-view/filter beta tiles, each defaults OFF until the
    // rider opts in, each persists in its own key (M:10744-10771;
    // toggles H:845-855). Keys below are the toggle stems; labels
    // verbatim from the served buttons.
    tiles: Object.freeze([
      Object.freeze({ key: 'stop-tiles', label: 'Stop tiles', storageKey: 'lt-stop-tiles', defaultOn: false }),
      Object.freeze({ key: 'upcoming-stops', label: 'Upcoming stops', storageKey: 'lt-upcoming-stops', defaultOn: false }),
      Object.freeze({ key: 'suggest-transfer', label: 'Suggest transfer', storageKey: 'lt-suggest-transfer', defaultOn: false }),
    ]),
    suggestDepartures: true, // betaSuggest() departure suggestions (M:10773+) [CEN CG-14]
  }),

  // ---- Page shell prose (schema v2.1, T2) -----------------------------------
  // Extracted from the SERVED Detroit site-shell page this run
  // (live-transit.html MD5 7501f2bbb56efb309bf571e5b2c5b4fc;
  // HTML entities decoded). Detroit's shell is the full site
  // shell, NOT the fleet LT template — root-emit (T6.3) owns how
  // these values are carried; they are recorded here as the
  // page's prose of record. Canonical URL is NOT stored — it is
  // the E2 exception value in city.canonicalPath.
  page: Object.freeze({
    title: 'Live Transit Detroit — Real-Time DDOT Bus Tracker in 3D', // [SRV H <title>]
    metaDescription: 'Every DDOT bus live in 3D; SMART buses shown live under license. Positions publish about every five minutes — the map dead-reckons between updates.', // [SRV H:10]
    h1: 'Live transit <span class="accent">· Detroit</span>', // [SRV H:761, inner HTML verbatim]
    intro: '83 routes and 10,583 stops drawn on the actual streets of Detroit — DDOT, SMART, and the QLINE streetcar — with live vehicle positions, published about every five minutes.', // [SRV H:1064 Help lede — the shell's intro prose]
    statusText: 'connecting…', // [SRV H:764 #bus-updated initial text]
    plannerLine: ' — this page shows live bus positions; the trip planner uses scheduled times.', // [SRV H:856 filter-panel planner note, the shell's planner line]
    canvasAriaLabel: '3D map of DDOT, SMART, and QLINE routes with live bus positions', // [SRV H:756 #live-map role=img aria-label]
    aboutCoverage: 'Route shapes and stop positions come from the agencies’ published GTFS schedule data; the bus markers are live vehicle positions from the agencies’ own feeds, published about every five minutes. Zoom in close and the markers resolve into true-scale bus models — each DDOT bus is matched to its fleet model (dimensions and seating from the DDOT fleet roster) and oriented to its reported heading. It is the same live layer that powered the retired Forge Line page’s bus count — the Forge Line concept itself was modeled on the transit Detroit already runs.', // [SRV H:1091 About prose]
    aboutLicense: 'Route shapes & stops: DDOT, SMART, and QLINE GTFS. Bus dimensions & seating: DDOT fleet roster via CPTDB wiki. Street underlay: U.S. Census Bureau TIGER/Line 2025 (Wayne, Oakland & Macomb counties). Live data: DDOT via Clever Devices BusTime; SMART via Swiftly GTFS-Realtime; QLINE via its public GTFS-RT feed. Trademark notice: DDOT is a service mark of the City of Detroit. SMART is a service mark of the Suburban Mobility Authority for Regional Transportation. This is an unofficial project by Detroit Automation Academy — not affiliated with, endorsed by, or acting on behalf of DDOT, SMART, or the City of Detroit.', // [SRV H:1092-1093 fine print]
    terms: false, // no bundle terms.html: Detroit terms live at /live-transit/terms/ (footer H) + Help link live-transit-detroit/terms/ (H:1080) — a per-city page, never a bundle file [CEN A17]
    // CG-6 sponsored-span contract: the monolith toggles these
    // IDs (M:12068-12072); the hourly (a) assertion names them.
    sponsoredSpanIds: Object.freeze({ tag: 'places-sponsored-tag', note: 'places-sponsored-note' }), // [SRV H:857-858]
    // CG-14 Passes browse tab (M:3416-3435 openPasses; pane
    // H:891-916). Disclaimer verbatim H:892. Pass rows/prices
    // are page content; the config carries the tab's outbound
    // links as served.
    passesTab: Object.freeze({
      links: Object.freeze([
        Object.freeze({ label: 'Buy in Token Transit', url: 'https://tokentransit.com/app' }), // [SRV H:894-908 pass rows]
        Object.freeze({ label: 'Buy from SMART', url: 'https://www.smartbus.org/Fares/Buy-Passes' }), // [SRV H:911-912]
        Object.freeze({ label: 'Buy in Transit app', url: 'https://transitapp.com/download.html' }), // [SRV H:916]
        Object.freeze({ label: 'SMART Buy Passes page', url: 'https://www.smartbus.org/Fares/Buy-Passes' }), // [SRV H:916]
        Object.freeze({ label: 'DDOT fares page', url: 'https://detroitmi.gov/departments/detroit-department-transportation/transportation-fares' }), // [SRV H:916]
      ]),
      disclaimer: 'Dart passes are sold by DDOT and SMART through their apps and stores. Live Transit does not sell passes.', // [SRV H:892]
    }),
    boardLink: 'board/', // stop-card departure-board link [SRV H:962; CEN §A.4]
  }),

  // ---- Persisted rider state (LT-KAES-37) -----------------------------------
  storageKeys: Object.freeze({
    launcherSheet: 'lt-fv-sheet', // FV_SHEET_KEY (M:10480 area) [CEN §C]
    // Core-usage check (T6.2): core surfaces consumes ONLY
    // storageKeys.launcherSheet (surfaces L2145/L2550);
    // storageKeys.panel is NOT read anywhere in core — it is a
    // declaration key (fleet configs carry single keys, e.g.
    // 'sd-panel'). The monolith's panel geometry lives in the
    // lt-panel-w / lt-panel-h / lt-panel-min family (M) — a
    // PREFIX family rooted at this value, recorded as such for
    // T6.3.                                                  [CEN §C]
    panel: 'lt-panel',
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
