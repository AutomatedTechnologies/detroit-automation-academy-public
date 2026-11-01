// renderer/scene-model.mjs — the renderer's scene, as data.
// Platform rebuild R3 (LT-KAES-09/12/13/14/15). Label: UNVERIFIED /
// legacy-unsigned.
//
// The scene model is the single source the browser renderer
// materializes into THREE objects AND the picker resolves against —
// scene-true picking (KAES-14) by construction: a pick measures
// against the same projected positions, ribbon paths, and glyph
// set the frame draws, projected through the same camera model.
//
// Layer set (KAES-13, Detroit parity):
//   streets (tiered LineSegments geometry, per LT-G3 flat format)
//   water polygons + tributary lines + river labels (KAES-13)
//   landmark masses (extruded footprints) + landmark labels
//   street-name label anchors (pooled sprites in the renderer)
//   route deck ribbons: glow 230 m / case 95 m / deck 72 m +
//     skirts, Chaikin x2, per route group (KAES-09 / LT-G2)
//   route labels at longest-path midpoints (+ tethers)
//   stops (one instanced cloud; per-group visibility)
//   vehicle glyphs (see setVehicles for the glyph contract)
//
// Visibility: group visibility is model state; stats() counts
// exactly what the current view state draws (LT-G15 / RC5 family).

import { CITY_CONFIG } from '../config/city-config.mjs';
import { createProjector } from '../platform/projector.mjs';
import { PICK_TOL_PX, NO_HIT_GUARD_PX, toCanvasPoint, withinPickBand, beyondNoHitGuard } from '../platform/picking.mjs';
import { ribbonGeometry, skirtGeometry, prismGeometry, triangulateRing, extentOfRoutes, chaikin } from './geometry.mjs';
import { createCamera } from './camera.mjs';
import {
  MOTION, buildArcs, matchFix, createTracker, observeFix, predictStep,
  staleFixPoint, parseTimingCells, bucketFor, createSpeedmap, empiricalSpeedFrom,
} from './motion.mjs';

// ---- Cities V2 core fold (F5) — config-gated mechanisms -------------
// Every mechanism below reads ONLY optional config fields (F0
// contract, schema v2.2): a field absent = the mechanism is off and
// the code path is unreachable, so the fleet's rendered output is
// unchanged. No city/agency/product literal appears in this file;
// every city-specific value arrives via CITY_CONFIG.
const CFG = CITY_CONFIG || {};
const ASSETS = CFG.assets || {};
const SCENE_CFG = CFG.scene || {};
const MOTION_CFG = CFG.motion || {};
const ALERTS_FX_ON = !!(CFG.alertsFx && CFG.alertsFx.mapFx === true);
const MOTION_ON = MOTION_CFG.empirical === true;
const PLACES_3D_ON = ASSETS.placesMode === 'layer3d';
const STREET_VIEW_ON = SCENE_CFG.streetView === true;
const CAMERA_MEMORY_KEY = typeof SCENE_CFG.cameraMemoryKey === 'string' && SCENE_CFG.cameraMemoryKey
  ? SCENE_CFG.cameraMemoryKey : null;
const FLEET_MODELS_ON = !!ASSETS.fleetModels;
const STATIC_LAYER_ENTRIES = Array.isArray(ASSETS.staticLayers) ? ASSETS.staticLayers : [];
const EXTERNAL_LAYER_ENTRIES = Array.isArray(ASSETS.externalLayers) ? ASSETS.externalLayers : [];
const EXTRA_LAND_ASSETS = Array.isArray(ASSETS.extraLand) ? ASSETS.extraLand : [];

/** Default deck height for a static layer whose entry omits deckY
 *  (the monolith's elevated-guideway deck height, census CG-4). */
export const STATIC_LAYER_DEFAULT_DECK_Y = 140;
export const STATIC_LAYER_DECK_WIDTH_M = 14;

/** Stop LOD distance (CG-12): config override or the standing
 *  default (the monolith's STOP_LOD_DIST, census CG-12). */
export const STOP_LOD_DEFAULT_M = 26000;
export function stopLodDistM() {
  return typeof SCENE_CFG.stopLodDistM === 'number' && SCENE_CFG.stopLodDistM > 0
    ? SCENE_CFG.stopLodDistM : STOP_LOD_DEFAULT_M;
}

/** Water colours (CG-12): config overrides or the standing colours. */
export function waterColors() {
  const wc = SCENE_CFG.waterColors || {};
  return {
    deep: typeof wc.deep === 'number' ? wc.deep : WATER_COLOR,
    neon: typeof wc.neon === 'number' ? wc.neon : null,
  };
}

/** Places 3D constants (CG-6, monolith places* semantics). */
export const PLACES_3D = Object.freeze({
  discH: 16, discBaseD: 64, discK: 0.0146,
  pillarH: 48, pillarR: 5, glowK: 2.2, glowOpacity: 0.5,
  badgeY: 16 + 48 + 26,
});

/** Fleet true-scale LOD (CG-12): symbolic glyphs wide, true-scale
 *  models inside ~2.6 km, with the monolith's hysteresis band. */
export const FLEET_LOD = Object.freeze({ enterM: 2600, exitM: 3400 });
export function fleetLodDecision(distanceM, currentMode) {
  if (!FLEET_MODELS_ON) return 'glyph';
  if (currentMode !== 'model' && distanceM < FLEET_LOD.enterM) return 'model';
  if (currentMode === 'model' && distanceM > FLEET_LOD.exitM) return 'glyph';
  return currentMode === 'model' ? 'model' : 'glyph';
}

/** Street-view camera mode distances (CG-12, monolith semantics). */
export const STREET_VIEW = Object.freeze({ enterDistM: 1500, exitDistM: 2600, anchorRadiusM: 900 });

/** Extra-land pass colours (CG-12): filled land polygon + shore
 *  stroke, rendered with the water/land pass. */
export const EXTRA_LAND = Object.freeze({ fillColor: 0x08130c, shoreColor: 0x14532d, y: 3 });

/** Alert FX vocabulary (CG-11, monolith ALERT_FX semantics):
 *  effect -> glyph/label/colour. GTFS effect names, no city data. */
export const ALERT_FX = Object.freeze({
  NO_SERVICE: { glyph: '✕', label: 'No service', css: '#FF8A80' },
  DETOUR: { glyph: '↪', label: 'Detour', css: '#FF8A80' },
  REDUCED_SERVICE: { glyph: '◑', label: 'Reduced service', css: '#FFB000' },
  STOP_MOVED: { glyph: '⇄', label: 'Stop moved', css: '#4D96FF' },
  INFO: { glyph: 'ℹ', label: 'Notice', css: '#9AA0A6' },
});
export const ALERT_FX_FALLBACK = Object.freeze({ glyph: '⚠', label: 'Service alert', css: '#FF8A80' });
export function alertFxFor(effect) {
  if (effect && ALERT_FX[effect]) return ALERT_FX[effect];
  if (effect === 'SIGNIFICANT_DELAYS' || effect === 'MODIFIED_SERVICE' || effect === 'ACCESSIBILITY_ISSUE') {
    return { glyph: '⚠', label: ALERT_FX_FALLBACK.label, css: '#FF8A80' };
  }
  if (effect === 'ADDITIONAL_SERVICE') return ALERT_FX.INFO;
  return ALERT_FX_FALLBACK;
}
/** Pulse-ring phase (monolith alertPulseTick): scale/opacity at t. */
export function alertPulsePhase(timeMs, phase = 0) {
  const s = Math.sin(timeMs / 420 + phase);
  return { scale: 1 + 0.3 * s, opacity: 0.95 - 0.4 * (0.5 + 0.5 * s) };
}

