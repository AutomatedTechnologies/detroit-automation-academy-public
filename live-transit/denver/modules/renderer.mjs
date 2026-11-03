// modules/renderer.mjs — 3D renderer (LT-KAES-09).
// Platform rebuild R3 implementation, on the R1 contract. Label:
// UNVERIFIED / legacy-unsigned.
//
// What R3 builds here, against the register:
//   - WebGL 3D scene (KAES-09): route geometry as deck ribbons
//     (72 m deck; glow 230 m, case 95 m — LT-G2 reference geometry)
//     with Chaikin x2 smoothing + skirts; vehicles and stops as
//     sprites / point clouds. The scene's data lives in
//     renderer/scene-model.mjs; this module materializes it into
//     THREE objects in the browser and drives the same model
//     headlessly under Node (the harness path).
//   - Perspective camera (KAES-10): renderer/camera.mjs view model
//     (pan/zoom/tilt), synced to the THREE camera + OrbitControls
//     in the browser; fitToExtent frames the measured extent
//     (LT-S2.2/S2.3).
//   - Complete basemap (KAES-13): tiered streets + water polygons
//     and tributary lines + landmarks + street-name label anchors,
//     all staged in the R3 asset family (assets/).
//   - Scene-true picking (KAES-14): pick() resolves through the
//     scene model (the geometry the frame draws) via the platform
//     picking contract — RC1 canvas-rect conversion at
//     pickFromClient, PICK_TOL_PX = 16, 20 px no-hit guard (RC9).
//   - Vehicle glyphs (KAES-15): resolved records as route-coloured
//     sprites with per-vehicle stale state; UNASSIGNED records in
//     the designed unassigned glyph state (KAES-25 — see
//     scene-model.setVehicles and the R3 record).
//
// Vendored library: Three.js r160, declared ONCE in the shell's
// importmap (KAES-05) and imported dynamically inside
// createRenderer() so this module loads under Node without it.

import { CITY_CONFIG } from '../config/city-config.mjs';
import { createProjector } from '../platform/projector.mjs';
import { PICK_TOL_PX, NO_HIT_GUARD_PX } from '../platform/picking.mjs';
import { createSceneModel, GLYPH, HEIGHTS, WATER_COLOR, LANDMARK_COLOR, PLACES_3D, EXTRA_LAND, alertPulsePhase } from '../renderer/scene-model.mjs';
import { ribbonGeometry } from '../renderer/geometry.mjs';

export { GLYPH };

export const RENDER_CONSTANTS = Object.freeze({
  deckWidthM: 72, // LT-G2 reference geometry
  caseWidthM: 95,
  glowWidthM: 230,
  chaikinPasses: 2,
  pickTolPx: PICK_TOL_PX,
  noHitGuardPx: NO_HIT_GUARD_PX,
});

/** Geometry asset URLs the renderer consumes — from config, only. */
export function geometryAssetPaths() {
  const assets = CITY_CONFIG.assets || {};
  const paths = {
    streets: assets.streets,
    routesByFeed: assets.routesByFeed,
    stops: assets.stops,
    provenanceManifest: assets.provenanceManifest,
    water: assets.water,
    landmarks: assets.landmarks,
    streetNames: assets.streetNames,
  };
  // F5 fold (CG-4/CG-5/CG-12): gated asset slots appear ONLY when
  // configured — absent fields keep this shape exactly as before.
  if (Array.isArray(assets.staticLayers) && assets.staticLayers.length) {
    paths.staticLayers = Object.fromEntries(
      assets.staticLayers.map((e) => [e.id, e.asset]));
  }
  if (Array.isArray(assets.extraLand) && assets.extraLand.length) {
    paths.extraLand = assets.extraLand.slice();
  }
  if (assets.fleetModels) paths.fleetModels = assets.fleetModels;
  return paths;
}

function safeLocalStorage() {
  try {
    return (typeof globalThis !== 'undefined' && globalThis.localStorage) || null;
  } catch (e) { return null; }
}

/** The projector for this city, from config's declared origin. */
export function cityProjector() {
  return createProjector(CITY_CONFIG.assets.projection);
}

/**
 * Frame loop (repair 2026-10-25, blank map): drives the draw on
 * the browser's animation clock. The scheduler and the draw are
 * injected so the wiring is harness-testable headlessly — the
 * defect this repairs was exactly that render() existed with no
 * caller, which no headless harness could see.
 */
