// modules/renderer.mjs — 3D renderer (LT-KAES-09).
// PHL REBUILD R3 implementation, on the R1 contract. Label:
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
import { createSceneModel, GLYPH, HEIGHTS, WATER_COLOR, LANDMARK_COLOR } from '../renderer/scene-model.mjs';
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
  return {
    streets: CITY_CONFIG.assets.streets,
    routesByFeed: CITY_CONFIG.assets.routesByFeed,
    stops: CITY_CONFIG.assets.stops,
    provenanceManifest: CITY_CONFIG.assets.provenanceManifest,
    water: CITY_CONFIG.assets.water,
    landmarks: CITY_CONFIG.assets.landmarks,
    streetNames: CITY_CONFIG.assets.streetNames,
  };
}

/** The projector for this city, from config's declared origin. */
export function cityProjector() {
  return createProjector(CITY_CONFIG.assets.projection);
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
  const model = createSceneModel({ width, height });
  let THREE = null;
  let gl = null; // {renderer, scene, camera3, controls, groups...}

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
    syncThreeFromModel();
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
    const waterMat = new THREE.MeshBasicMaterial({ color: WATER_COLOR, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
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
    const waterLineMat = new THREE.MeshBasicMaterial({ color: WATER_COLOR, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
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
        rebuildVehicleSprites();
      }
      model.fitToExtent();
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
    pick(point) { return model.pick(point); },
    pickFromClient(cx, cy, rect) { return model.pickFromClient(cx, cy, rect); },
    fitToExtent() { model.fitToExtent(); syncThreeFromModel(); },
    render() {
      if (!gl) return false; // headless: no GPU frame exists to draw
      syncThreeFromModel();
      gl.renderer.render(gl.scene, gl.camera3);
      return true;
    },
    dispose() {
      if (gl && gl.renderer) gl.renderer.dispose();
      gl = null;
    },
    stats() { return model.stats(); },
  };
  if (canvas) await materialize();
  return api;
}