function hexColor(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
    if (m) return parseInt(m[1], 16);
  }
  return fallback;
}

export const GLYPH = Object.freeze({
  RESOLVED: 'resolved',       // route-coloured disc sprite (TRIP/ROUTE-MATCHED)
  UNASSIGNED: 'unassigned',   // designed state: muted hollow diamond (KAES-25)
  STALE: 'stale',             // resolved but fix aged past the stale band
});

// Per-vehicle stale band: a resolved record whose updated_at is
// older than (envelope generated_at - STALE_AFTER_SEC) renders in
// the stale state (KAES-15 / LT-S3.2 stale chip analogue in-scene).
export const STALE_AFTER_SEC = 180;

// Deck heights (Detroit layer cake): routes stagger so crossings
// never z-fight; streets/water sit at ground tiers.
export const HEIGHTS = Object.freeze({
  water: 6, waterLine: 8,
  streetFreeway: 16, streetArterial: 15, streetLocal: 14,
  landmarkBase: 0,
  deckBase: 66, deckPerRoute: 1.2,
  glowBase: 2, caseBase: 24,
  labelY: 1050,
});

const TIER_Y = { freeway: HEIGHTS.streetFreeway, arterial: HEIGHTS.streetArterial, local: HEIGHTS.streetLocal };
const TIER_COLOR = { freeway: 0x8a94a0, arterial: 0x4d5763, local: 0x333c46 };
export const WATER_COLOR = 0x14405e;
export const LANDMARK_COLOR = 0x3a4a5c;
export const UNASSIGNED_COLOR = 0x8a8f98;

/** Route resolution with the R2-measured OWL rule (base id fallback). */
export function resolveRouteId(routeById, routeId) {
  if (!routeId) return null;
  if (routeById[routeId]) return routeById[routeId];
  const base = String(routeId).split('_')[0];
  if (base !== routeId && routeById[base]) return routeById[base];
  return null;
}