export function createFrameLoop({ requestFrame, cancelFrame, draw }) {
  let handle = null;
  let stopped = true;
  let frames = 0;
  const tick = () => {
    if (stopped) { handle = null; return; }
    frames += 1;
    draw();
    handle = requestFrame(tick);
  };
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      handle = requestFrame(tick);
    },
    stop() {
      stopped = true;
      if (handle != null && cancelFrame) cancelFrame(handle);
      handle = null;
    },
    frames: () => frames,
    running: () => !stopped,
  };
}

function bufferGeometry(THREE, geo) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(geo.positions, 3));
  if (geo.index) g.setIndex(new THREE.BufferAttribute(geo.index, 1));
  return g;
}

/**
 * Create the renderer. In the browser pass a canvas; under Node
 * (harnesses) pass null/{headless:true} and the renderer runs the
 * full scene model + camera + picking with no GPU — the state the
 * two-pass browser UAT later certifies at pixel level.
 *
 * Contract (R1, as implemented):
 *   loadGeometry({streets, routesByFeed, stops, water, landmarks, names})
 *   setVehicles(vehiclesEnvelope)   // R2 canonical envelope
 *   setGroupVisibility(groupId, on) // immediate recompute (RC10)
 *   pick({x, y}) -> {kind:'vehicle'|'vehicle-unassigned'|'stop'|'route', ...} | null
 *   pickFromClient(clientX, clientY, canvasRect)  // RC1 entry
 *   fitToExtent() / render() / dispose()
 *   stats() -> {segments, paths, markers, ...}  // LT-G15
 */
