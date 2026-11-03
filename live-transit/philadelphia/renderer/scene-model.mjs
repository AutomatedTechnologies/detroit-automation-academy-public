// renderer/scene-model.mjs — the renderer's scene, as data.
// PHL REBUILD R3 (LT-KAES-09/12/13/14/15). Label: UNVERIFIED /
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

export function createSceneModel({ width = 960, height = 640 } = {}) {
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
  };
  for (const g of CITY_CONFIG.layerGroups) S.groups[g.id] = g.defaultOn === true;

  function loadGeometry({ streets, routesByFeed, stops, water, landmarks, names }) {
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
    // the staged PHL family carries all three — harness asserts).
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
    S.extent = extentOfRoutes(routesByFeed);
    S.loaded = true;
    recompute();
    return S;
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
      S.glyphs.push({
        record: r, x, z, kind, stale,
        routeId: route ? route.id : null,
        group: route ? route.group : null,
        color: route ? route.color : null,
        classification: cls,
      });
    }
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
    stats, pick, pickFromClient, screenOf,
    fitToExtent(pad) { return camera.fitToExtent(S.extent, pad); },
    get extent() { return S.extent; },
    get loaded() { return S.loaded; },
  };
}