export function createSceneModel({ width = 960, height = 640, storage = null } = {}) {
  const projector = createProjector(CITY_CONFIG.assets.projection);
  const camera = createCamera({ width, height });
  const S = {
    projector, camera,
    loaded: false,
    extent: null,
    groups: {},            // groupId -> bool (from config defaults)
    routes: [],            // route records (both feeds merged at render, LT-F5(b))
    routeById: {},
    feedOfRoute: {},       // routeId -> 'bus' | 'rail'
    ribbons: [],           // {routeId, group, pathIndex, glow, case, deck, skirt, yDeck}
    routeLabels: [],       // {routeId, text, x, z, y}
    streetTiers: {},       // tier -> {segments, positions(Float32Array), color, y}
    streetSegmentsTotal: 0,
    water: { polygons: [], lines: [], labels: [] },
    landmarks: [],         // {name, height_m, prism, x, z}
    streetNameAnchors: [], // [name, x, z, class]
    stops: [],             // stop records with group set derived from routes
    stopGroups: new Map(), // stopId -> Set(groupId)
    glyphs: [],            // vehicle glyphs (see setVehicles)
    hiddenRoutes: new Set(), // per-route filter (R5 / LT-KAES-33): route ids
                             // the rider filtered out; EMPTY by default, and an
                             // empty set is exactly the R3 behaviour.
    feedState: null,       // {generated_at, sources} of the last vehicles envelope
    counts: null,          // last computed stats
    // --- F5 fold state (all empty/off unless config-gated on) ---
    staticLayers: [],      // CG-4 [{id,label,deckY,visible,color,ribbons,stations,pillars}]
    staticLayerById: {},
    externalStations: {},  // CG-5 layerId -> [{record, id, name, x, z, layerId}]
    externalVisibility: {},// CG-5 layerId -> bool
    places3d: [],          // CG-6 [{record, x, z, disc, pillar, glow, badge}]
    placesVisible: false,  // CG-6 session toggle, default off (monolith)
    landPolygons: [],      // CG-12 extraLand [{name, polygon, y, fillColor, shoreColor}]
    fleetRanges: null,     // CG-12 fleet model ranges doc (loaded)
    fleetMode: 'glyph',    // CG-12 LOD decision state ('glyph' | 'model')
    alertFx: null,         // CG-11 {glyphs, pulseRings, ribbons, stops} | null
    streetView: false,     // CG-12 street-view camera mode active
    motion: null,          // CG-9 motion state (created below iff gated)
  };
  if (MOTION_ON) {
    S.motion = {
      enabled: true,
      trackers: new Map(),   // vehicle_id -> Kalman tracker (motion.mjs)
      arcsByRoute: new Map(),// routeId -> arcs | null
      segTableByRoute: new Map(),
      timingCells: null,     // parsed timing-cells map (motion prior only)
      timingCellsUrl: typeof MOTION_CFG.timingCellsUrl === 'string' ? MOTION_CFG.timingCellsUrl : null,
      // L2 baseline stays DISABLED exactly as in the monolith:
      // timing cells load for the motion prior only; no dep/arr
      // L2 offsets are produced anywhere in this stack.
      l2Baseline: 'disabled',
      speedmap: createSpeedmap(
        typeof MOTION_CFG.speedmapStorageKey === 'string' ? MOTION_CFG.speedmapStorageKey : null,
        storage),
      lastAdvanceMs: null,
      lastPollMs: null,
    };
  }
  for (const e of EXTERNAL_LAYER_ENTRIES) {
    S.externalVisibility[e.id] = e.defaultOn === true;
  }
  for (const g of CITY_CONFIG.layerGroups) S.groups[g.id] = g.defaultOn === true;

  function loadGeometry({ streets, routesByFeed, stops, water, landmarks, names,
    staticLayers = null, extraLand = null, fleetModels = null, places = null }) {
    // Projection origin is one shared plane per city (S10): a
    // dataset at a different origin is rejected at import (LT-G3).
    for (const [label, doc] of [['streets', streets], ['stops', stops],
      ...Object.entries(routesByFeed).map(([k, v]) => [`routes:${k}`, v])]) {
      // LT-G3 streets carry the origin at meta.projection; the
      // routes/stops family carries it at top level.
      const p = doc && (doc.projection || (doc.meta && doc.meta.projection));
      if (!p || p.lat0 !== projector.lat0 || p.lon0 !== projector.lon0) {
        throw new Error(`geometry origin mismatch in ${label}: ${JSON.stringify(p)} != config projection`);
      }
    }
    // streets: LT-G3 flat tiers — every 4-tuple is one segment.
    S.streetTiers = {};
    S.streetSegmentsTotal = 0;
    for (const tier of ['freeway', 'arterial', 'local']) {
      const arr = streets[tier] || [];
      const n = arr.length / 4;
      const pos = new Float32Array(n * 6);
      for (let i = 0; i < n; i++) {
        pos[i * 6] = arr[i * 4]; pos[i * 6 + 1] = TIER_Y[tier]; pos[i * 6 + 2] = arr[i * 4 + 1];
        pos[i * 6 + 3] = arr[i * 4 + 2]; pos[i * 6 + 4] = TIER_Y[tier]; pos[i * 6 + 5] = arr[i * 4 + 3];
      }
      S.streetTiers[tier] = { segments: n, positions: pos, color: TIER_COLOR[tier], y: TIER_Y[tier] };
      S.streetSegmentsTotal += n;
    }
    // routes: deck ribbons per path (glow/case/deck/skirt).
    S.routes = [];
    S.routeById = {};
    S.feedOfRoute = {};
    S.ribbons = [];
    S.routeLabels = [];
    let ri = 0;
    for (const [feed, doc] of Object.entries(routesByFeed)) {
      for (const r of doc.routes) {
        S.routes.push(r);
        S.routeById[r.id] = r;
        S.feedOfRoute[r.id] = feed;
        const yDeck = HEIGHTS.deckBase + ri * HEIGHTS.deckPerRoute;
        const yGlow = HEIGHTS.glowBase + ri * 0.25;
        const yCase = HEIGHTS.caseBase + ri * 0.15;
        let longest = null;
        r.paths.forEach((path, pathIndex) => {
          if (path.length < 2) return;
          S.ribbons.push({
            routeId: r.id, group: r.group, pathIndex, path,
            glow: ribbonGeometry(path, 230, yGlow),
            casing: ribbonGeometry(path, 95, yCase),
            deck: ribbonGeometry(path, 72, yDeck),
            skirt: skirtGeometry(path, 72, yDeck),
            yDeck,
          });
          if (!longest || path.length > longest.length) longest = path;
        });
        if (longest) {
          const mid = longest[Math.floor(longest.length / 2)];
          const text = (r.name === r.id || String(r.short) === String(r.id))
            ? String(r.name) : `${r.name} - ${r.id}`;
          S.routeLabels.push({ routeId: r.id, group: r.group, text, x: mid[0], z: mid[1], y: HEIGHTS.labelY });
        }
        ri++;
      }
    }
    // stops: group membership derives from the routes serving them.
    S.stops = stops.stops || [];
    S.stopGroups = new Map();
    for (const st of S.stops) {
      const gs = new Set();
      for (const rid of st.r || []) {
        const route = S.routeById[rid];
        if (route) gs.add(route.group);
      }
      S.stopGroups.set(st.id, gs);
    }
    // water / landmarks / names (each optional in the doc set, but
    // the staged family carries all three — harness asserts).
    S.water = {
      polygons: (water && water.polygons) || [],
      lines: (water && water.lines) || [],
      labels: (water && water.labels) || [],
    };
    S.landmarks = ((landmarks && landmarks.landmarks) || []).map((l) => ({
      name: l.name, kind: l.kind, height_m: l.height_m,
      prism: prismGeometry(l.footprint, l.height_m),
      x: l.cx, z: l.cz,
    }));
    S.streetNameAnchors = (names && names.labels) || [];
    // F5 fold assets (each present only when its config gate is on;
    // absent = the state above stays exactly as it was).
    if (staticLayers && typeof staticLayers === 'object') {
      for (const entry of STATIC_LAYER_ENTRIES) {
        const doc = staticLayers[entry.id] ?? staticLayers[entry.asset];
        if (doc) loadStaticLayer(entry, doc);
      }
    }
    if (Array.isArray(extraLand)) for (const doc of extraLand) loadExtraLand(doc);
    if (fleetModels) loadFleetModels(fleetModels);
    if (places) setPlaces(places);
    S.extent = extentOfRoutes(routesByFeed);
    S.loaded = true;
    recompute();
    return S;
  }

  // ================= F5 fold mechanisms (config-gated) =================

  /** A point as [x, z]: array form, {x, z} form, or {lat, lon}. */
  function xyOf(p) {
    if (!p) return null;
    if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number') return [p[0], p[1]];
    if (typeof p.x === 'number' && typeof p.z === 'number') return [p.x, p.z];
    if (typeof p.lat === 'number' && typeof p.lon === 'number') return projector.project(p.lat, p.lon);
    return null;
  }

  // ---- CG-4: static layers -------------------------------------------
  /**
   * Load one configured static layer's asset. Asset shape follows
   * the geometry-loader conventions: a routes-family doc
   * ({routes:[{paths, color?}], stations|stops:[...]}), a guideway
   * doc ({loop|paths, stations|stops}), or both. Line geometry
   * becomes an elevated deck ribbon at entry.deckY (default
   * STATIC_LAYER_DEFAULT_DECK_Y); stations become pickable station
   * records; support pillars stand only at stations (monolith).
   */
  function loadStaticLayer(entry, doc) {
    if (!entry || !entry.id || !doc || typeof doc !== 'object') return null;
    const p = doc.projection || (doc.meta && doc.meta.projection);
    if (p && (p.lat0 !== projector.lat0 || p.lon0 !== projector.lon0)) {
      throw new Error(`geometry origin mismatch in static layer ${entry.id}`);
    }
    const deckY = typeof entry.deckY === 'number' ? entry.deckY : STATIC_LAYER_DEFAULT_DECK_Y;
    const paths = [];
    if (Array.isArray(doc.loop) && doc.loop.length >= 2) paths.push(doc.loop);
    for (const path of doc.paths || []) if (Array.isArray(path) && path.length >= 2) paths.push(path);
    let color = hexColor(entry.color ?? doc.color, 0x9aa0a6);
    for (const r of doc.routes || []) {
      for (const path of r.paths || []) if (Array.isArray(path) && path.length >= 2) paths.push(path);
      if (r.color != null) color = hexColor(r.color, color);
    }
    const ribbons = paths.map((path, pathIndex) => ({
      layerId: entry.id, pathIndex, path, yDeck: deckY,
      deck: ribbonGeometry(path, STATIC_LAYER_DECK_WIDTH_M, deckY),
    }));
    const rawStations = doc.stations || doc.stops || [];
    const stations = [];
    rawStations.forEach((s, i) => {
      const xy = xyOf(s);
      if (!xy) return;
      stations.push({
        id: s.id != null ? String(s.id) : `${entry.id}-${i}`,
        n: s.n || s.name || String(s.id != null ? s.id : i),
        x: xy[0], z: xy[1], r: Array.isArray(s.r) ? s.r : [],
        layerId: entry.id, staticLayer: true,
      });
    });
    const layer = {
      id: entry.id, label: entry.label || entry.id, deckY,
      visible: entry.defaultOn === true, color, ribbons, stations,
      // Support pillars only at known station points (no infill).
      pillars: stations.map((s) => ({ x: s.x, z: s.z, y0: 0, y1: deckY })),
    };
    const prev = S.staticLayerById[entry.id];
    if (prev) S.staticLayers[S.staticLayers.indexOf(prev)] = layer;
    else S.staticLayers.push(layer);
    S.staticLayerById[entry.id] = layer;
    recompute();
    return layer;
  }
  function setStaticLayerVisible(id, on) {
    const layer = S.staticLayerById[id];
    if (!layer) return false;
    layer.visible = !!on;
    recompute();
    return true;
  }
  function staticLayerVisible(id) {
    const layer = S.staticLayerById[id];
    return layer ? layer.visible : false;
  }

  // ---- CG-12: extra land polygons --------------------------------------
  /**
   * Register one additional land-polygon asset with the water/land
   * pass. Shapes: {polygon:[[x,z]...]}, {polygons:[{polygon|rings}]},
   * {rings:[...]}, or a bare array of polygons/rings.
   */
  function loadExtraLand(doc, name) {
    if (!doc) return 0;
    const p = doc.projection || (doc.meta && doc.meta.projection);
    if (p && (p.lat0 !== projector.lat0 || p.lon0 !== projector.lon0)) {
      throw new Error('geometry origin mismatch in extra land asset');
    }
    let added = 0;
    const push = (polygon, label) => {
      if (Array.isArray(polygon) && polygon.length >= 3) {
        S.landPolygons.push({
          name: label || (doc && doc.name) || 'land',
          polygon, y: EXTRA_LAND.y,
          fillColor: EXTRA_LAND.fillColor, shoreColor: EXTRA_LAND.shoreColor,
        });
        added++;
      }
    };
    if (Array.isArray(doc)) for (const item of doc) push(item && (item.polygon || (Array.isArray(item) ? item : null)), item && item.name);
    else if (Array.isArray(doc.polygon)) push(doc.polygon, name || doc.name);
    else if (Array.isArray(doc.polygons)) {
      for (const poly of doc.polygons) {
        if (Array.isArray(poly)) push(poly, name);
        else if (poly) push(poly.polygon || (poly.rings && poly.rings[0]), poly.name || name);
      }
    } else if (Array.isArray(doc.rings) && doc.rings.length) push(doc.rings[0], name || doc.name);
    else if (Array.isArray(doc.land)) for (const item of doc.land) push(item && (item.polygon || item), item && item.name);
    if (added) recompute();
    return added;
  }

  // ---- CG-12: fleet true-scale models ----------------------------------
  /** Load the fleet model set: {ranges:[{from,to,model,length_m,
   *  width_m,height_m,seats,...}]} (monolith fleet-data shape). */
  function loadFleetModels(doc) {
    if (!doc || !Array.isArray(doc.ranges)) return false;
    S.fleetRanges = doc.ranges;
    // Backfill glyphs that arrived before the model set loaded.
    for (const g of S.glyphs) g.fleet = fleetLookup(g.record && g.record.vehicle_id);
    recompute();
    return true;
  }
  /** Model record for a vehicle id (numeric prefix range match,
   *  monolith semantics); an assumed standard vehicle otherwise. */
  function fleetLookup(vehicleId) {
    const fallback = {
      model: 'standard transit vehicle', detail: 'model assumed',
      length_m: 12.19, width_m: 2.59, height_m: 3.3, seats: null, assumed: true,
    };
    if (!S.fleetRanges) return fallback;
    const m = String(vehicleId == null ? '' : vehicleId).match(/^(\d+)/);
    if (!m) return fallback;
    const num = parseInt(m[1], 10);
    for (const r of S.fleetRanges) {
      if (num >= r.from && num <= r.to) {
        return {
          model: r.model,
          detail: (r.year || '') + (r.note ? ` · ${r.note}` : ''),
          length_m: r.length_m, width_m: r.width_m, height_m: r.height_m,
          seats: r.seats != null ? r.seats : null, assumed: false,
        };
      }
    }
    return fallback;
  }
  /** LOD swap decision for a camera distance (hysteresis, CG-12). */
  function updateFleetLod(distanceM) {
    S.fleetMode = fleetLodDecision(distanceM, S.fleetMode);
    return S.fleetMode;
  }

  // ---- CG-6: places as a 3D layer ---------------------------------------
  /**
   * Set the places dataset (array, or {places:[...]}). Each place
   * becomes a disc + pillar + glow + badge model entry (monolith
   * places semantics, PLACES_3D constants). No-op returning 0 when
   * cfg.assets.placesMode is not 'layer3d' — proximity mode keeps
   * today's behaviour (no places geometry).
   */
  function setPlaces(dataset) {
    if (!PLACES_3D_ON) return 0;
    const list = Array.isArray(dataset) ? dataset : (dataset && dataset.places) || [];
    S.places3d = [];
    for (const rec of list) {
      if (!rec) continue;
      const xy = xyOf(rec);
      if (!xy) continue;
      const color = hexColor(rec.color, 0x8a8f98);
      S.places3d.push({
        record: rec, id: rec.id != null ? String(rec.id) : null,
        name: rec.name || rec.n || '', x: xy[0], z: xy[1],
        disc: { diameter: PLACES_3D.discBaseD, height: PLACES_3D.discH, color },
        pillar: { height: PLACES_3D.pillarH, radius: PLACES_3D.pillarR, color },
        glow: { diameter: PLACES_3D.discBaseD * PLACES_3D.glowK, opacity: PLACES_3D.glowOpacity, color },
        badge: { text: rec.badge || '', y: PLACES_3D.badgeY, color },
      });
    }
    recompute();
    return S.places3d.length;
  }
  function setPlacesVisible(on) {
    if (!PLACES_3D_ON) return false;
    S.placesVisible = !!on;
    recompute();
    return S.placesVisible;
  }

  // ---- CG-5: external-layer station markers ------------------------------
  /**
   * Supply one external layer's station records (from the data
   * layer's records, through this seam). Records keep their object
   * identity: picking returns the record itself so surfaces can
   * card it. Positions: {lat, lon} or {x, z} (or nested
   * record.position / record.station of either form).
   */
  function setExternalStations(layerId, records) {
    if (!layerId || !Array.isArray(records)) return 0;
    const out = [];
    records.forEach((rec, i) => {
      if (!rec) return;
      const xy = xyOf(rec) || xyOf(rec.position) || xyOf(rec.station);
      if (!xy) return;
      out.push({
        record: rec, layerId,
        id: rec.id != null ? String(rec.id) : (rec.station_id != null ? String(rec.station_id) : `${layerId}-${i}`),
        name: rec.name || rec.n || '',
        x: xy[0], z: xy[1],
      });
    });
    S.externalStations[layerId] = out;
    if (!(layerId in S.externalVisibility)) S.externalVisibility[layerId] = true;
    recompute();
    return out.length;
  }
  function setExternalLayerVisible(layerId, on) {
    S.externalVisibility[layerId] = !!on;
    recompute();
    return S.externalVisibility[layerId];
  }
  function externalLayerVisible(layerId) {
    return S.externalVisibility[layerId] !== false
      && Array.isArray(S.externalStations[layerId]);
  }

  // ---- CG-9: motion (dead-reckoning + Kalman + empirical prior) ---------
  function routeArcs(routeId) {
    const M = S.motion;
    if (!M) return null;
    if (M.arcsByRoute.has(routeId)) return M.arcsByRoute.get(routeId);
    const route = resolveRouteId(S.routeById, routeId);
    const arcs = route ? buildArcs(route.paths) : null;
    M.arcsByRoute.set(routeId, arcs);
    return arcs;
  }
  /** Stop-pair segments of a route, ordered along its shape arcs
   *  (monolith routeSegments): stops within 120 m of an arc join it. */
  function routeSegments(routeId) {
    const M = S.motion;
    if (!M) return [];
    if (M.segTableByRoute.has(routeId)) return M.segTableByRoute.get(routeId);
    const segs = [];
    const route = resolveRouteId(S.routeById, routeId);
    const arcs = routeArcs(routeId);
    if (route && arcs) {
      const perPath = arcs.map(() => []);
      for (const st of S.stops) {
        if (!(st.r || []).includes(route.id)) continue;
        let best = null;
        arcs.forEach((arc, pi) => {
          // nearestOnArc over this arc (arc-local, via motion.mjs)
          let bD = Infinity, bS = 0;
          for (let i = 0; i < arc.pts.length - 1; i++) {
            const ax = arc.pts[i][0], az = arc.pts[i][1];
            const dx = arc.pts[i + 1][0] - ax, dz = arc.pts[i + 1][1] - az;
            const l2 = dx * dx + dz * dz;
            let t = l2 > 0 ? ((st.x - ax) * dx + (st.z - az) * dz) / l2 : 0;
            t = Math.max(0, Math.min(1, t));
            const d = Math.hypot(st.x - (ax + dx * t), st.z - (az + dz * t));
            if (d < bD) { bD = d; bS = arc.cum[i] + Math.sqrt(l2) * t; }
          }
          if (bD < 120 && (!best || bD < best.dist)) best = { pathIdx: pi, s: bS, dist: bD };
        });
        if (best) perPath[best.pathIdx].push({ id: st.id, s: best.s });
      }
      perPath.forEach((list, pi) => {
        list.sort((a, b) => a.s - b.s);
        for (let i = 0; i + 1 < list.length; i++) {
          if (list[i + 1].s - list[i].s < 5) continue;
          segs.push({ from: list[i].id, to: list[i + 1].id, s0: list[i].s, s1: list[i + 1].s, pathIdx: pi });
        }
      });
    }
    M.segTableByRoute.set(routeId, segs);
    return segs;
  }
  function segmentAt(routeId, pathIdx, s) {
    const segs = routeSegments(routeId);
    for (const g of segs) if (g.pathIdx === pathIdx && s >= g.s0 && s <= g.s1) return g;
    let best = null;
    for (const h of segs) {
      if (h.pathIdx !== pathIdx || h.s1 < s) continue;
      if (!best || h.s0 < best.s0) best = h;
    }
    return best;
  }
  /**
   * Empirical speed (m/s) for a route segment, or null. Exported
   * for surfaces' suggestion consumers. Gate-off = always null.
   * seg may be {from, to} or a segmentAt() result.
   */
  function empiricalSpeed(routeId, seg, nowMs) {
    const M = S.motion;
    if (!M || !seg) return null;
    return empiricalSpeedFrom({
      timingCells: M.timingCells, speedmap: M.speedmap,
      routeId, seg,
      bucket: bucketFor(nowMs != null ? nowMs : Date.now(), CFG.city && CFG.city.timezone),
      nowMs: nowMs != null ? nowMs : Date.now(),
    });
  }
  /** Fetch the empirical timing cells (motion prior ONLY — the L2
   *  baseline stays disabled; see motion.mjs). fetchImpl follows
   *  the platform loader's injectable shape; a stub may resolve a
   *  Response-like {ok, json()} or the parsed document itself. */
  async function loadTimingCells(fetchImpl) {
    const M = S.motion;
    if (!M || !M.timingCellsUrl) return null;
    const f = fetchImpl || globalThis.fetch;
    if (typeof f !== 'function') return null;
    try {
      const res = await f(M.timingCellsUrl, { cache: 'no-store' });
      const doc = res && typeof res.json === 'function'
        ? (res.ok === false ? null : await res.json()) : res;
      M.timingCells = parseTimingCells(doc);
    } catch (e) { /* keep the previous cache; the local map covers */ }
    return M.timingCells;
  }
  /** Reconcile one vehicle record into its motion tracker. */
  function motionObserve(record, route, x, z, nowMs) {
    const M = S.motion;
    if (!M || !record || record.vehicle_id == null || !route) return null;
    const vid = String(record.vehicle_id);
    let tr = M.trackers.get(vid);
    if (!tr || tr.routeId !== route.id) {
      tr = createTracker(vid, route.id);
      M.trackers.set(vid, tr);
    }
    tr.lastX = x; tr.lastZ = z;
    const arcs = routeArcs(route.id);
    const match = arcs ? matchFix(arcs, x, z, record.bearing, tr.arc ? tr : null) : null;
    const inst = typeof record.speed_mph === 'number' && record.speed_mph >= 0
      ? record.speed_mph * MOTION.MPH_TO_MPS : null;
    // Learn: observed along-track speed between consecutive matched
    // polls feeds the local speedmap (the empirical prior).
    if (match && match.dist <= MOTION.OFFSHAPE_M && tr.matchS != null
        && tr.matchPath === match.pathIdx && M.lastPollMs) {
      const dtP = (nowMs - M.lastPollMs) / 1000;
      if (dtP > 20 && dtP < 150) {
        const obsV = (match.s - tr.matchS) / dtP;
        if (Math.abs(obsV) < 31.3) {
          const segMid = segmentAt(route.id, match.pathIdx, (match.s + tr.matchS) / 2);
          if (segMid) M.speedmap.observe(M.speedmap.key(route.id, segMid), Math.max(0, obsV), nowMs);
        }
      }
    }
    observeFix(tr, match, inst, nowMs);
    return tr;
  }
  /**
   * Advance every tracked glyph to nowMs: dead-reckoning along the
   * route arc under the Kalman state, with the empirical prior
   * revising velocity downward only. Past the horizon the glyph
   * holds at the last matched fix. Returns the number moved.
   * Gate-off: no-op, glyphs stay exactly as published.
   */
  function advanceMotion(nowMs) {
    const M = S.motion;
    if (!M) return 0;
    // Elapsed step since the last advance; the horizon rule inside
    // predictStep bounds how far a stale fix can carry a glyph.
    const stepS = M.lastAdvanceMs != null ? Math.max(0, (nowMs - M.lastAdvanceMs) / 1000) : 0;
    M.lastAdvanceMs = nowMs;
    let moved = 0;
    for (const g of S.glyphs) {
      const tr = g.motion;
      if (!tr) continue;
      if (!tr.arc) continue; // raw (detour) fix: hold, as the monolith
      if (!g.motionSeg || g.motionSegPath !== tr.pathIdx
          || tr.kS < g.motionSeg.s0 || tr.kS > g.motionSeg.s1) {
        g.motionSeg = segmentAt(tr.routeId, tr.pathIdx, tr.kS);
        g.motionSegPath = tr.pathIdx;
      }
      const vEmp = empiricalSpeed(tr.routeId, g.motionSeg, nowMs);
      const pt = predictStep(tr, stepS, nowMs, vEmp);
      if (!pt) {
        // Past the horizon: hold at the last matched fix.
        const fp = staleFixPoint(tr);
        if (fp && (Math.abs(fp.x - g.x) > 0.01 || Math.abs(fp.z - g.z) > 0.01)) {
          g.x = fp.x; g.z = fp.z; moved++;
        }
        continue;
      }
      if (Math.abs(pt.x - g.x) > 0.01 || Math.abs(pt.z - g.z) > 0.01) {
        g.x = pt.x; g.z = pt.z; g.heading = Math.atan2(pt.dx, pt.dz);
        moved++;
      }
    }
    if (moved) recompute();
    return moved;
  }

  // ---- CG-11: alert map FX ----------------------------------------------
  /**
   * Build the alert-FX model from an alerts envelope ({alerts:[...]})
   * or a bare list. Accepts both record shapes in the estate: the
   * monolith shape ({routes, stops, effect, active_period, kind})
   * and the core shape ({informed_entities:[{route_id, stop_id}],
   * active_periods:[{start_epoch, end_epoch}], effect}).
   * Planned notices draw NO map geometry (monolith rule); INFO and
   * unlisted effects draw none either. Gate-off: no-op, null.
   */
  function setAlerts(envelope, nowMs) {
    if (!ALERTS_FX_ON) { S.alertFx = null; return null; }
    const list = Array.isArray(envelope) ? envelope : (envelope && envelope.alerts) || [];
    const now = nowMs != null ? nowMs : Date.now();
    const fx = { glyphs: [], pulseRings: [], ribbons: [], stops: [] };
    const stopById = new Map(S.stops.map((s) => [String(s.id), s]));
    const isActive = (a) => {
      if (Array.isArray(a.active_periods) && a.active_periods.length) {
        return a.active_periods.some((p) => {
          const st = typeof p.start_epoch === 'number' ? p.start_epoch * 1000 : -Infinity;
          const en = typeof p.end_epoch === 'number' ? p.end_epoch * 1000 : Infinity;
          return now >= st && now <= en;
        });
      }
      const p = a.active_period || {};
      const st = p.start ? Date.parse(p.start) : NaN;
      const en = p.end ? Date.parse(p.end) : NaN;
      if (Number.isFinite(st) && now < st) return false;
      if (Number.isFinite(en) && now > en) return false;
      return true;
    };
    const routesOf = (a) => {
      const out = new Set();
      for (const rid of a.routes || []) out.add(String(rid));
      for (const e of a.informed_entities || []) if (e.route_id) out.add(String(e.route_id));
      return [...out];
    };
    const stopsOf = (a) => {
      const out = new Set();
      for (const sid of a.stops || []) out.add(String(sid));
      for (const e of a.informed_entities || []) if (e.stop_id) out.add(String(e.stop_id));
      return [...out];
    };
    for (const a of list) {
      if (!a || a.kind === 'planned' || !isActive(a)) continue;
      const fxv = alertFxFor(a.effect);
      for (const rid of routesOf(a)) {
        const route = resolveRouteId(S.routeById, rid);
        if (!route || !route.paths) continue;
        const namedStops = stopsOf(a)
          .map((sid) => stopById.get(sid))
          .filter((st) => st && (st.r || []).includes(route.id));
        const y = HEIGHTS.deckBase + 3;
        const addGlyph = (x, z, scale) => fx.glyphs.push({
          alertId: a.id || null, routeId: route.id, effect: a.effect || null,
          glyph: fxv.glyph, label: fxv.label, colorCss: fxv.css, x, z, y: y + 130, scale,
        });
        const addPulse = (st) => fx.pulseRings.push({
          alertId: a.id || null, stopId: String(st.id), x: st.x, z: st.z, y: 22,
          rInner: 34, rOuter: 58, color: 0xffb000, phase: fx.pulseRings.length * 1.7,
        });
        if (a.effect === 'NO_SERVICE' || a.effect === 'DETOUR') {
          for (const span of alertSpanPaths(route, namedStops)) {
            if (a.effect === 'NO_SERVICE') {
              fx.ribbons.push({ alertId: a.id || null, routeId: route.id, kind: 'fade', path: span, width: 78, y, opacity: 0.45 });
            }
            fx.ribbons.push({ alertId: a.id || null, routeId: route.id, kind: 'dash', path: span, width: 78, y: y + 0.7 });
            const mid = span[Math.floor(span.length / 2)];
            addGlyph(mid[0], mid[1], 160);
          }
          for (const st of namedStops) {
            addPulse(st);
            fx.stops.push({ alertId: a.id || null, stopId: String(st.id), x: st.x, z: st.z, effect: a.effect, ring: 'pulse' });
          }
        } else if (a.effect === 'REDUCED_SERVICE') {
          for (const path of route.paths) {
            if (path.length >= 2) fx.ribbons.push({ alertId: a.id || null, routeId: route.id, kind: 'dim', path, width: 78, y, opacity: 0.38 });
          }
        } else if (a.effect === 'STOP_MOVED') {
          for (const st of namedStops) {
            fx.stops.push({ alertId: a.id || null, stopId: String(st.id), x: st.x, z: st.z, effect: a.effect, ring: 'moved' });
            fx.glyphs.push({
              alertId: a.id || null, routeId: route.id, effect: a.effect,
              glyph: fxv.glyph, label: fxv.label, colorCss: fxv.css,
              x: st.x, z: st.z, y: y + 100, scale: 120,
            });
          }
        }
        // INFO / unlisted effects: no map geometry (vocabulary rule).
      }
    }
    S.alertFx = fx;
    recompute();
    return fx;
  }
  /** Route paths, or the sub-span between the named stops when the
   *  alert names stops on the route (monolith alertSpanFor). */
  function alertSpanPaths(route, namedStops) {
    if (!namedStops.length) return (route.paths || []).filter((p) => p.length >= 2);
    let best = null;
    for (const path of route.paths || []) {
      if (!path || path.length < 2) continue;
      const idx = [];
      for (const st of namedStops) {
        let bi = -1, bd = Infinity;
        path.forEach((p, i) => {
          const d = (p[0] - st.x) ** 2 + (p[1] - st.z) ** 2;
          if (d < bd) { bd = d; bi = i; }
        });
        if (bi >= 0 && bd <= 600 * 600) idx.push(bi);
      }
      if (idx.length && (!best || idx.length > best.idx.length)) best = { path, idx };
    }
    if (!best) return (route.paths || []).filter((p) => p.length >= 2);
    let lo = Math.max(0, Math.min(...best.idx) - 1);
    let hi = Math.min(best.path.length - 1, Math.max(...best.idx) + 1);
    if (hi - lo < 1) { lo = Math.max(0, lo - 1); hi = Math.min(best.path.length - 1, hi + 1); }
    return [best.path.slice(lo, hi + 1)];
  }

  // ---- CG-12: street view + camera memory --------------------------------
  /**
   * Enter street-view camera mode (gated by cfg.scene.streetView):
   * the camera closes to street distance over the nearest visible
   * stop to the current target (within STREET_VIEW.anchorRadiusM),
   * or over the target itself. Exit restores no forced move
   * (monolith semantics). Gate-off: no-op returning false.
   */
  function enterStreetView() {
    if (!STREET_VIEW_ON) return false;
    let anchor = null, bd = STREET_VIEW.anchorRadiusM ** 2;
    for (const st of S.stops) {
      if (!stopVisible(st)) continue;
      const d = (st.x - camera.target.x) ** 2 + (st.z - camera.target.z) ** 2;
      if (d < bd) { bd = d; anchor = st; }
    }
    if (anchor) camera.target = { x: anchor.x, z: anchor.z };
    camera.distance = Math.min(camera.distance, STREET_VIEW.enterDistM);
    camera.tiltDeg = Math.max(camera.tiltDeg, 62);
    S.streetView = true;
    return true;
  }
  function exitStreetView() {
    if (!STREET_VIEW_ON) return false;
    S.streetView = false;
    return true;
  }
  /** Persist the camera view under cfg.scene.cameraMemoryKey.
   *  Storage is injected or taken from the model's storage option;
   *  no key configured = no-op returning false. */
  function saveCameraMemory(store) {
    if (!CAMERA_MEMORY_KEY) return false;
    const s = store || storage;
    if (!s || typeof s.setItem !== 'function') return false;
    try { s.setItem(CAMERA_MEMORY_KEY, JSON.stringify(camera.snapshot())); return true; }
    catch (e) { return false; }
  }
  function restoreCameraMemory(store) {
    if (!CAMERA_MEMORY_KEY) return false;
    const s = store || storage;
    if (!s || typeof s.getItem !== 'function') return false;
    try {
      const raw = s.getItem(CAMERA_MEMORY_KEY);
      if (!raw) return false;
      return camera.restoreSnapshot(JSON.parse(raw));
    } catch (e) { return false; }
  }
  /** Stops render (and pick) only inside the stop LOD distance. */
  function stopsWithinLod(cameraDistanceM) {
    return typeof cameraDistanceM === 'number' ? cameraDistanceM <= stopLodDistM() : true;
  }

  /**
   * Vehicle glyphs from R2 canonical records (KAES-15/24/25).
   * Glyph contract:
   *  - TRIP-MATCHED / ROUTE-MATCHED with a resolvable route ->
   *    RESOLVED disc in the route colour. ROUTE-MATCHED keeps the
   *    record surfaced (never absorbed) — its classification rides
   *    on the glyph for the card layer.
   *  - UNASSIGNED (verified descriptor-less, or a route_id that
   *    resolves to no route) -> the DESIGNED unassigned state: a
   *    muted hollow diamond, counted separately, pickable with its
   *    classification disclosed — not invisibility-by-accident
   *    (KAES-25 as the R3 scope files it; see the delivery record
   *    for the RC8/LT-S3.3 reconciliation note).
   *  - RESOLVED but fix aged past STALE_AFTER_SEC vs the envelope's
   *    generated_at -> STALE glyph state (desaturated in-scene).
   * Records without a position draw no glyph (LT-F7).
   */
  function setVehicles(envelope) {
    const records = (envelope && envelope.vehicles) || [];
    const genAt = envelope && envelope.generated_at ? Date.parse(envelope.generated_at) / 1000 : null;
    S.feedState = envelope
      ? { generated_at: envelope.generated_at, sources: envelope.sources || null }
      : null;
    S.glyphs = [];
    for (const r of records) {
      if (typeof r.lat !== 'number' || typeof r.lon !== 'number') continue;
      const [x, z] = projector.project(r.lat, r.lon);
      const route = resolveRouteId(S.routeById, r.route_id);
      const cls = r.classification || (r.trip_id ? 'TRIP-MATCHED' : r.route_id ? 'ROUTE-MATCHED' : 'UNASSIGNED');
      // Resolved requires BOTH a classification that carries a
      // route AND a route_id that resolves; anything else is the
      // designed unassigned state (incl. an unresolved route id).
      let kind = (route && cls !== 'UNASSIGNED') ? GLYPH.RESOLVED : GLYPH.UNASSIGNED;
      let stale = false;
      if (kind === GLYPH.RESOLVED && genAt && r.updated_at) {
        const up = Date.parse(r.updated_at) / 1000;
        if (Number.isFinite(up) && genAt - up > STALE_AFTER_SEC) stale = true;
      }
      if (stale) kind = GLYPH.STALE;
      const glyph = {
        record: r, x, z, kind, stale,
        routeId: route ? route.id : null,
        group: route ? route.group : null,
        color: route ? route.color : null,
        classification: cls,
      };
      // CG-9 (gated): reconcile the record into its motion tracker.
      // The glyph still STARTS at the published fix; advanceMotion
      // moves it between polls. Gate-off: no tracker is created.
      if (S.motion && route) {
        const nowMs = genAt ? genAt * 1000 : Date.now();
        glyph.motion = motionObserve(r, route, x, z, nowMs);
        if (glyph.motion && glyph.motion.arc && glyph.motion.kInit) {
          glyph.motionSeg = segmentAt(route.id, glyph.motion.pathIdx, glyph.motion.kS);
          glyph.motionSegPath = glyph.motion.pathIdx;
        }
      }
      if (S.fleetRanges) glyph.fleet = fleetLookup(r.vehicle_id);
      S.glyphs.push(glyph);
    }
    if (S.motion) S.motion.lastPollMs = genAt ? genAt * 1000 : Date.now();
    recompute();
    return S.glyphs;
  }

  function setGroupVisibility(groupId, on) {
    if (!(groupId in S.groups)) throw new Error(`unknown layer group: ${groupId}`);
    S.groups[groupId] = !!on;
    recompute(); // immediate (RC10): stats reflect the toggle NOW
  }

  /** Per-route filter (R5 / LT-KAES-33): hide or restore ONE route
   *  (its ribbons, its resolved glyphs, its picks). Recompute is
   *  immediate (RC10). With no route hidden this is a no-op against
   *  the R3 behaviour — the filter is a view state, never a data
   *  change: the route stays in S.routes and stays listed in
   *  browse (LT-KAES-39 stay-listed). */
  function setRouteVisibility(routeId, on) {
    if (!S.routeById[routeId]) throw new Error(`unknown route: ${routeId}`);
    if (on) S.hiddenRoutes.delete(routeId);
    else S.hiddenRoutes.add(routeId);
    recompute();
  }
  function routeVisible(routeId) {
    return !S.hiddenRoutes.has(routeId);
  }

  function glyphVisible(g) {
    if (g.kind === GLYPH.UNASSIGNED) return true; // designed state: always drawn
    if (g.routeId && S.hiddenRoutes.has(g.routeId)) return false; // per-route filter (R5)
    return g.group ? S.groups[g.group] !== false : true;
  }
  function stopVisible(st) {
    const gs = S.stopGroups.get(st.id);
    if (!gs || gs.size === 0) return true;
    for (const g of gs) if (S.groups[g]) return true;
    return false;
  }

  /** LT-G15: counts exactly what the current view state draws. */
  function recompute() {
    if (!S.loaded) { S.counts = null; return null; }
    let paths = 0;
    for (const rb of S.ribbons) if (S.groups[rb.group] && !S.hiddenRoutes.has(rb.routeId)) paths++;
    let markers = 0, unassigned = 0, stale = 0;
    for (const g of S.glyphs) {
      if (!glyphVisible(g)) continue;
      if (g.kind === GLYPH.UNASSIGNED) unassigned++;
      else { markers++; if (g.stale) stale++; }
    }
    let stopsVisible = 0;
    for (const st of S.stops) if (stopVisible(st)) stopsVisible++;
    let feedDown = [];
    if (S.feedState && S.feedState.sources) {
      for (const [fam, s] of Object.entries(S.feedState.sources)) {
        if (s && s.ok === false) feedDown.push(fam);
      }
    }
    S.counts = {
      segments: S.streetSegmentsTotal,
      paths,
      markers,
      unassignedMarkers: unassigned,
      staleMarkers: stale,
      routes: S.routes.filter((r) => S.groups[r.group] && !S.hiddenRoutes.has(r.id)).length,
      routesTotal: S.routes.length,
      stops: stopsVisible,
      stopsTotal: S.stops.length,
      waterPolygons: S.water.polygons.length,
      waterLines: S.water.lines.length,
      landmarks: S.landmarks.length,
      streetNameAnchors: S.streetNameAnchors.length,
      routeLabels: S.routeLabels.filter((l) => S.groups[l.group]).length,
      feedDown,
      degraded: feedDown.length > 0,
    };
    // F5 fold counts: keys appear ONLY when the corresponding
    // mechanism carries state, so gate-off stats are byte-shaped
    // exactly as before the fold.
    if (S.staticLayers.length) {
      S.counts.staticLayers = S.staticLayers.filter((l) => l.visible).length;
      S.counts.staticLayerStations = S.staticLayers
        .reduce((n, l) => n + (l.visible ? l.stations.length : 0), 0);
    }
    const extN = Object.entries(S.externalStations)
      .reduce((n, [id, arr]) => n + (S.externalVisibility[id] === false ? 0 : arr.length), 0);
    if (extN || Object.keys(S.externalStations).length) S.counts.externalStations = extN;
    if (PLACES_3D_ON) S.counts.places3d = S.placesVisible ? S.places3d.length : 0;
    if (S.landPolygons.length) S.counts.extraLandPolygons = S.landPolygons.length;
    if (S.alertFx) {
      S.counts.alertGlyphs = S.alertFx.glyphs.length;
      S.counts.alertPulseRings = S.alertFx.pulseRings.length;
      S.counts.alertRibbons = S.alertFx.ribbons.length;
      S.counts.alertStops = S.alertFx.stops.length;
    }
    if (S.motion) S.counts.motionTrackers = S.motion.trackers.size;
    return S.counts;
  }

  function stats() { return S.counts || recompute(); }

  // ---------------- picking (KAES-14 / LT-G14) ----------------
  // Distances are measured on screen through the shared camera
  // model: scene-true, because the positions measured are the
  // scene's own. Priority: vehicles, then stops, then routes.
  // Band rules (platform/picking.mjs): a candidate within
  // PICK_TOL_PX hits; beyond NO_HIT_GUARD_PX nothing can hit; in
  // between, the NEAREST candidate wins (the platform's stated
  // nearest-candidate decision).
  function screenDistToPath(sx, sz, path, y, project) {
    let best = Infinity;
    let prev = null;
    for (const p of path) {
      const sp = project(p[0], y, p[1]);
      if (!sp) { prev = null; continue; }
      if (prev) {
        const dx = sp.x - prev.x, dz = sp.y - prev.y;
        const L2 = dx * dx + dz * dz;
        let t = L2 === 0 ? 0 : ((sx - prev.x) * dx + (sz - prev.y) * dz) / L2;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(sx - (prev.x + t * dx), sz - (prev.y + t * dz));
        if (d < best) best = d;
      } else {
        const d = Math.hypot(sx - sp.x, sz - sp.y);
        if (d < best) best = d;
      }
      prev = sp;
    }
    return best;
  }

  /** pick({x, y}) in CANVAS pixels. null = clean no-op (LT-G14). */
  function pick(point) {
    if (!S.loaded || !point || typeof point.x !== 'number') return null;
    const { x: sx, y: sy } = point;
    const project = camera.projectorFn();
    const cands = [];
    const consider = (kind, payload, d) => {
      if (beyondNoHitGuard(d)) return;
      cands.push({ kind, payload, d });
    };
    for (const g of S.glyphs) {
      if (!glyphVisible(g)) continue;
      const sp = project(g.x, HEIGHTS.deckBase, g.z);
      if (!sp) continue;
      consider(g.kind === GLYPH.UNASSIGNED ? 'vehicle-unassigned' : 'vehicle',
        { record: g.record, glyph: g }, Math.hypot(sx - sp.x, sy - sp.y));
    }
    if (!cands.length) {
      for (const st of S.stops) {
        if (!stopVisible(st)) continue;
        const sp = project(st.x, HEIGHTS.deckBase, st.z);
        if (!sp) continue;
        consider('stop', { stop: st }, Math.hypot(sx - sp.x, sy - sp.y));
      }
      // CG-4 (gated by presence): visible static-layer stations pick
      // as their own kind, carrying the station record.
      for (const layer of S.staticLayers) {
        if (!layer.visible) continue;
        for (const st of layer.stations) {
          const sp = project(st.x, layer.deckY, st.z);
          if (!sp) continue;
          consider('static-station', { stop: st, station: st, layerId: layer.id },
            Math.hypot(sx - sp.x, sy - sp.y));
        }
      }
      // CG-5: external-layer stations pick with their source record
      // (record identity preserved — surfaces card the record).
      for (const [layerId, stations] of Object.entries(S.externalStations)) {
        if (S.externalVisibility[layerId] === false) continue;
        for (const st of stations) {
          const sp = project(st.x, HEIGHTS.deckBase, st.z);
          if (!sp) continue;
          consider('external-station', { record: st.record, station: st, layerId },
            Math.hypot(sx - sp.x, sy - sp.y));
        }
      }
      // CG-6: places pick when the 3D places layer is visible.
      if (PLACES_3D_ON && S.placesVisible) {
        for (const pl of S.places3d) {
          const sp = project(pl.x, HEIGHTS.deckBase, pl.z);
          if (!sp) continue;
          consider('place', { record: pl.record, place: pl },
            Math.hypot(sx - sp.x, sy - sp.y));
        }
      }
    }
    if (!cands.length) {
      // Routes: coarse pass over every 12th compiled vertex prunes
      // the field; only survivors pay the full smoothed-centreline
      // measurement. The Chaikin x2 centreline is what the deck
      // draws, so the fine pass measures against the drawn curve.
      const coarse = [];
      for (const rb of S.ribbons) {
        if (!S.groups[rb.group] || S.hiddenRoutes.has(rb.routeId)) continue;
        let best = Infinity;
        for (let i = 0; i < rb.path.length; i += 12) {
          const sp = project(rb.path[i][0], rb.yDeck, rb.path[i][1]);
          if (!sp) continue;
          const d = Math.hypot(sx - sp.x, sy - sp.y);
          if (d < best) best = d;
        }
        const last = project(rb.path[rb.path.length - 1][0], rb.yDeck, rb.path[rb.path.length - 1][1]);
        if (last) best = Math.min(best, Math.hypot(sx - last.x, sy - last.y));
        if (best <= 90) coarse.push(rb);
      }
      for (const rb of coarse) {
        const line = chaikin(chaikin(rb.path));
        consider('route', { route: S.routeById[rb.routeId], pathIndex: rb.pathIndex },
          screenDistToPath(sx, sy, line, rb.yDeck, project));
      }
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.d - b.d);
    const best = cands[0];
    if (withinPickBand(best.d)) return { kind: best.kind, ...best.payload, distancePx: best.d };
    // band < d <= guard: nearest-candidate decision (platform rule)
    return { kind: best.kind, ...best.payload, distancePx: best.d };
  }

  /** RC1 entry: client/viewport coords + canvas rect -> pick. */
  function pickFromClient(clientX, clientY, canvasRect) {
    return pick(toCanvasPoint(clientX, clientY, canvasRect));
  }

  /** Screen position of a scene point through the shared camera. */
  function screenOf(x, y, z) { return camera.project(x, y, z); }

  return {
    state: S, camera, projector,
    loadGeometry, setVehicles, setGroupVisibility,
    setRouteVisibility, routeVisible,
    // F5 fold seams (each inert when its config gate is off)
    loadStaticLayer, setStaticLayerVisible, staticLayerVisible,
    loadExtraLand, loadFleetModels, fleetLookup, updateFleetLod,
    setPlaces, setPlacesVisible,
    setExternalStations, setExternalLayerVisible, externalLayerVisible,
    empiricalSpeed, loadTimingCells, advanceMotion, routeSegments,
    setAlerts,
    enterStreetView, exitStreetView,
    saveCameraMemory, restoreCameraMemory,
    stopLodDistM, stopsWithinLod, waterColors,
    stats, pick, pickFromClient, screenOf,
    fitToExtent(pad) { return camera.fitToExtent(S.extent, pad); },
    get extent() { return S.extent; },
    get loaded() { return S.loaded; },
  };
}