export async function createRenderer(canvas = null, opts = {}) {
  const width = opts.width || (canvas && canvas.clientWidth) || 960;
  const height = opts.height || (canvas && canvas.clientHeight) || 640;
  const storage = opts.storage !== undefined ? opts.storage : safeLocalStorage();
  const model = createSceneModel({ width, height, storage });
  let cameraMemoryRestored = false;
  // CG-9 (gated inside the model): fetch the empirical timing cells
  // for the motion prior. Fire-and-forget; failure keeps the local
  // speedmap as the prior. The L2 baseline stays disabled.
  if (model.state.motion) {
    model.loadTimingCells(opts.fetchImpl).catch(() => {});
  }
  let THREE = null;
  let gl = null; // {renderer, scene, camera3, controls, groups...}
  let frameLoop = null;

  async function materialize() {
    if (!canvas || typeof document === 'undefined') return false;
    try {
      THREE = await import('three');
    } catch (e) {
      // No importmap in this context: run headless rather than fail.
      console.warn(`[renderer] three unavailable (${e.message}); headless model only`);
      return false;
    }
    const renderer3 = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer3.setSize(model.camera.width, model.camera.height, false);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0e13);
    const camera3 = new THREE.PerspectiveCamera(
      model.camera.fovDeg, model.camera.width / Math.max(1, model.camera.height), 10, 600000);
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(20000, 40000, 12000);
    scene.add(sun);
    let controls = null;
    try {
      const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
      controls = new OrbitControls(camera3, canvas);
      controls.enableDamping = false;
      controls.maxPolarAngle = Math.PI * 0.49;
      controls.addEventListener('change', () => syncModelFromThree());
    } catch (e) { /* controls are an enhancement; the model still drives */ }
    gl = { renderer: renderer3, scene, camera3, controls, dynamic: new THREE.Group() };
    scene.add(gl.dynamic);
    buildStaticLayers();
    buildFoldLayers();
    syncThreeFromModel();
    // Repair 2026-10-25 (blank map): the scene was fully built
    // but never drawn — render() had no caller anywhere in the
    // client, so the canvas kept its clear color while picking
    // (model-space) worked. Start the frame loop: each animation
    // frame syncs the drawing buffer to the canvas size, syncs
    // the camera from the model, and issues the draw.
    frameLoop = createFrameLoop({
      requestFrame: (cb) => requestAnimationFrame(cb),
      cancelFrame: (id) => cancelAnimationFrame(id),
      draw: () => { syncCanvasSize(); drawFrame(); },
    });
    frameLoop.start();
    return true;
  }

  function syncCanvasSize() {
    if (!gl || !canvas) return;
    const w = canvas.clientWidth || 0, h = canvas.clientHeight || 0;
    if (!w || !h) return;
    if (model.camera.width !== w || model.camera.height !== h) {
      model.camera.setViewport(w, h);
      gl.renderer.setSize(w, h, false);
      gl.camera3.aspect = w / h;
      gl.camera3.updateProjectionMatrix();
    }
  }

  function drawFrame() {
    if (!gl) return false;
    foldFrameSync();
    syncThreeFromModel();
    gl.renderer.render(gl.scene, gl.camera3);
    return true;
  }

  function syncThreeFromModel() {
    if (!gl) return;
    const cam = model.camera;
    const eye = cam.eye();
    gl.camera3.position.set(eye[0], eye[1], eye[2]);
    gl.camera3.lookAt(cam.target.x, 0, cam.target.z);
    if (gl.controls) gl.controls.target.set(cam.target.x, 0, cam.target.z);
  }
  function syncModelFromThree() {
    if (!gl || !gl.controls) return;
    const p = gl.camera3.position, t = gl.controls.target;
    const dx = p.x - t.x, dy = p.y, dz = p.z - t.z;
    const cam = model.camera;
    cam.target = { x: t.x, z: t.z };
    cam.distance = Math.hypot(dx, dy, dz);
    cam.tiltDeg = Math.max(8, Math.min(82, (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI));
    cam.azimuthDeg = (Math.atan2(dx, dz) * 180) / Math.PI;
    // CG-12 (gated): persist the rider's framing as it changes.
    model.saveCameraMemory(storage);
  }

  function buildStaticLayers() {
    if (!gl) return;
    const S = model.state;
    const { scene } = gl;
    // streets
    for (const tier of ['freeway', 'arterial', 'local']) {
      const t = S.streetTiers[tier];
      if (!t || !t.segments) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(t.positions, 3));
      const lines = new THREE.LineSegments(g,
        new THREE.LineBasicMaterial({ color: t.color, transparent: true, opacity: 0.9 }));
      lines.frustumCulled = false;
      lines.name = `streets-${tier}`;
      scene.add(lines);
    }
    // water polygons (shape + contained holes) + tributary ribbons
    // CG-12: scene.waterColors overrides when configured; otherwise
    // the standing colours, exactly as before.
    const wc = model.waterColors();
    const waterMat = new THREE.MeshBasicMaterial({ color: wc.deep, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    for (const poly of S.water.polygons) {
      const shapes = [];
      const rings = poly.rings;
      if (rings.length) {
        const outer = rings[0];
        const shape = new THREE.Shape(outer.map((p) => new THREE.Vector2(p[0], -p[1])));
        for (const holeRing of rings.slice(1)) {
          const hx = holeRing.map((p) => p[0]), hz = holeRing.map((p) => p[1]);
          const inside = hx.every((x) => x >= Math.min(...outer.map((p) => p[0])) && x <= Math.max(...outer.map((p) => p[0])));
          if (inside) {
            const hole = new THREE.Path(holeRing.map((p) => new THREE.Vector2(p[0], -p[1])));
            shape.holes.push(hole);
          } else {
            shapes.push(new THREE.Shape(holeRing.map((p) => new THREE.Vector2(p[0], -p[1]))));
          }
          void hz;
        }
        shapes.unshift(shape);
      }
      for (const shape of shapes) {
        const geo = new THREE.ShapeGeometry(shape);
        geo.rotateX(-Math.PI / 2);
        geo.translate(0, HEIGHTS.water, 0);
        const mesh = new THREE.Mesh(geo, waterMat);
        mesh.name = `water-${poly.name || 'unnamed'}`;
        scene.add(mesh);
      }
    }
    const waterLineMat = new THREE.MeshBasicMaterial({ color: wc.neon != null ? wc.neon : WATER_COLOR, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    for (const line of S.water.lines) {
      if (line.path.length < 2) continue;
      const mesh = new THREE.Mesh(bufferGeometry(THREE, ribbonGeometry(line.path, 26, HEIGHTS.waterLine)), waterLineMat);
      mesh.name = `water-line-${line.name}`;
      scene.add(mesh);
    }
    // landmarks: one massing mesh per footprint prism
    const lmMat = new THREE.MeshLambertMaterial({ color: LANDMARK_COLOR });
    for (const lm of S.landmarks) {
      const mesh = new THREE.Mesh(bufferGeometry(THREE, lm.prism), lmMat);
      mesh.frustumCulled = false;
      mesh.name = `landmark-${lm.name}`;
      scene.add(mesh);
    }
    // routes: ribbons per path, grouped by layer group
    gl.routeGroups = {};
    for (const g of CITY_CONFIG.layerGroups) {
      const grp = new THREE.Group();
      grp.name = `routes-${g.id}`;
      scene.add(grp);
      gl.routeGroups[g.id] = grp;
    }
    const casingMat = new THREE.MeshBasicMaterial({ color: 0x0c1116, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
    const byRoute = new Map();
    for (const rb of S.ribbons) {
      if (!byRoute.has(rb.routeId)) byRoute.set(rb.routeId, []);
      byRoute.get(rb.routeId).push(rb);
    }
    for (const [routeId, ribbons] of byRoute) {
      const route = S.routeById[routeId];
      const color = new THREE.Color(route.color);
      const deckMat = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
      const skirtMat = new THREE.MeshLambertMaterial({ color: color.clone().multiplyScalar(0.38), side: THREE.DoubleSide });
      const glowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const grp = new THREE.Group();
      grp.name = `route-${routeId}`;
      for (const rb of ribbons) {
        grp.add(new THREE.Mesh(bufferGeometry(THREE, rb.glow), glowMat));
        grp.add(new THREE.Mesh(bufferGeometry(THREE, rb.casing), casingMat));
        const deck = bufferGeometry(THREE, rb.deck);
        deck.computeVertexNormals();
        grp.add(new THREE.Mesh(deck, deckMat));
        grp.add(new THREE.Mesh(bufferGeometry(THREE, rb.skirt), skirtMat));
      }
      gl.routeGroups[route.group].add(grp);
    }
    // stops: one point cloud
    const stopPos = new Float32Array(S.stops.length * 3);
    S.stops.forEach((st, i) => { stopPos.set([st.x, HEIGHTS.deckBase, st.z], i * 3); });
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(stopPos, 3));
    const points = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0x9fb4c8, size: 5, sizeAttenuation: false }));
    points.name = 'stops';
    points.frustumCulled = false;
    scene.add(points);
    gl.stopsPoints = points;
  }

  // ================= F5 fold GL layers (config-gated) =================
  // Each builder reads model state that stays empty unless its
  // config gate is on, so with gates off these add nothing to the
  // scene. Visual/WebGL parity beyond this materialization is
  // verified at the browser pass (F7/T6.5 territory), not here.

  function buildFoldLayers() {
    if (!gl) return;
    buildStaticLayerGroups();
    buildExtraLandMeshes();
    rebuildPlacesGroup();
    rebuildExternalGroup();
    rebuildAlertFxGroup();
  }

  function buildStaticLayerGroups() {
    if (!gl) return;
    const S = model.state;
    if (gl.staticLayerGroups) {
      for (const grp of Object.values(gl.staticLayerGroups)) gl.scene.remove(grp);
    }
    gl.staticLayerGroups = {};
    for (const layer of S.staticLayers) {
      const grp = new THREE.Group();
      grp.name = `static-layer-${layer.id}`;
      grp.visible = layer.visible;
      const deckMat = new THREE.MeshLambertMaterial({
        color: layer.color, side: THREE.DoubleSide });
      for (const rb of layer.ribbons) {
        grp.add(new THREE.Mesh(bufferGeometry(THREE, rb.deck), deckMat));
      }
      // Station pins + support pillars (stations only, no infill).
      const pinMat = new THREE.MeshLambertMaterial({ color: 0xf5f2ea });
      for (const st of layer.stations) {
        const pin = new THREE.Mesh(new THREE.CylinderGeometry(24, 32, 300, 12), pinMat);
        pin.position.set(st.x, layer.deckY + 150, st.z);
        pin.name = `static-station-${st.id}`;
        grp.add(pin);
        const pillar = new THREE.Mesh(
          new THREE.CylinderGeometry(6, 9, layer.deckY, 10),
          new THREE.MeshLambertMaterial({ color: new THREE.Color(layer.color).multiplyScalar(0.55) }));
        pillar.position.set(st.x, layer.deckY / 2, st.z);
        grp.add(pillar);
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(40, 64, 32),
          new THREE.MeshBasicMaterial({ color: 0xf5f2ea, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(st.x, layer.deckY + 3, st.z);
        grp.add(ring);
      }
      gl.scene.add(grp);
      gl.staticLayerGroups[layer.id] = grp;
    }
  }

  function buildExtraLandMeshes() {
    if (!gl) return;
    const S = model.state;
    if (gl.landGroup) gl.scene.remove(gl.landGroup);
    if (!S.landPolygons.length) { gl.landGroup = null; return; }
    const grp = new THREE.Group();
    grp.name = 'extra-land';
    for (const land of S.landPolygons) {
      const shape = new THREE.Shape(land.polygon.map((p) => new THREE.Vector2(p[0], -p[1])));
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, land.y, 0);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: land.fillColor, side: THREE.DoubleSide }));
      mesh.name = `land-${land.name}`;
      grp.add(mesh);
      const shorePts = land.polygon.map((p) => new THREE.Vector3(p[0], land.y + 1, p[1]));
      const shore = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(shorePts),
        new THREE.LineBasicMaterial({ color: land.shoreColor, transparent: true, opacity: 0.9 }));
      grp.add(shore);
    }
    gl.scene.add(grp);
    gl.landGroup = grp;
  }

  function canvasSprite(draw, w = 128, h = 128) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    return new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(c), transparent: true, depthTest: false }));
  }

  function rebuildPlacesGroup() {
    if (!gl) return;
    const S = model.state;
    if (gl.placesGroup) gl.scene.remove(gl.placesGroup);
    if (!S.places3d.length) { gl.placesGroup = null; return; }
    const grp = new THREE.Group();
    grp.name = 'places-3d';
    grp.visible = S.placesVisible;
    for (const pl of S.places3d) {
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(pl.disc.diameter / 2, pl.disc.diameter / 2, pl.disc.height, 20),
        new THREE.MeshLambertMaterial({ color: pl.disc.color }));
      disc.position.set(pl.x, HEIGHTS.deckBase + pl.disc.height / 2, pl.z);
      grp.add(disc);
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(pl.pillar.radius, pl.pillar.radius, pl.pillar.height, 8),
        new THREE.MeshLambertMaterial({ color: pl.pillar.color }));
      pillar.position.set(pl.x, HEIGHTS.deckBase + pl.disc.height + pl.pillar.height / 2, pl.z);
      grp.add(pillar);
      const glow = canvasSprite((x) => {
        const g = x.createRadialGradient(64, 64, 4, 64, 64, 62);
        g.addColorStop(0, 'rgba(255,255,255,0.85)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        x.fillStyle = g; x.fillRect(0, 0, 128, 128);
      });
      glow.material.color = new THREE.Color(pl.glow.color);
      glow.material.opacity = PLACES_3D.glowOpacity;
      glow.position.set(pl.x, HEIGHTS.deckBase + pl.disc.height + pl.pillar.height / 2, pl.z);
      glow.scale.set(pl.glow.diameter * 4, pl.glow.diameter * 4, 1);
      grp.add(glow);
      if (pl.badge.text) {
        const badge = canvasSprite((x, w, h) => {
          x.fillStyle = 'rgba(9,13,17,0.88)';
          x.beginPath(); x.arc(64, 64, 52, 0, Math.PI * 2); x.fill();
          x.fillStyle = '#ffffff'; x.font = '700 52px system-ui, sans-serif';
          x.textAlign = 'center'; x.textBaseline = 'middle';
          x.fillText(pl.badge.text, 64, 66);
        });
        badge.position.set(pl.x, HEIGHTS.deckBase + pl.badge.y, pl.z);
        badge.scale.set(220, 220, 1);
        grp.add(badge);
      }
    }
    gl.scene.add(grp);
    gl.placesGroup = grp;
  }

  function rebuildExternalGroup() {
    if (!gl) return;
    const S = model.state;
    if (gl.externalGroup) gl.scene.remove(gl.externalGroup);
    const grp = new THREE.Group();
    grp.name = 'external-stations';
    let any = false;
    for (const [layerId, stations] of Object.entries(S.externalStations)) {
      if (S.externalVisibility[layerId] === false) continue;
      const pos = new Float32Array(stations.length * 3);
      stations.forEach((st, i) => { pos.set([st.x, HEIGHTS.deckBase + 20, st.z], i * 3); any = true; });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const points = new THREE.Points(g, new THREE.PointsMaterial({
        color: 0xffd166, size: 9, sizeAttenuation: false }));
      points.name = `external-${layerId}`;
      points.frustumCulled = false;
      grp.add(points);
    }
    if (any) { gl.scene.add(grp); gl.externalGroup = grp; }
    else gl.externalGroup = null;
  }

  function rebuildAlertFxGroup() {
    if (!gl) return;
    const fx = model.state.alertFx;
    if (gl.alertGroup) gl.scene.remove(gl.alertGroup);
    gl.alertPulseRings = [];
    if (!fx) { gl.alertGroup = null; return; }
    const grp = new THREE.Group();
    grp.name = 'alert-fx';
    // detour dash ribbons: red/white dash texture over the span
    const dashTex = (() => {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 16;
      const x = c.getContext('2d');
      x.fillStyle = '#B3261E'; x.fillRect(0, 0, 128, 16);
      x.fillStyle = '#F5F2EA'; x.fillRect(128, 0, 42, 16);
      const t = new THREE.CanvasTexture(c);
      t.wrapS = THREE.RepeatWrapping;
      return t;
    })();
    for (const rb of fx.ribbons) {
      const geo = ribbonGeometry(rb.path, rb.width, rb.y);
      if (rb.kind === 'dash') {
        grp.add(new THREE.Mesh(bufferGeometry(THREE, geo),
          new THREE.MeshBasicMaterial({ map: dashTex, transparent: true, side: THREE.DoubleSide, depthWrite: false })));
      } else {
        grp.add(new THREE.Mesh(bufferGeometry(THREE, geo),
          new THREE.MeshBasicMaterial({ color: 0x05070a, transparent: true, opacity: rb.opacity || 0.45, side: THREE.DoubleSide, depthWrite: false })));
      }
    }
    for (const g of fx.glyphs) {
      const spr = canvasSprite((x) => {
        x.font = '700 124px system-ui, sans-serif';
        x.textAlign = 'center'; x.textBaseline = 'middle';
        x.lineWidth = 16; x.strokeStyle = 'rgba(12,17,22,.92)';
        x.strokeText(g.glyph, 96, 102);
        x.fillStyle = g.colorCss; x.fillText(g.glyph, 96, 102);
      }, 192, 192);
      spr.position.set(g.x, g.y, g.z);
      spr.scale.set(g.scale, g.scale, 1);
      grp.add(spr);
    }
    for (const ring of fx.pulseRings) {
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(ring.rInner, ring.rOuter, 40),
        new THREE.MeshBasicMaterial({ color: ring.color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(ring.x, ring.y, ring.z);
      mesh.userData.phase = ring.phase;
      grp.add(mesh);
      gl.alertPulseRings.push(mesh);
    }
    for (const st of fx.stops) {
      if (st.ring !== 'moved') continue;
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(26, 42, 32),
        new THREE.MeshBasicMaterial({ color: 0x4d96ff, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(st.x, 22, st.z);
      grp.add(mesh);
    }
    gl.scene.add(grp);
    gl.alertGroup = grp;
  }

  /** Alert pulse animation (model-phase math in scene-model). */
  function tickAlertPulse(timeMs) {
    if (!gl || !gl.alertPulseRings) return;
    for (const mesh of gl.alertPulseRings) {
      const p = alertPulsePhase(timeMs, mesh.userData.phase || 0);
      mesh.scale.set(p.scale, p.scale, 1);
      mesh.material.opacity = p.opacity;
    }
  }

  /** True-scale fleet models (CG-12): box bodies at fleetLookup
   *  dimensions replace glyph sprites inside the LOD distance. */
  function rebuildFleetModels() {
    if (!gl) return;
    const S = model.state;
    if (gl.fleetGroup) gl.scene.remove(gl.fleetGroup);
    gl.fleetGroup = null;
    if (S.fleetMode !== 'model') return;
    const grp = new THREE.Group();
    grp.name = 'fleet-models';
    for (const g of S.glyphs) {
      if (!g.fleet) continue;
      const f = g.fleet;
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(f.length_m, f.height_m, f.width_m),
        new THREE.MeshLambertMaterial({ color: g.color || 0xe8edf2 }));
      body.position.set(g.x, f.height_m / 2, g.z);
      if (typeof g.heading === 'number') body.rotation.y = g.heading;
      body.name = `fleet-${g.record.vehicle_id || ''}`;
      grp.add(body);
    }
    gl.scene.add(grp);
    gl.fleetGroup = grp;
  }

  /** Per-frame fold sync: motion advance + LOD + pulse + stop LOD. */
  function foldFrameSync() {
    if (!gl) return;
    if (model.state.motion) {
      // Motion fix times are envelope epoch ms (generated_at), so
      // the advance clock is the wall clock, not the frame clock.
      const moved = model.advanceMotion(Date.now());
      if (moved && gl.vehicleGroup) {
        const glyphs = model.state.glyphs;
        gl.vehicleGroup.children.forEach((sp, i) => {
          const g = glyphs[i];
          if (g) sp.position.set(g.x, HEIGHTS.deckBase + 30, g.z);
        });
      }
      if (moved && model.state.fleetMode === 'model') rebuildFleetModels();
    }
    const lodMode = model.updateFleetLod(model.camera.distance);
    if (gl.fleetGroup && lodMode !== 'model') rebuildFleetModels();
    else if (!gl.fleetGroup && lodMode === 'model' && model.state.fleetRanges) rebuildFleetModels();
    if (gl.vehicleGroup) gl.vehicleGroup.visible = lodMode !== 'model';
    if (gl.stopsPoints) gl.stopsPoints.visible = model.stopsWithinLod(model.camera.distance);
    tickAlertPulse(typeof performance !== 'undefined' ? performance.now() : Date.now());
  }

  function rebuildVehicleSprites() {
    if (!gl) return;
    const S = model.state;
    if (gl.vehicleGroup) { gl.scene.remove(gl.vehicleGroup); }
    const grp = new THREE.Group();
    grp.name = 'vehicles';
    const mkTex = (draw) => {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      draw(c.getContext('2d'));
      const t = new THREE.CanvasTexture(c);
      return t;
    };
    for (const g of S.glyphs) {
      let tex, scale = 900;
      if (g.kind === GLYPH.UNASSIGNED) {
        tex = mkTex((x) => {
          x.strokeStyle = '#aab4c0'; x.lineWidth = 5;
          x.beginPath(); x.moveTo(32, 6); x.lineTo(58, 32); x.lineTo(32, 58); x.lineTo(6, 32); x.closePath(); x.stroke();
        });
        scale = 700;
      } else {
        const fill = g.stale ? '#6d7681' : (g.color || '#e8edf2');
        tex = mkTex((x) => {
          x.fillStyle = fill; x.beginPath(); x.arc(32, 32, 24, 0, Math.PI * 2); x.fill();
          x.lineWidth = 4; x.strokeStyle = '#0b0e13'; x.stroke();
        });
      }
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
      sp.position.set(g.x, HEIGHTS.deckBase + 30, g.z);
      sp.scale.set(scale, scale, 1);
      sp.name = `vehicle-${g.record.vehicle_id || ''}`;
      sp.visible = g.kind === GLYPH.UNASSIGNED ? true
        : (model.state.groups[g.group] !== false && model.routeVisible(g.routeId));
      grp.add(sp);
    }
    gl.scene.add(grp);
    gl.vehicleGroup = grp;
  }

  const api = {
    model, camera: model.camera,
    isMaterialized: () => !!gl,
    async loadGeometry(docs) {
      model.loadGeometry(docs);
      if (canvas && !gl) await materialize();
      else if (gl) {
        // Reload: clear the scene and rebuild the static layers
        // from the new model (lights are re-added by materialize
        // semantics — here we simply rebuild everything).
        while (gl.scene.children.length) gl.scene.remove(gl.scene.children[0]);
        gl.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
        const sun = new THREE.DirectionalLight(0xffffff, 1.1);
        sun.position.set(20000, 40000, 12000);
        gl.scene.add(sun);
        buildStaticLayers();
        buildFoldLayers();
        rebuildVehicleSprites();
      }
      model.fitToExtent();
      // CG-12 (gated): restore the persisted camera view once per
      // boot, after the extent fit it would otherwise override.
      if (!cameraMemoryRestored) {
        cameraMemoryRestored = true;
        model.restoreCameraMemory(storage);
      }
      syncThreeFromModel();
      return api.stats();
    },
    setVehicles(envelope) {
      model.setVehicles(envelope);
      rebuildVehicleSprites();
      return api.stats();
    },
    setGroupVisibility(groupId, on) {
      model.setGroupVisibility(groupId, on);
      if (gl && gl.routeGroups && gl.routeGroups[groupId]) {
        gl.routeGroups[groupId].visible = !!on;
      }
      if (gl) rebuildVehicleSprites();
      return api.stats();
    },
    /** Per-route filter (R5 / LT-KAES-33): one route's ribbons +
     *  glyphs off/on, immediate recompute (RC10). The THREE route
     *  group is the child named `route-<id>` in its layer group. */
    setRouteVisibility(routeId, on) {
      model.setRouteVisibility(routeId, on);
      if (gl && gl.routeGroups) {
        for (const grp of Object.values(gl.routeGroups)) {
          const child = grp.children.find((c) => c.name === `route-${routeId}`);
          if (child) child.visible = !!on;
        }
      }
      if (gl) rebuildVehicleSprites();
      return api.stats();
    },
    routeVisible(routeId) { return model.routeVisible(routeId); },
    // ---- F5 fold seams (each inert when its config gate is off) ----
    /** CG-4: load one static layer's asset doc (surfaces fetch it
     *  from geometryAssetPaths().staticLayers[id]). */
    loadStaticLayer(entry, doc) {
      const layer = model.loadStaticLayer(entry, doc);
      buildStaticLayerGroups();
      return layer;
    },
    setStaticLayerVisible(id, on) {
      const ok = model.setStaticLayerVisible(id, on);
      if (gl && gl.staticLayerGroups && gl.staticLayerGroups[id]) {
        gl.staticLayerGroups[id].visible = !!on;
      }
      return ok;
    },
    staticLayerVisible(id) { return model.staticLayerVisible(id); },
    /** CG-5: external-layer station records -> pickable markers. */
    setExternalStations(layerId, records) {
      const n = model.setExternalStations(layerId, records);
      rebuildExternalGroup();
      return n;
    },
    setExternalLayerVisible(layerId, on) {
      const v = model.setExternalLayerVisible(layerId, on);
      rebuildExternalGroup();
      return v;
    },
    /** CG-6: places dataset + visibility (layer3d mode only). */
    setPlaces(dataset) {
      const n = model.setPlaces(dataset);
      rebuildPlacesGroup();
      return n;
    },
    setPlacesVisible(on) {
      const v = model.setPlacesVisible(on);
      if (gl && gl.placesGroup) gl.placesGroup.visible = !!v && !!on;
      return v;
    },
    /** CG-12: additional land-polygon assets. */
    loadExtraLand(doc, name) {
      const n = model.loadExtraLand(doc, name);
      buildExtraLandMeshes();
      return n;
    },
    /** CG-12: fleet model set (LOD swap handled per frame). */
    loadFleetModels(doc) { return model.loadFleetModels(doc); },
    fleetLookup(vehicleId) { return model.fleetLookup(vehicleId); },
    /** CG-9: motion stack (empirical prior + advance + L2 state). */
    empiricalSpeed(routeId, seg, nowMs) { return model.empiricalSpeed(routeId, seg, nowMs); },
    fetchTimingCells(fetchImpl) { return model.loadTimingCells(fetchImpl); },
    loadTimingCells(fetchImpl) { return model.loadTimingCells(fetchImpl); },
    advanceMotion(nowMs) { return model.advanceMotion(nowMs != null ? nowMs : Date.now()); },
    /** CG-11: alert FX model from an alerts envelope/list. */
    setAlerts(envelope, nowMs) {
      const fx = model.setAlerts(envelope, nowMs);
      rebuildAlertFxGroup();
      return fx;
    },
    /** CG-12: street-view camera mode + camera memory. */
    enterStreetView() {
      const ok = model.enterStreetView();
      if (ok) syncThreeFromModel();
      return ok;
    },
    exitStreetView() {
      const ok = model.exitStreetView();
      if (ok) syncThreeFromModel();
      return ok;
    },
    isStreetView() { return model.state.streetView === true; },
    saveCameraMemory() { return model.saveCameraMemory(storage); },
    restoreCameraMemory() {
      const ok = model.restoreCameraMemory(storage);
      if (ok) syncThreeFromModel();
      return ok;
    },
    pick(point) { return model.pick(point); },
    pickFromClient(cx, cy, rect) { return model.pickFromClient(cx, cy, rect); },
    fitToExtent() { model.fitToExtent(); syncThreeFromModel(); },
    render() {
      if (!gl) return false; // headless: no GPU frame exists to draw
      return drawFrame();
    },
    dispose() {
      model.saveCameraMemory(storage);
      if (model.state.motion && model.state.motion.speedmap) {
        model.state.motion.speedmap.save(Date.now());
      }
      if (frameLoop) { frameLoop.stop(); frameLoop = null; }
      if (gl && gl.renderer) gl.renderer.dispose();
      gl = null;
    },
    stats() {
      const s = model.stats();
      return s ? { ...s, renderFrames: frameLoop ? frameLoop.frames() : 0 } : s;
    },
  };
  if (canvas) await materialize();
  return api;
}
