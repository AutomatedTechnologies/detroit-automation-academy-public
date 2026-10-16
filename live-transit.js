/* Live Transit · Detroit — dedicated 3D page.
 *
 * All 37 DDOT routes (GTFS shapes) rendered as elevated 3D guideways, with
 * live bus positions polled from the Forge Line proxy every 60s. Bus pillars
 * are InstancedMesh (4 draw calls total); zooming in swaps to true-scale bus
 * models built lazily. Instant paint from the logged history file, with
 * honest live/retry badge states. Route filters by group (ConnectTen /
 * Primary / Neighborhood) plus per-route chips.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

(function () {
  'use strict';

  var STAMP = '20261015-2034';
  // Build string in the help footer derives from the cache stamp — never
  // hardcoded (2026-10-06: a stale hardcoded "Build 20261002-2780" shipped
  // for days before anyone noticed).
  try {
    var _bs = document.getElementById('build-stamp');
    if (_bs) _bs.textContent = 'Build ' + STAMP + '.';
  } catch (e) {}
  var POLL_MS = 60000;
  var BUS_MAX = 400;
  var DETAIL_MAX = 48;
  var DEG = Math.PI / 180;
  var COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  var HISTORY_URL = 'https://raw.githubusercontent.com/smit4786/forge-line-transit-data/main/data/latest.json';

  var container = document.getElementById('live-map');
  if (!container) return;
  // Map gesture containment backstop (2026-10-15): iOS Safari drives page
  // pinch-zoom through the proprietary gesture events when a pinch starts
  // on a surface touch-action does not cover. The CSS in live-transit.html
  // sets touch-action on every stage surface; this listener closes the
  // remaining path by cancelling gesture events that originate inside the
  // map stage. Scoped to the stage: pinch on the rest of the page is
  // untouched, and OrbitControls consumes pointer events (never gesture
  // events) on the canvas, so camera control is unaffected.
  var mapStage = document.querySelector('.map-stage');
  if (mapStage && mapStage.addEventListener) {
    var killStageGesture = function (e) { e.preventDefault(); };
    mapStage.addEventListener('gesturestart', killStageGesture, { passive: false });
    mapStage.addEventListener('gesturechange', killStageGesture, { passive: false });
  }
  var $ = function (id) { return document.getElementById(id); };
  // Shared screen-reader announcements (defect sr-status): one polite live
  // region (#sr-status in live-transit.html) for dynamic changes that have
  // no visible live region of their own — card opens, trip results, and
  // filter changes. Clearing first, then setting in a timeout, makes a
  // repeated identical message announce again.
  var _srFilterShown = null;
  function announceSr(msg) {
    var el = $('sr-status');
    if (!el || !msg) return;
    el.textContent = '';
    setTimeout(function () { el.textContent = msg; }, 30);
  }

  function fail(msg) {
    container.innerHTML = '<div class="map-fallback"><p>' + msg + '</p></div>';
  }

  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch (e) {
    fail('3D is not available in this browser.');
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c1116);
  scene.fog = new THREE.Fog(0x0c1116, 32000, 75000);

  var camera = new THREE.PerspectiveCamera(42, 1, 100, 140000);
  // Home framing (2026-10-15, Accessible Detroit): the first-load view
  // centers the downtown hub (Campus Martius, 42.3314, -83.0458 in scene
  // units) where the radial corridors converge, at a 35-degree elevation
  // and ~20.5 km distance — steeper and wider than the old origin-centered
  // framing, so a first-time car-free user sees the useful whole (hub,
  // Midtown, the Woodward spine north) legibly at a glance. Distance stays
  // under 22,000 so the local-street tier remains in the home view.
  // homePos/homeTarget below clone these values, so the rail's Home/Reset
  // control returns to exactly this framing.
  camera.position.set(8448, 11758, 22332);

  var controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(8448, 0, 5539);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  // Pinch/wheel zoom anchors to the fingers/cursor, not the orbit target —
  // otherwise the point you meant to zoom into drifts away mid-gesture.
  // (r160 already implements this; it just ships disabled by default.)
  controls.zoomToCursor = true;
  controls.maxPolarAngle = 1.35;
  controls.minDistance = 1200;
  controls.maxDistance = 55000;

  // Touchscreen navigation: one finger drags the map (like a maps app),
  // pinch zooms and two-finger twist rotates. Desktop keeps drag-orbit.
  var homePos = camera.position.clone();
  var homeTarget = controls.target.clone();
  var isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  if (isTouch) {
    controls.touches.ONE = THREE.TOUCH.PAN;
    controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
  }

  scene.add(new THREE.HemisphereLight(0xf5f2ea, 0x0c1116, 0.9));
  var sun = new THREE.DirectionalLight(0xffffff, 0.7);
  sun.position.set(9000, 14000, 5000);
  scene.add(sun);

  // --- textures -----------------------------------------------------------
  function radialTex(inner, mid) {
    var c = document.createElement('canvas');
    c.width = c.height = 256;
    var x = c.getContext('2d');
    var g = x.createRadialGradient(128, 128, 8, 128, 128, 126);
    g.addColorStop(0, inner);
    g.addColorStop(0.45, mid);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 256, 256);
    return new THREE.CanvasTexture(c);
  }
  var glowTex = radialTex('rgba(255,255,255,1)', 'rgba(255,255,255,0.35)');

  // Street-map coverage bounds (WGS84). Streets are drawn as vector
  // geometry from U.S. Census TIGER/Line 2025 (see build scripts); no raster tiles.
  var STREET_BOUNDS = { lonW: -83.3431083, lonE: -82.8992288, latN: 42.47997522924901, latS: 42.25539743550126 };
  // Street-mosaic bounds: the expanded mosaic (Downriver south, suburbs
  // west). The ground plane and the coverage border are drawn to this
  // extent; the core street tiers render inside STREET_BOUNDS.
  var MOSAIC_BOUNDS = { lonW: -83.385, lonE: -82.8992288, latN: 42.47997522924901, latS: 42.178 };

  // --- path smoothing ---------------------------------------------------
  // Chaikin corner-cutting: each iteration replaces every segment with two
  // quarter-points, quadrupling density and rounding kinks into smooth
  // curves. Fixes the blocky "plank joint" look at intermediate zooms.
  // Returns a new array; the input is never mutated.
  function chaikin(pts) {
    var n = pts.length;
    if (n < 3) return pts.slice();
    var out = [pts[0]];
    for (var i = 0; i < n - 1; i++) {
      var a = pts[i], b = pts[i + 1];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out.push(pts[n - 1]);
    return out;
  }
  // True miter offset for point i: offset along the angle bisector, scaled
  // by 1/cos(half-angle) so the ribbon holds constant width through turns
  // instead of pinching. Clamped to 2x to avoid spikes on hairpins.
  function miterOffset(pts, i, hw) {
    var n = pts.length;
    var p = pts[i];
    var a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    var d0x = p[0] - a[0], d0z = p[1] - a[1];
    var d1x = b[0] - p[0], d1z = b[1] - p[1];
    var l0 = Math.hypot(d0x, d0z), l1 = Math.hypot(d1x, d1z);
    var nx, nz, m;
    if (l0 < 1e-6 || l1 < 1e-6) {
      var ex = l0 >= l1 ? d0x : d1x, ez = l0 >= l1 ? d0z : d1z;
      var el = Math.hypot(ex, ez) || 1;
      nx = -ez / el; nz = ex / el; m = 1;
    } else {
      d0x /= l0; d0z /= l0; d1x /= l1; d1z /= l1;
      var tx = d0x + d1x, tz = d0z + d1z, tl = Math.hypot(tx, tz);
      if (tl < 1e-6) { nx = -d0z; nz = d0x; m = 1; }
      else {
        tx /= tl; tz /= tl; nx = -tz; nz = tx;
        m = 1 / Math.max(0.5, nx * -d0z + nz * d0x);
      }
    }
    return [nx * hw * m, nz * hw * m];
  }

  // --- geometry helpers ---------------------------------------------------
  function ribbonGeometry(pts, width, y) {
    pts = chaikin(chaikin(pts));
    var n = pts.length;
    var pos = new Float32Array(n * 2 * 3);
    var idx = [];
    var hw = width / 2;
    for (var i = 0; i < n; i++) {
      var p = pts[i], o = miterOffset(pts, i, hw);
      pos.set([p[0] + o[0], y, p[1] + o[1]], i * 6);
      pos.set([p[0] - o[0], y, p[1] - o[1]], i * 6 + 3);
      if (i < n - 1) {
        var k = i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
  }

  // Vertical skirts under an elevated ribbon: turns a flat strip into a solid
  // 3D guideway. One skirt per edge, from y=0 up to yTop.
  function skirtGeometry(pts, width, yTop) {
    pts = chaikin(chaikin(pts));
    var n = pts.length;
    var pos = [];
    var idx = [];
    var hw = width / 2;
    function edgePt(i, side, y) {
      var p = pts[i], o = miterOffset(pts, i, hw);
      return [p[0] + o[0] * side, y, p[1] + o[1] * side];
    }
    [1, -1].forEach(function (side) {
      var base = pos.length / 3;
      for (var i = 0; i < n; i++) {
        var b = edgePt(i, side, 0), t = edgePt(i, side, yTop);
        pos.push(b[0], b[1], b[2], t[0], t[1], t[2]);
        if (i < n - 1) {
          var k = base + i * 2;
          idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
        }
      }
    });
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  function makeLabel(text, colorHex) {
    var c = document.createElement('canvas');
    c.height = 128;
    // Long text (the People Mover title) must not clip at the canvas edge:
    // measure at the standard size and widen the pill to fit, keeping the
    // same type size as the route chips.
    var mx = c.getContext('2d');
    mx.font = '600 52px "Space Grotesk", sans-serif';
    var tw = Math.ceil(mx.measureText(text).width);
    c.width = tw > 460 ? tw + 52 : 512;
    var x = c.getContext('2d');
    x.fillStyle = 'rgba(12,17,22,0.85)';
    x.beginPath();
    if (x.roundRect) x.roundRect(6, 14, c.width - 12, 100, 50); else x.rect(6, 14, c.width - 12, 100);
    x.fill();
    x.strokeStyle = colorHex; x.lineWidth = 4; x.stroke();
    x.fillStyle = colorHex;
    x.font = '600 52px "Space Grotesk", sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(text, c.width / 2, 68);
    var tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.scale.set(375 * c.width / c.height, 375, 1);
    return sp;
  }

  // --- state ---------------------------------------------------------------
  var routeColors = {};   // id -> THREE.Color
  var routeNames = {};    // id -> name
  var routeById = {};     // id -> route record from JSON
  var routeGroups = {};   // route id -> THREE.Group (guideway + label + tether)
  var groupObjs = {};     // group id -> THREE.Group (stops cloud)
  var routeOrder = [];
  var groupOrder = [];
  var labelSprites = [];  // { sprite, routeId }
  var liveCounts = {};    // route id -> live bus count (raw, pre-filter)
  // Smart disabling: per-route running state. 'unknown' until the first live
  // poll (history paint never marks routes not-running). A route flips to
  // 'not-running' only after 3 consecutive polls with zero buses (grace
  // against brief feed dropouts); any bus resets the streak immediately.
  var runningState = {};  // rid -> 'unknown' | 'running' | 'not-running'
  var quietStreak = {};   // rid -> consecutive polls with zero buses
  var DIM_OPACITY = 0.22;
  var proj = null;
  var streetData = null; // vector streets (assets/detroit-streets.json)
  var streetNameData = null; // street name anchors (assets/detroit-street-names.json)
  var stopData = null;   // raw stops array from ddot-routes-3d.json

  // People Mover layer: static schedule geometry (no live feed exists —
  // verified 2026-10-05). Independent of the DDOT route filter machinery:
  // its own toggle, its own honesty labeling, never presented as live.
  var pmGroup = null;      // THREE.Group: loop deck + skirts + station pins + label
  var pmStations = [];     // pickable records {id, n, x, z, r:['DPM'], pm:true}
  var pmPins = [];         // station pin meshes (zoom-scaled with the stop family)
  var pmLabel = null, pmTether = null;
  var pmVisible = false; // OFF by default: user enables via pm-toggle
  var belleIsleLabel = null, belleIsleTether = null; // island landmass label (static layer)
  var PM_DECK_Y = 140;     // elevated guideway: floats above the highest DDOT route deck (~110)

  function project(lat, lon) {
    return [(lon - proj.lon0) * proj.mLon, -(lat - proj.lat0) * proj.mLat];
  }

  // --- fleet data: vehicle number -> model, dimensions, seating ----------------
  var fleetData = null;
  function fleetLookup(vehicleId) {
    var fallback = { model: '40-ft transit bus', detail: 'model assumed', length_m: 12.19, width_m: 2.59, height_m: 3.3, seats: null, assumed: true };
    if (!fleetData || !fleetData.ranges) return fallback;
    var m = String(vehicleId == null ? '' : vehicleId).match(/^(\d+)/);
    if (!m) return fallback;
    var num = parseInt(m[1], 10);
    for (var i = 0; i < fleetData.ranges.length; i++) {
      var r = fleetData.ranges[i];
      if (num >= r.from && num <= r.to) {
        return {
          model: r.model,
          detail: r.year + (r.note ? ' · ' + r.note : ''),
          length_m: r.length_m, width_m: r.width_m, height_m: r.height_m,
          seats: r.seats, assumed: false
        };
      }
    }
    return fallback;
  }

  // --- bus pillars: InstancedMesh, 4 draw calls total --------------------------
  // Marker assembly redesigned 2026-10-06 for the true-scale skyline
  // (landmark massing: RenCen 221m). The full stack — glow, core, beacon
  // ("ceiling"), ground ring ("floor"), badges — is sized as one coherent
  // marker language: visible at wide zoom, subordinate to the towers,
  // compact at street zoom. Nothing in the assembly exceeds ~265m.
  var PILLAR_H = 220;
  // Zoom-coupled marker scale: full-height symbolic pillars wide out, shrinking
  // as the camera dives so downtown stays intelligible at street zoom. The
  // handoff to true-scale bus models happens at ~2.6 km (updateLOD).
  var pillarYS = 1;
  function pillarScaleFor(d) {
    // Same close-zoom floor as stops: bus markers must stay readable when the
    // camera moves in close (e.g. after selecting a bus flies the view to it).
    var lo = (typeof streetView !== 'undefined' && streetView) ? 0.55 : 0.35;
    if (d >= 8000) return 1;
    if (d <= 2800) return lo;
    var t = (d - 2800) / (8000 - 2800);
    t = t * t * (3 - 2 * t); // smoothstep: gentle at both ends
    return lo + (1 - lo) * t;
  }
  var pillarGlowIM = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(36, 36, PILLAR_H, 12, 1, true),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    BUS_MAX);
  var pillarCoreIM = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(12, 16, PILLAR_H, 10),
    new THREE.MeshLambertMaterial({}),
    BUS_MAX);
  var pillarBeaconIM = new THREE.InstancedMesh(
    new THREE.SphereGeometry(20, 16, 12),
    new THREE.MeshBasicMaterial({}),
    BUS_MAX);
  var pillarRingIM = new THREE.InstancedMesh(
    new THREE.RingGeometry(20, 36, 28),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    BUS_MAX);
  var pillarMeshes = [pillarGlowIM, pillarCoreIM, pillarBeaconIM, pillarRingIM];
  // Uncertainty halo: one soft disc per bus, radius = 3σ of the Kalman
  // position variance. Additive, subtle — it reads as "confidence," not geometry.
  var haloIM = new THREE.InstancedMesh(
    new THREE.CircleGeometry(1, 24),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    BUS_MAX);
  haloIM.frustumCulled = false;
  haloIM.renderOrder = 4;
  pillarMeshes.push(haloIM);

  // Per-bus route badges: number-only chips. Destinations live in the bus
  // card (title + Destination row) — the floating badge stays compact.
  var badgeTexCache = {};
  function titleCase(s) {
    return String(s || '').toLowerCase().replace(/(?:^|\s)\S/g, function (m) { return m.toUpperCase(); });
  }
  function formatDest(rid, dest) {
    if (!dest) return '';
    // BusTime destination signs often repeat the route ("10 to Fairlane") — strip it.
    var dRaw = String(dest).trim().replace(new RegExp('^' + rid + '\\s*(to\\s+)?', 'i'), '');
    var dShort = titleCase(dRaw);
    if (dShort.length > 24) dShort = dShort.slice(0, 23) + '…';
    return dShort;
  }
  // Route identity label — the naming convention (settled 2026-10-11):
  // "Name - Number" ("Greenfield - 10", "Fast Michigan - 261"). A route
  // whose name equals its id renders name only (QLINE — never
  // "QLINE - QLINE"); a route with no registry name falls back to the
  // bare id; a non-numeric id renders name only (the code-registered
  // Detroit People Mover pseudo-route carries no route number). Every
  // surface that names a route goes through this one formatter.
  function routeLabel(rid) {
    var name = routeNames[rid];
    if (!name) return String(rid);
    if (name === rid) return name;
    if (/^\d+$/.test(rid)) return name + ' - ' + rid;
    return name;
  }

  function routeBadgeTexture(rid) {
    var t = badgeTexCache[rid];
    if (t) return t;
    var rc = routeColors[rid];
    var col = '#' + (rc ? rc.getHexString() : '9aa0a6');
    var label = String(rid);
    var c = document.createElement('canvas');
    // Bus silhouette (top-down): fixed proportions read as a bus at any zoom.
    var W = 168, H = 84;
    c.width = W; c.height = H;
    var x = c.getContext('2d');
    // Wheels: small dark blocks on both flanks.
    x.fillStyle = 'rgba(5,7,10,0.95)';
    x.fillRect(18, 0, 16, 10);
    x.fillRect(W - 34, 0, 16, 10);
    x.fillRect(18, H - 10, 16, 10);
    x.fillRect(W - 34, H - 10, 16, 10);
    // Body.
    x.fillStyle = 'rgba(9,13,17,0.88)';
    x.beginPath();
    if (x.roundRect) x.roundRect(8, 6, W - 16, H - 12, 14); else x.rect(8, 6, W - 16, H - 12);
    x.fill();
    x.lineWidth = 4; x.strokeStyle = col; x.stroke();
    // Windshield: light band across the front.
    x.fillStyle = 'rgba(180,200,215,0.35)';
    x.fillRect(20, 14, W - 40, 10);
    // Route number centered on the body.
    x.fillStyle = '#ffffff';
    x.font = '700 30px system-ui, -apple-system, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    // Shrink font for long route ids so the number stays inside the body.
    var tw = x.measureText(label).width;
    if (tw > W - 48) {
      x.font = '700 ' + Math.floor(30 * (W - 48) / tw) + 'px system-ui, -apple-system, sans-serif';
    }
    x.fillText(label, W / 2, H / 2 + 8);
    var tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    t = { tex: tex, aspect: c.width / c.height };
    badgeTexCache[rid] = t;
    return t;
  }
  var badgePool = [];
  for (var _bi = 0; _bi < BUS_MAX; _bi++) {
    var _sp = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true }));
    _sp.scale.set(480, 240, 1);
    _sp.visible = false;
    _sp.renderOrder = 40;
    scene.add(_sp);
    badgePool.push(_sp);
  }

  // In-scene info label for the tapped bus: route + destination up top,
  // vehicle + speed + data age below. Drawn on demand (not cached — the
  // age text goes stale), parked beside the bus so it never covers it.
  var busInfoSprite = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true }));
  busInfoSprite.visible = false;
  busInfoSprite.renderOrder = 41;
  scene.add(busInfoSprite);

  // === SMART FRESHNESS LABELING (reactivation graft, 2026-10-15) =========
  // SMART positions arrive via Swiftly GTFS-Realtime in a separate display
  // payload (live-data/smart-display.json), rebuilt on the feed's 5-minute
  // cadence. Display-only under the Swiftly API License §4(vi): the
  // payload is this application's own rendering channel and is never part
  // of the public vehicles.json contract. S6: a surface may claim only
  // the freshness its source measures, so SMART carries its measured age
  // wherever it is presented as current: the SMART filter-group header,
  // the SMART beta note, the live-count pill, and SMART stop cards.
  // Text only, by design: age is never carried by appearance alone.
  // DDOT and QLINE are never touched.
  // The age source is the payload's own generated_at paired with the
  // oldest vehicle updated_at inside the same payload, so client clock
  // skew cannot distort it. Bands: fresh (payload at most 7.5 minutes
  // old — within 1.5 build cycles; nothing to label), aging (payload
  // up to 15 minutes old; surfaces state the positions' as-of time),
  // stale (past 15 minutes — 3x the build cadence): the payload's
  // vehicles are dropped at ingest (smartDisplayVehicles) and the
  // surfaces say the data is old instead of rendering positions as
  // current. This restores the labeling the SMART removal took out with
  // the Transit snapshot source it was written for, re-based on a live
  // GPS source: there is no snapshot age to report because the feed
  // carries one timestamp per vehicle.
  var smartAge = { band: 'unknown', ageMin: null, payloadAtMs: null,
                   oldestAtMs: null, payloadAgeMin: null, count: 0 };
  var SMART_PAYLOAD_STALE_MS = 15 * 60 * 1000; // 3x the 5-minute build cadence

  function computeSmartAge(s, nowMs) {
    var out = { band: 'unknown', ageMin: null, payloadAtMs: null,
                oldestAtMs: null, payloadAgeMin: null, count: 0 };
    if (!s || !Array.isArray(s.vehicles)) return out;
    out.count = s.vehicles.length;
    var gen = s.generated_at ? new Date(s.generated_at).getTime() : NaN;
    if (isNaN(gen)) return out;
    out.payloadAtMs = gen;
    var oldest = null;
    for (var i = 0; i < s.vehicles.length; i++) {
      var v = s.vehicles[i];
      if (!v || !v.updated_at) continue;
      var vt = new Date(v.updated_at).getTime();
      if (isNaN(vt)) continue;
      if (oldest == null || vt < oldest) oldest = vt;
    }
    out.oldestAtMs = oldest;
    if (oldest != null) out.ageMin = Math.max(0, (gen - oldest) / 60000);
    var payloadAgeMs = nowMs - gen;
    out.payloadAgeMin = Math.max(0, payloadAgeMs / 60000);
    out.band = payloadAgeMs > SMART_PAYLOAD_STALE_MS ? 'stale'
      : (payloadAgeMs > SMART_PAYLOAD_STALE_MS / 2 ? 'aging' : 'fresh');
    return out;
  }
  // The vehicles a display payload contributes to the merged live set:
  // none when the payload is missing, malformed, or stale — SMART
  // vehicles age out and disappear honestly rather than render as
  // stale ghosts. Records without a position are dropped here as well.
  function smartDisplayVehicles(s, nowMs) {
    if (!s || !Array.isArray(s.vehicles)) return [];
    if (computeSmartAge(s, nowMs).band === 'stale') return [];
    return s.vehicles.filter(function (v) {
      return v && v.agency === 'smart' && v.lat != null && v.lon != null;
    });
  }
  function formatClock12(ms) {
    var d = new Date(ms);
    var h = d.getHours(), m = d.getMinutes();
    var ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
  }
  function formatAgeLong(ageMin) {
    if (ageMin == null || isNaN(ageMin)) return '';
    if (ageMin < 1.5) return 'about a minute';
    if (ageMin < 55) return Math.round(ageMin) + ' minutes';
    var hrs = ageMin / 60;
    if (hrs < 1.5) return 'about an hour';
    return Math.round(hrs) + ' hours';
  }
  function smartHeaderText(age) {
    if (!age || age.band === 'unknown' || age.band === 'fresh') return '';
    if (age.band === 'aging') return age.oldestAtMs != null ? 'as of ' + formatClock12(age.oldestAtMs) : '';
    return formatAgeLong(age.payloadAgeMin) + ' old';
  }
  function smartNoteText(age) {
    if (!age || age.band === 'unknown' || age.band === 'fresh') return '';
    if (age.band === 'aging') return age.oldestAtMs != null ? 'SMART positions as of ' + formatClock12(age.oldestAtMs) + '.' : '';
    return 'SMART data is ' + formatAgeLong(age.payloadAgeMin) + ' old \u2014 positions may have moved.';
  }
  function smartStopNoteText(age) {
    if (!age) return '';
    if (age.band === 'aging') return age.oldestAtMs != null ? 'SMART positions as of ' + formatClock12(age.oldestAtMs) + '.' : '';
    if (age.band === 'stale') return 'SMART data is ' + formatAgeLong(age.payloadAgeMin) + ' old \u2014 buses may have moved from the positions shown.';
    return '';
  }
  function smartPillText(age) {
    if (!age || age.band !== 'stale') return '';
    return 'SMART ' + age.count + ' (stale)';
  }

  // Applies the current smartAge object to every SMART age surface.
  // Called after the filter panel is built and on every live poll; each
  // surface is independently optional, so a missing element is a no-op.
  function applySmartAgeUI() {
    var label = $('smart-age-label');
    if (label) label.textContent = smartHeaderText(smartAge);
    var note = $('smart-age-note');
    if (note) note.textContent = smartNoteText(smartAge);
    var pill = $('smart-pill-note');
    if (pill) {
      var t = smartPillText(smartAge);
      pill.textContent = t;
      pill.hidden = !t;
    }
    renderStopSmartNote();
  }
  function stopServedBySmart(st) {
    if (!st || !st.r || !st.r.length) return false;
    var smartRoutes = groupRoutes.smart || [];
    if (!smartRoutes.length) return false;
    for (var i = 0; i < st.r.length; i++) {
      if (smartRoutes.indexOf(String(st.r[i])) !== -1) return true;
    }
    return false;
  }
  function renderStopSmartNote() {
    var el = $('stop-smart-note');
    if (!el) return;
    var t = (selectedStop && stopServedBySmart(selectedStop)) ? smartStopNoteText(smartAge) : '';
    el.textContent = t;
    el.hidden = !t;
  }
  // === END SMART FRESHNESS LABELING ===

  function busAgeText(v) {
    if (!v.updated_at) return '–';
    var s = Math.max(0, Math.round((Date.now() - new Date(v.updated_at).getTime()) / 1000));
    return s < 60 ? s + 's ago' : Math.floor(s / 60) + 'm ago';
  }
  function drawBusInfo(v) {
    var col = routeColors[v.route_id] ? '#' + routeColors[v.route_id].getHexString() : '#9aa0a6';
    var dest = formatDest(v.route_id, v.destination);
    var line1 = routeLabel(v.route_id) + (dest ? ' → ' + dest : '');
    var spd = (v.speed_mph != null && !isNaN(v.speed_mph)) ? Math.round(v.speed_mph) + ' mph' : '–';
    var line2 = 'Bus ' + (v.vehicle_id || '–') + ' · ' + spd + ' · ' + busAgeText(v);
    var c = document.createElement('canvas');
    var m = c.getContext('2d');
    m.font = '700 34px system-ui, -apple-system, sans-serif';
    var w1 = Math.ceil(m.measureText(line1).width);
    m.font = '500 28px system-ui, -apple-system, sans-serif';
    var w2 = Math.ceil(m.measureText(line2).width);
    c.width = Math.max(w1, w2) + 72; c.height = 128;
    var x = c.getContext('2d');
    x.fillStyle = 'rgba(9,13,17,0.92)';
    x.beginPath();
    if (x.roundRect) x.roundRect(4, 4, c.width - 8, c.height - 8, 20); else x.rect(4, 4, c.width - 8, c.height - 8);
    x.fill();
    x.lineWidth = 4; x.strokeStyle = col; x.stroke();
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = '#ffffff';
    x.font = '700 34px system-ui, -apple-system, sans-serif';
    x.fillText(line1, c.width / 2 - 14, 42);
    x.fillStyle = '#c9ced4';
    x.font = '500 28px system-ui, -apple-system, sans-serif';
    x.fillText(line2, c.width / 2 - 14, 88);
    // Dismiss × — the whole pill is tappable, this is the affordance.
    x.strokeStyle = '#9AA0A6'; x.lineWidth = 5; x.lineCap = 'round';
    var xx = c.width - 36, xy = 34;
    x.beginPath(); x.arc(xx, xy, 16, 0, Math.PI * 2); x.stroke();
    x.beginPath();
    x.moveTo(xx - 6, xy - 6); x.lineTo(xx + 6, xy + 6);
    x.moveTo(xx + 6, xy - 6); x.lineTo(xx - 6, xy + 6);
    x.stroke();
    if (busInfoSprite.material.map) busInfoSprite.material.map.dispose();
    var tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    busInfoSprite.material.map = tex;
    busInfoSprite.material.needsUpdate = true;
    busInfoSprite.userData.aspect = c.width / c.height;
    var h = badgeHeight() * 1.15;
    busInfoSprite.scale.set(h * busInfoSprite.userData.aspect, h, 1);
  }
  function placeBusInfo() {
    if (!busInfoSprite.visible || !selectedVehicleId) return;
    for (var i = 0; i < busSlots.length; i++) {
      var s = busSlots[i];
      if (s.vehicle && s.vehicle.vehicle_id === selectedVehicleId) {
        // Upper area of the column, clear of the route badge: reads as a unit
        // with the badge without covering the pillar. Tracks the zoom-coupled
        // pillar height (busMode uses true-scale models instead). Scale eases
        // per frame with the badges so the card glides instead of stepping.
        var y = busMode ? 150 : Math.max(60, PILLAR_H * pillarYS - 40);
        busInfoSprite.position.set(s.x + 200, y, s.z);
        if (busInfoSprite.userData.aspect) {
          var ih = badgeHeight() * 1.15;
          busInfoSprite.scale.set(ih * busInfoSprite.userData.aspect, ih, 1);
        }
        return;
      }
    }
    busInfoSprite.visible = false; // bus left the visible set
  }
  function refreshBusInfo() {    if (!selectedVehicleId) { busInfoSprite.visible = false; return; }
    for (var i = 0; i < busSlots.length; i++) {
      var s = busSlots[i];
      if (s.vehicle && s.vehicle.vehicle_id === selectedVehicleId) {
        drawBusInfo(s.vehicle);
        busInfoSprite.visible = true;
        placeBusInfo();
        return;
      }
    }
    busInfoSprite.visible = false;
  }

  // Shared temps.
  var _e3 = new THREE.Euler();

  // Street name labels: pooled sprites fed from detroit-street-names.json.
  // Freeway/arterial names under 20 km, local names under 6 km, deduped by
  // name within view, nearest 14 win.
  var streetLabelCache = {};
  function streetLabelTexture(name) {
    var t = streetLabelCache[name];
    if (t) return t;
    var c = document.createElement('canvas');
    var mc = c.getContext('2d');
    mc.font = '600 36px system-ui, -apple-system, sans-serif';
    var tw = Math.ceil(mc.measureText(name).width);
    c.width = tw + 44; c.height = 56;
    var x = c.getContext('2d');
    x.fillStyle = 'rgba(12,17,22,0.85)';
    x.beginPath();
    if (x.roundRect) x.roundRect(2, 2, c.width - 4, 52, 14); else x.rect(2, 2, c.width - 4, 52);
    x.fill();
    x.lineWidth = 3; x.strokeStyle = 'rgba(245,242,234,0.35)'; x.stroke();
    x.fillStyle = '#F5F2EA';
    x.font = '600 36px system-ui, -apple-system, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(name, c.width / 2, 29);
    t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    var o = { tex: t, aspect: c.width / c.height };
    streetLabelCache[name] = o;
    return o;
  }
  var streetLabelPool = [];
  for (var _sli = 0; _sli < 14; _sli++) {
    var _sl = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 }));
    _sl.visible = false;
    _sl.renderOrder = 35;
    scene.add(_sl);
    streetLabelPool.push(_sl);
  }
  var lastStreetLabelUpdate = 0;
  var MAX_STREET_LABELS = 6;
  // Street-label stability: without memory the picker churns — the nearest
  // anchor per street jumps as you pan and the nearest-N set reshuffles, so
  // labels pop and swap. We keep the previously shown anchor per street
  // (within a 1.3x radius hysteresis) and place previously shown streets
  // first, so the set only changes when it has to.
  var prevStreetNames = []; // names shown last update, in placement order
  var streetAnchorIdx = {}; // name -> index into streetNameData.labels
  function updateStreetLabels() {
    var now = performance.now();
    if (now - lastStreetLabelUpdate < 350) return;
    lastStreetLabelUpdate = now;
    function clearLabels() {
      for (var i = 0; i < streetLabelPool.length; i++) streetLabelPool[i].visible = false;
      prevStreetNames = [];
      streetAnchorIdx = {};
    }
    var labels = streetNameData && streetNameData.labels;
    var camDist = camera.position.distanceTo(controls.target);
    var showMajor = camDist < 10000, showLocal = camDist < 5000;
    if (!labels || (!showMajor && !showLocal)) { clearLabels(); return; }
    var tx = controls.target.x, tz = controls.target.z;
    var R = camDist * 0.55, R2 = R * R, keepR2 = R2 * 1.69; // 1.3x hysteresis
    var best = {};
    for (var j = 0; j < labels.length; j++) {
      var l = labels[j];
      if (l[3] === 2 ? !showLocal : !showMajor) continue;
      // Stable anchor: keep showing the same point for this street while
      // it's still reasonably close, instead of jumping anchor to anchor.
      var kj = streetAnchorIdx[l[0]];
      if (kj !== undefined && labels[kj] && labels[kj][0] === l[0] &&
          (labels[kj][3] === 2 ? showLocal : showMajor)) {
        var kdx = labels[kj][1] - tx, kdz = labels[kj][2] - tz;
        var kd2 = kdx * kdx + kdz * kdz;
        if (kd2 < keepR2 && !best[l[0]]) {
          best[l[0]] = { d2: kd2, l: labels[kj], j: kj };
          continue;
        }
      }
      var dx = l[1] - tx, dz = l[2] - tz;
      var d2 = dx * dx + dz * dz;
      if (d2 > R2) continue;
      var e = best[l[0]];
      if (!e || d2 < e.d2) best[l[0]] = { d2: d2, l: l, j: j };
    }
    var arr = [];
    for (var k in best) arr.push(best[k]);
    // Stable order: streets already on screen keep their slots; newcomers
    // fill by distance. Kills the reshuffle when the camera drifts.
    var prevPos = {};
    for (var pi = 0; pi < prevStreetNames.length; pi++) prevPos[prevStreetNames[pi]] = pi;
    arr.sort(function (a, b) {
      var pa = (a.l[0] in prevPos) ? prevPos[a.l[0]] : 1e9;
      var pb = (b.l[0] in prevPos) ? prevPos[b.l[0]] : 1e9;
      if (pa !== pb) return pa - pb;
      return a.d2 - b.d2;
    });
    // Nearest-first placement with screen-space collision: no overlapping labels.
    var placed = [];
    var h = camDist * 0.02;
    var rw = renderer.domElement.clientWidth, rh = renderer.domElement.clientHeight;
    var pxPerM = rh / (2 * camDist * Math.tan(camera.fov * 0.5 * DEG));
    clearLabels();
    var shown = 0;
    for (var q = 0; q < arr.length && shown < MAX_STREET_LABELS; q++) {
      var lt = streetLabelTexture(arr[q].l[0]);
      var lw = h * lt.aspect * pxPerM, lh = h * pxPerM;
      _p3.set(arr[q].l[1], 34, arr[q].l[2]).project(camera);
      if (_p3.z > 1 || _p3.z < -1) continue;
      var cxp = (_p3.x * 0.5 + 0.5) * rw, cyp = (-_p3.y * 0.5 + 0.5) * rh;
      var clash = false;
      for (var c = 0; c < placed.length; c++) {
        var pr = placed[c];
        if (Math.abs(cxp - pr.x) < (lw + pr.w) / 2 + 10 &&
            Math.abs(cyp - pr.y) < (lh + pr.h) / 2 + 8) { clash = true; break; }
      }
      if (clash) continue;
      placed.push({ x: cxp, y: cyp, w: lw, h: lh });
      var sp = streetLabelPool[shown++];
      if (sp.material.map !== lt.tex) { sp.material.map = lt.tex; sp.material.needsUpdate = true; }
      sp.scale.set(h * lt.aspect, h, 1);
      sp.position.set(arr[q].l[1], 34, arr[q].l[2]);
      sp.visible = true;
      // Remember what's on screen so the next pass prefers stability.
      prevStreetNames.push(arr[q].l[0]);
      streetAnchorIdx[arr[q].l[0]] = arr[q].j;
    }
  }
  pillarMeshes.forEach(function (im) {
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.count = 0;
    im.frustumCulled = false;
    scene.add(im);
  });

  // True-scale bus geometry (shared; detail groups built lazily for busMode).
  var busBodyGeo = new THREE.BoxGeometry(1, 1, 1);
  var busWinGeo = new THREE.BoxGeometry(1, 1, 1);
  var wheelGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.4, 12);
  var busWinMat = new THREE.MeshBasicMaterial({ color: 0x10161c });
  var wheelMat = new THREE.MeshBasicMaterial({ color: 0x05070a });

  var detailPool = [];
  function getDetail(i) {
    if (!detailPool[i]) {
      var g = new THREE.Group();
      var body = new THREE.Mesh(busBodyGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }));
      var wins = new THREE.Mesh(busWinGeo, busWinMat);
      var wheels = [];
      for (var k = 0; k < 4; k++) {
        var wh = new THREE.Mesh(wheelGeo, wheelMat);
        wh.rotation.x = Math.PI / 2;
        wheels.push(wh);
        g.add(wh);
      }
      g.add(body); g.add(wins);
      g.visible = false;
      body.userData.detail = null; // set below
      scene.add(g);
      var d = { group: g, body: body, wins: wins, wheels: wheels, vehicle: null };
      body.userData.detail = d;
      detailPool[i] = d;
    }
    return detailPool[i];
  }

  // busSlots[i]: one entry per currently visible bus (index == instance id).
  var busSlots = [];
  var selectedVehicleId = null; // tapped bus; its indicator renders expanded

  var _m4 = new THREE.Matrix4();
  var _p3 = new THREE.Vector3();
  var _q3 = new THREE.Quaternion();
  var _s3 = new THREE.Vector3(1, 1, 1);
  var _ringQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));

  function markColorsDirty() {
    pillarMeshes.forEach(function (im) {
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    });
  }

  // Pulse rate shared with the user-location ring: 1 + 0.22*sin(t/420).
  function busPulse() { return 1 + 0.22 * Math.sin(performance.now() / 420); }

  function writeBusMatrices(k, b, pulse) {
    var isSel = !!selectedVehicleId && b.vehicle.vehicle_id === selectedVehicleId;
    var exz = (isSel ? 1.55 : 1) * (isSel ? pulse : 1); // selected bus expands + pulses
    var topY = PILLAR_H * pillarYS;
    _p3.set(b.x, topY / 2, b.z);
    _q3.identity();
    _s3.set(exz, pillarYS, exz);
    _m4.compose(_p3, _q3, _s3);
    pillarGlowIM.setMatrixAt(k, _m4);
    pillarCoreIM.setMatrixAt(k, _m4);
    _p3.set(b.x, topY + 24, b.z);
    _m4.compose(_p3, _q3, _s3);
    pillarBeaconIM.setMatrixAt(k, _m4);
    _p3.set(b.x, 4, b.z);
    _s3.set(exz * 1.35, exz * 1.35, 1);
    _m4.compose(_p3, _ringQ, _s3);
    pillarRingIM.setMatrixAt(k, _m4);
    // Uncertainty halo: flat disc at y=8, scaled to the 3σ radius.
    var hr = b.haloR || 15;
    _p3.set(b.x, 8, b.z);
    _q3.identity();
    _s3.set(hr, hr, 1);
    _m4.compose(_p3, _ringQ, _s3);
    haloIM.setMatrixAt(k, _m4);
  }

  function renderBusInstances() {
    var n = busSlots.length;
    if (busMode) {
      pillarMeshes.forEach(function (im) { im.visible = false; });
      var dn = Math.min(n, DETAIL_MAX);
      for (var i = 0; i < DETAIL_MAX; i++) {
        var d = getDetail(i);
        if (i < dn) {
          var s = busSlots[i];
          var fi = fleetLookup(s.vehicle.vehicle_id);
          d.group.position.set(s.x, 0, s.z);
          d.group.rotation.y = s.rotY;
          d.body.scale.set(fi.length_m, fi.height_m, fi.width_m);
          d.body.position.y = fi.height_m / 2 + 0.35;
          d.body.material.color.copy(s.color);
          var isSelD = !!selectedVehicleId && s.vehicle.vehicle_id === selectedVehicleId;
          var dsc = isSelD ? 1.45 : 1; // selected bus expands
          d.group.scale.set(dsc, dsc, dsc);
          d.wins.scale.set(fi.length_m * 0.88, fi.height_m * 0.32, fi.width_m * 1.02);
          d.wins.position.y = fi.height_m * 0.72 + 0.35;
          var wx = fi.length_m * 0.32, wz = fi.width_m / 2;
          d.wheels[0].position.set(wx, 0.55, wz);
          d.wheels[1].position.set(wx, 0.55, -wz);
          d.wheels[2].position.set(-wx, 0.55, wz);
          d.wheels[3].position.set(-wx, 0.55, -wz);
          d.vehicle = s.vehicle;
          d.group.visible = true;
        } else {
          d.group.visible = false;
          d.vehicle = null;
        }
      }
      updateBusBadges(n, 430);
      return;
    }
    // Pillar mode: hide detail models, fill instances.
    for (var j = 0; j < DETAIL_MAX; j++) {
      if (detailPool[j]) { detailPool[j].group.visible = false; detailPool[j].vehicle = null; }
    }
    pillarMeshes.forEach(function (im) { im.visible = true; });
    for (var k = 0; k < n; k++) {
      var b = busSlots[k];
      writeBusMatrices(k, b, 1);
      // Itinerary focus: darken pillars for routes not in the active trip.
      var pc = b.color;
      if (itineraryDims(b.vehicle.route_id)) {
        pc = b.color.clone().multiplyScalar(0.25);
      }
      pillarGlowIM.setColorAt(k, pc);
      pillarCoreIM.setColorAt(k, pc);
      pillarBeaconIM.setColorAt(k, pc);
      pillarRingIM.setColorAt(k, pc);
    }
    pillarMeshes.forEach(function (im) {
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
    });
    markColorsDirty();
    updateBusBadges(n, PILLAR_H * pillarYS + 80);
  }

  // Per-bus route badges: one sprite per bus, shown only at close street-level zooms.
  // Badge size tracks zoom (constant screen presence) via smoothBadges, called every frame.
  function badgeHeight() {
    var camDist = camera.position.distanceTo(controls.target);
    var h = Math.max(60, Math.min(170, camDist * 0.045));
    // Close-zoom ease: below ~6 km badges shrink toward 55% so dense
    // downtown clusters stop stacking into a wall of chips. Wide-out
    // presence is unchanged.
    if (camDist < 6000) {
      var t = Math.max(0, (camDist - 2600) / (6000 - 2600));
      h *= 0.55 + 0.45 * t;
    }
    return h;
  }
  function updateBusBadges(n, yBase) {
    var show = camera.position.distanceTo(controls.target) < 7000;
    var h = badgeHeight();
    for (var bi = 0; bi < BUS_MAX; bi++) {
      var sp = badgePool[bi];
      if (bi < n && show) {
        var bs = busSlots[bi];
        // The selected bus is identified by the card, the info sprite, and
        // the selection pulse: its route badge would be a second floating
        // label tracking the same bus. Hide it for visual clarity.
        if (selectedVehicleId && bs.vehicle && bs.vehicle.vehicle_id === selectedVehicleId) {
          sp.visible = false;
          continue;
        }
        var bt = routeBadgeTexture(bs.vehicle.route_id);
        if (sp.material.map !== bt.tex) { sp.material.map = bt.tex; sp.material.needsUpdate = true; }
        sp.userData.aspect = bt.aspect;
        sp.userData.slot = bi;
        sp.userData.pri = (selectedVehicleId && bs.vehicle.vehicle_id === selectedVehicleId) ? 0 : 1;
        sp.scale.set(h * bt.aspect, h, 1);
        sp.position.set(bs.x, yBase, bs.z);
        // Itinerary focus: dim badges for routes not in the active trip.
        sp.material.opacity = itineraryDims(bs.vehicle.route_id) ? 0.2 : 1;
        sp.visible = true;
      } else {
        sp.visible = false;
      }
    }
  }
  // Guaranteed badge decluttering: greedy screen-space insertion, selected
  // bus first, then stable slot order. Each badge tests its anchor against
  // placed rects; on overlap it spirals through 24 candidate offsets and
  // takes the first non-overlapping slot. Separation is guaranteed by
  // construction — badges never stack into a wall. Runs in smoothBadges.
  var _dcV = new THREE.Vector3(), _dcR = new THREE.Vector3(), _dcU = new THREE.Vector3();
  function declutterBadges() {
    var cw = renderer.domElement.clientWidth || 1, ch = renderer.domElement.clientHeight || 1;
    var items = [];
    for (var i = 0; i < badgePool.length; i++) {
      var sp = badgePool[i];
      if (!sp.visible || !sp.userData.aspect) continue;
      items.push(sp);
    }
    if (items.length < 2) {
      // Still anchor single badges at their yBase (set by smoothBadges caller).
      return;
    }
    items.sort(function (a, b) { return (a.userData.pri - b.userData.pri) || (a.userData.slot - b.userData.slot); });
    camera.updateMatrixWorld();
    _dcR.setFromMatrixColumn(camera.matrix, 0);
    _dcU.setFromMatrixColumn(camera.matrix, 1);
    var placed = []; // {x,y,w,h} in screen px
    for (var k = 0; k < items.length; k++) {
      var s2 = items[k];
      var bw = s2.scale.x, bh = s2.scale.y;
      // anchor screen pos
      _dcV.copy(s2.position).project(camera);
      var ax = (_dcV.x * 0.5 + 0.5) * cw, ay = (-_dcV.y * 0.5 + 0.5) * ch;
      // badge world-to-px at anchor depth for offset conversion
      var dist = camera.position.distanceTo(s2.position);
      var wpp = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / ch;
      var found = null;
      outer:
      for (var ring = 0; ring <= 2; ring++) {
        var rad = ring * Math.max(bw, bh) * 0.75 / Math.max(wpp, 1e-6); // world units
        var steps = ring === 0 ? 1 : 8;
        for (var st = 0; st < steps; st++) {
          var ang = (st / steps) * Math.PI * 2 + ring * 0.4;
          var ox = ring === 0 ? 0 : Math.cos(ang) * rad;
          var oy = ring === 0 ? 0 : Math.sin(ang) * rad;
          // candidate world pos = anchor + right*ox + up*oy
          _dcV.copy(s2.position).addScaledVector(_dcR, ox).addScaledVector(_dcU, oy).project(camera);
          var cx = (_dcV.x * 0.5 + 0.5) * cw, cy = (-_dcV.y * 0.5 + 0.5) * ch;
          // screen-space badge rect (scale is world units; convert)
          var pxW = bw / Math.max(wpp, 1e-6), pxH = bh / Math.max(wpp, 1e-6);
          var ok = true;
          for (var p = 0; p < placed.length; p++) {
            var r = placed[p];
            if (Math.abs(cx - r.x) < (pxW + r.w) / 2 && Math.abs(cy - r.y) < (pxH + r.h) / 2) { ok = false; break; }
          }
          if (ok) { found = { x: cx, y: cy, w: pxW, h: pxH, ox: ox, oy: oy }; break outer; }
        }
      }
      if (!found) {
        // Fallback (shouldn't happen): stack above anchor.
        found = { x: ax, y: ay - placed.length * bh / Math.max(wpp, 1e-6), w: bw / wpp, h: bh / wpp, ox: 0, oy: placed.length * bh };
      }
      placed.push(found);
      s2.position.addScaledVector(_dcR, found.ox).addScaledVector(_dcU, found.oy);
    }
  }
  // Per-frame badge smoothing: scale and anchor track the live zoom every
  // frame, so badges glide with the pillars instead of stepping on a timer.
  // Visibility/texture assignment stays in updateBusBadges (data updates).
  function smoothBadges() {
    var h = badgeHeight();
    var yBase = busMode ? 150 : PILLAR_H * pillarYS + 80;
    for (var i = 0; i < badgePool.length; i++) {
      var sp = badgePool[i];
      if (!sp.visible || !sp.userData.aspect) continue;
      sp.scale.set(h * sp.userData.aspect, h, 1);
      // Reset to anchor before decluttering (declutter adds offsets).
      var bs = busSlots[sp.userData.slot];
      if (bs) sp.position.set(bs.x, yBase, bs.z);
    }
    declutterBadges();
  }

  // Zoom LOD: wide view shows the symbolic pillars; zoomed in past ~2.6 km
  // the markers resolve into true-scale bus models. Hysteresis avoids flicker.
  var busMode = false;
  function updateLOD() {
    var d = camera.position.distanceTo(controls.target);
    if (!busMode && d < 2600) busMode = true;
    else if (busMode && d > 3400) busMode = false;
  }

  // --- street view: the max-zoom experience --------------------------------
  // Pinch-zooming past STREET_ENTER_DIST hands off to a street-level view:
  // the camera glides (never cuts) to an oblique vantage over the nearest
  // stop, stop name labels fade in, and a camera floor keeps the lens out of
  // the geometry. Zooming back out past STREET_EXIT_DIST restores the orbit
  // view. Hysteresis on both ends so the handoff never flickers mid-pinch.
  var streetView = false;
  var STREET_ENTER_DIST = 1500, STREET_EXIT_DIST = 2600;
  var STREET_MIN_Y = 45;    // camera never dips into street-level geometry
  var streetTween = null;   // {t0, dur, fromPos, toPos, fromTgt, toTgt}
  var _svDir = new THREE.Vector3();

  function nearestStopTo(x, z, maxR) {
    var best = null, bd2 = maxR * maxR;
    var list = (stopPickList && stopPickList.length) ? stopPickList : (stopData || []);
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var dx = s.x - x, dz = s.z - z, d2 = dx * dx + dz * dz;
      if (d2 < bd2) { bd2 = d2; best = s; }
    }
    // People Mover stations are stop-class anchors too.
    for (var p = 0; p < pmStations.length; p++) {
      var q = pmStations[p];
      var qdx = q.x - x, qdz = q.z - z, qd2 = qdx * qdx + qdz * qdz;
      if (qd2 < bd2) { bd2 = qd2; best = q; }
    }
    return best;
  }
  // Eased camera flight: position + target glide together over ~1.4 s.
  // The user's grab always wins — pointerdown cancels the flight instantly.
  // --- DisplayBounds: device-specific visible-map framing --------------------
  // The map canvas (#live-map) is full-viewport with UI chrome overlaid. This
  // module measures the actually-visible map region ("safe frame") by
  // subtracting the screen rects of visible chrome elements. Phase 2's
  // transition engine will frame subjects inside the safe frame so the camera
  // never lands a subject under a card or panel.
  //
  // Phase 1: measurement only. Nothing consumes the safe frame yet. The API
  // is exposed as window.__db() for verification.
  var DisplayBounds = (function () {
    'use strict';
    var MOBILE_MAX_W = 768;

    function isShown(el) {
      if (!el || el.hidden) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    // Registry: chrome element -> viewport edge it docks to per device class.
    // 'modal' = centered overlay; when any modal is open the safe frame is
    // degenerate and callers must dismiss it before transitioning.
    var registry = [
      { sel: 'header.nav', edge: { mobile: 'top', desktop: 'top' }, visible: isShown },
      { id: 'bus-card', edge: { mobile: 'bottom', desktop: 'left' }, visible: isShown },
      { id: 'stop-card', edge: { mobile: 'bottom', desktop: 'left' }, visible: isShown },
      { id: 'trip-card', edge: { mobile: 'bottom', desktop: 'right' }, visible: isShown },
      { id: 'trip-planner', edge: { mobile: 'bottom', desktop: 'right' }, visible: isShown },
      { id: 'filter-panel', edge: { mobile: 'right', desktop: 'right' }, visible: isShown },
      { id: 'browse-panel', edge: { mobile: 'modal', desktop: 'modal' }, visible: isShown },
      { id: 'nav-overlay', edge: { mobile: 'modal', desktop: 'modal' }, visible: isShown },
      { id: 'map-hint', edge: { mobile: 'bottom', desktop: 'bottom' }, visible: isShown },
      { id: 'zoom-in', edge: { mobile: 'right', desktop: 'right' }, visible: isShown },
      { id: 'zoom-out', edge: { mobile: 'right', desktop: 'right' }, visible: isShown },
      { id: 'view-locate', edge: { mobile: 'right', desktop: 'right' }, visible: isShown },
      { id: 'view-reset', edge: { mobile: 'right', desktop: 'right' }, visible: isShown },
      { id: 'view-full', edge: { mobile: 'right', desktop: 'right' }, visible: isShown },
      { id: 'browse-toggle', edge: { mobile: 'right', desktop: 'right' }, visible: isShown },
      { id: 'map-bar', edge: { mobile: 'top', desktop: 'top' }, visible: isShown },
      { id: 'filter-btn', edge: { mobile: 'top', desktop: 'top' }, visible: isShown },
      { id: 'trip-btn', edge: { mobile: 'top', desktop: 'top' }, visible: isShown }
    ];

    function get() {
      var vw = window.innerWidth, vh = window.innerHeight;
      var dc = vw < MOBILE_MAX_W ? 'mobile' : 'desktop';
      var insets = { top: 0, left: 0, right: 0, bottom: 0 };
      var modalOpen = false;
      var parts = [];
      for (var i = 0; i < registry.length; i++) {
        var e = registry[i];
        var el = e.id ? document.getElementById(e.id) : document.querySelector(e.sel);
        if (!el || !e.visible(el)) continue;
        var r = el.getBoundingClientRect();
        var edge = e.edge[dc];
        if (edge === 'modal') { modalOpen = true; parts.push({ id: e.id || e.sel, edge: 'modal' }); continue; }
        var extent = edge === 'top' ? r.bottom
          : edge === 'left' ? r.right
          : edge === 'right' ? vw - r.left
          : vh - r.top; // bottom
        extent = Math.max(0, Math.round(extent));
        if (extent > insets[edge]) insets[edge] = extent;
        parts.push({ id: e.id || e.sel, edge: edge, extent: extent });
      }
      var sf = {
        x: insets.left, y: insets.top,
        w: Math.max(0, vw - insets.left - insets.right),
        h: Math.max(0, vh - insets.top - insets.bottom)
      };
      return {
        vw: vw, vh: vh, deviceClass: dc,
        insets: insets, modalOpen: modalOpen,
        safeFrame: sf,
        center: { x: Math.round(sf.x + sf.w / 2), y: Math.round(sf.y + sf.h / 2) },
        _parts: parts
      };
    }

    return { get: get, MOBILE_MAX_W: MOBILE_MAX_W };
  })();
  // Verification hook (Phase 1): window.__db() returns the live measurement.
  window.__db = function () { return DisplayBounds.get(); };
  // STAGING-ONLY debug readout: ?dbdebug=1 renders the live DisplayBounds
  // measurement into the DOM so script-less verification can read it.
  // Hostname-gated: never activates on production (2026-10-06).
  if (/[?&]dbdebug=1/.test(location.search) &&
      /smit4786\.github\.io|localhost/.test(location.hostname)) {
    (function () {
      var pre = document.createElement('pre');
      pre.id = 'db-debug';
      pre.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;max-width:92vw;max-height:40vh;overflow:auto;background:rgba(0,0,0,.85);color:#0f0;font:11px/1.4 monospace;padding:8px;white-space:pre-wrap;';
      document.body.appendChild(pre);
      setInterval(function () {
        try {
          var d = DisplayBounds.get();
          d.cam = [Math.round(camera.position.x), Math.round(camera.position.y), Math.round(camera.position.z)];
          d.tgt = [Math.round(controls.target.x), Math.round(controls.target.y), Math.round(controls.target.z)];
          d.follow = followVId;
          d.selectedBus = selectedVehicleId;
          pre.textContent = JSON.stringify(d, null, 1);
        } catch (e) { /* keep last */ }
      }, 500);
    })();
  }

  function glideTo(pos, tgt, dur, onDone) {
    streetTween = {
      t0: performance.now(), dur: dur || 1400,
      fromPos: camera.position.clone(), toPos: pos.clone(),
      fromTgt: controls.target.clone(), toTgt: tgt.clone(),
      onDone: (typeof onDone === 'function') ? onDone : null
    };
    controls.enabled = false;
  }
  function stepStreetTween(now) {
    if (!streetTween) return;
    var t = Math.min(1, (now - streetTween.t0) / streetTween.dur);
    // Minimum-jerk profile (Flash & Hogan): minimizes ∫jerk², the provably
    // smoothest rest-to-rest trajectory and the one human motor control uses.
    // Closed-form quintic; replaces easeInOutCubic. Interruption, follow-on-
    // complete, and safe-frame offset behavior unchanged.
    var e = t * t * t * (t * (t * 6 - 15) + 10);
    camera.position.lerpVectors(streetTween.fromPos, streetTween.toPos, e);
    controls.target.lerpVectors(streetTween.fromTgt, streetTween.toTgt, e);
    if (t >= 1) {
      var done = streetTween.onDone;
      streetTween = null;
      if (!tripFly) controls.enabled = true;
      // Only a naturally completed glide runs its follow directive; a
      // cancelled glide (pointerdown / programmatic move) never does.
      if (done) { try { done(); } catch (err) {} }
    }
  }
  // Programmatic camera moves (reset, locate) cancel any in-flight glide so
  // they don't fight over the camera.
  function cancelStreetTween() {
    if (streetTween) { streetTween = null; if (!tripFly) controls.enabled = true; }
    setFollow(null); // any programmatic move also ends bus tracking (restores zoomToCursor)
  }
  renderer.domElement.addEventListener('pointerdown', function () {
    if (streetTween) { streetTween = null; if (!tripFly) controls.enabled = true; }
    setFollow(null); // user takes the camera: stop tracking the bus
  });

  // --- Camera memory (2026-10-15) ---------------------------------------
  // Opening a card flies the camera to the card's subject (bus, stop,
  // place); the rider's own framing — where they were looking, at their
  // zoom — is otherwise lost, and closing the card strands the camera at
  // the subject. One snapshot repairs that: it is taken on the transition
  // INTO a card session (the first card opened while no card session is
  // active — showBus / showStop / setRideMode(true) / setTripMode(true)
  // call camMemTake) and restored by camMemOnSettled, which exclRestore
  // calls once a close leaves nothing showing. Chained cards never
  // overwrite it: when a covering card closes, the exclusion stack
  // restores the covered card and the session (and its snapshot) simply
  // continues; the revert fires only when the LAST card closes. The
  // snapshot lives in a variable only — never persisted.
  //
  // Rules around the snapshot:
  // - A framing gliding INTO place counts at its destination: if a glide
  //   is in flight when the snapshot is taken or refreshed, the glide's
  //   target framing is the rider's framing, not a mid-flight point.
  // - Manual camera moves while a card is open (drag, wheel, the rail's
  //   zoom buttons) never touch the snapshot: closing the card reverts
  //   them, per the directed behavior.
  // - Explicit camera actions are not card opens and are never reverted:
  //   Home/Reset and a successful locate REDEFINE the preserved framing
  //   (camMemRefresh, called by resetView and onLocated) — if a card is
  //   open over them, closing it returns to the framing they chose.
  // - A follow session is live-driven: engaging follow under a held
  //   snapshot marks it follow-owned. A card close that leaves follow
  //   running (the ride card) does NOT restore — follow owns the camera
  //   and the snapshot stays held; the bus card's close ends follow
  //   first (hideBus), so its restore fires normally, back to the fixed
  //   pre-follow framing however far the bus has since travelled. If
  //   follow instead ends with no card showing (the bus left the set,
  //   the rider grabbed the camera), the snapshot is dropped
  //   unrestored: the session that preserved it is over, and the camera
  //   stays where the rider's hands or the bus left it.
  // - Restore clamps the preserved distance into the controls' CURRENT
  //   limits (street view widens minDistance while it is active, so a
  //   framing preserved inside street view must not be restored past
  //   the limit in force at close). A card that never moved the camera
  //   (planner open, ride open without boarding) restores as a no-op.
  var camMem = null; // {pos, tgt, followOwned}
  function camMemFraming() {
    if (streetTween) return { pos: streetTween.toPos.clone(), tgt: streetTween.toTgt.clone() };
    return { pos: camera.position.clone(), tgt: controls.target.clone() };
  }
  function camMemTake() {
    if (camMem) return;
    if (typeof tripFly !== 'undefined' && tripFly) return; // the cinematic owns the camera
    var cur = visibleSurface();
    if (cur === 'stop' || cur === 'bus' || cur === 'trip' || cur === 'ride') return;
    var f = camMemFraming();
    camMem = { pos: f.pos, tgt: f.tgt, followOwned: !!followVId };
  }
  function camMemRefresh() {
    if (!camMem) return;
    var f = camMemFraming();
    camMem.pos = f.pos;
    camMem.tgt = f.tgt;
  }
  function camMemOnSettled() {
    if (!camMem) return;
    if (visibleSurface()) return;
    if (followVId) return; // follow owns the camera; the snapshot stays held
    if (typeof tripFly !== 'undefined' && tripFly) return; // cinematic owns the camera
    var mem = camMem;
    camMem = null;
    var off = mem.pos.clone().sub(mem.tgt);
    var len = off.length();
    var cl = Math.max(controls.minDistance, Math.min(controls.maxDistance, len));
    var pos = (len > 0 && cl !== len) ? mem.tgt.clone().add(off.setLength(cl)) : mem.pos;
    if (pos.distanceTo(camera.position) < 0.5 && mem.tgt.distanceTo(controls.target) < 0.5) return;
    var dist = camera.position.distanceTo(pos);
    glideTo(pos, mem.tgt, Math.min(1600, Math.max(600, dist * 0.35)));
  }
  // --- TransitionEngine (Phase 2) -----------------------------------------
  // After-touch camera transitions: every selection intent flows through one
  // path that frames the subject at the DisplayBounds safe-frame center
  // (not the viewport center), animates position + target with the existing
  // interruptible glide, and applies the intent's follow directive only on
  // natural completion. A cancelled intent never engages follow.
  var TransitionEngine = (function () {
    function worldPerPixel(dist) {
      var vFov = THREE.MathUtils.degToRad(camera.fov);
      var h = renderer.domElement.clientHeight || 1;
      return (2 * dist * Math.tan(vFov / 2)) / h;
    }
    // Shift pos/tgt so the subject renders at the safe-frame center instead
    // of the viewport center. Uses the camera's right/up basis at the
    // subject's depth; no-ops when the safe frame is already centered.
    function applySafeFrameOffset(pos, tgt) {
      var b = DisplayBounds.get();
      var sx = b.center.x - b.vw / 2, sy = b.center.y - b.vh / 2;
      if (Math.abs(sx) < 1 && Math.abs(sy) < 1) return { pos: pos, tgt: tgt };
      var wpp = worldPerPixel(pos.distanceTo(tgt));
      camera.updateMatrixWorld();
      var right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
      var up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      var off = new THREE.Vector3()
        .addScaledVector(right, -sx * wpp)
        .addScaledVector(up, sy * wpp);
      return { pos: pos.clone().add(off), tgt: tgt.clone().add(off) };
    }
    // 32° elevated vantage for a bus at (bx, bz); keeps the current azimuth
    // so buildings don't occlude the subject. Distance respects the active
    // zoom limit so the per-frame clamp can't snap back mid-glide.
    function vantageForBus(bx, bz) {
      var bd = Math.max(controls.minDistance * 1.3, 900);
      _svDir.copy(camera.position).sub(controls.target); _svDir.y = 0;
      if (_svDir.lengthSq() < 1e-6) _svDir.set(1, 0, 0);
      _svDir.normalize();
      return {
        pos: new THREE.Vector3(bx + _svDir.x * bd, bd * 0.65, bz + _svDir.z * bd),
        tgt: new THREE.Vector3(bx, 40, bz)
      };
    }
    // 32° elevated vantage for a stop at (sx, sy, sz); keeps the current
    // azimuth. Closer than the bus vantage (stops are smaller targets).
    function vantageForStop(sx, sy, sz) {
      var sd = Math.max(controls.minDistance * 1.1, 700);
      _svDir.copy(camera.position).sub(controls.target); _svDir.y = 0;
      if (_svDir.lengthSq() < 1e-6) _svDir.set(1, 0, 0);
      _svDir.normalize();
      return {
        pos: new THREE.Vector3(sx + _svDir.x * sd, sy + sd * 0.65, sz + _svDir.z * sd),
        tgt: new THREE.Vector3(sx, sy, sz)
      };
    }
    // intent: { vantage:{pos,tgt}, follow:'engage'|'hold', vehicleId, slot }
    function go(intent) {
      if (typeof tripFly !== 'undefined' && tripFly) return; // D4a: cinematic owns the camera
      var framed = applySafeFrameOffset(intent.vantage.pos, intent.vantage.tgt);
      var dist = camera.position.distanceTo(framed.pos);
      var dur = Math.min(1600, Math.max(600, dist * 0.35));
      glideTo(framed.pos, framed.tgt, dur, function () {
        if (intent.follow === 'engage' && intent.vehicleId) setFollow(intent.vehicleId, intent.slot);
        else refreshFollowBtn();
      });
    }
    return { go: go, vantageForBus: vantageForBus, vantageForStop: vantageForStop };
  })();
  // Vantage for a stop anchor: keep the user's current azimuth, pull back to
  // an oblique street-level framing. Works for DDOT stops (ground) and
  // People Mover stations (elevated deck).
  function streetVantageFor(st) {
    var ax = st.x, az = st.z, ay = st.pm ? PM_DECK_Y : STOP_BASE_Y;
    _svDir.copy(camera.position).sub(controls.target); _svDir.y = 0;
    if (_svDir.lengthSq() < 1e-6) _svDir.set(1, 0, 0);
    _svDir.normalize();
    return {
      pos: new THREE.Vector3(ax + _svDir.x * 620, ay + 250, az + _svDir.z * 620),
      tgt: new THREE.Vector3(ax, ay, az)
    };
  }
  function enterStreetView() {
    var anchor = nearestStopTo(controls.target.x, controls.target.z, 900);
    var st = anchor || { x: controls.target.x, z: controls.target.z };
    var v = streetVantageFor(st);
    controls.minDistance = 150;   // street view owns the close range
    camera.near = 10; camera.updateProjectionMatrix();
    streetView = true;
    streetGuideFadeTarget = 0.07; // guideways recede; stops + buses take over
    glideTo(v.pos, v.tgt, 1400);
  }
  function exitStreetView() {
    streetView = false;
    controls.minDistance = 1200;  // restore the orbit constraint
    camera.near = 100; camera.updateProjectionMatrix();
    streetGuideFadeTarget = 1;    // guideways glide back
    // No forced camera move: the user is already zooming out.
  }
  // Stop name labels: the "individual stops" legibility layer. Only in
  // street view, nearest few within ~1 km of the target.
  var stopLabelCache = {};
  function stopLabelTex(name) {
    var hit = stopLabelCache[name];
    if (hit) return hit;
    var c = document.createElement('canvas');
    var x = c.getContext('2d');
    x.font = '500 30px system-ui, -apple-system, sans-serif';
    var w = Math.ceil(x.measureText(name).width) + 44;
    c.width = w; c.height = 56;
    var g = x; // redraw after resize (resizing clears the context state)
    g.fillStyle = 'rgba(10,14,18,0.85)';
    g.beginPath();
    if (g.roundRect) g.roundRect(0, 0, c.width, c.height, 14); else g.rect(0, 0, c.width, c.height);
    g.fill();
    g.font = '500 30px system-ui, -apple-system, sans-serif';
    g.fillStyle = '#F5F2EA'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(name, c.width / 2, c.height / 2 + 1);
    var t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    var o = { tex: t, aspect: c.width / c.height };
    stopLabelCache[name] = o;
    return o;
  }
  var stopLabelPool = [];
  for (var _svi = 0; _svi < 8; _svi++) {
    var _svl = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 }));
    _svl.visible = false;
    _svl.renderOrder = 36;
    scene.add(_svl);
    stopLabelPool.push(_svl);
  }
  var lastStopLabelUpdate = 0;
  function updateStopLabels() {
    var now = performance.now();
    if (now - lastStopLabelUpdate < 500) return;
    lastStopLabelUpdate = now;
    var i;
    if (!streetView) {
      for (i = 0; i < stopLabelPool.length; i++) stopLabelPool[i].visible = false;
      return;
    }
    var tx = controls.target.x, tz = controls.target.z;
    var scored = [];
    var list = (stopPickList && stopPickList.length) ? stopPickList : (stopData || []);
    for (i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s.n) continue;
      var d2 = (s.x - tx) * (s.x - tx) + (s.z - tz) * (s.z - tz);
      if (d2 < 1000 * 1000) scored.push([d2, s]);
    }
    for (var p = 0; p < pmStations.length; p++) {
      var q = pmStations[p];
      var qd2 = (q.x - tx) * (q.x - tx) + (q.z - tz) * (q.z - tz);
      if (qd2 < 1000 * 1000) scored.push([qd2, q]);
    }
    scored.sort(function (a, b) { return a[0] - b[0]; });
    // Nearest-first placement with screen-space collision: no overlapping
    // stop labels (2026-10-06: production screenshot showed stop names
    // stacking into unreadable piles at street zoom).
    var placed = [];
    var rw = renderer.domElement.clientWidth, rh = renderer.domElement.clientHeight;
    var camDist = camera.position.distanceTo(controls.target);
    var pxPerM = rh / (2 * camDist * Math.tan(camera.fov * 0.5 * DEG));
    var n = 0;
    for (i = 0; i < scored.length && n < stopLabelPool.length; i++) {
      var st = scored[i][1];
      var o = stopLabelTex(st.n);
      var ly = (st.pm ? PM_DECK_Y : STOP_BASE_Y) + stopHeight((st.r || []).length) * stopYS + 40;
      _p3.set(st.x, ly, st.z).project(camera);
      if (_p3.z > 1 || _p3.z < -1) continue;
      var cxp = (_p3.x * 0.5 + 0.5) * rw, cyp = (-_p3.y * 0.5 + 0.5) * rh;
      var lw = 44 * o.aspect * pxPerM, lh = 44 * pxPerM;
      var clash = false;
      for (var c = 0; c < placed.length; c++) {
        var pr = placed[c];
        if (Math.abs(cxp - pr.x) < (lw + pr.w) / 2 + 8 &&
            Math.abs(cyp - pr.y) < (lh + pr.h) / 2 + 6) { clash = true; break; }
      }
      if (clash) continue;
      placed.push({ x: cxp, y: cyp, w: lw, h: lh });
      var sp = stopLabelPool[n++];
      if (sp.userData.tex !== o.tex) { sp.material.map = o.tex; sp.userData.tex = o.tex; sp.material.needsUpdate = true; }
      sp.scale.set(44 * o.aspect, 44, 1);
      sp.position.set(st.x, ly, st.z);
      sp.visible = true;
    }
    for (i = n; i < stopLabelPool.length; i++) stopLabelPool[i].visible = false;
  }

  // Zoom-coupled pillar scale, eased every frame toward the zoom target so
  // markers glide instead of stepping. Rewrites instance matrices only while
  // the eased value is still moving; badge anchors follow the pillar tops.
  function easePillarScale(camDist) {
    if (busMode) return; // true-scale models need no pillar scaling
    var target = pillarScaleFor(camDist);
    var d = target - pillarYS;
    if (Math.abs(d) < 0.003) {
      if (pillarYS === target) return;
      pillarYS = target;
    } else {
      pillarYS += d * 0.16;
    }
    for (var k = 0; k < busSlots.length; k++) writeBusMatrices(k, busSlots[k], 1);
    pillarMeshes.forEach(function (im) { im.instanceMatrix.needsUpdate = true; });
    updateBusBadges(busSlots.length, PILLAR_H * pillarYS + 80);
  }

  // Zoom-coupled stop scale, eased every frame like the pillars. Matrix-only
  // rewrites while moving (colors are untouched); the selection highlight is
  // re-applied after each rewrite. People Mover pins follow the same scale
  // so all stop-class markers behave as one family.
  function easeStopScale(camDist) {
    var target = stopScaleFor(camDist);
    var d = target - stopYS;
    if (Math.abs(d) < 0.003) {
      if (stopYS === target) return;
      stopYS = target;
    } else {
      stopYS += d * 0.16;
    }
    if (stopPickList.length) {
      writeStopMatrices(stopPickList, false);
      setStopSelectedColor(selectedStopIndex, true);
    }
    for (var p = 0; p < pmPins.length; p++) {
      var pin = pmPins[p];
      pin.scale.y = stopYS;
      pin.position.y = PM_DECK_Y + (300 * stopYS) / 2;
    }
    if (typeof mogoRescale === 'function') mogoRescale();
    if (typeof placesRescale === 'function') placesRescale();
    // NOTE 2026-10-06: stop distance-fade (opacity easing) reverted — it
    // correlated with renderer crashes in testing. Stops stay fully opaque
    // until a safer quieting mechanism is validated.
  }

  var raycaster = new THREE.Raycaster();
  var pointerNDC = new THREE.Vector2();
  var downPos = null;
  // Nearest bus within a touch-friendly screen radius (fingers are imprecise).
  // Pillar mode: distance to the pillar's full screen segment (base -> beacon),
  // so tapping anywhere along the visible column selects the bus. Bus mode:
  // distance to the model position on the ground.
  function pickNearestScreen(cx, cy, r) {
    var best = null, bestD2 = 48 * 48;
    for (var i = 0; i < busSlots.length; i++) {
      var s = busSlots[i];
      var d2;
      if (busMode) {
        _p3.set(s.x, 40, s.z).project(camera);
        if (_p3.z > 1 || _p3.z < -1) continue;
        var sx = (_p3.x * 0.5 + 0.5) * r.width + r.left;
        var sy = (-_p3.y * 0.5 + 0.5) * r.height + r.top;
        var ddx = sx - cx, ddy = sy - cy;
        d2 = ddx * ddx + ddy * ddy;
      } else {
        _p3.set(s.x, 0, s.z).project(camera);
        if (_p3.z > 1 || _p3.z < -1) continue;
        var ax = (_p3.x * 0.5 + 0.5) * r.width + r.left;
        var ay = (-_p3.y * 0.5 + 0.5) * r.height + r.top;
        _p3.set(s.x, PILLAR_H * pillarYS + 48, s.z).project(camera);
        if (_p3.z > 1 || _p3.z < -1) continue;
        var bx = (_p3.x * 0.5 + 0.5) * r.width + r.left;
        var by = (-_p3.y * 0.5 + 0.5) * r.height + r.top;
        var vx = bx - ax, vy = by - ay;
        var len2 = vx * vx + vy * vy;
        var tt = len2 ? ((cx - ax) * vx + (cy - ay) * vy) / len2 : 0;
        tt = tt < 0 ? 0 : (tt > 1 ? 1 : tt);
        var px = ax + tt * vx - cx, py = ay + tt * vy - cy;
        d2 = px * px + py * py;
      }
      if (d2 < bestD2) { bestD2 = d2; best = s.vehicle; }
    }
    return best;
  }
  // Tap a stop pylon: raycast the instanced markers, report name + routes.
  // Touch gets a 44px screen-space nearest fallback so finger taps are
  // forgiving at far zooms (mirrors the bus pillar fallback).
  var _stopV3 = null;
  // Touch fallback: nearest stop center on screen within 44px. Split out so
  // the tap handler can try the depth-ordered raycast first.
  function pickStopScreen(cx, cy, r) {
    if (!_stopV3) _stopV3 = new THREE.Vector3();
    var sx = cx - r.left, sy = cy - r.top;
    var best = null, bestD = 44;
    for (var i = 0; i < stopPickList.length; i++) {
      var s = stopPickList[i];
      _stopV3.set(s.x, STOP_BASE_Y + stopHeight(s.r.length) * stopYS / 2, s.z).project(camera);
      if (_stopV3.z > 1) continue;
      var px = (_stopV3.x * 0.5 + 0.5) * r.width;
      var py = (-_stopV3.y * 0.5 + 0.5) * r.height;
      var d = Math.hypot(px - sx, py - sy);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }
  function pickStop(cx, cy, isTouch) {
    if (!stopGroup || !stopGroup.visible || !stopPickList.length) return null;
    var r = renderer.domElement.getBoundingClientRect();
    pointerNDC.set(
      ((cx - r.left) / r.width) * 2 - 1,
      -(((cy - r.top) / r.height) * 2 - 1)
    );
    raycaster.setFromCamera(pointerNDC, camera);
    var hits = raycaster.intersectObject(stopIM);
    if (hits.length && hits[0].instanceId != null) {
      return stopPickList[hits[0].instanceId] || null;
    }
    if (!isTouch) return null;
    return pickStopScreen(cx, cy, r);
  }
  // Depth-ordered tap pick: buses and stops in ONE raycast so the visually
  // frontmost marker wins. Previously buses were tested first and always won,
  // even when a stop stood in front of the pillar (2026-10-06: tapping a stop
  // overlapping a bus pillar could not select the stop).
  function pickTopHit(cx, cy) {
    var r = renderer.domElement.getBoundingClientRect();
    pointerNDC.set(
      ((cx - r.left) / r.width) * 2 - 1,
      -(((cy - r.top) / r.height) * 2 - 1)
    );
    raycaster.setFromCamera(pointerNDC, camera);
    var targets = [];
    var busMeshCount = 0;
    if (busMode) {
      for (var i = 0; i < DETAIL_MAX; i++) {
        var d = detailPool[i];
        if (d && d.group.visible) { targets.push(d.body); busMeshCount++; }
      }
    } else {
      targets.push(pillarBeaconIM, pillarGlowIM, pillarCoreIM);
      busMeshCount = 3;
    }
    var stopMesh = null;
    if (stopGroup && stopGroup.visible && stopPickList.length) {
      stopMesh = stopIM; targets.push(stopIM);
    }
    if (!targets.length) return null;
    var hits = raycaster.intersectObjects(targets);
    if (!hits.length) return null;
    var h = hits[0];
    if (stopMesh && h.object === stopMesh) {
      var st = (h.instanceId != null) ? (stopPickList[h.instanceId] || null) : null;
      return st ? { kind: 'stop', stop: st } : null;
    }
    if (busMode) {
      var veh = (h.object.userData.detail) ? h.object.userData.detail.vehicle : null;
      return veh ? { kind: 'bus', vehicle: veh } : null;
    }
    var slot = (h.instanceId != null) ? busSlots[h.instanceId] : null;
    return (slot && slot.vehicle) ? { kind: 'bus', vehicle: slot.vehicle } : null;
  }
  function pickBus(cx, cy, touchSlop) {
    var r = renderer.domElement.getBoundingClientRect();
    pointerNDC.set(
      ((cx - r.left) / r.width) * 2 - 1,
      -((cy - r.top) / r.height) * 2 + 1
    );
    raycaster.setFromCamera(pointerNDC, camera);
    if (busMode) {
      var bodies = [];
      for (var i = 0; i < DETAIL_MAX; i++) {
        var d = detailPool[i];
        if (d && d.group.visible) bodies.push(d.body);
      }
      var hits = raycaster.intersectObjects(bodies);
      if (hits.length) return hits[0].object.userData.detail.vehicle;
    } else {
      // Beacon heads, the visible glow column, then thin cores.
      var ih = raycaster.intersectObjects([pillarBeaconIM, pillarGlowIM, pillarCoreIM]);
      if (ih.length && ih[0].instanceId != null && busSlots[ih[0].instanceId]) {
        return busSlots[ih[0].instanceId].vehicle;
      }
    }
    if (touchSlop) return pickNearestScreen(cx, cy, r);
    return null;
  }
  renderer.domElement.addEventListener('pointerdown', function (e) {
    downPos = [e.clientX, e.clientY];
  });
  // Tapping the info pill dismisses it (the × is the affordance; the
  // whole pill is the target — fingers are imprecise).
  function tapHitsBusInfo(cx, cy) {
    if (!busInfoSprite.visible) return false;
    var r = renderer.domElement.getBoundingClientRect();
    pointerNDC.set(
      ((cx - r.left) / r.width) * 2 - 1,
      -(((cy - r.top) / r.height) * 2 - 1)
    );
    raycaster.setFromCamera(pointerNDC, camera);
    return raycaster.intersectObject(busInfoSprite).length > 0;
  }
  renderer.domElement.addEventListener('pointerup', function (e) {
    if (!downPos) return;
    var dx = e.clientX - downPos[0], dy = e.clientY - downPos[1];
    downPos = null;
    var isTouch = e.pointerType === 'touch';
    if (dx * dx + dy * dy > (isTouch ? 169 : 36)) return; // was a drag (13px touch slop)
    if (tapHitsBusInfo(e.clientX, e.clientY)) { hideBus(); return; }
    // Depth-ordered: one raycast across buses and stops, frontmost wins.
    var hit = pickTopHit(e.clientX, e.clientY);
    if (hit && hit.kind === 'bus') { showBus(hit.vehicle); return; }
    if (hit && hit.kind === 'stop') { showStop(hit.stop); return; }
    // People Mover stations first: their elevated pins were losing taps to the
    // dense downtown DDOT stops beneath them. (No-op while the PM layer is off.)
    var pm = pickPMStation(e.clientX, e.clientY, isTouch);
    if (pm) { showStop(pm); return; }
    // MoGo bikeshare stations: same direct-pick precedence as the
    // People Mover pins. (No-op while the layer is off or feed down.)
    var mg = (typeof pickMogoStation === 'function') ? pickMogoStation(e.clientX, e.clientY, isTouch) : null;
    if (mg) { showStop(mg); return; }
    // Places (Starbucks / Planet Fitness): same direct-pick precedence,
    // after MoGo. (No-op while both brand toggles are off.)
    var pl = (typeof pickPlace === 'function') ? pickPlace(e.clientX, e.clientY, isTouch) : null;
    if (pl) { showStop(pl); return; }
    if (isTouch) {
      // Raycast missed everything: nearest-on-screen fallbacks, as before.
      var _r = renderer.domElement.getBoundingClientRect();
      var _v = pickNearestScreen(e.clientX, e.clientY, _r);
      if (_v) { showBus(_v); return; }
      var _st = pickStopScreen(e.clientX, e.clientY, _r);
      if (_st) { showStop(_st); return; }
    }
    hideBus(); hideStop();
  });
  renderer.domElement.addEventListener('pointermove', function (e) {
    if (e.pointerType !== 'mouse' || downPos) return;
    renderer.domElement.style.cursor = pickBus(e.clientX, e.clientY) ? 'pointer' : 'grab';
  });

  function compass(bearing) {
    if (bearing == null || isNaN(bearing)) return '–';
    return COMPASS[Math.round(bearing / 45) % 8] + ' (' + Math.round(bearing) + '°)';
  }

  function tapBuzz() { try { if (navigator.vibrate) navigator.vibrate(10); } catch (e) {} }
  // Selected-bus follow: the one-time glide in showBus lands on the bus's
  // position at select time, but dead reckoning moves every bus each frame and
  // polls re-match it — without tracking, the bus drives out of the static
  // view. While a bus is selected, followTick translates the whole camera rig
  // with the bus's live slot position, so the selection stays on screen.
  // Any canvas pointerdown hands the camera back to the user.
  var followVId = null;
  var followSuppressed = false; // user explicitly toggled follow OFF for this selection
  var _followPrev = new THREE.Vector3();
  // Single mutation point for follow state: keeps the Follow button label in
  // sync wherever tracking starts or stops.
  function setFollow(vid, slot) {
    followVId = vid || null;
    // Camera memory: follow engaged under a held snapshot marks the
    // session follow-owned; follow ending with no card showing drops a
    // follow-owned snapshot unrestored (see the camera-memory block).
    if (followVId) { if (camMem) camMem.followOwned = true; }
    else if (camMem && camMem.followOwned && !visibleSurface()) camMem = null;
    // Cursor-anchored zoom re-anchors the orbit target to the cursor ray on
    // every wheel tick, which fights followTick's bus-anchored target and
    // teleports the camera off the bus. Track-centered zoom while following.
    if (typeof controls !== 'undefined') controls.zoomToCursor = !followVId;
    if (followVId && slot) _followPrev.set(slot.x, 0, slot.z);
    refreshFollowBtn();
  }
  function followTick() {
    if (!followVId) return;
    var sl = null;
    for (var i = 0; i < busSlots.length; i++) {
      if (busSlots[i].vehicle && busSlots[i].vehicle.vehicle_id === followVId) { sl = busSlots[i]; break; }
    }
    if (!sl) { setFollow(null); return; } // bus left the visible set: stop
    if (streetTween || (typeof tripFly !== 'undefined' && tripFly)) {
      _followPrev.set(sl.x, 0, sl.z); // a glide owns the camera: keep the seed fresh
      return;
    }
    var dx = sl.x - _followPrev.x, dz = sl.z - _followPrev.z;
    if (dx || dz) {
      camera.position.x += dx; camera.position.z += dz;
      controls.target.x += dx; controls.target.z += dz;
      _followPrev.set(sl.x, 0, sl.z);
    }
  }
  /* === DIRECTION C — ONE SURFACE AT A TIME (mutual exclusion) =========
     The stop card, bus card, trip card, ride card, routes panel and
     browse panel share one screen slot. Opening any of them covers
     whichever is open; closing the covering surface restores the covered
     one. Covering hides the element ONLY — selection and mode state are
     never cleared by exclusion, so the covered surface returns exactly
     as it was (the stop card you were reading is still there when the
     Routes panel closes). Hard closes keep their existing semantics and
     live in the surfaces' own close paths (hideBus / hideStop /
     setTripMode(false) / setRideMode(false) / togglePanel(false) /
     setBrowse(false)); each of those calls exclRestore() when it
     finishes. The one deliberate exception: stop taps while the trip
     planner is open are planner inputs (tripStopTapped) and never open
     the stop card over the planner. ================================ */
  var _coveredStack = []; // surface names hidden by exclusion, state intact
  var _exclBusy = false;   // reentrancy guard while exclusion wiring runs
  function _surfaceElId(name) {
    return name === 'filter' ? 'filter-panel'
      : name === 'browse' ? 'browse-panel' : name + '-card';
  }
  function visibleSurface() {
    var names = ['stop', 'bus', 'trip', 'ride', 'filter', 'browse'];
    for (var i = 0; i < names.length; i++) {
      var el = $(_surfaceElId(names[i]));
      if (el && !el.hidden) return names[i];
    }
    return null;
  }
  function _hideSurfaceEl(name) {
    var el = $(_surfaceElId(name));
    if (el) el.hidden = true;
    if (name === 'filter') $('filter-btn').setAttribute('aria-expanded', 'false');
    if (name === 'browse') $('browse-toggle').setAttribute('aria-expanded', 'false');
  }
  function _showSurfaceEl(name) {
    var el = $(_surfaceElId(name));
    if (el) el.hidden = false;
    if (name === 'filter') $('filter-btn').setAttribute('aria-expanded', 'true');
    if (name === 'browse') $('browse-toggle').setAttribute('aria-expanded', 'true');
  }
  function _surfaceStillValid(name) {
    if (name === 'stop') return !!selectedStop;
    if (name === 'bus') return !!selectedVehicleId;
    if (name === 'trip') return typeof tripMode !== 'undefined' && !!tripMode;
    if (name === 'ride') return !!rideMode;
    return false;
  }
  // Called at the top of every surface's own open path (the opener then
  // unhides itself). Closes panels outright, hard-closes the other mode
  // when a mode opens, and covers any card with its state intact.
  function exclCover(name) {
    _coveredStack = _coveredStack.filter(function (n) { return n !== name; });
    var cur = visibleSurface();
    if (!cur || cur === name) return;
    _exclBusy = true;
    try {
      if (cur === 'filter') togglePanel(false);
      else if (cur === 'browse') setBrowse(false);
      else if ((cur === 'trip' || cur === 'ride') && (name === 'trip' || name === 'ride')) {
        if (cur === 'trip') setTripMode(false); else setRideMode(false);
      } else {
        _hideSurfaceEl(cur);
        _coveredStack.push(cur);
      }
    } finally { _exclBusy = false; }
  }
  // Called at the end of every surface's own close path: if nothing is
  // showing, bring back the most recently covered surface whose state is
  // still live. Entries whose state was hard-cleared meanwhile are
  // dropped silently.
  function exclRestore() {
    if (_exclBusy) return;
    if (visibleSurface()) return;
    while (_coveredStack.length) {
      var name = _coveredStack.pop();
      if (!_surfaceStillValid(name)) continue;
      _showSurfaceEl(name);
      if (name === 'stop' && typeof renderStopLive === 'function') renderStopLive();
      return;
    }
    camMemOnSettled();
  }

  var _busReturnFocus = null;
  var _stopReturnFocus = null;
  function showBus(v) {
    if (!v) return;
    camMemTake();
    exclCover('bus');
    var isReselect = (v.vehicle_id === selectedVehicleId);
    tapBuzz();
    selectedVehicleId = v.vehicle_id;
    renderBusInstances(); // expand the selected indicator
    var sn = v.route_id;
    var dest = formatDest(sn, v.destination);
    var chipBg = routeColors[sn] ? '#' + routeColors[sn].getHexString() : '#F5F2EA';
    $('bus-chip').style.background = chipBg;
    var chipC = $('bus-chip-c'); // compact bar (staging Phase 2 HTML); guard for HTML without it
    if (chipC) chipC.style.background = chipBg;
    var compactTitle = routeLabel(sn) + (dest ? ' → ' + dest : '');
    $('bus-title').textContent = compactTitle;
    var cTitle = $('bus-compact-title');
    if (cTitle) cTitle.textContent = compactTitle;
    var cId = $('bus-compact-id');
    if (cId) cId.textContent = 'Vehicle ' + (v.vehicle_id || '–');
    $('bus-id').textContent = v.vehicle_id || '–';
    $('bus-dest').textContent = formatDest(sn, v.destination) || '–';
    $('bus-speed').textContent = (v.speed_mph != null && !isNaN(v.speed_mph)) ? Math.round(v.speed_mph) + ' mph' : '–';
    $('bus-heading').textContent = compass(v.bearing);
    var fi = fleetLookup(v.vehicle_id);
    $('bus-model').textContent = fi.model + ' · ' + fi.detail;
    $('bus-cap').textContent = (fi.seats != null ? fi.seats + ' seats · ' : '') + fi.length_m.toFixed(1) + ' m long';
    var when = v.updated_at ? new Date(v.updated_at) : null;
    $('bus-card-updated').textContent = (when && !isNaN(when)) ? when.toLocaleTimeString() : '–';
    $('bus-card').hidden = false;
    // Ride Along: while ride mode is on, a bus selection from any surface
    // (map tap, Browse list, arrow keys — all funnel through showBus)
    // boards that bus in the widget, so the rider's-seat view follows the
    // selection instead of waiting for the card's own dropdown.
    var rideBoarded = false;
    if (rideMode && rideWidget) rideBoarded = boardRideBus(v.vehicle_id, false);
    // Dialog focus: remember the opener only on a fresh open, then move
    // focus into the card. Arrow-key cycling re-enters showBus with the
    // card already focused, so the original opener is preserved.
    if (_busReturnFocus === null && document.activeElement && !$('bus-card').contains(document.activeElement)) _busReturnFocus = document.activeElement;
    $('bus-card').focus();
    announceSr('Bus details opened. ' + compactTitle + '. Vehicle ' + (v.vehicle_id || 'unknown') + '.');
    // D1a: on mobile the card opens as a compact route/vehicle bar; tap to expand.
    setBusCardCompact(DisplayBounds.get().deviceClass === 'mobile');
    refreshBusInfo(); // in-scene label beside the bus
    if (typeof renderBetaTiles === 'function') renderBetaTiles();
    // After-touch transition: one engine path frames the bus at the
    // safe-frame center (not the viewport center), so the card never covers
    // it. D2b: on mobile the selection frames and holds; the explicit Follow
    // button starts tracking. Desktop keeps the existing auto-follow.
    if (typeof tripFly === 'undefined' || !tripFly) {
      var _bs = null;
      for (var _bi = 0; _bi < busSlots.length; _bi++) {
        if (busSlots[_bi].vehicle && busSlots[_bi].vehicle.vehicle_id === v.vehicle_id) { _bs = busSlots[_bi]; break; }
      }
      if (_bs) {
        TransitionEngine.go({
          vantage: TransitionEngine.vantageForBus(_bs.x, _bs.z),
          // A bus boarded for Ride Along is an explicit ride intent: the
          // camera centers on it and follow engages on every device class
          // (overriding the mobile hold), unless the rider explicitly
          // toggled follow OFF for this same selection.
          follow: (rideBoarded && !(isReselect && followSuppressed)) ? 'engage'
            : (isReselect && followSuppressed) ? 'hold'
            : (DisplayBounds.get().deviceClass === 'mobile' ? 'hold' : 'engage'),
          vehicleId: v.vehicle_id,
          slot: _bs
        });
      }
    } else if (rideBoarded) {
      // The trip cinematic owns the camera right now; followTick defers to
      // it frame-by-frame, so engaging follow here is safe and takes over
      // framing when the fly-through ends.
      var _fs = null;
      for (var _fi = 0; _fi < busSlots.length; _fi++) {
        if (busSlots[_fi].vehicle && busSlots[_fi].vehicle.vehicle_id === v.vehicle_id) { _fs = busSlots[_fi]; break; }
      }
      if (_fs) setFollow(v.vehicle_id, _fs);
    }
  }
  function hideBus() {
    var _hadFocus = $('bus-card').contains(document.activeElement);
    selectedVehicleId = null;
    followSuppressed = false;
    setFollow(null); // stop tracking
    $('bus-card').hidden = true;
    // Return focus to the opener when focus was inside the dialog.
    if (_hadFocus && _busReturnFocus && _busReturnFocus !== document.body && document.contains(_busReturnFocus)) _busReturnFocus.focus();
    _busReturnFocus = null;
    busInfoSprite.visible = false;
    renderBusInstances(); // shrink the indicator back
    exclRestore();
  }
  $('bus-close').addEventListener('click', hideBus);
  $('bus-card').addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); hideBus(); } });
  // --- D1a compact bar + D2b Follow button ---------------------------------
  // On mobile the bus card opens collapsed to a route/vehicle bar; tapping
  // the bar expands the full details. The Follow button toggles tracking on
  // every device class (on mobile it is the only way tracking starts).
  function setBusCardCompact(compact) {
    $('bus-card').classList.toggle('compact', !!compact);
  }
  var _followBtnLabel = null;
  function refreshFollowBtn() {
    var label = followVId ? 'Following' : 'Follow';
    if (label === _followBtnLabel) return;
    _followBtnLabel = label;
    var btns = document.querySelectorAll('.bus-follow-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].textContent = label;
      btns[i].setAttribute('aria-pressed', followVId ? 'true' : 'false');
    }
  }
  function toggleFollow() {
    if (followVId) { setFollow(null); followSuppressed = true; return; }
    followSuppressed = false;
    var sl = null;
    for (var i = 0; i < busSlots.length; i++) {
      if (busSlots[i].vehicle && busSlots[i].vehicle.vehicle_id === selectedVehicleId) { sl = busSlots[i]; break; }
    }
    if (sl) setFollow(selectedVehicleId, sl);
  }
  Array.prototype.forEach.call(document.querySelectorAll('.bus-follow-btn'), function (b) {
    b.addEventListener('click', toggleFollow);
  });
  var _busExpand = $('bus-expand'); // compact bar (staging Phase 2 HTML); guard for HTML without it
  if (_busExpand) _busExpand.addEventListener('click', function () { setBusCardCompact(false); });

  // --- Accessible browse panel: list-based alternative to canvas tapping ---
  // Every tappable 3D object (stop pylon, bus pillar) is also reachable as a
  // real <button> with a 44px minimum target, keyboard-focusable and
  // screen-reader labeled. Selection flows through the same showStop/showBus
  // paths as canvas taps, so behavior is identical.
  var browseBusIds = '';
  function setBrowse(open) {
    var p = $('browse-panel'); if (!p) return;
    var wasOpen = !p.hidden;
    if (open && !wasOpen) exclCover('browse');
    p.hidden = !open;
    $('browse-toggle').setAttribute('aria-expanded', String(open));
    if (open) {
      togglePanel(false); // mutually exclusive with the routes panel
      buildBrowseStops();
      refreshBrowseBuses(true);
      // Move focus into the dialog so keyboard users land on the tabs.
      ($('browse-buses-pane').hidden ? $('browse-tab-stops') : $('browse-tab-buses')).focus();
    } else if (p.contains(document.activeElement)) {
      $('browse-toggle').focus(); // return focus to the toggle on close
    }
    if (!open && wasOpen) exclRestore();
  }
  $('browse-toggle').addEventListener('click', function () {
    setBrowse($('browse-panel').hidden);
  });
  $('browse-close').addEventListener('click', function () { setBrowse(false); });
  function browseTab(which) {
    var stops = which === 'stops';
    $('browse-tab-stops').setAttribute('aria-selected', String(stops));
    $('browse-tab-buses').setAttribute('aria-selected', String(!stops));
    $('browse-tab-stops').tabIndex = stops ? 0 : -1;
    $('browse-tab-buses').tabIndex = stops ? -1 : 0;
    $('browse-stops-pane').hidden = !stops;
    $('browse-buses-pane').hidden = stops;
    if (!stops) refreshBrowseBuses(true);
  }
  $('browse-tab-stops').addEventListener('click', function () { browseTab('stops'); });
  $('browse-tab-buses').addEventListener('click', function () { browseTab('buses'); });
  // WAI-ARIA tab keyboard support: Arrow keys / Home / End move focus between
  // tabs with automatic activation. Roving tabindex keeps the inactive tab out
  // of the Tab order, so the arrow keys are its only keyboard path.
  document.querySelector('#browse-panel .browse-tabs').addEventListener('keydown', function (e) {
    var tabs = [$('browse-tab-buses'), $('browse-tab-stops')];
    var i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    var j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    if (j === null || j === i) return;
    e.preventDefault();
    tabs[j].focus();
    browseTab(tabs[j] === $('browse-tab-stops') ? 'stops' : 'buses');
  });
  function browseStopRow(st) {
    var li = document.createElement('li');
    var b = document.createElement('button');
    var n = (st.r || []).length;
    b.setAttribute('aria-label', 'Stop ' + (st.n || 'unnamed') + ', served by ' + n + (n === 1 ? ' route' : ' routes'));
    var dot = document.createElement('i'); dot.className = 'b-dot';
    var rc = routeColors[(st.r || [])[0]];
    dot.style.background = rc ? '#' + rc.getHexString() : '#9AA0A6';
    var main = document.createElement('span'); main.className = 'b-main';
    var name = document.createElement('b'); name.textContent = st.n || 'Stop';
    var sub = document.createElement('span');
    sub.textContent = n + (n === 1 ? ' route' : ' routes') + (st.id ? ' · ID ' + st.id : '');
    main.appendChild(name); main.appendChild(sub);
    if (typeof alertsForStop === 'function' && typeof alertFx === 'function' && alertsState.ok) {
      var mine = alertsForStop(st.id);
      var pool = mine;
      if (!pool.length) {
        pool = [];
        (st.r || []).forEach(function (r) { alertsForRoute(r).forEach(function (a) { pool.push(a); }); });
      }
      if (pool.length) {
        var wEff = alertWorstEffect(pool);
        var wFx = alertFx({ effect: wEff });
        var sAdv = document.createElement('span');
        sAdv.className = 'b-adv' + (wEff === 'NO_SERVICE' ? ' severe' : '');
        sAdv.textContent = wFx.glyph + ' ' + wFx.label.toLowerCase() + (mine.length ? ' at this stop' : ' on a serving route');
        main.appendChild(sAdv);
      }
    }
    b.appendChild(dot); b.appendChild(main);
    b.addEventListener('click', function () { setBrowse(false); showStop(st); });
    li.appendChild(b);
    return li;
  }
  function buildBrowseStops() {
    var list = $('browse-stop-list'); if (!list) return;
    var q = ($('browse-stop-search').value || '').toLowerCase();
    var all = (typeof stopPickList !== 'undefined' && stopPickList) || [];
    var stops = all.slice().sort(function (a, b) { return (a.n || '').localeCompare(b.n || ''); });
    if (q) stops = stops.filter(function (st) { return (st.n || '').toLowerCase().indexOf(q) >= 0; });
    list.innerHTML = '';
    if (!stops.length) {
      var li = document.createElement('li');
      li.className = 'browse-empty';
      li.textContent = all.length ? 'No stops match.' : 'Stops still loading…';
      list.appendChild(li); return;
    }
    stops.slice(0, 200).forEach(function (st) { list.appendChild(browseStopRow(st)); });
    if (stops.length > 200) {
      var more = document.createElement('li'); more.className = 'browse-empty';
      more.textContent = 'Showing 200 of ' + stops.length + ' — refine your search.';
      list.appendChild(more);
    }
  }
  $('browse-stop-search').addEventListener('input', buildBrowseStops);
  function browseBusRow(slot) {
    var v = slot.vehicle;
    var li = document.createElement('li');
    var b = document.createElement('button');
    var dest = formatDest(v.route_id, v.destination);
    b.setAttribute('aria-label', 'Bus ' + (v.vehicle_id || '') + ', ' + routeLabel(v.route_id) + (dest ? ', to ' + dest : ''));
    var dot = document.createElement('i'); dot.className = 'b-dot';
    var rc = routeColors[v.route_id];
    dot.style.background = rc ? '#' + rc.getHexString() : '#F5F2EA';
    var main = document.createElement('span'); main.className = 'b-main';
    var name = document.createElement('b');
    name.textContent = routeLabel(v.route_id) + ' · Bus ' + (v.vehicle_id || '');
    var sub = document.createElement('span');
    sub.textContent = dest ? 'to ' + dest : (routeNames[v.route_id] || 'DDOT');
    main.appendChild(name); main.appendChild(sub);
    if (typeof alertsForRoute === 'function' && typeof alertFx === 'function' && alertsState.ok && alertsForRoute(v.route_id).length) {
      var rList = alertsForRoute(v.route_id);
      var rEff = alertWorstEffect(rList);
      var rFx = alertFx({ effect: rEff });
      var bAdv = document.createElement('span');
      bAdv.className = 'b-adv' + (rEff === 'NO_SERVICE' ? ' severe' : '');
      bAdv.textContent = rFx.glyph + ' ' + rFx.label.toLowerCase() + ' on this route';
      main.appendChild(bAdv);
    }
    b.appendChild(dot); b.appendChild(main);
    b.addEventListener('click', function () { setBrowse(false); showBus(v); });
    li.appendChild(b);
    return li;
  }
  function refreshBrowseBuses(force) {
    var list = $('browse-bus-list'); if (!list) return;
    var q = ($('browse-bus-search').value || '').toLowerCase();
    var slots = busSlots;
    if (q) slots = slots.filter(function (s) {
      var v = s.vehicle;
      var hay = (v.route_id + ' ' + (v.vehicle_id || '') + ' ' + (routeNames[v.route_id] || '') + ' ' + (formatDest(v.route_id, v.destination) || '')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    var ids = slots.map(function (s) { return s.vehicle.vehicle_id; }).join(',');
    if (!force && ids === browseBusIds && !q) return; // no change: keep focus/scroll
    browseBusIds = q ? '' : ids; // searching bypasses the change cache
    var n = slots.length;
    $('browse-bus-count').textContent = n ? '(' + n + ')' : '';
    list.innerHTML = '';
    if (!n) {
      var li = document.createElement('li'); li.className = 'browse-empty';
      li.textContent = q ? 'No buses match.' : 'No buses on the visible routes right now.';
      list.appendChild(li); return;
    }
    // Numerical order: routes ascending numerically, then vehicle numbers
    // ascending numerically (lexicographic fallback for non-numeric ids).
    function numKey(x) { var n = parseInt(x, 10); return isNaN(n) ? null : n; }
    slots.slice().sort(function (a, b) {
      // Route lists sort alphabetically by route name (convention,
      // settled 2026-10-11): "Greenfield - 10" files under G, ahead
      // of "Vernor - 1"; vehicles within a route stay numeric below.
      var rc = routeLabel(a.vehicle.route_id).localeCompare(routeLabel(b.vehicle.route_id));
      if (rc !== 0) return rc;
      var av = numKey(a.vehicle.vehicle_id), bv = numKey(b.vehicle.vehicle_id);
      if (av !== null && bv !== null && av !== bv) return av - bv;
      return String(a.vehicle.vehicle_id).localeCompare(String(b.vehicle.vehicle_id));
    }).forEach(function (s) { list.appendChild(browseBusRow(s)); });
  }
  $('browse-bus-search').addEventListener('input', function () { refreshBrowseBuses(true); });

  // --- map navigation tools ----------------------------------------------------
  function zoomStep(dir) {
    var off = camera.position.clone().sub(controls.target);
    var len = off.length() * (dir > 0 ? 0.8 : 1.25);
    len = Math.max(controls.minDistance, Math.min(controls.maxDistance, len));
    off.setLength(len);
    camera.position.copy(controls.target).add(off);
  }
  function resetView() {
    cancelStreetTween();
    camera.position.copy(homePos);
    controls.target.copy(homeTarget);
    camMemRefresh();
  }
  $('zoom-in').addEventListener('click', function () { zoomStep(1); });
  $('zoom-out').addEventListener('click', function () { zoomStep(-1); });
  $('view-reset').addEventListener('click', resetView);
  // Keyboard camera (defect keyboard-camera): arrow keys pan and +/-
  // zoom when #live-map has focus (tabindex="0" in the HTML; the canvas
  // is its only child, so keydown events from the map reach this listener
  // and events from overlay controls, which are siblings, do not).
  // ArrowLeft/ArrowRight yield to the existing bus/stop cycling handler
  // (the document keydown handler below) while a card selection is
  // active, so the two bindings never act on the same keypress.
  container.addEventListener('keydown', function (e) {
    if (e.key === '+' || e.key === '=') { zoomStep(1); e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === '-' || e.key === '_') { zoomStep(-1); e.preventDefault(); e.stopPropagation(); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (selectedVehicleId || selectedStop)) return;
    var dist = camera.position.distanceTo(controls.target);
    var step = Math.max(50, dist * 0.12);
    var fwd = new THREE.Vector3();
    fwd.subVectors(controls.target, camera.position); fwd.y = 0;
    if (fwd.lengthSq() === 0) return;
    fwd.normalize();
    var right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    var move = new THREE.Vector3();
    if (e.key === 'ArrowUp') move.addScaledVector(fwd, step);
    else if (e.key === 'ArrowDown') move.addScaledVector(fwd, -step);
    else if (e.key === 'ArrowRight') move.addScaledVector(right, step);
    else move.addScaledVector(right, -step);
    camera.position.add(move);
    controls.target.add(move);
    if (typeof controls.update === 'function') controls.update();
    e.preventDefault();
    e.stopPropagation();
  });
  if (isTouch) {
    var hint = document.querySelector('.map-hint');
    if (hint) {
      hint.innerHTML = 'drag&nbsp;·&nbsp;move&nbsp;&nbsp;&nbsp;pinch&nbsp;·&nbsp;zoom&nbsp;&nbsp;&nbsp;tap bus or stop&nbsp;·&nbsp;details';
      hint.classList.add('touch');
    }
  }

  // --- navigation tutorial overlay ---------------------------------------------
  var ICO_FINDME = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
  var ICO_FULL = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
  var NAV_STEPS_TOUCH = [
    ['\u2194', 'Drag', 'Move around the city. The map is a true-scale 3D model of Detroit — every street, every route corridor, every stop is where it actually is.'],
    ['+', 'Pinch', 'Zoom in and out. Zoom close enough and the glowing pillars resolve into true-scale 3D bus models with windows and wheels.'],
    ['\u27F3', 'Two-finger twist', 'Rotate the view. Tilt to see the elevated route guideways — each route floats at its own height so crossings read as clean overpasses.'],
    ['\u25CF', 'Tap a bus', 'Opens the bus card: vehicle number, route, destination, speed, heading, and how fresh the position reading is. Tap Follow to track it.'],
    ['\u25A0', 'Bus badges', 'Each bus carries a bus-shaped badge showing its route number, bordered in the route\u2019s color. Badges declutter automatically when buses cluster.'],
    ['\u29E9', 'Routes', 'Filter by group (DDOT, SMART, QLINE, People Mover) or individual route. Routes with no live buses are dimmed or hidden automatically.'],
    ['\u25C8', 'Plan trip', 'Enter two points and get a transit itinerary with real routes, transfers, and walking legs — built on the same schedule data as the map.'],
    ['\u25C9', 'Ride along', 'Pick any live bus and see its upcoming stops and intersections from the rider\u2019s seat, ordered by travel direction. If a bus is already selected it rides that bus; selecting a bus on the map while Ride along is open rides it too, and the camera follows it.'],
    [ICO_FINDME, 'Find me', 'Center the map on your location. "Routes near me" then shows only routes with a stop within 1,250 m of you.'],
    [ICO_FULL, 'Fullscreen', 'Fill the screen with the map.'],
    ['\u2302', 'Reset view', 'Return to the full-system view.']
  ];
  var NAV_STEPS_DESK = [
    ['\u27F3', 'Drag', 'Orbit the view. The map is a true-scale 3D model of Detroit — every street, every route corridor, every stop is where it actually is.'],
    ['+', 'Scroll', 'Zoom in and out. Zoom close enough and the glowing pillars resolve into true-scale 3D bus models with windows and wheels.'],
    ['\u2194', 'Right-drag', 'Pan across the city. Tilt to see the elevated route guideways — each route floats at its own height so crossings read as clean overpasses.'],
    ['\u25CF', 'Click a bus', 'Opens the bus card: vehicle number, route, destination, speed, heading, and how fresh the position reading is. Click Follow to track it.'],
    ['\u25A0', 'Bus badges', 'Each bus carries a bus-shaped badge showing its route number, bordered in the route\u2019s color. Badges declutter automatically when buses cluster.'],
    ['\u29E9', 'Routes', 'Filter by group (DDOT, SMART, QLINE, People Mover) or individual route. Routes with no live buses are dimmed or hidden automatically.'],
    ['\u25C8', 'Plan trip', 'Enter two points and get a transit itinerary with real routes, transfers, and walking legs — built on the same schedule data as the map.'],
    ['\u25C9', 'Ride along', 'Pick any live bus and see its upcoming stops and intersections from the rider\u2019s seat, ordered by travel direction. If a bus is already selected it rides that bus; selecting a bus on the map while Ride along is open rides it too, and the camera follows it.'],
    [ICO_FINDME, 'Find me', 'Center the map on your location. "Routes near me" then shows only routes with a stop within 1,250 m of you.'],
    [ICO_FULL, 'Fullscreen', 'Fill the screen with the map.'],
    ['\u2302', 'Reset view', 'Return to the full-system view.']
  ];
  function buildNavOverlay() {
    var host = $('nav-steps');
    host.innerHTML = '';
    (isTouch ? NAV_STEPS_TOUCH : NAV_STEPS_DESK).forEach(function (s) {
      var d = document.createElement('div');
      d.className = 'nav-step';
      d.innerHTML = '<span class="ico">' + s[0] + '</span><div><b>' + s[1] + '</b><span>' + s[2] + '</span></div>';
      host.appendChild(d);
    });
  }
  function toggleNavOverlay(force) {
    var ov = $('nav-overlay');
    var show = (typeof force === 'boolean') ? force : ov.hidden;
    if (show) buildNavOverlay();
    ov.hidden = !show;
    $('nav-help').setAttribute('aria-expanded', String(show));
  }
  $('nav-help').addEventListener('click', function () { toggleNavOverlay(); });
  $('nav-close').addEventListener('click', function () { toggleNavOverlay(false); });
  $('nav-overlay').addEventListener('click', function (e) { if (e.target === this) toggleNavOverlay(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') toggleNavOverlay(false); });

  // --- routes panel: minimize + resize -----------------------------------------
  var panel = $('filter-panel');
  var PANEL_MIN_W = 240, PANEL_MAX_W = 560, PANEL_MIN_H = 140;
  function panelMaxH() { return Math.max(220, window.innerHeight - 140); }
  function setPanelMin(min) {
    panel.classList.toggle('minimized', min);
    var b = $('panel-min');
    b.textContent = min ? '+' : '\u2013';
    b.setAttribute('aria-label', min ? 'Expand routes panel' : 'Minimize routes panel');
    b.setAttribute('aria-expanded', String(!min));
    try { localStorage.setItem('lt-panel-min', min ? '1' : '0'); } catch (e) {}
  }
  (function applyPanelPrefs() {
    if (window.innerWidth <= 640) return;
    try {
      var w = parseInt(localStorage.getItem('lt-panel-w'), 10);
      var h = parseInt(localStorage.getItem('lt-panel-h'), 10);
      if (w >= PANEL_MIN_W && w <= PANEL_MAX_W) panel.style.width = w + 'px';
      if (h >= PANEL_MIN_H && h <= panelMaxH()) { panel.style.height = h + 'px'; panel.style.maxHeight = 'none'; }
      if (localStorage.getItem('lt-panel-min') === '1') setPanelMin(true);
    } catch (e) {}
  })();
  $('panel-min').addEventListener('click', function () { setPanelMin(!panel.classList.contains('minimized')); });
  var grip = $('panel-resize'), rsz = null;
  grip.addEventListener('pointerdown', function (e) {
    if (window.innerWidth <= 640) return;
    e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch (err) {}
    rsz = { x: e.clientX, y: e.clientY, w: panel.offsetWidth, h: panel.offsetHeight };
  });
  grip.addEventListener('pointermove', function (e) {
    if (!rsz) return;
    var w = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, rsz.w + (rsz.x - e.clientX)));
    var h = Math.min(panelMaxH(), Math.max(PANEL_MIN_H, rsz.h + (e.clientY - rsz.y)));
    panel.style.width = w + 'px';
    panel.style.height = h + 'px';
    panel.style.maxHeight = 'none';
  });
  function endResize(save) {
    if (!rsz) return;
    if (save) {
      try {
        localStorage.setItem('lt-panel-w', String(panel.offsetWidth));
        localStorage.setItem('lt-panel-h', String(panel.offsetHeight));
      } catch (e) {}
    }
    rsz = null;
  }
  grip.addEventListener('pointerup', function () { endResize(true); });
  grip.addEventListener('pointercancel', function () { endResize(false); });

  // --- map tools rail: minimize toggle (Direction C) -------------------
  // The rail rests collapsed on mobile (locate + this toggle only) and
  // expanded on desktop. The toggle flips it manually; the choice
  // persists for the session only (sessionStorage), matching the
  // session-only precedent of the layer toggles.
  var toolsRail = document.querySelector('.map-tools');
  function setToolsMin(min, persist) {
    if (!toolsRail) return;
    toolsRail.classList.toggle('collapsed', !!min);
    var b = $('tools-toggle');
    if (b) {
      b.setAttribute('aria-expanded', String(!min));
      b.setAttribute('aria-label', min ? 'Expand map tools' : 'Minimize map tools');
    }
    if (persist) {
      try { sessionStorage.setItem('lt-tools-min', min ? '1' : '0'); } catch (e) {}
    }
  }
  (function initToolsRail() {
    if (!toolsRail || !$('tools-toggle')) return;
    var stored = null;
    try { stored = sessionStorage.getItem('lt-tools-min'); } catch (e) {}
    setToolsMin(stored != null ? stored === '1' : window.innerWidth <= 640, false);
    $('tools-toggle').addEventListener('click', function () {
      setToolsMin(!toolsRail.classList.contains('collapsed'), true);
    });
  })();

  // --- independent chrome controls (Direction C substrate) ---------------
  // Every chrome element is governed by exactly one control, and no
  // control touches another element's state, so the minimalist design
  // iterations can show, hide, or collapse each element independently:
  //   bar  -> chromeHide('bar', h)   (body.chrome-no-bar; display only —
  //          the bar's buttons keep their state and their panels)
  //   rail -> collapse: setToolsMin(min, persist) / #tools-toggle;
  //          full hide: chromeHide('rail', h) (body.chrome-no-rail)
  //   hint -> chromeHide('hint', h)  (body.chrome-no-hint)
  //   each surface -> its own open/close function (togglePanel,
  //   setBrowse, setTripMode, setRideMode, showStop/hideStop,
  //   showBus/hideBus); the exclusion block coordinates them without
  //   coupling their state. Nothing in Direction C calls chromeHide —
  //   the default chrome is fully visible; the control exists so a
  //   variant can drive it without rework.
  function chromeHide(name, hide) {
    document.body.classList.toggle('chrome-no-' + name, !!hide);
  }
  function chromeHidden(name) {
    return document.body.classList.contains('chrome-no-' + name);
  }

  // --- app lock (route-filters-missing fix, stamp 20261015-1437) --------
  // While the app script is running, the document itself does not
  // scroll. The page carries real content below the stage, so the
  // document is taller than the viewport; an uncovered scroll vector
  // (a drag on the help overlay's backdrop, which has no touch-action
  // anywhere in its ancestor chain, or a wheel scroll over non-canvas
  // chrome) could scroll the document until the whole .map-bar sat
  // above the visible area — and with it the only entry to the route
  // filter panel (togglePanel is called from #filter-btn alone), the
  // planner, ride-along, and the home link — while every contained
  // surface refuses to scroll it back. The lock reuses the max-mode
  // presentation lock's mechanism (the html/body .app-lock rules in
  // the HTML mirror html/body.pseudo-full-lock), set here by the app
  // script at boot: with the script absent the classes are never set
  // and the static page scrolls as before. setMaxMode composes
  // unchanged — its saved scroll offset is 0 under the lock, and its
  // own lock classes are added and removed alongside. Subset stopgap:
  // the app-borders shell carries the same semantics (document height
  // = viewport height in the app view) and subsumes these rules when
  // it lands. Trace: files/route-filters-missing/trace.md.
  document.documentElement.classList.add('app-lock');
  document.body.classList.add('app-lock');

  // --- fullscreen toggle (native API where offered; maximized view where not) ---
  // Behavior contract (files/fullscreen-fix/fullscreen-fix.md):
  //   states: off | native (the stage element in the Fullscreen API) |
  //   max (the stage pinned to the shell frame, document locked).
  //   The button never claims a state that did not occur: the pressed
  //   state and the label are written only by the fullscreenchange
  //   events and by the max-mode transitions — never synchronously
  //   after a request is issued — and where the element API does not
  //   exist (iPhone Safari) the control is labeled "expanded view",
  //   not fullscreen. Capability is detected on the stage element
  //   itself: document.*FullscreenEnabled is true on iPhone (it
  //   reflects video fullscreen) and must not be trusted for page
  //   elements. Frame discipline (S5): the toggle owns no frame
  //   geometry — native mode presents the stage's existing frame, max
  //   mode pins it to the shell frame values in the CSS above, and
  //   camera framing is untouched (a resize notification is all that
  //   fires on a transition).
  var stage = document.querySelector('.map-stage');
  var fullBtn = $('view-full');
  var FS_REQ_NAMES = ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen'];
  function fsRequestName() {
    for (var i = 0; i < FS_REQ_NAMES.length; i++) {
      if (stage && typeof stage[FS_REQ_NAMES[i]] === 'function') return FS_REQ_NAMES[i];
    }
    return null;
  }
  var fsNativeCapable = !!fsRequestName();
  function nativeFsEl() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function maxActive() { return stage.classList.contains('pseudo-full'); }
  function fsActive() { return !!nativeFsEl() || maxActive(); }
  function setFsBtn() {
    var on = fsActive();
    fullBtn.setAttribute('aria-pressed', String(on));
    fullBtn.setAttribute('aria-label', on
      ? (nativeFsEl() ? 'Exit fullscreen' : 'Exit expanded view')
      : (fsNativeCapable ? 'Enter fullscreen' : 'Enter expanded view'));
  }
  function notifyMapResize() {
    try { window.dispatchEvent(new Event('resize')); } catch (e) {}
  }
  function syncFsLock() { document.body.classList.toggle('fs-lock', fsActive()); }

  // Max mode. The scroll lock: iOS Safari does not honor
  // overflow:hidden on body as a scroll lock, so the body is also
  // position:fixed at the saved scroll offset (the .pseudo-full-lock
  // rules in the HTML) and the offset is restored on exit. fs-lock
  // rides along via syncFsLock, composing with the permanent gesture
  // containment deployed 20261015-1130: no touch-action is set here,
  // and nothing is set on an ancestor of a scrollable panel.
  var maxScrollY = 0;
  var fsFallbackNote = false; // set when max mode is a failed-native fallback
  function setMaxMode(on) {
    if (on === maxActive()) { setFsBtn(); syncFsLock(); return; }
    if (on) {
      maxScrollY = window.scrollY || window.pageYOffset || 0;
      stage.classList.add('pseudo-full');
      document.documentElement.classList.add('pseudo-full-lock');
      document.body.classList.add('pseudo-full-lock');
      document.body.style.top = (-maxScrollY) + 'px';
    } else {
      stage.classList.remove('pseudo-full');
      document.documentElement.classList.remove('pseudo-full-lock');
      document.body.classList.remove('pseudo-full-lock');
      document.body.style.top = '';
      window.scrollTo(0, maxScrollY);
    }
    setFsBtn();
    syncFsLock();
    notifyMapResize();
    if (on && fsFallbackNote) announceSr('Fullscreen unavailable. Expanded view on.');
    else announceSr(on ? 'Expanded view on.' : 'Expanded view off.');
    fsFallbackNote = false;
  }
  function enterNative() {
    var name = fsRequestName();
    if (!name) { setMaxMode(true); return; }
    var p;
    try {
      // navigationUI:'hide' asks Chrome-class browsers to keep their
      // own UI out of the presentation; an engine that rejects the
      // options argument falls through to the no-argument call.
      p = (name === 'requestFullscreen') ? stage[name]({ navigationUI: 'hide' }) : stage[name]();
    } catch (e) {
      try { p = stage[name](); } catch (e2) { fsFallbackNote = true; setMaxMode(true); return; }
    }
    if (p && p.catch) p.catch(function () { if (!fsActive()) { fsFallbackNote = true; setMaxMode(true); } });
    // No state is written here: fullscreenchange confirms the transition.
  }
  function exitNative() {
    var exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (!exit) return;
    try { var p = exit.call(document); if (p && p.catch) p.catch(function () {}); } catch (e) {}
  }
  fullBtn.addEventListener('click', function () {
    if (nativeFsEl()) { exitNative(); return; }
    if (maxActive()) { setMaxMode(false); return; }
    if (fsNativeCapable) enterNative(); else setMaxMode(true);
  });
  var fsWasNative = false;
  function onFsChange() {
    var isNative = !!nativeFsEl();
    setFsBtn(); syncFsLock(); notifyMapResize();
    if (isNative !== fsWasNative) {
      fsWasNative = isNative;
      announceSr(isNative ? 'Fullscreen on.' : 'Fullscreen off.');
    }
  }
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  function onFsError() { if (!fsActive()) { fsFallbackNote = true; setMaxMode(true); } }
  document.addEventListener('fullscreenerror', onFsError);
  document.addEventListener('webkitfullscreenerror', onFsError);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && maxActive()) setMaxMode(false);
  });
  setFsBtn();
  // Keyboard selection: arrows cycle buses/stops when a card is open,
  // Escape clears. (OrbitControls doesn't bind arrows — no conflict.)
  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
    if (e.key === 'Escape') { hideBus(); hideStop(); return; }
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    var dir = e.key === 'ArrowRight' ? 1 : -1;
    if (selectedVehicleId && busSlots.length) {
      var bi = -1;
      for (var i = 0; i < busSlots.length; i++) {
        if (busSlots[i].vehicle && busSlots[i].vehicle.vehicle_id === selectedVehicleId) { bi = i; break; }
      }
      var nb = busSlots[(bi + dir + busSlots.length) % busSlots.length];
      if (nb && nb.vehicle) { showBus(nb.vehicle); e.preventDefault(); }
    } else if (selectedStop && stopPickList.length && selectedStopIndex >= 0) {
      var ns = stopPickList[(selectedStopIndex + dir + stopPickList.length) % stopPickList.length];
      if (ns) { showStop(ns); e.preventDefault(); }
    }
  });

  // --- location services ---------------------------------------------------------
  // Coverage = the Detroit street mosaic bounds (DDOT's service area),
  // extended to the full mosaic while the SMART group is displayed.
  function inCoverage(lat, lon) {
    if (lat <= STREET_BOUNDS.latN && lat >= STREET_BOUNDS.latS &&
        lon >= STREET_BOUNDS.lonW && lon <= STREET_BOUNDS.lonE) return true;
    // SMART suburbs: covered only while the SMART group is displayed, so
    // "routes near you" and other location features work in the suburbs
    // with SMART enabled and stay Detroit-scoped when it is off. The
    // bounds are MOSAIC_BOUNDS — the street mosaic's declared bbox,
    // and the values this branch used before the SMART removal, under
    // the name the removal's rename gave them.
    try {
      if (groupSelState('smart') !== 'none' &&
          lat <= MOSAIC_BOUNDS.latN && lat >= MOSAIC_BOUNDS.latS &&
          lon >= MOSAIC_BOUNDS.lonW && lon <= MOSAIC_BOUNDS.lonE) return true;
    } catch (e) {}
    return false;
  }
  // --- 3D user representation (scaffold) -----------------------------------------
  // Branded "you are here" marker: Forge Orange beam + floating Forge D badge.
  // Built to extend: heading wedge, accuracy disc, and label hooks live here.
  var YOU_BADGE_Y = 1250, YOU_BADGE_BOB = 70;
  var youMarker = (function () {
    var g = new THREE.Group();

    var beam = new THREE.Mesh(
      new THREE.CylinderGeometry(30, 30, 1000, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xE85D1A, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    );
    beam.position.y = 500;
    g.add(beam);

    var ring = new THREE.Mesh(
      new THREE.RingGeometry(120, 170, 40),
      new THREE.MeshBasicMaterial({ color: 0xE85D1A, transparent: true, opacity: 0.65, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 40;
    g.add(ring);

    var accDisc = new THREE.Mesh(
      new THREE.CircleGeometry(200, 40),
      new THREE.MeshBasicMaterial({ color: 0xE85D1A, transparent: true, opacity: 0.12, depthWrite: false })
    );
    accDisc.rotation.x = -Math.PI / 2;
    accDisc.position.y = 30;
    g.add(accDisc);

    var badge = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }));
    badge.scale.set(760, 760, 1);
    badge.position.y = YOU_BADGE_Y;
    g.add(badge);

    g.visible = false;
    scene.add(g);

    // Paint the Forge D badge; falls back to a serif "D" if the logo can't load.
    function paintBadge(img) {
      var S = 256, c = document.createElement('canvas');
      c.width = c.height = S;
      var x = c.getContext('2d');
      x.beginPath(); x.arc(S / 2, S / 2, S / 2 - 4, 0, Math.PI * 2);
      x.fillStyle = '#0C1116'; x.fill();
      x.save();
      x.beginPath(); x.arc(S / 2, S / 2, S / 2 - 16, 0, Math.PI * 2); x.clip();
      if (img) { x.drawImage(img, 0, 0, S, S); }
      else {
        x.fillStyle = '#E85D1A';
        x.font = '700 150px Georgia, "Times New Roman", serif';
        x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillText('D', S / 2, S / 2 + 10);
      }
      x.restore();
      x.lineWidth = 10; x.strokeStyle = '#E85D1A';
      x.beginPath(); x.arc(S / 2, S / 2, S / 2 - 10, 0, Math.PI * 2); x.stroke();
      var tex = new THREE.CanvasTexture(c);
      tex.anisotropy = 4;
      badge.material.map = tex;
      badge.material.needsUpdate = true;
    }
    var logoImg = new Image();
    logoImg.onload = function () { paintBadge(logoImg); };
    logoImg.onerror = function () { paintBadge(null); };
    logoImg.src = 'assets/logo.webp?v=' + STAMP;

    return {
      group: g, badge: badge, ring: ring, beam: beam,
      setAccuracy: function (meters) {
        var r = Math.max(60, Math.min(2000, meters || 200));
        accDisc.scale.set(r / 200, r / 200, 1);
      }
    };
  })();
  var toastTimer = null;
  function hideToast() { $('map-toast').hidden = true; clearTimeout(toastTimer); }
  function showToast(msg, sticky) {
    var t = $('map-toast');
    t.innerHTML = '';
    var s = document.createElement('span');
    s.textContent = msg;
    t.appendChild(s);
    if (sticky) {
      var x = document.createElement('button');
      x.id = 'toast-x';
      x.setAttribute('aria-label', 'Dismiss');
      x.textContent = '\u00D7';
      x.addEventListener('click', function (e) { e.stopPropagation(); hideToast(); });
      t.appendChild(x);
    } else {
      clearTimeout(toastTimer);
      toastTimer = setTimeout(hideToast, 4500);
    }
    t.hidden = false;
  }
  $('map-toast').addEventListener('click', hideToast);
  var locateBtn = $('view-locate'), locating = false;
  function onLocated(lat, lon, accMeters) {
    if (!proj) { showToast('Map is still loading — try again in a moment.'); return; }
    if (!inCoverage(lat, lon)) {
      youMarker.group.visible = false;
      locateBtn.setAttribute('aria-pressed', 'false');
      showToast('Out of bounds — you are outside DDOT\u2019s Detroit coverage area.', true);
      return;
    }
    hideToast();
    var p = project(lat, lon);
    userXZ = p;
    cancelStreetTween();
    youMarker.group.position.set(p[0], 0, p[1]);
    // Zoom-on-enable (2026-10-15, Justin's priority): enabling location
    // flies the camera SMOOTHLY to street level over the rider, so the
    // buses, stops, and routes around the rider are individually
    // tappable and selectable. The framing is the app's own bus vantage
    // (TransitionEngine.vantageForBus): a 32-degree-elevated view at
    // horizontal offset max(controls.minDistance * 1.3, 900) — 1,560 m
    // at the normal-mode minDistance of 1,200 m — for a total camera
    // distance of ~1,840 m. Derivation: the home framing (~20.5 km) is
    // far too wide to pick out one bus; the street-view vantage
    // (~670 m) sits below controls.minDistance in normal mode, so
    // OrbitControls would snap the camera back out on the next
    // interaction (vantageForBus's own comment documents that
    // constraint); at ~1,840 m stopScaleFor() is at its close-zoom
    // floor (<= 2,800 m), so stops and buses render at full street
    // scale. The move reuses TransitionEngine.go -> glideTo, the
    // existing minimum-jerk fly-to — no second animation system. While
    // a trip fly-through owns the camera, TransitionEngine.go defers
    // and would drop the move entirely, so that case keeps the legacy
    // instant recenter. Denied or unavailable location never reaches
    // this code: the error path and the settled home framing are
    // unchanged.
    if (typeof tripFly !== 'undefined' && tripFly) {
      var off = camera.position.clone().sub(controls.target);
      controls.target.set(p[0], 0, p[1]);
      camera.position.copy(controls.target).add(off);
    } else {
      TransitionEngine.go({ vantage: TransitionEngine.vantageForBus(p[0], p[1]) });
    }
    // Camera memory (R6): a successful locate redefines the preserved
    // framing — camMemFraming counts the in-flight glide at its
    // destination; the tripFly branch above has already landed.
    camMemRefresh();
    youMarker.setAccuracy(accMeters);
    youMarker.group.visible = true;
    locateBtn.setAttribute('aria-pressed', 'true');
    if (pendingNearMe) {
      setNearMe(true);
    } else if (filterState.nearMe) {
      computeNearMe();
      applyFilters();
      syncFilterUI();
      refreshFilterCounts();
    }
  }
  locateBtn.addEventListener('click', function () {
    if (!('geolocation' in navigator)) { showToast('Location services are not available on this device.'); return; }
    if (locating) return;
    locating = true;
    showToast('Locating\u2026');
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        locating = false;
        onLocated(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
      },
      function (err) {
        locating = false;
        pendingNearMe = false;
        if (err && err.code === 1) showToast('Location access denied — allow it in your browser settings to use this.');
        else showToast('Could not get your location — please try again.');
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  });

  // Soft location prompt at load: one quiet toast offering the locate flow,
  // never the raw system dialog uninvited. Silent when already located,
  // unsupported, or previously denied.
  var locPrompted = false;
  function maybePromptLocation() {
    if (locPrompted || userXZ || !('geolocation' in navigator)) return;
    locPrompted = true;
    var show = function () {
      var t = $('map-toast');
      t.innerHTML = '';
      var s = document.createElement('span');
      s.textContent = 'See routes near you?';
      var go = document.createElement('button');
      go.textContent = 'Enable location';
      go.className = 'toast-btn';
      go.addEventListener('click', function (e) { e.stopPropagation(); hideToast(); locateBtn.click(); });
      var no = document.createElement('button');
      no.textContent = 'Not now';
      no.className = 'toast-btn toast-btn-quiet';
      no.addEventListener('click', function (e) { e.stopPropagation(); hideToast(); });
      t.appendChild(s); t.appendChild(go); t.appendChild(no);
      t.hidden = false;
    };
    try {
      if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: 'geolocation' }).then(function (res) {
          if (res.state === 'granted') locateBtn.click();
          else if (res.state === 'prompt') show();
        }, function () { show(); });
      } else { show(); }
    } catch (e) { show(); }
  }

  // --- Ride-along stop times (2026-10-15) ---------------------------------
  // Supplies Ride Along's upcoming-stops list with per-stop times from
  // the best source the data supports, per agency (ARCHITECTURE.md):
  // DDOT — the vehicle's matched timetable trip via the delay engine.
  // QLINE — no stop times published to this view:
  // sequence only, named. Coverage boundaries are stated in the view,
  // never presented as a generic empty state (S4).
  //
  // The timetable engine (raptor.js + the DDOT timetable) normally
  // loads with the first planner use. Ride Along needs its
  // vehicle-to-trip matching (updateLiveDelays) as soon as a rider
  // boards, so opening Ride Along loads it quietly (setRideMode).
  // Planner state is shared: when the planner later opens it finds
  // tripTT/tripRaptor already set.
  var rideEngineLoading = false;
  function ensureTripEngine() {
    if ((tripTT && tripRaptor) || rideEngineLoading) return;
    rideEngineLoading = true;
    var loadR = tripRaptor ? Promise.resolve(tripRaptor)
      : import('./raptor.js?v=' + STAMP).then(function (m) { tripRaptor = m.default || m; return tripRaptor; });
    loadR.then(function (R) {
      if (tripTT || !R || !R.loadTimetable) return;
      return R.loadTimetable('ddot-timetable-S1000182.json?v=' + STAMP).then(function (tt) { tripTT = tt; });
    }).catch(function () { /* engine unavailable: times degrade to the named notes (S4) */ })
      .then(function () { rideEngineLoading = false; if (rideWidget) rideWidget.refresh(); });
  }

  // Ride Along stop-times provider (the widget's setTimesProvider).
  // Returns { byStop: { gtfsStopId: label }, onlyIds: { gtfsStopId:
  // true } | null, note }. DDOT source: the vehicle's matched timetable
  // trip (the delay engine's tripDelayState) — the trip's remaining
  // stops are the sequence filter, and its arrival times — empirically
  // adjusted (arrL2) when the timing cells have substituted them, else
  // scheduled (arr) — are shifted by the vehicle's measured delay.
  function rideTimesFor(v) {
    if (!v) return null;
    if (v.agency === 'qline') {
      return { byStop: {}, onlyIds: null, note: 'QLINE stop times are not published to this view. Stops are listed in order.' };
    }
    if (v.agency === 'smart') {
      // Restored with the reactivation (and now literally true): SMART
      // publishes live positions to this view, never stop times.
      return { byStop: {}, onlyIds: null, note: 'SMART stop times are not published to this view. Stops are listed in order.' };
    }
    if (v.agency !== 'ddot') return null;
    if (!tripTT) {
      return { byStop: {}, onlyIds: null, note: 'Stop times load with the trip engine; they appear here once it is ready.' };
    }
    var found = null;
    tripDelayState.forEach(function (st, trip) { if (st.vehicleId === v.vehicle_id) found = { st: st, trip: trip }; });
    if (!found) {
      return { byStop: {}, onlyIds: null, note: 'This bus is not matched to a scheduled trip yet, so stop times are not shown. Matching runs every minute while the bus reports a current position.' };
    }
    var trip = found.trip, st = found.st;
    var arr = trip.arrL2 || trip.arr;
    var nowSec = detroitParts(Date.now()).sec;
    var byStop = {}, onlyIds = {};
    for (var j = 0; j < trip.stops.length; j++) {
      var eta = arr[j] + (st.disrupted ? 0 : st.delaySec);
      if (eta < nowSec - 30) continue; // already served (30 s grace for the stop the bus is standing at)
      var sObj = stopData && stopData[trip.stops[j]];
      if (!sObj || sObj.id == null) continue;
      var gid = String(sObj.id);
      onlyIds[gid] = true;
      var dSec = eta - nowSec;
      byStop[gid] = dSec < 45 ? 'now' : (dSec <= 5400 ? Math.round(dSec / 60) + ' min' : tripClock(eta));
    }
    var note = st.disrupted
      ? 'This bus is off its schedule pattern; the times shown are its scheduled times.'
      : (trip.arrL2
        ? 'Times are live estimates for this bus: typical running times for its trip, adjusted by its measured delay.'
        : 'Times are live estimates for this bus: its scheduled trip times, adjusted by its measured delay.');
    return { byStop: byStop, onlyIds: onlyIds, note: note };
  }

  // --- stops ---------------------------------------------------------------
  // Stops follow individual route filters (not groups). Single-route stops
  // take their route's color; multi-route stops ("hubs") draw paper-white
  // and larger so transfer points read at a glance. Two draw calls total.
  var stopGroup = new THREE.Group();
  stopGroup.visible = false; // LOD-gated in the animation loop
  scene.add(stopGroup);
  var STOP_LOD_DIST = 20000; // above the ~18.6km default home view: stops visible on load

  // Stop markers: one instanced pylon per stop. Height encodes importance:
  // 75m + 28m per serving route, so a 13-route mega-hub towers over a
  // single-route stop the way it should. Single-route pylons take their
  // route's color; multi-route hubs draw paper-white. One draw call.
  var STOP_MAX = 16384; // merged registry capacity: DDOT stops + SMART stops + QLINE stops (10,583) plus headroom
  var stopIM = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(14, 18, 1, 8),
    new THREE.MeshLambertMaterial({ color: 0xffffff }), STOP_MAX);
  stopIM.frustumCulled = false;
  stopIM.count = 0;
  stopGroup.add(stopIM);
  var stopPickList = [];
  var STOP_BASE_Y = 18; // street level: above the street lines, below casing

  var lastStopSig = null;
  var _stopTmpColor = new THREE.Color();
  function stopHeight(nRoutes) { return 75 + 28 * nRoutes; }
  // Zoom-coupled stop scale: the importance-encoded heights read well wide
  // out but tower over downtown at street zoom. Gentler than the bus-pillar
  // curve — stops are wayfinding anchors and must stay findable.
  var stopYS = 1;
  function stopScaleFor(d) {
    // In street view the stops are the subject: they ease a touch taller
    // than the plain close-zoom floor so individual markers read clearly.
    var lo = streetView ? 0.55 : 0.35;
    if (d >= 8000) return 1;
    if (d <= 2800) return lo;
    var t = (d - 2800) / (8000 - 2800);
    t = t * t * (3 - 2 * t);
    return lo + (1 - lo) * t;
  }
  function writeStopMatrices(list, withColors) {
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var h = stopHeight(s.r.length) * stopYS;
      _p3.set(s.x, STOP_BASE_Y + h / 2, s.z);
      _q3.identity();
      _s3.set(1, h, 1);
      _m4.compose(_p3, _q3, _s3);
      stopIM.setMatrixAt(i, _m4);
      if (withColors) {
        if (s.r.length > 1) {
          _stopTmpColor.set(0xf5f2ea);
        } else {
          var rc = routeColors[s.r[0]];
          if (rc) _stopTmpColor.copy(rc); else _stopTmpColor.set(0xf5f2ea);
        }
        stopIM.setColorAt(i, _stopTmpColor);
      }
    }
    stopIM.count = list.length;
    stopIM.instanceMatrix.needsUpdate = true;
    if (withColors && stopIM.instanceColor) stopIM.instanceColor.needsUpdate = true;
  }
  function rebuildStops() {
    // Stops only depend on route toggles: skip the full rebuild when the
    // visible route set hasn't changed (e.g. polls that only flip dimming).
    var sig = routeOrder.map(function (rid) { return routeIsOn(rid) ? '1' : '0'; }).join('') +
      '|nm:' + (filterState.nearMe ? Object.keys(nearMeSet || {}).sort().join(',') : 'off');
    if (sig === lastStopSig) return;
    lastStopSig = sig;
    var list = [];
    if (stopData && stopData.length) {
      stopData.forEach(function (s) {
        if (!s.r || !s.r.length) return;
        var on = s.r.some(function (rid) { return routeIsOn(rid) && routeNearOk(rid); });
        if (!on) return;
        list.push(s);
      });
    }
    stopPickList = list;
    writeStopMatrices(list, true);
    // Rebuilds recolor every instance: re-apply the selection highlight.
    selectedStopIndex = selectedStop ? list.indexOf(selectedStop) : -1;
    if (selectedStopIndex < 0 && selectedStop) hideStop();
    else setStopSelectedColor(selectedStopIndex, true);
  }

  // Selected-stop highlight: a narrow pulsing ring hugging the pylon base
  // plus the pylon itself painted white — unambiguous at any zoom.
  var selectedStop = null;
  var selectedStopIndex = -1;
  var stopHighlight = new THREE.Mesh(
    new THREE.RingGeometry(30, 52, 40),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false })
  );
  stopHighlight.rotation.x = -Math.PI / 2;
  stopHighlight.visible = false;
  scene.add(stopHighlight);

  // Paint the selected pylon white (restore its route/paper color after).
  // Called on select, deselect, and rebuild (toggles recolor everything).
  function setStopSelectedColor(idx, on) {
    if (idx < 0 || idx >= stopPickList.length || !stopIM.instanceColor) return;
    var s = stopPickList[idx];
    if (on) {
      _stopTmpColor.set(0xffffff);
    } else if (s.r.length > 1) {
      _stopTmpColor.set(0xf5f2ea);
    } else {
      var rc = routeColors[s.r[0]];
      if (rc) _stopTmpColor.copy(rc); else _stopTmpColor.set(0xf5f2ea);
    }
    stopIM.setColorAt(idx, _stopTmpColor);
    stopIM.instanceColor.needsUpdate = true;
  }
  function showStop(st) {
    if (!st) return;
    setFollow(null); // a stop selection ends bus tracking
    if (typeof tripMode !== 'undefined' && tripMode) { tripStopTapped(st); return; }
    camMemTake();
    exclCover('stop');
    tapBuzz();
    setStopSelectedColor(selectedStopIndex, false);
    selectedStop = st;
    selectedStopIndex = stopPickList.indexOf(st);
    setStopSelectedColor(selectedStopIndex, true);
    $('stop-title').textContent = st.n || 'Stop';
    $('stop-id').textContent = st.id || '–';
    $('stop-nroutes').textContent = (st.r || []).length + ((st.r || []).length === 1 ? ' route' : ' routes');
    var host = $('stop-routes');
    host.innerHTML = '';
    (st.r || []).forEach(function (rid) {
      var chip = document.createElement('span');
      chip.className = 'stop-route';
      var dot = document.createElement('i');
      var rc = routeColors[rid];
      dot.style.background = rc ? '#' + rc.getHexString() : '#F5F2EA';
      chip.appendChild(dot);
      var b = document.createElement('b');
      b.textContent = routeLabel(rid);
      chip.appendChild(b);
      if (typeof alertsForRoute === 'function' && typeof alertFx === 'function' && alertsForRoute(rid).length) {
        var cFx = alertFx({ effect: alertWorstEffect(alertsForRoute(rid)) });
        var adv = document.createElement('span');
        adv.className = 'adv-tag fx-' + cFx.cls;
        adv.textContent = cFx.glyph;
        adv.title = cFx.label + ' — active service alert on this route';
        chip.appendChild(adv);
      }
      host.appendChild(chip);
    });
    if (typeof renderStopAlerts === 'function') renderStopAlerts(st);
    if (typeof renderStopMogo === 'function') renderStopMogo(st);
    if (typeof renderStopPlace === 'function') renderStopPlace(st);
    $('stop-card').hidden = false;
    // Dialog focus: same pattern as showBus above.
    if (_stopReturnFocus === null && document.activeElement && !$('stop-card').contains(document.activeElement)) _stopReturnFocus = document.activeElement;
    $('stop-card').focus();
    if (st.place && typeof placesCardText === 'function') {
      announceSr(placesCardText(st));
    } else if (st.mogo && st.station) {
      announceSr('Bikeshare station details opened. ' + (st.n || 'Station') + '. ' +
        (typeof mogoCardModel === 'function' ? mogoCardModel(st.station, Date.now()).bikesLine + '. ' : '') +
        (typeof mogoStatusSentence === 'function' ? mogoStatusSentence(st.station) : ''));
    } else {
      announceSr('Stop details opened. ' + (st.n || 'Stop') + '. ' + (st.r || []).length + ((st.r || []).length === 1 ? ' route serves this stop.' : ' routes serve this stop.'));
    }
    // Selection ring hugs the ground for DDOT stops, the guideway deck for
    // People Mover stations (their pins stand on the elevated loop).
    stopHighlight.position.set(st.x, st.pm ? PM_DECK_Y + 4 : 20, st.z);
    stopHighlight.visible = true;
    renderStopLive();
    // Stop selection glides the camera (Phase 2 stop intent): frame the stop
    // at the safe-frame center. No follow — stops don't move. Skipped in
    // street view (its own glide above), trip modes, and the cinematic.
    if (!streetView && !tripFly && !(typeof tripMode !== 'undefined' && tripMode)) {
      var _sy = st.pm ? PM_DECK_Y : 20;
      TransitionEngine.go({
        vantage: TransitionEngine.vantageForStop(st.x, _sy, st.z),
        follow: 'hold'
      });
    }
    // In street view, tapping a stop glides the camera to center it —
    // the max-zoom way of walking down the street stop by stop.
    if (streetView && !tripFly && !(typeof tripMode !== 'undefined' && tripMode)) {
      var _sv = streetVantageFor(st);
      glideTo(_sv.pos, _sv.tgt, 1100);
    }
  }
  // Live arrivals on the selected stop's routes, refreshed on every poll.
  function renderStopLive() {
    var host = $('stop-live'), list = $('stop-live-list');
    if (!host || !list) return;
    renderStopSmartNote();
    if (!selectedStop || !lastVehicles || !lastVehicles.length) {
      host.hidden = true; return;
    }
    var rows = [];
    for (var i = 0; i < lastVehicles.length; i++) {
      var v = lastVehicles[i];
      if (selectedStop.r.indexOf(v.route_id) >= 0) rows.push(v);
    }
    if (!rows.length) { host.hidden = true; return; }
    host.hidden = false;
    list.innerHTML = '';
    var now = Date.now();
    rows.slice(0, 5).forEach(function (v) {
      var row = document.createElement('div');
      row.className = 'stop-live-row';
      var dot = document.createElement('i');
      var rc = routeColors[v.route_id];
      dot.style.background = rc ? '#' + rc.getHexString() : '#F5F2EA';
      row.appendChild(dot);
      var b = document.createElement('b');
      var slDest = formatDest(v.route_id, v.destination);
      b.textContent = routeLabel(v.route_id) + (slDest ? ' · ' + slDest : '');
      row.appendChild(b);
      // Stop tiles: the serving vehicle's number, so a rider can match
      // the row to the bus they can see. Gate: stopTilesOn.
      if (typeof stopTilesOn !== 'undefined' && stopTilesOn && v.vehicle_id) {
        var bn = document.createElement('span');
        bn.className = 'stop-live-bus';
        bn.textContent = 'Bus ' + v.vehicle_id;
        row.appendChild(bn);
      }
      var t = document.createElement('span');
      var when = v.updated_at ? new Date(v.updated_at) : null;
      var mins = (when && !isNaN(when)) ? Math.max(0, Math.round((now - when.getTime()) / 60000)) : null;
      t.textContent = mins == null ? '' : (mins < 1 ? 'just now' : mins + 'm ago');
      row.appendChild(t);
      list.appendChild(row);
    });
  }
  function hideStop() {
    var _hadFocus = $('stop-card').contains(document.activeElement);
    setStopSelectedColor(selectedStopIndex, false);
    selectedStopIndex = -1;
    selectedStop = null;
    $('stop-card').hidden = true;
    // Return focus to the opener when focus was inside the dialog.
    if (_hadFocus && _stopReturnFocus && _stopReturnFocus !== document.body && document.contains(_stopReturnFocus)) _stopReturnFocus.focus();
    _stopReturnFocus = null;
    stopHighlight.visible = false;
    // Restore the generic row labels now, not on the next open: the MoGo
    // path relabels them ("Station ID"/"Bikes"), and renderStopMogo's
    // non-MoGo branch is the existing restore path.
    if (typeof renderStopMogo === 'function') renderStopMogo(null);
    if (typeof renderStopPlace === 'function') renderStopPlace(null);
    exclRestore();
  }
  $('stop-close').addEventListener('click', hideStop);
  $('stop-card').addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); hideStop(); } });

  // --- trip planning (RAPTOR, scheduled times) -------------------------------
  // Phase 1: client-side RAPTOR over the compact timetable
  // (ddot-timetable-<feed>.json, built by build-timetable.py from DDOT GTFS).
  // Lazily imported only when the rider opens the planner; origin and
  // destination never leave the device. Every result is labeled scheduled.
  //
  // Phase 2 scaffold: live-fusion.js annotates scheduled journeys with live
  // vehicle context (per-route live counts now; delay propagation designed
  // next — see that module). Phase 3 (multimodal) is scoped in
  // raptor-concept.md; the leg model already supports it: a new leg type
  // only needs a renderer in renderTripDetail() and legPoints3D().
  var tripMode = false;
  var tripFrom = null;      // {kind:'stop', idx} | {kind:'loc', x, z}
  var tripTo = null;        // {kind:'stop', idx}
  var tripMapPick = null;   // 'from' | 'to' — the next map tap sets this field
  var tripView = 'planner'; // 'planner' | 'search'
  var tripSearchFor = 'from';
  var tripLeaveMode = 'now';// 'now' | 'at'
  var tripLeaveTime = '';
  var tripTT = null, tripRaptor = null, tripFusion = null;
  var tripJourneys = [], tripSel = -1, tripLoading = false;
  var tripAutoMinimized = false; // mobile: collapse card on first results render
  var tripFly = null;
  var tripGroup = new THREE.Group();
  tripGroup.visible = false;
  scene.add(tripGroup);
  var tripMats = []; // highlight materials, pulsed at the shared rate
  var _flyUp = new THREE.Vector3(0, 550, 0);
  var _flyDir = new THREE.Vector3();
  var SVC_NAMES = { '1': 'Sunday', '2': 'Saturday', '3': 'Weekday' };
  function tripEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function tripClock(sec) {
    sec = Math.floor(sec) % 86400;
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    var ap = h >= 12 ? 'PM' : 'AM', h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
  }
  function tripStopName(idx) {
    if (idx === -1) return 'Your location';
    var s = stopData && stopData[idx];
    return s ? (s.n || 'Stop ' + (s.id || '')) : 'Stop';
  }
  function tripMarker(color) {
    var m = new THREE.Mesh(
      new THREE.RingGeometry(34, 58, 40),
      new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
    );
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    scene.add(m);
    return m;
  }
  var tripOriginMark = tripMarker(0xffb000); // Amber = origin
  var tripDestMark = tripMarker(0xffffff);   // Paper = destination
  var HINT_DEFAULT = 'drag&nbsp;·&nbsp;orbit&nbsp;&nbsp;&nbsp;scroll&nbsp;·&nbsp;zoom&nbsp;&nbsp;&nbsp;tap bus or stop&nbsp;·&nbsp;details&nbsp;&nbsp;&nbsp;Tab to Browse for keyboard bus search · +/− buttons zoom';

  function setTripMode(on) {
    tripMode = on;
    $('trip-btn').setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) {
      camMemTake();
      exclCover('trip');
      cancelTripFly();
      $('trip-card').classList.remove('min');
      $('trip-mini').hidden = true;
      tripAutoMinimized = false;
      // Default origin: your location when known — the standard pattern.
      if (!tripFrom && typeof userXZ !== 'undefined' && userXZ) {
        tripFrom = { kind: 'loc', x: userXZ[0], z: userXZ[1] };
      }
      showTripView('planner');
      $('trip-card').hidden = false;
      if (typeof renderBetaTiles === 'function') renderBetaTiles();
      renderTripFields();
      updateTripMarkers();
      maybeReplan();
    } else {
      cancelTripFly();
      clearTrip();
      exclRestore();
    }
  }
  function clearTripHighlight() {
    for (var i = tripGroup.children.length - 1; i >= 0; i--) {
      var c = tripGroup.children[i];
      tripGroup.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
    tripMats.length = 0;
    tripGroup.visible = false;
    // Clear itinerary focus: restore full opacity to all routes.
    itineraryRoutes = {};
    if (typeof applyFilters === 'function') applyFilters();
  }
  // Routes in the currently selected trip itinerary. Empty object = no trip
  // active, no dimming. Populated by highlightJourney from the journey legs.
  var itineraryRoutes = {};
  function itineraryActive() {
    return Object.keys(itineraryRoutes).length > 0;
  }
  function itineraryDims(rid) {
    return itineraryActive() && !itineraryRoutes[rid];
  }
  function clearTrip() {
    tripFrom = null; tripTo = null;
    tripMapPick = null;
    tripJourneys = []; tripSel = -1;
    tripOriginMark.visible = false;
    tripDestMark.visible = false;
    clearTripHighlight();
    $('trip-card').hidden = true;
    $('map-hint').innerHTML = HINT_DEFAULT;
  }
  function cancelTripFly() {
    if (tripFly) { tripFly = null; controls.enabled = true; }
  }
  // Map taps in trip mode: an explicit "choose on map" target wins;
  // otherwise first tap = origin, second = destination, third restarts.
  function tripStopTapped(st) {
    var idx = stopData ? stopData.indexOf(st) : -1;
    if (idx < 0) return;
    tapBuzz();
    cancelTripFly();
    if (tripMapPick === 'to' || (!tripMapPick && tripFrom && !tripTo)) {
      setTripTo({ kind: 'stop', idx: idx });
    } else {
      setTripFrom({ kind: 'stop', idx: idx });
      if (!tripMapPick) tripTo = null;
    }
    tripMapPick = null;
    if (tripView === 'search') showTripView('planner');
    else { renderTripFields(); updateTripMarkers(); }
    maybeReplan();
  }
  function setTripFrom(f) {
    tripFrom = f;
    renderTripFields();
    updateTripMarkers();
  }
  function setTripTo(t) {
    tripTo = t;
    renderTripFields();
    updateTripMarkers();
  }
  function updateTripMarkers() {
    if (tripFrom) {
      var p = tripFrom.kind === 'stop' ? stopData[tripFrom.idx] : tripFrom;
      if (p) { tripOriginMark.position.set(p.x, 20, p.z); tripOriginMark.visible = true; }
      else tripOriginMark.visible = false;
    } else tripOriginMark.visible = false;
    if (tripTo && tripTo.kind === 'stop' && stopData[tripTo.idx]) {
      var s = stopData[tripTo.idx];
      tripDestMark.position.set(s.x, 20, s.z);
      tripDestMark.visible = true;
    } else tripDestMark.visible = false;
  }
  function renderTripFields() {
    $('trip-from-label').textContent = tripFrom
      ? (tripFrom.kind === 'loc' ? 'Your location' : tripStopName(tripFrom.idx)) : 'From';
    $('trip-from-label').classList.toggle('placeholder', !tripFrom);
    $('trip-to-label').textContent = tripTo ? tripStopName(tripTo.idx) : 'Where to?';
    $('trip-to-label').classList.toggle('placeholder', !tripTo);
    $('trip-now-btn').setAttribute('aria-pressed', tripLeaveMode === 'now' ? 'true' : 'false');
    if (tripLeaveMode === 'now') $('trip-time-input').value = '';
  }
  function showTripView(v) {
    tripView = v;
    $('trip-planner').hidden = v !== 'planner';
    $('trip-search').hidden = v !== 'search';
    if (v === 'search') {
      var inp = $('trip-search-input');
      inp.value = '';
      renderTripSearchOpts();
      renderTripSearchResults('');
      setTimeout(function () { inp.focus(); }, 50);
    }
  }
  function openTripSearch(forField) {
    tripSearchFor = forField;
    tapBuzz();
    showTripView('search');
  }
  function renderTripSearchOpts() {
    var host = $('trip-search-opts');
    host.innerHTML = '';
    if (tripSearchFor === 'from') {
      var loc = document.createElement('button');
      loc.className = 'trip-search-opt';
      var hasLoc = (typeof userXZ !== 'undefined' && userXZ);
      loc.innerHTML = '<b>' + (hasLoc ? 'Use my location' : 'Locate me') + '</b><span>' +
        (hasLoc ? 'nearest stops within a short walk' : 'finds your position first') + '</span>';
      loc.addEventListener('click', function () {
        if (typeof userXZ !== 'undefined' && userXZ) {
          setTripFrom({ kind: 'loc', x: userXZ[0], z: userXZ[1] });
          showTripView('planner');
          renderTripFields(); updateTripMarkers(); maybeReplan();
        } else {
          var lb = $('view-locate');
          if (lb) lb.click();
          showToast('Locating… tap "Use my location" again once found.');
        }
      });
      host.appendChild(loc);
    }
    var map = document.createElement('button');
    map.className = 'trip-search-opt';
    map.innerHTML = '<b>Choose on map</b><span>tap a stop in the 3D view</span>';
    map.addEventListener('click', function () {
      tripMapPick = tripSearchFor;
      showTripView('planner');
      renderTripFields();
      $('map-hint').innerHTML = 'tap a stop for <b>' +
        (tripSearchFor === 'from' ? 'origin' : 'destination') + '</b>';
    });
    host.appendChild(map);
  }
  function searchStops(q) {
    q = (q || '').trim().toLowerCase();
    if (q.length < 2 || !stopData) return [];
    var seen = {}, out = [];
    for (var i = 0; i < stopData.length; i++) {
      var s = stopData[i];
      var n = (s.n || '').toLowerCase();
      if (n.indexOf(q) < 0) continue;
      var e = seen[n];
      if (e) {
        e.count++;
        if ((s.r || []).length > (e.stop.r || []).length) { e.stop = s; e.idx = i; }
        continue;
      }
      e = { stop: s, idx: i, count: 1, prefix: n.indexOf(q) === 0 };
      seen[n] = e;
      out.push(e);
    }
    out.sort(function (a, b) {
      return (b.prefix - a.prefix) || (b.count - a.count) || ((b.stop.r || []).length - (a.stop.r || []).length);
    });
    return out.slice(0, 8);
  }
  function renderTripSearchResults(q) {
    var host = $('trip-search-results');
    host.innerHTML = '';
    var hits = searchStops(q);
    if (!hits.length) {
      if ((q || '').trim().length >= 2) {
        host.innerHTML = '<p class="trip-note">No stops match. Try a street or landmark name.</p>';
      }
      return;
    }
    hits.forEach(function (h) {
      var b = document.createElement('button');
      b.className = 'trip-search-hit';
      var t = document.createElement('b');
      t.textContent = h.stop.n || 'Stop';
      b.appendChild(t);
      var r = document.createElement('span');
      r.textContent = (h.stop.r || []).slice(0, 4).map(routeLabel).join(' · ') + ((h.stop.r || []).length > 4 ? ' +' + ((h.stop.r || []).length - 4) : '');
      b.appendChild(r);
      b.addEventListener('click', function () {
        tapBuzz();
        var val = { kind: 'stop', idx: h.idx };
        if (tripSearchFor === 'from') setTripFrom(val); else setTripTo(val);
        showTripView('planner');
        renderTripFields(); updateTripMarkers(); maybeReplan();
      });
      host.appendChild(b);
    });
  }
  function tripSeeds() {
    if (!tripFrom) return [];
    if (tripFrom.kind === 'stop') return [{ stop: tripFrom.idx, walk: 0 }];
    // Virtual origin: nearest stops within a 400 m walk of your position.
    var seeds = [];
    for (var i = 0; i < stopData.length; i++) {
      var s = stopData[i];
      var d = Math.hypot(s.x - tripFrom.x, s.z - tripFrom.z);
      if (d <= 400) seeds.push({ stop: i, walk: Math.max(60, Math.round(d / 1.4)) });
    }
    seeds.sort(function (a, b) { return a.walk - b.walk; });
    return seeds.slice(0, 12);
  }
  // The scheduled timetable covers only the DDOT segment of the merged
  // stop registry: buildIndex derives tt.nStops from the timetable
  // (5,116) while the registry carries 10,583 records (DDOT stops, the
  // SMART tombstone segment, then QLINE stops). A QLINE stop can
  // therefore never be a planner endpoint as-is, and plan() fails
  // silently for one. Map an out-of-coverage stop to the nearest
  // covered stop within 400 m — stops at one intersection sit metres
  // apart — or return -1 when no covered stop is that close.
  function coveredStopIdx(idx, tt) {
    if (idx == null || idx < 0) return -1;
    if (!tt || idx < tt.nStops) return idx;
    var s = stopData && stopData[idx];
    if (!s) return -1;
    var best = -1, bd = 400;
    for (var i = 0; i < tt.nStops; i++) {
      var t = stopData[i];
      if (!t) continue;
      var d = Math.hypot(t.x - s.x, t.z - s.z);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  // Planner arguments with endpoint coverage applied. Returns null when
  // an endpoint is out of coverage with no covered stop within 400 m.
  function planArgs(tt) {
    var dest = coveredStopIdx(tripTo.idx, tt);
    if (dest < 0) return null;
    var seeds;
    if (tripFrom.kind === 'stop') {
      var o = coveredStopIdx(tripFrom.idx, tt);
      if (o < 0) return null;
      var w = 0;
      if (o !== tripFrom.idx) {
        var a = stopData[tripFrom.idx], b = stopData[o];
        w = Math.max(60, Math.round(Math.hypot(a.x - b.x, a.z - b.z) / 1.4));
      }
      seeds = [{ stop: o, walk: w }];
    } else {
      seeds = tripSeeds();
    }
    return { seeds: seeds, dest: dest };
  }
  function renderTripUncovered() {
    var host = $('trip-results');
    host.innerHTML = '';
    var none = document.createElement('p');
    none.className = 'trip-note';
    none.textContent = 'One of these stops is not on a DDOT route, and no DDOT stop is within a short walk of it. The scheduled planner covers DDOT routes; SMART and QLINE stops share the map and the stop search.';
    host.appendChild(none);
    announceSr(none.textContent);
  }
  function tripWhen() {
    if (tripLeaveMode === 'at' && tripLeaveTime) {
      var p = tripLeaveTime.split(':');
      var d = new Date();
      d.setHours(parseInt(p[0], 10) || 0, parseInt(p[1], 10) || 0, 0, 0);
      return d;
    }
    return new Date();
  }
  function maybeReplan() {
    if (tripMode && tripFrom && tripTo && !tripLoading) runTripPlan();
    else if (tripMode && (!tripFrom || !tripTo)) {
      tripJourneys = []; tripSel = -1;
      clearTripHighlight();
      renderTripEmpty();
    }
  }
  function renderTripEmpty() {
    var host = $('trip-results');
    host.innerHTML = '<p class="trip-note">Pick an origin and destination to see scheduled trips.</p>';
  }
  function mergeWalkLegs(legs) {
    var out = [];
    legs.forEach(function (l) {
      var p = out[out.length - 1];
      if (l.type === 'walk' && p && p.type === 'walk') { p.to = l.to; p.secs += l.secs; }
      else out.push(Object.assign({}, l));
    });
    return out;
  }
  function runTripPlan() {
    if (tripLoading) return;
    tripLoading = true;
    tapBuzz();
    cancelTripFly();
    $('trip-prov').textContent = 'scheduled';
    var host = $('trip-results');
    host.innerHTML = '<p class="trip-note">Planning…</p>';
    var go = function (R) {
      tripRaptor = R;
      var loaded = tripTT ? Promise.resolve(tripTT)
        : R.loadTimetable('ddot-timetable-S1000182.json?v=' + STAMP).then(function (tt) { tripTT = tt; return tt; });
      var when = tripWhen();
      var oF = tripFrom, oT = tripTo; // capture; ignore if the user moved on
      return loaded.then(function (tt) {
        if (oF !== tripFrom || oT !== tripTo) return; // stale
        var args = planArgs(tt);
        if (!args) {
          tripJourneys = []; tripSel = -1;
          clearTripHighlight();
          renderTripUncovered();
          return;
        }
        var res = R.plan(tt, args.seeds, args.dest, when);
        if (oF !== tripFrom || oT !== tripTo) return; // stale
        tripJourneys = res.journeys;
        tripSel = tripJourneys.length ? 0 : -1;
        applyTripFusion();
        renderTripResults(res);
        if (tripSel >= 0) { highlightJourney(tripJourneys[0]); }
        else clearTripHighlight();
      });
    };
    var boot = (tripRaptor && tripFusion) ? Promise.resolve({ R: tripRaptor, F: tripFusion })
      : Promise.all([
          tripRaptor ? Promise.resolve(tripRaptor) : import('./raptor.js?v=' + STAMP),
          tripFusion ? Promise.resolve(tripFusion) : import('./live-fusion.js?v=' + STAMP)
        ]).then(function (ms) { return { R: ms[0].default || ms[0], F: ms[1].default || ms[1] }; })
        .then(function (m) { tripFusion = m.F; return m; });
    // Note: raptor.js uses named exports; the .default fallback keeps this
    // working if the module shape ever changes.
    boot.then(function (m) { return go(m.R); }).catch(function (err) {
      $('trip-results').innerHTML = '<p class="trip-note">Could not plan the trip (' +
        tripEsc((err && err.message) || String(err)) + '). Check your connection and try again.</p>';
    }).then(function () { tripLoading = false; });
  }
  function applyTripFusion() {
    if (!tripFusion || !tripJourneys.length) return;
    try { tripFusion.fuseJourneys(tripJourneys, (typeof lastVehicles !== 'undefined' && lastVehicles) || []); }
    catch (e) { /* fusion never breaks planning */ }
  }
  // Called from the vehicle poll so live counts stay fresh while a trip is open.
  function refreshTripFusion() {
    if (!tripMode || !tripJourneys.length || !tripFusion) return;
    applyTripFusion();
    if (tripSel >= 0) renderTripDetail();
  }
  // Phase 2b-i: quietly re-plan "leave now" queries each poll so the card
  // reflects fresh delays. "Depart at" queries are fixed in time and keep
  // their original plan. Selection is preserved when the option survives.
  function replanLive() {
    if (!tripMode || !tripJourneys.length || !tripRaptor || !tripTT || tripLoading) return;
    try {
      var args = planArgs(tripTT);
      if (!args) return; // endpoint out of coverage: keep the current results
      var res = tripRaptor.plan(tripTT, args.seeds, args.dest, new Date());
      var sig = tripSel >= 0 && tripJourneys[tripSel] ? journeySig(tripJourneys[tripSel]) : null;
      tripJourneys = res.journeys;
      tripSel = -1;
      if (sig) {
        for (var i = 0; i < tripJourneys.length; i++) {
          if (journeySig(tripJourneys[i]) === sig) { tripSel = i; break; }
        }
      }
      if (tripSel < 0) tripSel = tripJourneys.length ? 0 : -1;
      applyTripFusion();
      renderTripResults(res);
      if (tripSel >= 0) highlightJourney(tripJourneys[tripSel]); else clearTripHighlight();
    } catch (e) { /* live refresh never breaks the card */ }
  }
  function journeySig(j) {
    return j.legs.map(function (l) {
      return l.type === 'bus' ? ('b' + l.routeId + '@' + l.board + '>' + l.alight) : 'w';
    }).join('|');
  }
  // --- Phase 2c: active ride guidance -----------------------------------------
  // Advisory banners driven by the selected journey + live vehicle positions.
  // Framed around the BUS (what we can see), never the rider (what we can't).
  // Triggers: "board soon" (bus ≤2 min from boarding stop), "alight next"
  // (1 stop out), missed transfer → auto-replan from the live position.
  var guidanceDismissedSig = null;
  var missedCooldownUntil = 0;

  function guidanceVehicle(leg) {
    if (!leg.tripRef) return null;
    var st = tripDelayState.get(leg.tripRef);
    if (!st || st.disrupted) return null;
    var tr = busTrackers[st.vehicleId];
    if (!tr || !tr.arc || !tr.vehicle) return null;
    return tr;
  }
  function stopsToAlight(leg, tr, arcMap) {
    var trip = leg.tripRef;
    var pts = [];
    for (var k = 0; k < trip.stops.length; k++) {
      var sk = arcMap[String(trip.stops[k])];
      if (sk != null) pts.push({ stop: String(trip.stops[k]), s: sk });
    }
    var vi = -1, ai = -1;
    for (var q = 0; q < pts.length; q++) {
      if (pts[q].s <= tr.s + 30) vi = q;
      if (pts[q].stop === String(leg.alight)) ai = q;
    }
    if (vi < 0 || ai < 0) return -1;
    return ai - vi;
  }
  function fmtEta(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + 's';
    var m = Math.round(sec / 60);
    return m + ' min';
  }
  // Live-adjusted leg time: refresh the plan-time delay with the current one.
  function liveLegTime(leg, which) {
    var base = which === 'board' ? leg.boardSec : leg.alightSec;
    if (!leg.tripRef) return base;
    var st = tripDelayState.get(leg.tripRef);
    if (st && !st.disrupted) return base - (leg.delaySec || 0) + st.delaySec;
    return base;
  }
  function guidanceForLeg(leg) {
    var tr = guidanceVehicle(leg);
    if (!tr) return null; // no live bus on this trip: no guidance, no fiction
    var arcMap = stopArcMap(leg.routeId, tr.pathIdx);
    var sBoard = arcMap[String(leg.board)], sAlight = arcMap[String(leg.alight)];
    if (sBoard == null || sAlight == null) return null;
    var speed = Math.max(tr.speedMps, 1.5);
    if (tr.s < sBoard - 50) {
      var eta = (sBoard - tr.s) / speed;
      if (eta <= 150) {
        return { kind: 'board', text: 'Route ' + routeLabel(leg.routeId) + ' reaches ' +
          tripStopName(leg.board) + ' in ~' + fmtEta(eta) + ' — be ready to board.' };
      }
      return null;
    }
    var left = stopsToAlight(leg, tr, arcMap);
    if (left < 0) return null;
    if (left === 0) return 'passed';
    if (left === 1) {
      return { kind: 'alight', urgent: true, text: 'Route ' + routeLabel(leg.routeId) +
        ' arriving at ' + tripStopName(leg.alight) + ' — get off at the next stop.' };
    }
    return { kind: 'riding', text: 'Route ' + routeLabel(leg.routeId) + ' — ' + left +
      ' stops to ' + tripStopName(leg.alight) + '.' };
  }
  function checkMissedTransfer(j, busLegs) {
    for (var i = 0; i + 1 < busLegs.length; i++) {
      var leg1 = busLegs[i], leg2 = busLegs[i + 1];
      var alight1 = liveLegTime(leg1, 'alight');
      var board2 = liveLegTime(leg2, 'board');
      // Walk between the legs comes from the journey's own walk legs.
      var walkSec = 0, inWalk = false;
      for (var k = 0; k < j.legs.length; k++) {
        var l = j.legs[k];
        if (l === leg1) { inWalk = true; continue; }
        if (l === leg2) break;
        if (inWalk && l.type === 'walk') walkSec += l.secs || 0;
      }
      if (board2 < alight1 + walkSec + 60) {
        return { leg1: leg1, leg2: leg2, alightStop: leg1.alight };
      }
    }
    return null;
  }
  function showGuidanceBanner(kind, text, urgent, done) {
    var banner = $('trip-guidance');
    if (!banner) return;
    banner.innerHTML = '';
    banner.className = urgent ? 'urgent' : (done ? 'done' : '');
    banner.hidden = false;
    // Urgent guidance (alight-next) must be seen: expand a minimized card.
    // A rider must not miss their stop because the card was collapsed.
    if (urgent) {
      var tc = $('trip-card');
      if (tc && tc.classList.contains('min')) {
        tc.classList.remove('min');
        $('trip-mini').hidden = true;
      }
    }
    var dot = document.createElement('b');
    dot.textContent = kind === 'alight' ? '◉' : (kind === 'missed' ? '⚠' : '●');
    dot.style.color = urgent ? '#FF6B60' : '#FFB000';
    banner.appendChild(dot);
    var sp = document.createElement('span');
    sp.textContent = text;
    banner.appendChild(sp);
    var x = document.createElement('button');
    x.textContent = '×';
    x.setAttribute('aria-label', 'Dismiss guidance');
    x.addEventListener('click', function () {
      if (tripSel >= 0 && tripJourneys[tripSel]) guidanceDismissedSig = journeySig(tripJourneys[tripSel]);
      banner.hidden = true;
    });
    banner.appendChild(x);
  }
  function hideGuidanceBanner() {
    var banner = $('trip-guidance');
    if (banner) { banner.hidden = true; }
  }
  // Replan from the rider's live position: the bus they're on, else GPS,
  // else the missed leg's alighting stop.
  function replanFromLive(missed) {
    var tr = guidanceVehicle(missed.leg1);
    if (tr && tr.vehicle && tr.vehicle.x != null) {
      tripFrom = { kind: 'loc', x: tr.vehicle.x, z: tr.vehicle.z };
    } else if (youMarker.group.visible) {
      tripFrom = { kind: 'loc', x: youMarker.group.position.x, z: youMarker.group.position.z };
    } else {
      var sd = stopData[missed.alightStop];
      tripFrom = sd ? { kind: 'stop', idx: missed.alightStop } : tripFrom;
    }
    renderTripFields();
    updateTripMarkers();
    runTripPlan();
  }
  function updateGuidance() {
    if (!tripMode || !tripJourneys.length || tripSel < 0) { hideGuidanceBanner(); return; }
    if (tripLeaveMode === 'at' && tripLeaveTime) { hideGuidanceBanner(); return; }
    var j = tripJourneys[tripSel];
    var sig = journeySig(j);
    var dismissed = (guidanceDismissedSig === sig);
    var busLegs = j.legs.filter(function (l) { return l.type === 'bus'; });
    if (!busLegs.length) { hideGuidanceBanner(); return; }
    // Missed transfer: highest priority.
    var missed = checkMissedTransfer(j, busLegs);
    if (missed && Date.now() > missedCooldownUntil) {
      missedCooldownUntil = Date.now() + 5 * 60 * 1000;
      guidanceDismissedSig = null;
      showGuidanceBanner('missed',
        'Missed the Route ' + routeLabel(missed.leg2.routeId) + ' connection — replanned from your current position.',
        true, false);
      replanFromLive(missed);
      return;
    }
    for (var i = 0; i < busLegs.length; i++) {
      var g = guidanceForLeg(busLegs[i]);
      if (g === 'passed') continue;
      // Urgent guidance (get off at the next stop) always shows: a dismissal
      // must never suppress a safety-critical banner. Dismissal only quiets
      // non-urgent guidance for this journey.
      if (g) {
        if (dismissed && !g.urgent) { hideGuidanceBanner(); return; }
        showGuidanceBanner(g.kind, g.text, !!g.urgent, false);
        return;
      }
    }
    if (dismissed) { hideGuidanceBanner(); return; }
    showGuidanceBanner('done', 'You have arrived.', false, true);
  }
  function renderTripResults(res) {
    var host = $('trip-results');
    host.innerHTML = '';
    refreshTripMini();
    // Small screens: default to the minimized bar on the first results render
    // so the map stays usable. Never re-collapse after the user expanded it.
    if (!tripAutoMinimized && tripJourneys.length &&
        window.matchMedia('(max-width: 640px)').matches) {
      tripAutoMinimized = true;
      $('trip-mini-label').textContent = tripMiniLabel();
      $('trip-mini').hidden = false;
      $('trip-card').classList.add('min');
    }
    var meta = document.createElement('p');
    meta.className = 'trip-note';
    var svcName = res.meta.service && SVC_NAMES[res.meta.service] ? SVC_NAMES[res.meta.service] : 'DDOT';
    var whenLbl = tripLeaveMode === 'at' && tripLeaveTime ? 'depart ' + tripLeaveTime : 'leave now';
    var provMode = 'scheduled';
    tripJourneys.forEach(function (j) {
      j.legs.forEach(function (l) {
        if (l.type !== 'bus') return;
        if (l.provenance === 'live') provMode = 'live';
        else if (l.provenance === 'empirical' && provMode === 'scheduled') provMode = 'empirical';
      });
    });
    var provLbl = provMode === 'live' ? 'Live delays' : (provMode === 'empirical' ? 'Typical times' : 'Scheduled times');
    meta.textContent = provLbl + ' · ' + svcName + ' service · ' + whenLbl + ' · feed ' + (res.meta.feedVersion || '');
    var provEl = $('trip-prov');
    if (provEl) provEl.textContent = provMode === 'live' ? 'live' : (provMode === 'empirical' ? 'typical' : 'scheduled');
    host.appendChild(meta);
    if (!tripJourneys.length) {
      var none = document.createElement('p');
      none.className = 'trip-note';
      none.textContent = res.meta.reason === 'no-service'
        ? 'No scheduled DDOT service at this time.'
        : res.meta.reason === 'no-origin'
          ? 'No DDOT stop is within a short walk of the start point. The scheduled planner covers DDOT routes.'
          : 'No scheduled trip found between these stops right now. Try a different pair or time.';
      host.appendChild(none);
      announceSr(none.textContent);
      return;
    }
    var list = document.createElement('div');
    list.id = 'trip-opt-list';
    tripJourneys.forEach(function (j, i) { list.appendChild(tripOptionEl(j, i)); });
    host.appendChild(list);
    var det = document.createElement('div');
    det.id = 'trip-detail';
    host.appendChild(det);
    renderTripDetail();
    announceSr(tripJourneys.length + (tripJourneys.length === 1 ? ' scheduled trip' : ' scheduled trips') + ' found. First trip: ' + tripJourneys[0].durationMin + ' minutes, ' + tripJourneys[0].departClock + ' to ' + tripJourneys[0].arriveClock + '.');
  }
  function tripOptionEl(j, i) {
    var b = document.createElement('button');
    b.className = 'trip-opt' + (i === tripSel ? ' sel' : '');
    b.setAttribute('aria-pressed', i === tripSel ? 'true' : 'false');
    var top = document.createElement('div');
    top.className = 'trip-opt-top';
    var mins = document.createElement('b');
    mins.textContent = j.durationMin + ' min';
    top.appendChild(mins);
    var times = document.createElement('span');
    times.textContent = j.departClock + ' → ' + j.arriveClock;
    top.appendChild(times);
    b.appendChild(top);
    var sub = document.createElement('div');
    sub.className = 'trip-opt-sub';
    var liveN = j.legs.reduce(function (n, l) { return n + (l.liveVehicles || 0); }, 0);
    var jProv = 'scheduled';
    j.legs.forEach(function (l) {
      if (l.type !== 'bus') return;
      if (l.provenance === 'live') jProv = 'live';
      else if (l.provenance === 'empirical' && jProv === 'scheduled') jProv = 'empirical';
    });
    var jProvLbl = jProv === 'live' ? 'live delays' : (jProv === 'empirical' ? 'typical times' : 'scheduled');
    if (j.legs.some(function (l) { return l.disrupted; })) jProvLbl += ' · disrupted';
    sub.textContent = (j.nBus === 0 ? 'Walk' : (j.transfers === 0 ? 'Direct' : j.transfers + (j.transfers === 1 ? ' transfer' : ' transfers'))) +
      ' · ' + j.walkMin + ' min walk' + (liveN > 0 ? ' · ' + liveN + ' live' : '') + ' · ' + jProvLbl;
    b.appendChild(sub);
    var legs = document.createElement('div');
    legs.className = 'trip-legs';
    mergeWalkLegs(j.legs).forEach(function (l) {
      var chip = document.createElement('span');
      chip.className = 'trip-leg-chip';
      if (l.type === 'bus') {
        var dot = document.createElement('i');
        dot.style.background = l.color || '#F5F2EA';
        chip.appendChild(dot);
        var lbl = document.createElement('b');
        lbl.textContent = routeLabel(l.routeId);
        chip.appendChild(lbl);
      } else {
        var w = document.createElement('b');
        w.className = 'walk';
        w.textContent = 'walk ' + Math.max(1, Math.round(l.secs / 60)) + 'm';
        chip.appendChild(w);
      }
      legs.appendChild(chip);
    });
    b.appendChild(legs);
    b.addEventListener('click', function () {
      tripSel = i;
      tapBuzz();
      var opts = document.querySelectorAll('#trip-opt-list .trip-opt');
      for (var k = 0; k < opts.length; k++) {
        opts[k].classList.toggle('sel', k === tripSel);
        opts[k].setAttribute('aria-pressed', k === tripSel ? 'true' : 'false');
      }
      renderTripDetail();
      highlightJourney(tripJourneys[i]);
      flyJourney(tripJourneys[i]); // the perspective is the interface
    });
    return b;
  }
  // Phase 2b-i: human-readable provenance for a bus leg.
  function tripProvLabel(l) {
    if (l.disrupted) return 'disrupted · times as scheduled';
    if (l.provenance === 'live') {
      var dMin = Math.round(l.delaySec / 60);
      var dTxt = Math.abs(l.delaySec) <= 60 ? 'on time'
        : (dMin > 0 ? '+' + dMin + ' min late' : dMin + ' min early');
      // Age is the vehicle's GPS fix age (falls back to the delay computation
      // time when the fix stamp is unavailable).
      var ageMs = l.delayFixStamp || l.delayStamp || Date.now();
      var ageS = Math.max(0, Math.round((Date.now() - ageMs) / 1000));
      var ageTxt = ageS < 90 ? ageS + 's' : Math.round(ageS / 60) + ' min';
      return dTxt + ' · live ' + ageTxt + ' old';
    }
    if (l.provenance === 'empirical') return 'typical time';
    return 'scheduled';
  }
  function renderTripDetail() {
    var det = $('trip-detail');
    if (!det) return;
    det.innerHTML = '';
    if (tripSel < 0 || !tripJourneys[tripSel]) return;
    // Service alerts (Map-Native): a NO_SERVICE effect on any leg's route
    // is stated at the top of the itinerary; every alert on a leg's route
    // also gets a "What changed" line on the leg itself, and the leg row
    // takes the vocabulary's left-border treatment. The planner informs —
    // it never silently reroutes around an alert.
    if (typeof alertsForRoute === 'function') {
      var topAlert = null, topRid = null;
      mergeWalkLegs(tripJourneys[tripSel].legs).forEach(function (l0) {
        if (l0.type !== 'bus' || topAlert) return;
        alertsForRoute(l0.routeId).forEach(function (a) {
          if (!topAlert && a.effect === 'NO_SERVICE') { topAlert = a; topRid = l0.routeId; }
        });
      });
      if (topAlert) {
        var ban = document.createElement('div');
        ban.className = 'trip-alert-top';
        ban.textContent = '✕ No service on ' + routeLabel(topRid) + ': ' + topAlert.header +
          (topAlert.kind === 'planned' ? ' (planned notice)' : '') +
          ' — this itinerary uses that route; the leg below states what changed.';
        det.appendChild(ban);
      }
    }
    mergeWalkLegs(tripJourneys[tripSel].legs).forEach(function (l) {
      var row = document.createElement('div');
      row.className = 'trip-leg-row';
      var dot = document.createElement('i');
      var body = document.createElement('div');
      if (l.type === 'bus') {
        dot.style.background = l.color || '#F5F2EA';
        var t = document.createElement('b');
        t.textContent = routeLabel(l.routeId) + (l.headsign ? ' · ' + l.headsign : '');
        body.appendChild(t);
        var s = document.createElement('span');
        s.textContent = tripStopName(l.board) + ' → ' + tripStopName(l.alight);
        body.appendChild(s);
        var tm = document.createElement('span');
        tm.className = 'trip-leg-time';
        tm.textContent = tripClock(l.boardSec) + ' → ' + tripClock(l.alightSec) + ' · ' + tripProvLabel(l) +
          (l.interp ? ' · estimated' : '') + (l.liveVehicles > 0 ? ' · ' + l.liveVehicles + ' live' : '');
        body.appendChild(tm);
        if (l.provenance === 'live' || l.disrupted) {
          var badge = document.createElement('span');
          badge.className = l.disrupted ? 'trip-disrupted-badge' : 'trip-live-badge';
          badge.textContent = l.disrupted ? 'Disrupted' : 'Live';
          body.appendChild(badge);
        }
        if (typeof alertsForRoute === 'function' && typeof alertWhatChanged === 'function') {
          var legAlerts = alertsForRoute(l.routeId);
          if (legAlerts.length) {
            row.classList.add('alerted');
            if (alertWorstEffect(legAlerts) === 'NO_SERVICE') row.classList.add('severe');
          }
          legAlerts.forEach(function (a) {
            var fx = alertFx(a);
            var aw = document.createElement('span');
            aw.className = 'trip-leg-alert';
            var lead = document.createElement('b');
            lead.className = 'fx fx-' + fx.cls;
            lead.textContent = fx.glyph + ' What changed: ';
            aw.appendChild(lead);
            var txt = alertWhatChanged(a);
            // Stop precision the feed actually supports: when the alert
            // names this leg's boarding stop, say so in words.
            var bs = (typeof stopData !== 'undefined' && stopData) ? stopData[l.board] : null;
            if (bs && (a.stops || []).indexOf(String(bs.id)) >= 0 &&
                (a.effect === 'DETOUR' || a.effect === 'NO_SERVICE' || a.effect === 'STOP_MOVED')) {
              txt += ' Your boarding stop, ' + (bs.n || ('stop ' + bs.id)) + ', is one of the stops this alert names.';
            }
            aw.appendChild(document.createTextNode(txt));
            body.appendChild(aw);
          });
        }
      } else {
        dot.className = 'walk';
        var wt = document.createElement('b');
        wt.textContent = 'Walk ' + Math.max(1, Math.round(l.secs / 60)) + ' min';
        body.appendChild(wt);
        var ws = document.createElement('span');
        ws.textContent = tripStopName(l.from) + ' → ' + tripStopName(l.to);
        body.appendChild(ws);
      }
      row.appendChild(dot);
      row.appendChild(body);
      det.appendChild(row);
    });
  }
  function nearestOnPath(path, x, z) {
    var bi = 0, bd = Infinity;
    for (var i = 0; i < path.length; i++) {
      var dx = path[i][0] - x, dz = path[i][1] - z;
      var d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  }
  // Slice of a route's guideway between two stops, for highlight + fly-through.
  function busLegSlice(leg) {
    var route = routeById[leg.routeId];
    if (!route || !route.paths || !route.paths.length) return null;
    var ri = routeOrder.indexOf(leg.routeId);
    var y = 66 + ri * 1.2 + 3; // just above this route's deck
    var a = stopData[leg.board], b = stopData[leg.alight];
    if (!a || !b) return null;
    var best = null;
    route.paths.forEach(function (path) {
      if (!path || path.length < 2) return;
      var ia = nearestOnPath(path, a.x, a.z), ib = nearestOnPath(path, b.x, b.z);
      var d = Math.pow(path[ia][0] - a.x, 2) + Math.pow(path[ia][1] - a.z, 2) +
              Math.pow(path[ib][0] - b.x, 2) + Math.pow(path[ib][1] - b.z, 2);
      if (!best || d < best.d) best = { path: path, ia: ia, ib: ib, d: d };
    });
    if (!best) return null;
    var i0 = Math.min(best.ia, best.ib), i1 = Math.max(best.ia, best.ib);
    if (i1 - i0 < 1) return null;
    return { pts: best.path.slice(i0, i1 + 1), y: y };
  }
  function legPoints3D(leg) {
    if (leg.type === 'walk') {
      var a = leg.fromLoc ? { x: tripFrom.x, z: tripFrom.z } : stopData[leg.from];
      var b = stopData[leg.to];
      if (!a || !b) return [];
      return [new THREE.Vector3(a.x, 80, a.z), new THREE.Vector3(b.x, 80, b.z)];
    }
    var sl = busLegSlice(leg);
    if (!sl) return [];
    return sl.pts.map(function (p) { return new THREE.Vector3(p[0], sl.y, p[1]); });
  }
  function highlightJourney(j) {
    clearTripHighlight();
    if (!j) return;
    // Populate itinerary focus: routes in this journey stay bright, others dim.
    itineraryRoutes = {};
    mergeWalkLegs(j.legs).forEach(function (leg) {
      if (leg.type === 'bus' && leg.routeId) itineraryRoutes[leg.routeId] = true;
    });
    if (typeof applyFilters === 'function') applyFilters();
    mergeWalkLegs(j.legs).forEach(function (leg) {
      if (leg.type === 'bus') {
        var sl = busLegSlice(leg);
        if (!sl) return;
        var mat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(leg.color || '#F5F2EA'), transparent: true,
          opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
        });
        mat.userData.baseOpacity = 0.85;
        tripGroup.add(new THREE.Mesh(ribbonGeometry(sl.pts, 46, sl.y), mat));
        tripMats.push(mat);
      } else {
        var pts3 = legPoints3D(leg);
        if (pts3.length < 2) return;
        pts3[0].y = 30; pts3[1].y = 30;
        var g = new THREE.BufferGeometry().setFromPoints(pts3);
        var wm = new THREE.LineDashedMaterial({ color: 0xf5f2ea, transparent: true, opacity: 0.8, dashSize: 60, gapSize: 40 });
        var line = new THREE.Line(g, wm);
        line.computeLineDistances();
        wm.userData.baseOpacity = 0.8;
        tripGroup.add(line);
        tripMats.push(wm);
      }
    });
    tripGroup.visible = true;
  }
  // Cinematic fly-through of the selected journey: the perspective is the
  // interface. Chase-cam along the journey path; any pointerdown hands
  // control straight back to the rider.
  function flyJourney(j) {
    if (!j) return;
    var pts = [];
    mergeWalkLegs(j.legs).forEach(function (leg) {
      var lp = legPoints3D(leg);
      for (var i = 0; i < lp.length; i++) {
        if (pts.length && i === 0) continue;
        pts.push(lp[i]);
      }
    });
    if (pts.length < 2) return;
    if (pts.length > 80) {
      var step = (pts.length - 1) / 79, dp = [];
      for (var k = 0; k < 80; k++) dp.push(pts[Math.round(k * step)]);
      pts = dp;
    }
    tripFly = {
      curve: new THREE.CatmullRomCurve3(pts),
      t0: performance.now(),
      dur: Math.min(6500, 2600 + pts.length * 45)
    };
    controls.enabled = false;
  }
  function stepTripFly(now) {
    if (!tripFly) return;
    var t = Math.min(1, (now - tripFly.t0) / tripFly.dur);
    var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    var pos = tripFly.curve.getPoint(e);
    var ahead = tripFly.curve.getPoint(Math.min(1, e + 0.03));
    _flyDir.copy(ahead).sub(pos);
    if (_flyDir.lengthSq() > 1e-6) _flyDir.normalize();
    camera.position.copy(pos).addScaledVector(_flyDir, -450).add(_flyUp);
    controls.target.copy(ahead);
    if (t >= 1) { tripFly = null; controls.enabled = true; }
  }
  $('trip-btn').addEventListener('click', function () { tapBuzz(); setTripMode(!tripMode); });
  $('trip-close').addEventListener('click', function () { setTripMode(false); });

  // Ride Along widget wiring.
  var rideWidget = null, rideMode = false;
  // Put the camera on a ridden bus: glide to its vantage and engage the
  // follow loop, so the bus stays centered as it moves. Boarding is an
  // explicit ride intent, so it clears any follow suppression left over
  // from the plain selection flow. While a trip fly-through owns the
  // camera, follow is engaged directly — followTick defers to the
  // cinematic frame-by-frame and takes over framing when it ends.
  function rideFollowBus(vid) {
    var sl = null;
    for (var i = 0; i < busSlots.length; i++) {
      if (busSlots[i].vehicle && busSlots[i].vehicle.vehicle_id === vid) { sl = busSlots[i]; break; }
    }
    if (!sl) { refreshFollowBtn(); return; }
    followSuppressed = false;
    if (typeof tripFly !== 'undefined' && tripFly) { setFollow(vid, sl); return; }
    // Engage follow immediately; do not leave it solely to the glide's
    // completion directive. glideTo() replaces any in-flight glide, and
    // a replaced glide's onDone never runs — so an engage deferred to
    // completion is silently lost when another glide (e.g. the stop
    // card's, issued moments earlier in the select-bus -> stop -> Ride
    // along sequence) or a programmatic camera move intervenes, and the
    // ride then never tracks. followTick defers to an active glide
    // frame-by-frame and keeps its seed fresh, so engaging now is safe;
    // the glide below still centers the camera on the bus, and its
    // completion directive re-applies this same follow.
    setFollow(vid, sl);
    TransitionEngine.go({
      vantage: TransitionEngine.vantageForBus(sl.x, sl.z),
      follow: 'engage',
      vehicleId: vid,
      slot: sl
    });
  }
  var _rideBoardMute = false; // board() fires onBoard; boardRideBus does its own camera work
  // Board a bus in the ride widget. Returns false (no-op) when the widget
  // does not know the vehicle — never board a bus the picker cannot show.
  function boardRideBus(vid, engageCamera) {
    if (!rideWidget || !vid) return false;
    var known = false;
    for (var i = 0; i < rideWidget.vehicles.length; i++) {
      if (rideWidget.vehicles[i].vehicle_id === vid) { known = true; break; }
    }
    if (!known) return false;
    _rideBoardMute = true;
    try { rideWidget.board(vid); } finally { _rideBoardMute = false; }
    if (engageCamera) rideFollowBus(vid);
    return true;
  }
  function setRideMode(on) {
    rideMode = on;
    if (on) { camMemTake(); exclCover('ride'); }
    $('ride-btn').setAttribute('aria-pressed', on ? 'true' : 'false');
    $('ride-card').hidden = !on;
    if (on && !rideWidget && typeof RideAlong !== 'undefined') {
      rideWidget = RideAlong.create($('ride-along-mount'));
      // Camera hooks: boarding from the card's own dropdown also puts the
      // camera on the bus; getting off releases a follow this engagement
      // started.
      rideWidget.onBoard = function (vid) { if (!_rideBoardMute) rideFollowBus(vid); };
      rideWidget.onAlight = function (vid) { if (followVId === vid) setFollow(null); };
      // Feed cached route/stop data if already loaded.
      if (typeof routeById !== 'undefined' && typeof stopData !== 'undefined') {
        var rts = Object.keys(routeById).map(function (id) { return routeById[id]; });
        rideWidget.setData({ routes: rts, stops: stopData });
      }
      if (typeof lastVehicles !== 'undefined' && lastVehicles) {
        window.__setRideVehicles(lastVehicles);
      }
    }
    if (on && rideWidget) {
      // Ride along (2026-10-15): stop times for the ride view, and the
      // timetable engine a boarded bus's matching needs.
      if (rideWidget.setTimesProvider) rideWidget.setTimesProvider(rideTimesFor);
      ensureTripEngine();
      rideWidget.refresh();
    }
    // Respect the in-focus bus: if a bus is already selected when Ride
    // Along is switched on, ride THAT bus — no second selection in the
    // card's dropdown. (The selected bus survives a stop selection, so
    // this also covers select bus -> tap a stop -> Ride along.)
    if (on && rideWidget && selectedVehicleId) boardRideBus(selectedVehicleId, true);
    if (!on) exclRestore();
  }
  $('ride-btn').addEventListener('click', function () { tapBuzz(); setRideMode(!rideMode); });
  $('ride-close').addEventListener('click', function () { setRideMode(false); });
  // Expose for the vehicle poll to push updates.
  window.__rideWidget = function () { return rideWidget; };
  window.__setRideData = function (routes, stops) {
    if (rideWidget) rideWidget.setData({ routes: routes, stops: stops });
  };
  window.__setRideVehicles = function (vehicles) {
    if (!rideWidget) return;
    // The proxy feed carries lat/lon; the Ride Along widget works in
    // projected x/z (its data contract). Merge the projection onto a copy
    // of each record — the raw feed objects are shared with the map
    // renderer and must not be mutated. Speed arrives as speed_mph.
    // Real-time ride view (2026-10-15): the position handed to the
    // widget is the bus slot's CURRENT position — updateBusMotion
    // dead-reckons it from the Kalman state every frame — not the raw
    // fix the feed last reported. A DDOT fix can be a minute or more
    // old on arrival and the poll cadence is 60 s; projecting the raw
    // fix left the ride view's upcoming-stops list minutes behind the
    // bus (passed stops lingering, times stale). The slot position is
    // the same estimate the map renders. A vehicle without a slot (not
    // yet tracked) falls back to the raw fix projection.
    var slotById = {};
    for (var s = 0; s < busSlots.length; s++) {
      if (busSlots[s].vehicle) slotById[busSlots[s].vehicle.vehicle_id] = busSlots[s];
    }
    var mapped = (vehicles || []).map(function (v) {
      var sl = slotById[v.vehicle_id];
      if (sl) {
        var out = {};
        for (var k in v) out[k] = v[k];
        out.x = sl.x; out.z = sl.z;
        if (out.speed == null && v.speed_mph != null) out.speed = v.speed_mph;
        return out;
      }
      if (v.lat == null || v.lon == null || !proj || typeof project !== 'function') return v;
      var p = project(v.lat, v.lon);
      var out2 = {};
      for (var k2 in v) out2[k2] = v[k2];
      out2.x = p[0]; out2.z = p[1];
      if (out2.speed == null && v.speed_mph != null) out2.speed = v.speed_mph;
      return out2;
    });
    rideWidget.setVehicles(mapped);
  };
  // Real-time ride view (2026-10-15): while a bus is boarded, push its
  // tracker-predicted position to the widget every 5 s. The poll alone
  // refreshes the ride view once a minute; between polls the bus keeps
  // moving and its upcoming-stops list must advance with it. The widget
  // recomputes the vehicle's progress along its trip's stop sequence
  // from the pushed position on every push (RideAlong.updateVehicle ->
  // refresh): stops the bus has passed drop off, the next stop is
  // promoted, and the stop times are re-derived from the times
  // provider. No user interaction is involved. The guard makes the
  // interval a no-op unless a bus is boarded in Ride Along.
  function pushRidePosition() {
    if (!rideMode || !rideWidget || !rideWidget.currentVehicleId) return;
    var vid = rideWidget.currentVehicleId;
    for (var i = 0; i < busSlots.length; i++) {
      var sl = busSlots[i];
      if (sl.vehicle && sl.vehicle.vehicle_id === vid) {
        var rec = {};
        for (var k in sl.vehicle) rec[k] = sl.vehicle[k];
        rec.x = sl.x; rec.z = sl.z;
        if (rec.speed == null && sl.vehicle.speed_mph != null) rec.speed = sl.vehicle.speed_mph;
        rideWidget.updateVehicle(rec);
        return;
      }
    }
  }
  setInterval(function () { pushRidePosition(); }, 5000);

  function tripMiniLabel() {
    if (typeof tripJourneys !== 'undefined' && tripJourneys.length && tripJourneys[tripSel]) {
      var j = tripJourneys[tripSel];
      return j.durationMin + ' min · ' + j.departClock + ' → ' + j.arriveClock;
    }
    return 'Trip planner';
  }
  function refreshTripMini() {
    if ($('trip-card').classList.contains('min')) {
      $('trip-mini-label').textContent = tripMiniLabel();
    }
  }
  $('trip-min').addEventListener('click', function () {
    tapBuzz();
    $('trip-mini-label').textContent = tripMiniLabel();
    $('trip-mini').hidden = false;
    $('trip-card').classList.add('min');
  });
  $('trip-expand').addEventListener('click', function (e) {
    e.stopPropagation();
    tapBuzz();
    $('trip-card').classList.remove('min');
    $('trip-mini').hidden = true;
  });
  // The whole mini bar is tappable — easier to hit on a moving bus.
  $('trip-mini').addEventListener('click', function () {
    tapBuzz();
    $('trip-card').classList.remove('min');
    $('trip-mini').hidden = true;
  });
  $('trip-from-btn').addEventListener('click', function () { openTripSearch('from'); });
  $('trip-to-btn').addEventListener('click', function () { openTripSearch('to'); });
  $('trip-search-back').addEventListener('click', function () { showTripView('planner'); renderTripFields(); });
  $('trip-search-input').addEventListener('input', function (e) { renderTripSearchResults(e.target.value); });
  $('trip-swap').addEventListener('click', function () {
    tapBuzz();
    cancelTripFly();
    var f = tripFrom, t = tripTo;
    // A location origin can't become a destination; it yields its slot.
    tripFrom = (t && t.kind === 'stop') ? t : null;
    tripTo = (f && f.kind === 'stop') ? f : null;
    renderTripFields(); updateTripMarkers(); maybeReplan();
  });
  $('trip-now-btn').addEventListener('click', function () {
    tripLeaveMode = 'now'; tripLeaveTime = '';
    renderTripFields(); maybeReplan();
  });
  $('trip-time-input').addEventListener('change', function (e) {
    if (e.target.value) { tripLeaveMode = 'at'; tripLeaveTime = e.target.value; }
    else { tripLeaveMode = 'now'; tripLeaveTime = ''; }
    renderTripFields(); maybeReplan();
  });
  renderer.domElement.addEventListener('pointerdown', function () { cancelTripFly(); });

  // --- filters ---------------------------------------------------------------
  // filterState.routes[rid] is the ONLY visibility gate: any route can be
  // toggled on its own, no group header required. Group headers are bulk
  // setters (all on / all off); they never gate individual routes.
  // filterState.hideIdle (default ON): fully hide routes confirmed not-running.
  // filterState.nearMe: only routes with a stop within NEAR_ME_M of you.
  var filterState = { groups: {}, routes: {}, hideIdle: true, nearMe: false };
  var NEAR_ME_M = 1250;
  var nearMeSet = null;   // rid -> true, rebuilt when you move or toggle
  var userXZ = null;      // your projected position, set by onLocated
  var pendingNearMe = false;

  // True when the near-me filter lets this route through (or is off).
  function routeNearOk(rid) {
    return !filterState.nearMe || !!(nearMeSet && nearMeSet[rid]);
  }

  function routeIsOn(rid) {
    var r = routeById[rid];
    return !!(r && filterState.routes[rid]);
  }

  // 'all' | 'none' | 'mixed' — derived from the routes, never stored.
  function groupSelState(gid) {
    var rids = groupRoutes[gid] || [];
    if (!rids.length) return 'none';
    var on = 0;
    rids.forEach(function (rid) { if (filterState.routes[rid]) on++; });
    if (on === 0) return 'none';
    if (on === rids.length) return 'all';
    return 'mixed';
  }

  // Smart disabling: non-running routes are hidden when hideIdle is on,
  // dimmed when it is off. 'unknown' (pre-first-poll) never hides.
  function routeShown(rid) {
    if (!routeIsOn(rid)) return false;
    if (!routeNearOk(rid)) return false;
    // QLINE is exempt from hideIdle: the streetcar geometry should be visible
    // even when no streetcars are running (overnight, Sundays). The route
    // has a live feed; it just doesn't run 24/7.
    if (rid !== 'QLINE' && filterState.hideIdle && runningState[rid] === 'not-running') return false;
    return true;
  }

  function computeNearMe() {
    nearMeSet = {};
    if (!userXZ || !stopData) return;
    var r2 = NEAR_ME_M * NEAR_ME_M;
    for (var i = 0; i < stopData.length; i++) {
      var s = stopData[i];
      var dx = s.x - userXZ[0], dz = s.z - userXZ[1];
      if (dx * dx + dz * dz > r2) continue;
      for (var j = 0; j < s.r.length; j++) nearMeSet[s.r[j]] = true;
    }
    // Foundational rule: proximity wins. A route near the user is always
    // enabled — its group/route filter is switched on so near-me results are
    // actually drawn, not silently suppressed by an off toggle. Auto-enables
    // are tracked in nearMeAdded and reverted when near-me disengages, so a
    // temporary mode never permanently mutates the user's filter choices.
    Object.keys(nearMeSet).forEach(function (rid) {
      if (!filterState.routes[rid]) { filterState.routes[rid] = true; nearMeAdded[rid] = true; }
    });
  }

  var nearMeSnapshot = null; // filterState.routes copy taken when near-me engages
  var nearMeAdded = {};      // rids whose on-state is attributable to near-me

  function setNearMe(on) {
    filterState.nearMe = on;
    pendingNearMe = false;
    var t = $('nearme-toggle');
    if (t) t.setAttribute('aria-pressed', String(on));
    if (on) {
      nearMeSnapshot = {};
      routeOrder.forEach(function (rid) { nearMeSnapshot[rid] = !!filterState.routes[rid]; });
      nearMeAdded = {};
      computeNearMe();
    } else if (nearMeSnapshot) {
      Object.keys(nearMeAdded).forEach(function (rid) {
        filterState.routes[rid] = !!nearMeSnapshot[rid];
      });
      nearMeSnapshot = null;
      nearMeAdded = {};
    }
    applyFilters();
    syncFilterUI();
    refreshFilterCounts();
    if (on) {
      var n = nearMeSet ? Object.keys(nearMeSet).length : 0;
      showToast(n ? n + ' routes within ' + NEAR_ME_M + ' m of you.' : 'No routes within ' + NEAR_ME_M + ' m of you.', !n);
    } else {
      hideToast();
    }
  }

  function applyDim(rid) {
    var g = routeGroups[rid];
    if (!g || !g.userData.guideMats) return;
    // Honest rendering: only a route with a live bus on it right now renders
    // bright. 'unknown' (not yet confirmed by the feed) and 'not-running'
    // both dim — the map never implies a route is active before live data
    // proves it. ('not-running' is additionally hidden when hideIdle is on.)
    // Opacity composes with the street-view guideway fade (dimmed x faded).
    var dim = (runningState[rid] !== 'running' && g.visible) || itineraryDims(rid);
    g.userData.guideMats.forEach(function (e) {
      if (e.dimmed === dim) return; // unchanged: never touch the material (needsUpdate forces a shader recompile)
      e.dimmed = dim;
      syncGuideEntry(e);
    });
  }
  // Street-view guideway fade: the elevated layer cake (decks + solid skirts
  // + casing + ground glow) reads as walls at street level and buries the
  // stops and true-scale buses. In street view it eases to a whisper so the
  // street grid, stops, and buses carry the scene. The fade multiplies with
  // the running-state dimming; transparency flips only on real state changes
  // (shader recompiles are never per-frame).
  var streetGuideFade = 1, streetGuideFadeTarget = 1;
  var streetGlowMats = []; // per-route ground-glow materials (not dimmed by running state)
  function guideEntryOpacity(e) {
    return (e.dimmed ? DIM_OPACITY : e.opacity) * streetGuideFade;
  }
  function syncGuideEntry(e) {
    var wantTransparent = e.dimmed || streetGuideFade < 0.999;
    if (e.mat.transparent !== wantTransparent) {
      e.mat.transparent = wantTransparent;
      e.mat.needsUpdate = true;
    }
    e.mat.opacity = guideEntryOpacity(e);
  }
  function easeGuideFade() {
    var d = streetGuideFadeTarget - streetGuideFade;
    if (Math.abs(d) < 0.005) {
      if (streetGuideFade === streetGuideFadeTarget) return;
      streetGuideFade = streetGuideFadeTarget;
    } else {
      streetGuideFade += d * 0.12;
    }
    for (var ri = 0; ri < routeOrder.length; ri++) {
      var g = routeGroups[routeOrder[ri]];
      if (!g || !g.userData.guideMats) continue;
      g.userData.guideMats.forEach(syncGuideEntry);
    }
    // Shared casing + ground glows answer only to the street fade.
    if (typeof casingMat !== 'undefined' && casingMat) {
      casingMat.opacity = 0.9 * streetGuideFade;
    }
    for (var gi = 0; gi < streetGlowMats.length; gi++) {
      streetGlowMats[gi].opacity = 0.13 * streetGuideFade;
    }
  }

  // --- Street extension tier --------------------------------------------------
  // Street segments outside STREET_BOUNDS (Downriver, western suburbs) live
  // in streetExt, displayed only while the SMART filter group is displayed
  // (restored with the SMART reactivation, 2026-10-15).
  var streetExt = null;          // THREE.Group (assigned in buildStreets)
  var streetExtLocal = null;     // extension local tier (own LOD rule)
  var streetExtMats = [];        // {mat, baseOpacity} faded together
  var streetExtFade = 0, streetExtFadeTarget = 0;
  var streetExtFadeFrom = 0, streetExtFadeT0 = 0, streetExtFadeDur = 1;
  var STREET_EXT_FADE_MS = 900;
  // Called from applyFilters: starts (or reverses) the fade when the SMART
  // group's displayed state changes. Reversing mid-fade continues from the
  // current opacity — never a snap.
  function syncStreetExt() {
    if (!streetExt) return;
    var on = false;
    try { on = groupSelState('smart') !== 'none'; } catch (e) {}
    var target = on ? 1 : 0;
    if (target === streetExtFadeTarget) return;
    streetExtFadeFrom = streetExtFade;
    streetExtFadeTarget = target;
    streetExtFadeT0 = performance.now();
    // Duration scales with remaining distance: a full fade takes 900 ms,
    // a mid-fade reversal covers only what's left.
    streetExtFadeDur = Math.max(1, STREET_EXT_FADE_MS * Math.abs(target - streetExtFadeFrom));
    if (target === 1) streetExt.visible = true;
  }
  function stepStreetExtFade(now) {
    if (!streetExt || streetExtFade === streetExtFadeTarget) return;
    var t = Math.min(1, (now - streetExtFadeT0) / streetExtFadeDur);
    // Minimum-jerk easing: the same rest-to-rest profile as the camera glide.
    var e = t * t * t * (t * (t * 6 - 15) + 10);
    streetExtFade = streetExtFadeFrom + (streetExtFadeTarget - streetExtFadeFrom) * e;
    for (var i = 0; i < streetExtMats.length; i++) {
      var m = streetExtMats[i];
      m.mat.opacity = m.baseOpacity * streetExtFade;
    }
    if (t >= 1) {
      streetExtFade = streetExtFadeTarget;
      // Perf: fully faded-out geometry leaves the render path entirely.
      if (streetExtFadeTarget === 0) streetExt.visible = false;
    }
  }

  function applyFilters() {
    routeOrder.forEach(function (rid) {
      if (routeGroups[rid]) routeGroups[rid].visible = routeShown(rid);
      applyDim(rid);
    });
    groupOrder.forEach(function (gid) {
      if (groupObjs[gid]) groupObjs[gid].visible = groupSelState(gid) !== 'none';
    });
    rebuildStops();
    if (lastVehicles) updateBuses(lastVehicles);
    refreshHeaderCount();
    syncStreetExt();
    // Announce filter changes through #sr-status, but only when the number
    // of shown routes actually changes — applyFilters also runs on every
    // live poll, and repeating an unchanged count would spam screen readers.
    // The first call just records the baseline shown count.
    var _shownNow = 0;
    routeOrder.forEach(function (rid) { if (routeShown(rid)) _shownNow++; });
    if (_srFilterShown !== null && _shownNow !== _srFilterShown) {
      announceSr(_shownNow + (_shownNow === 1 ? ' route' : ' routes') + ' shown on the map.');
    }
    _srFilterShown = _shownNow;
  }

  function syncFilterUI() {
    groupOrder.forEach(function (gid) {
      var st = groupSelState(gid);
      var check = document.querySelector('.f-group-head[data-group="' + gid + '"] .f-check');
      var sec = document.querySelector('.f-group[data-group="' + gid + '"]');
      if (check) check.setAttribute('aria-pressed', st === 'mixed' ? 'mixed' : String(st === 'all'));
      if (sec) sec.classList.toggle('off', st === 'none');
    });
    routeOrder.forEach(function (rid) {
      var b = document.querySelector('.f-chip[data-route="' + rid + '"]');
      if (b) b.setAttribute('aria-pressed', String(!!filterState.routes[rid]));
    });
    var idle = $('hide-idle-toggle');
    if (idle) idle.setAttribute('aria-pressed', String(!!filterState.hideIdle));
    var pmT = $('pm-toggle');
    if (pmT) pmT.setAttribute('aria-pressed', String(!!pmVisible));
    var mgT = $('mogo-toggle');
    if (mgT && typeof mogoVisible !== 'undefined') mgT.setAttribute('aria-pressed', String(mogoVisible));
  }

  function buildFilterPanel(groups) {
    var host = $('filter-groups');
    host.innerHTML = '';
    groups.forEach(function (g) {
      // Calm default: only the ConnectTen core network is on. The panel
      // opens as an accordion (3 rows); route chips expand per group.
      var gOn = (g.id === 'connect-ten');
      var gLabel = g.name;
      // SMART (reactivated 2026-10-15): labeled beta, default OFF until
      // the rider enables it, persisted across sessions. Suburban
      // scale (45 routes) would bury the Detroit default view if it
      // started on.
      if (g.id === 'smart') {
        gLabel = g.name + ' (beta)';
        try { gOn = localStorage.getItem('lt-smart-on') === '1'; } catch (e) { gOn = false; }
      }
      filterState.groups[g.id] = gOn;
      var sec = document.createElement('div');
      sec.className = 'f-group';
      sec.dataset.group = g.id;
      var head = document.createElement('div');
      head.className = 'f-group-head';
      head.dataset.group = g.id;
      var check = document.createElement('button');
      check.className = 'f-check';
      check.setAttribute('aria-label', 'Toggle all ' + gLabel + ' routes');
      check.innerHTML = '<span class="f-box"></span>';
      check.addEventListener('click', function () {
        var on = groupSelState(g.id) !== 'all'; // all-on -> switch off; else switch on
        filterState.groups[g.id] = on;
        if (g.id === 'smart') { try { localStorage.setItem('lt-smart-on', on ? '1' : '0'); } catch (e) {} }
        g.routes.forEach(function (rid) { filterState.routes[rid] = on; delete nearMeAdded[rid]; });
        applyFilters();
        syncFilterUI();
      });
      var label = document.createElement('button');
      label.className = 'f-label';
      label.setAttribute('aria-expanded', 'false');
      label.setAttribute('aria-label', 'Expand ' + gLabel + ' routes');
      label.innerHTML = '<b>' + gLabel + '</b>' +
        (g.id === 'smart' ? '<span class="f-count" id="smart-age-label"></span>' : '') +
        '<span class="f-count" id="fgc-' + g.id + '">–</span>' +
        '<span class="f-chev">▾</span>';
      label.addEventListener('click', function () {
        var open = sec.classList.toggle('open');
        label.setAttribute('aria-expanded', String(open));
      });
      head.appendChild(check);
      head.appendChild(label);
      var list = document.createElement('div');
      list.className = 'f-routes';
      g.routes.slice().sort(function (a, b) {
        // Name-alphabetical within the group (convention, 2026-10-11);
        // the data files list routes in numeric order.
        return routeLabel(a).localeCompare(routeLabel(b));
      }).forEach(function (rid) {
        var route = routeById[rid];
        if (!route) return;
        filterState.routes[rid] = gOn;
        var b = document.createElement('button');
        b.className = 'route-chip f-chip';
        b.setAttribute('aria-pressed', 'true');
        b.dataset.route = rid;
        // Route display name: "name - number" unless they're identical (QLINE).
        var chipName = routeLabel(rid);
        b.innerHTML = '<i style="background:' + route.color + '"></i><b>' +
          chipName + '</b><span class="cnt" id="cnt-' + rid + '">–</span>' +
          '<span class="idle-tag" id="idle-' + rid + '" hidden>not running</span>';
        b.addEventListener('click', function () {
          filterState.routes[rid] = !filterState.routes[rid];
          delete nearMeAdded[rid]; // user's explicit choice now owns this route
          applyFilters();
          syncFilterUI();
        });
        list.appendChild(b);
      });
      sec.appendChild(head);
      sec.appendChild(list);
      if (g.id === 'smart') {
        // S6/S9: the beta note carries the derived route count and the
        // live source; the freshness sentence (smart-age-note) is set
        // by applySmartAgeUI and stays empty while the feed is fresh.
        var betaNote = document.createElement('p');
        betaNote.className = 'f-beta-note';
        betaNote.textContent = 'Beta: all ' + g.routes.length + ' routes have map lines. Vehicle positions via Swiftly GTFS-Realtime.';
        var smartAgeNote = document.createElement('span');
        smartAgeNote.id = 'smart-age-note';
        betaNote.appendChild(smartAgeNote);
        sec.appendChild(betaNote);
      }
      host.appendChild(sec);
    });
    applySmartAgeUI();
    $('filter-all').addEventListener('click', function () {
      // "Show all" means all: the near-me proximity restriction must not
      // override it, so near-me is switched off first.
      if (filterState.nearMe) setNearMe(false);
      groupOrder.forEach(function (gid) { filterState.groups[gid] = true; });
      routeOrder.forEach(function (rid) { filterState.routes[rid] = true; });
      try { localStorage.setItem('lt-smart-on', '1'); } catch (e) {}
      applyFilters();
      syncFilterUI();
    });
    $('filter-none').addEventListener('click', function () {
      // Symmetric case: "All off" must not be undone by the near-me
      // auto-enable on the next location update.
      if (filterState.nearMe) setNearMe(false);
      groupOrder.forEach(function (gid) { filterState.groups[gid] = false; });
      routeOrder.forEach(function (rid) { filterState.routes[rid] = false; });
      try { localStorage.setItem('lt-smart-on', '0'); } catch (e) {}
      applyFilters();
      syncFilterUI();
    });
    $('hide-idle-toggle').addEventListener('click', function () {
      filterState.hideIdle = !filterState.hideIdle;
      applyFilters();
      syncFilterUI();
    });
    $('nearme-toggle').addEventListener('click', function () {
      if (filterState.nearMe) { setNearMe(false); return; }
      if (userXZ) { setNearMe(true); return; }
      // No fix yet: run the locate flow; it enables near-me on success.
      pendingNearMe = true;
      locateBtn.click();
    });
    // People Mover static layer: independent of the DDOT route filters —
    // "Show all"/"All off" and near-me never touch it. Own toggle, own state.
    var pmT = $('pm-toggle');
    if (pmT) pmT.addEventListener('click', function () {
      pmVisible = !pmVisible;
      if (pmGroup) pmGroup.visible = pmVisible;
      pmT.setAttribute('aria-pressed', String(pmVisible));
      if (!pmVisible && selectedStop && selectedStop.pm) hideStop();
    });
  }

  // --- People Mover: stations + downtown loop (static) -------------------------
  // Source: Detroit People Mover GTFS static (agency permalink), projected
  // with the same lat0/lon0 as ddot-routes-3d.json so geometry aligns.
  // Visual language: Concrete #9AA0A6 deck (reads as infrastructure, distinct
  // from the saturated live-route colors), paper-white station pins, narrow
  // 14 m single-track guideway (automated, one direction — not a bus corridor).
  // Elevated at PM_DECK_Y with open air beneath: no continuous skirt, pillars
  // only at stations, so ground-level stops, buses and buildings stay visible.
  // Off by default; the pm-toggle enables it. Nothing here implies
  // live vehicles: no beacons, no "LIVE" marker, and the filter-panel note
  // states the static provenance outright.
  function buildPeopleMover(pm) {
    // Pseudo-route registration so the shared stop card renders a proper
    // chip ("DPM · Detroit People Mover"). Kept OUT of routeOrder: the
    // DDOT filter/dim/near-me machinery must never touch this layer.
    routeColors['DPM'] = new THREE.Color(0x9AA0A6);
    routeNames['DPM'] = 'Detroit People Mover';

    pmGroup = new THREE.Group();
    pmGroup.name = 'people-mover';
    var concrete = new THREE.Color(0x9AA0A6);
    var deckMat = new THREE.MeshLambertMaterial({ color: concrete, side: THREE.DoubleSide });
    var skirtMat = new THREE.MeshLambertMaterial({ color: concrete.clone().multiplyScalar(0.35), side: THREE.DoubleSide });
    var loop = pm.loop.slice();
    // Single-track elevated guideway, 14 m wide: narrow enough that street-level
    // endpoints (stops, buses, buildings) stay visible beneath it. No continuous
    // skirt — the solid wall obscured ground objects. Support pillars render
    // ONLY at station locations (the known points), not as invented infill.
    pmGroup.add(new THREE.Mesh(ribbonGeometry(loop, 14, PM_DECK_Y), deckMat));
    var pillarGeo = new THREE.CylinderGeometry(6, 9, PM_DECK_Y, 10);
    var pillarMat = new THREE.MeshLambertMaterial({ color: concrete.clone().multiplyScalar(0.55) });

    var pinGeo = new THREE.CylinderGeometry(24, 32, 300, 12);
    var pinMat = new THREE.MeshLambertMaterial({ color: 0xF5F2EA });
    var ringGeo = new THREE.RingGeometry(40, 64, 32);
    var ringMat = new THREE.MeshBasicMaterial({ color: 0xF5F2EA, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false });
    pmStations = pm.stations.map(function (s) {
      var pin = new THREE.Mesh(pinGeo, pinMat);
      pin.position.set(s.x, PM_DECK_Y + 150, s.z);
      pmGroup.add(pin);
      pmPins.push(pin);
      var pillar = new THREE.Mesh(pillarGeo, pillarMat);
      pillar.position.set(s.x, PM_DECK_Y / 2, s.z);
      pmGroup.add(pillar);
      var ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(s.x, PM_DECK_Y + 3, s.z);
      pmGroup.add(ring);
      return { id: s.id, n: s.name, x: s.x, z: s.z, r: ['DPM'], pm: true };
    });

    var mid = loop[Math.floor(loop.length / 2)];
    pmLabel = makeLabel('People Mover · Downtown Loop', '#9AA0A6');
    pmLabel.position.set(mid[0], 1050, mid[1]);
    pmGroup.add(pmLabel);
    pmTether = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(mid[0], PM_DECK_Y, mid[1]),
        new THREE.Vector3(mid[0], 980, mid[1])
      ]),
      new THREE.LineBasicMaterial({ color: 0x9AA0A6, transparent: true, opacity: 0.45 })
    );
    pmGroup.add(pmTether);
    pmGroup.visible = pmVisible;
    scene.add(pmGroup);
  }

  // Belle Isle landmass: true-form OSM island outline (assets/belle-isle.json).
  // Route 12 serves the island, but the uniform dark ground rendered no island
  // at all. Filled polygon at y=3 (above ground, below the street tiers),
  // dark park-green with a shoreline stroke, plus a floating place label.
  // Optional layer: absent file = no island, map otherwise unaffected.
  function buildBelleIsle(B) {
    if (!B || !B.polygon || B.polygon.length < 3) return;
    var contour = [];
    for (var i = 0; i < B.polygon.length; i++) {
      contour.push(new THREE.Vector2(B.polygon[i][0], B.polygon[i][1]));
    }
    var faces = THREE.ShapeUtils.triangulateShape(contour, []);
    var pos = [];
    for (var f = 0; f < faces.length; f++) {
      for (var k = 0; k < 3; k++) {
        var v = contour[faces[f][k]];
        pos.push(v.x, 0, v.y);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    var island = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x15211b }));
    island.position.y = 3;
    island.renderOrder = 1;
    scene.add(island);
    var shorePts = [];
    for (var s = 0; s < B.polygon.length; s++) {
      shorePts.push(new THREE.Vector3(B.polygon[s][0], 4, B.polygon[s][1]));
    }
    var shore = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(shorePts),
      new THREE.LineBasicMaterial({ color: 0x33523f, transparent: true, opacity: 0.9 })
    );
    shore.renderOrder = 2;
    scene.add(shore);
    var lx = B.label ? B.label.x : 14015, lz = B.label ? B.label.z : 4478;
    belleIsleLabel = makeLabel('Belle Isle', '#9db89a');
    belleIsleLabel.position.set(lx, 560, lz);
    belleIsleLabel.renderOrder = 36;
    scene.add(belleIsleLabel);
    belleIsleTether = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(lx, 4, lz),
        new THREE.Vector3(lx, 490, lz)
      ]),
      new THREE.LineBasicMaterial({ color: 0x9db89a, transparent: true, opacity: 0.4 })
    );
    scene.add(belleIsleTether);
  }

  // Screen-space nearest station (mirrors the stop touch fallback: forgiving
  // at far zooms, tighter for mouse). The pins are small; raycasting them
  // would be fiddly, so proximity picking is the primary path for both.
  var _pmV3 = new THREE.Vector3();
  function pickPMStation(cx, cy, isTouch) {
    if (!pmGroup || !pmGroup.visible || !pmStations.length) return null;
    var r = renderer.domElement.getBoundingClientRect();
    var sx = cx - r.left, sy = cy - r.top;
    var best = null, bestD = isTouch ? 48 : 26;
    for (var i = 0; i < pmStations.length; i++) {
      var s = pmStations[i];
      _pmV3.set(s.x, PM_DECK_Y + 150, s.z).project(camera);
      if (_pmV3.z > 1) continue;
      var px = (_pmV3.x * 0.5 + 0.5) * r.width;
      var py = (-_pmV3.y * 0.5 + 0.5) * r.height;
      var d = Math.hypot(px - sx, py - sy);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  var _filterReturnFocus = null;
  function togglePanel(force) {
    var panel = $('filter-panel');
    var btn = $('filter-btn');
    var show = (typeof force === 'boolean') ? force : panel.hidden;
    var wasHidden = panel.hidden;
    if (show && wasHidden) exclCover('filter');
    panel.hidden = !show;
    btn.setAttribute('aria-expanded', String(show));
    if (show && wasHidden) {
      // Move focus into the panel on open: remember the opener, then
      // focus the first control (Show all).
      if (document.activeElement && !panel.contains(document.activeElement)) _filterReturnFocus = document.activeElement;
      var first = $('filter-all');
      if (first) first.focus();
    } else if (!show && !wasHidden) {
      // Return focus to the opener on close when focus was inside the
      // panel (Escape via the document handler calls togglePanel(false));
      // fall back to the Routes button so focus is not lost to <body>.
      var hadFocus = panel.contains(document.activeElement);
      if (hadFocus && _filterReturnFocus && _filterReturnFocus !== document.body && document.contains(_filterReturnFocus)) _filterReturnFocus.focus();
      else if (hadFocus) btn.focus();
      _filterReturnFocus = null;
      exclRestore();
    }
  }

  // --- header badge ------------------------------------------------------------
  var liveEverOk = false;
  var historyOk = false;
  var lastTotal = null;

  function fmtTime(when) {
    return (when && !isNaN(when)) ? when.toLocaleTimeString() : '–';
  }

  var lastHeaderText = '', lastHeaderWarn = false;
  function setHeader(total, text, warn) {
    lastHeaderText = text; lastHeaderWarn = !!warn;
    $('bus-total').textContent = (total != null) ? total : '–';
    var el = $('bus-updated');
    el.textContent = text;
    el.title = text || '';
    el.className = warn ? 'feed-warn' : '';
  }
  // The header count must follow filters immediately — a toggle that
  // empties the map while the header still claims "13 buses" is a lie.
  function refreshHeaderCount() {
    if (!lastVehicles) return;
    setHeader(busSlots.length, lastHeaderText, lastHeaderWarn);
  }

  function updateCounts() {
    routeOrder.forEach(function (rid) {
      var el = $('cnt-' + rid);
      if (el) el.textContent = String(liveCounts[rid] || 0);
      var nr = runningState[rid] === 'not-running';
      var chip = document.querySelector('.f-chip[data-route="' + rid + '"]');
      if (chip) chip.classList.toggle('not-running', nr);
      var tag = $('idle-' + rid);
      if (tag) tag.hidden = !nr;
    });
    groupOrder.forEach(function (gid) {
      var el = $('fgc-' + gid);
      if (!el) return;
      if (!liveEverOk) { el.textContent = '–'; return; }
      var run = 0, shownNear = 0, nearTot = 0;
      var tot = (groupRoutes[gid] || []).length;
      (groupRoutes[gid] || []).forEach(function (rid) {
        if (runningState[rid] === 'running') run++;
        if (filterState.nearMe && nearMeSet && nearMeSet[rid]) {
          nearTot++;
          if (routeShown(rid)) shownNear++;
        }
      });
      // When near-me is on, say what is actually on the map — the global
      // "N of M running" no longer describes the view.
      el.textContent = filterState.nearMe
        ? shownNear + ' of ' + tot + ' shown near you'
        : run + ' of ' + tot + ' running';
    });
  }

  // Near-me scope label on the toggle itself, kept fresh wherever the
  // near set changes (toggle, locate, poll).
  function refreshFilterCounts() {
    updateCounts();
    var sub = $('nearme-sub');
    if (sub) {
      var n = (filterState.nearMe && nearMeSet) ? Object.keys(nearMeSet).length : 0;
      sub.textContent = NEAR_ME_M + ' m' + (filterState.nearMe ? ' · ' + n + ' near you' : '');
    }
  }

  var groupRoutes = {}; // gid -> [route ids]
  var lastVehicles = null;

  // Recompute per-route running state from the latest live counts.
  // Returns true if any route flipped between running/not-running.
  // Running-state engine. Asymmetric by design: a visible bus means
  // 'running' immediately (certain); a disappearance needs 3 quiet polls
  // (~3 minutes — uncertain, could be a feed gap or a between-buses lull).
  // A route is never assumed dead on load: with zero buses seen it stays
  // 'unknown' (which never hides or dims) until 3 consecutive polls come
  // back empty. Burying a scheduled route on a single empty snapshot —
  // e.g. page loaded between buses — was the old first-poll shortcut.
  function updateRunningState() {
    var changed = false;
    routeOrder.forEach(function (rid) {
      var buses = liveCounts[rid] || 0;
      if (buses > 0) {
        quietStreak[rid] = 0;
        if (runningState[rid] !== 'running') { runningState[rid] = 'running'; changed = true; }
      } else {
        quietStreak[rid] = (quietStreak[rid] || 0) + 1;
        if (quietStreak[rid] >= 3 && runningState[rid] !== 'not-running') {
          runningState[rid] = 'not-running'; changed = true;
        }
      }
    });
    return changed;
  }

  // Raw per-route bus counts from the live feed, BEFORE any visibility
  // filtering. The running-state engine must see the street, not the render:
  // counting only visible routes meant a hidden route could never recover,
  // and user filtering ("All off") falsely marked running routes not-running.
  function countByRoute(vehicles) {
    var m = {};
    for (var i = 0; i < vehicles.length; i++) {
      var v = vehicles[i];
      if (v.lat == null || v.lon == null) continue;
      if (!routeById[v.route_id]) continue;
      m[v.route_id] = (m[v.route_id] || 0) + 1;
    }
    return m;
  }

  // --- per-vehicle motion prediction -----------------------------------------
  // The feed polls every 60 s; between polls each bus dead-reckons along its
  // route's GTFS shape using the feed's own speed_mph, map-matched per fix.
  // Deterministic inputs: poll fixes, reported speed, reported bearing, and
  // the shape geometry (buses can't leave their path). Small fix divergences
  // ease in over ~2 s; teleports (>200 m) snap. Honest limits: no public
  // Detroit traffic-signal feed exists — a red light reads as speed 0 (hold,
  // never drift); arterial congestion is already encoded in the bus's own
  // reported speed, so no second feed is fused. A fix >150 m off every shape
  // is rendered raw (detour) with prediction suspended until it re-matches.
  var busTrackers = {};   // vehicle_id -> tracker (persists across polls)
  var shapeArcCache = {}; // route_id -> [{pts, cum, len}]
  var lastPollT = 0;      // performance.now() of the previous poll (for observations)
  var pollSeq = 0;        // increments per poll; trackers record their birth poll
  var MPH_TO_MPS = 0.44704;
  var PREDICT_HORIZON_S = 150; // never dead-reckon on a fix older than this
  var SNAP_DIST_M = 200;       // along-track divergence above this = teleport
  var OFFSHAPE_M = 150;        // cross-track beyond this = detour, render raw
  // Kalman filter noise model. R = GPS measurement variance (15m sigma).
  // Q_* are process-noise densities; replaced by Bayesian timing-cell
  // posteriors when telemetry-math/bayesian_cells.py lands in the pipeline.
  var KALMAN_R = 225, KALMAN_Q_POS = 2.0, KALMAN_Q_VEL = 0.5;

  function shapeArcs(routeId) {
    var hit = shapeArcCache[routeId];
    if (hit !== undefined) return hit;
    var r = routeById[routeId];
    var arcs = [];
    if (r && r.paths) {
      for (var pi = 0; pi < r.paths.length; pi++) {
        var pts = r.paths[pi];
        if (!pts || pts.length < 2) continue;
        var cum = [0];
        for (var i = 1; i < pts.length; i++) {
          cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
        }
        arcs.push({ pts: pts, cum: cum, len: cum[cum.length - 1] });
      }
    }
    shapeArcCache[routeId] = arcs.length ? arcs : null;
    return shapeArcCache[routeId];
  }

  function pointAt(arc, s) {
    s = Math.max(0, Math.min(arc.len, s));
    var cum = arc.cum, pts = arc.pts;
    var lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    var segLen = (cum[hi] - cum[lo]) || 1;
    var t = (s - cum[lo]) / segLen;
    var ax = pts[lo][0], az = pts[lo][1];
    var dx = pts[hi][0] - ax, dz = pts[hi][1] - az;
    var dl = Math.hypot(dx, dz) || 1;
    return { x: ax + dx * t, z: az + dz * t, dx: dx / dl, dz: dz / dl };
  }

  // Nearest point on one arc: arc-length, cross-track distance, direction.
  function nearestOnArc(arc, x, z) {
    var pts = arc.pts, cum = arc.cum;
    var bDist = Infinity, bS = 0, bDx = 1, bDz = 0;
    for (var i = 0; i < pts.length - 1; i++) {
      var ax = pts[i][0], az = pts[i][1];
      var dx = pts[i + 1][0] - ax, dz = pts[i + 1][1] - az;
      var l2 = dx * dx + dz * dz;
      var t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      var d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
      if (d < bDist) {
        bDist = d; bS = cum[i] + Math.sqrt(l2) * t;
        var dl = Math.sqrt(l2) || 1; bDx = dx / dl; bDz = dz / dl;
      }
    }
    return { s: bS, dist: bDist, dx: bDx, dz: bDz };
  }

  // Map-match a fix to (path, arc-length). Bearing disambiguates overlapping
  // outbound/inbound paths; the previous match lends continuity.
  function matchFix(routeId, x, z, bearingDeg, prev) {
    var arcs = shapeArcs(routeId);
    if (!arcs) return null;
    var bwx = 0, bwz = 0;
    var hasB = (bearingDeg != null && !isNaN(bearingDeg));
    if (hasB) {
      var br = bearingDeg * DEG;
      bwx = Math.sin(br) * proj.mLon; bwz = -Math.cos(br) * proj.mLat;
      var bl = Math.hypot(bwx, bwz) || 1; bwx /= bl; bwz /= bl;
    }
    var best = null;
    for (var pi = 0; pi < arcs.length; pi++) {
      var nb = nearestOnArc(arcs[pi], x, z);
      var dot = hasB ? (bwx * nb.dx + bwz * nb.dz) : 0;
      var score = nb.dist - 80 * Math.max(0, dot);
      if (prev && prev.pathIdx === pi && Math.abs(nb.s - prev.s) < 400) score -= 50;
      if (!best || score < best.score) {
        best = { score: score, pathIdx: pi, s: nb.s, dist: nb.dist, arc: arcs[pi] };
      }
    }
    return best;
  }

  // Advance every tracker's dead reckoning and push the predicted positions
  // into slots, badges, and true-scale models. Runs every frame; cheap.
  var lastMotionT = 0;
  function updateBusMotion(now) {
    if (!busSlots.length) return;
    var dt = lastMotionT ? Math.min(0.1, (now - lastMotionT) / 1000) : 0;
    lastMotionT = now;
    if (dt <= 0) return;
    var anyMoved = false;
    for (var i = 0; i < busSlots.length; i++) {
      var sl = busSlots[i], tr = sl.tracker;
      if (!tr || !tr.arc) continue;
      var moved = false;
      var ageS = (now - tr.fixT) / 1000;
      if (ageS < PREDICT_HORIZON_S && tr.kInit) {
        // Kalman predict: constant-velocity model, F = [[1,dt],[0,1]].
        // The empirical segment speed enters as a velocity prior (the old
        // mean-reversion, now inside the filter instead of beside it).
        if (!tr.seg || tr.segPath !== tr.pathIdx || tr.kS < tr.seg.s0 || tr.kS > tr.seg.s1) {
          tr.seg = segmentAt(tr.routeId, tr.pathIdx, tr.kS);
          tr.segPath = tr.pathIdx;
        }
        var v0 = tr.speedMps;
        var vEmp = empiricalSpeed(tr.routeId, tr.seg);
        var vPrior = (vEmp != null && vEmp < v0) ? vEmp : v0;
        // Ease the velocity state toward the prior (never invent accel).
        tr.kV += (vPrior - tr.kV) * (1 - Math.exp(-dt / REVERT_TAU_S));
        tr.kS += tr.kV * dt;
        // Covariance predict: P = F*P*F' + Q*dt.
        var p00 = tr.kP, p01 = tr.kPvS, p11 = tr.kPv;
        tr.kP = p00 + 2 * dt * p01 + dt * dt * p11 + KALMAN_Q_POS * dt;
        tr.kPvS = p01 + dt * p11;
        tr.kPv = p11 + KALMAN_Q_VEL * dt;
        if (Math.abs(tr.kV) > 0.3 || tr.kP > KALMAN_R * 4) {
          tr.s = Math.max(0, Math.min(tr.arc.len, tr.kS));
          moved = true;
        }
      }
      if (moved) {
        anyMoved = true;
        var pt = pointAt(tr.arc, tr.s);
        sl.x = pt.x; sl.z = pt.z;
        sl.rotY = Math.atan2(-pt.dz, pt.dx);
        var sp = badgePool[i];
        if (sp && sp.visible) { sp.position.x = pt.x; sp.position.z = pt.z; }
        // Uncertainty halo: radius = 3σ of the position variance, clamped.
        // Grows between fixes, collapses on the Kalman update — the honest
        // rendering of "we're less sure where this bus is."
        sl.haloR = Math.max(15, Math.min(150, 3 * Math.sqrt(Math.max(tr.kP, 1))));
      }
    }
    if (!anyMoved) return;
    if (!busMode) {
      for (var m = 0; m < busSlots.length; m++) writeBusMatrices(m, busSlots[m], 1);
      pillarMeshes.forEach(function (im) { im.instanceMatrix.needsUpdate = true; });
    } else {
      var dn = Math.min(busSlots.length, DETAIL_MAX);
      for (var di = 0; di < dn; di++) {
        var d = detailPool[di];
        if (d && d.group.visible) {
          d.group.position.set(busSlots[di].x, 0, busSlots[di].z);
          d.group.rotation.y = busSlots[di].rotY;
        }
      }
    }
  }

  // --- empirical motion prior ------------------------------------------------
  // Teaches the predictor which segments habitually run slow, so it stops
  // overshooting into red lights and dwells. One key space —
  // route|from_stop|to_stop — fed by two sources:
  //   1. Telemetry timing cells (canonical, multi-day aggregates), fetched
  //      hourly from the telemetry repo. No-ops until cells mature.
  //   2. Local speed map: learned live from the 60 s poll stream, EMA per
  //      segment, persisted to localStorage. Works today.
  // The predictor only ever revises DOWNWARD toward the empirical speed: a
  // cruising bus keeps its reported speed; a fast-reported bus entering a
  // habitually slow segment decays toward the segment mean. Never invents
  // acceleration — the worst case stays a smaller overshoot, never a phantom.
  var REVERT_TAU_S = 45;      // reported speed's trust half-life, seconds
  var LOCAL_FRESH_MS = 2 * 3600 * 1000; // local observations older than this are ignored
  var segTableCache = {};     // routeId -> [{from, to, s0, s1, pathIdx}]
  var stopsByRouteCache = {};
  var localSegs = {};         // "route|from|to" -> {v, t, n}
  var timingCells = null;     // telemetry segments.json (null until fetched)
  var speedmapSaveT = 0;

  function stopsByRoute(routeId) {
    var hit = stopsByRouteCache[routeId];
    if (hit) return hit;
    var out = [];
    for (var i = 0; i < stopData.length; i++) {
      var st = stopData[i];
      if (st.r && st.r.indexOf(routeId) !== -1) out.push(st);
    }
    stopsByRouteCache[routeId] = out;
    return out;
  }

  // Order each route's stops along its shape arcs -> stop-pair segments.
  function routeSegments(routeId) {
    var hit = segTableCache[routeId];
    if (hit) return hit;
    var segs = [];
    var arcs = shapeArcs(routeId);
    var stops = stopsByRoute(routeId);
    if (arcs && stops.length) {
      var perPath = arcs.map(function () { return []; });
      stops.forEach(function (st) {
        var best = null;
        for (var pi = 0; pi < arcs.length; pi++) {
          var nb = nearestOnArc(arcs[pi], st.x, st.z);
          if (nb.dist < 120 && (!best || nb.dist < best.dist)) {
            best = { pathIdx: pi, s: nb.s, dist: nb.dist };
          }
        }
        if (best) perPath[best.pathIdx].push({ id: st.id, s: best.s });
      });
      perPath.forEach(function (list, pi) {
        list.sort(function (a, b) { return a.s - b.s; });
        for (var i = 0; i + 1 < list.length; i++) {
          if (list[i + 1].s - list[i].s < 5) continue;
          segs.push({ from: list[i].id, to: list[i + 1].id, s0: list[i].s, s1: list[i + 1].s, pathIdx: pi });
        }
      });
    }
    segTableCache[routeId] = segs;
    return segs;
  }

  function segmentAt(routeId, pathIdx, s) {
    var segs = routeSegments(routeId);
    for (var i = 0; i < segs.length; i++) {
      var g = segs[i];
      if (g.pathIdx === pathIdx && s >= g.s0 && s <= g.s1) return g;
    }
    var best = null; // past the last stop: nearest upcoming segment
    for (var j = 0; j < segs.length; j++) {
      var h = segs[j];
      if (h.pathIdx !== pathIdx || h.s1 < s) continue;
      if (!best || h.s0 < best.s0) best = h;
    }
    return best;
  }

  function observeSegment(routeId, seg, obsV) {
    var key = routeId + '|' + seg.from + '|' + seg.to;
    var e = localSegs[key];
    var nowMs = Date.now();
    if (!e) localSegs[key] = { v: obsV, t: nowMs, n: 1 };
    else { e.v = e.v * 0.85 + obsV * 0.15; e.t = nowMs; e.n++; }
    if (nowMs - speedmapSaveT > 5 * 60 * 1000) {
      speedmapSaveT = nowMs;
      try { localStorage.setItem('fl-speedmap-v1', JSON.stringify(localSegs)); } catch (err) {}
    }
  }

  function loadSpeedmap() {
    try {
      var raw = localStorage.getItem('fl-speedmap-v1');
      if (raw) {
        var d = JSON.parse(raw);
        if (d && typeof d === 'object') localSegs = d;
      }
    } catch (err) {}
  }

  function detroitBucket(d) {
    d = d || new Date();
    var wd = null, hr = null;
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Detroit', weekday: 'short', hour: 'numeric', hourCycle: 'h23'
    }).formatToParts(d).forEach(function (p) {
      if (p.type === 'weekday') wd = p.value;
      if (p.type === 'hour') hr = parseInt(p.value, 10);
    });
    if (wd === 'Sat') return 'sat';
    if (wd === 'Sun') return 'sun';
    if (hr >= 6 && hr < 9) return 'wkd_am';
    if (hr >= 9 && hr < 15) return 'wkd_mid';
    if (hr >= 15 && hr < 19) return 'wkd_pm';
    if (hr >= 19 && hr < 24) return 'wkd_eve';
    return 'wkd_night';
  }

  function fetchTimingCells() {
    fetch('https://raw.githubusercontent.com/smit4786/forge-line-transit-data/main/data/timing/segments.json',
      { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (d) {
        // segments.json is a document envelope {schema, built_at, cells, segments};
        // the flat cell map lives under `segments`.
        timingCells = (d && d.segments && typeof d.segments === 'object') ? d.segments : null;
      })
      .catch(function () { /* keep the previous cache; the local map covers */ });
  }

  // Empirical speed (m/s) for a route segment, or null when unknown.
  // Telemetry cells (mature, bucketed) outrank the local map (recent, EMA).
  function empiricalSpeed(routeId, seg) {
    if (!seg) return null;
    var base = routeId + '|' + seg.from + '|' + seg.to;
    if (timingCells) {
      var cell = timingCells[base + '|' + detroitBucket()];
      if (cell && cell.n >= 3 && cell.mean_s > 0 && cell.dist_m > 0) {
        return cell.dist_m / cell.mean_s;
      }
    }
    var loc = localSegs[base];
    if (loc && loc.v > 0.2 && (Date.now() - loc.t) < LOCAL_FRESH_MS) return loc.v;
    return null;
  }

  // --- Phase 2b-i: live delay propagation --------------------------------------
  // Per poll, match live vehicles to scheduled trips and measure delays.
  // Client-side, honest: a clear margin or no match. Matched trips get their
  // remaining times shifted (clamped); disrupted trips are flagged, never
  // shifted. Three quiet polls and the match reverts to scheduled.
  var tripDelayState = new Map(); // trip object -> {delaySec, vehicleId, misses, disrupted}
  var stopArcCache = {};          // routeId|pathIdx -> {stopId: arc s}
  var ttRouteIdxById = null;      // built per timetable
  var lastEmpiricalRun = 0;

  function detroitParts(whenMs) {
    var o = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Detroit', year: 'numeric', month: 'numeric', day: 'numeric',
      weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23'
    }).formatToParts(new Date(whenMs)).forEach(function (p) { o[p.type] = p.value; });
    return {
      ymd: o.year + String(o.month).padStart(2, '0') + String(o.day).padStart(2, '0'),
      dow: { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[o.weekday],
      sec: (+o.hour) * 3600 + (+o.minute) * 60 + (+o.second)
    };
  }

  function stopArcMap(routeId, pathIdx) {
    var key = routeId + '|' + pathIdx;
    var hit = stopArcCache[key];
    if (hit) return hit;
    var m = {};
    routeSegments(routeId).forEach(function (g) {
      if (g.pathIdx !== pathIdx) return;
      if (!(g.from in m)) m[g.from] = g.s0;
      m[g.to] = g.s1;
    });
    stopArcCache[key] = m;
    return m;
  }

  // Where a scheduled trip should be (arc s) at nowSec, via its stops mapped
  // onto the shape. Returns null when the trip isn't on this path / is over.
  function tripExpected(trip, stopS, nowSec) {
    var pts = [];
    // Measure against the empirical baseline when 2b-ii substituted it;
    // measuring a typically-late bus against the raw schedule would
    // double-count the lateness (empirical shift + delay vs raw).
    var dep = trip.depL2 || trip.dep, arr = trip.arrL2 || trip.arr;
    for (var j = 0; j < trip.stops.length; j++) {
      var s = stopS[String(trip.stops[j])];
      if (s == null) continue;
      pts.push({ s: s, dep: dep[j], arr: arr[j] });
    }
    if (pts.length < 2) return null;
    for (var k = 1; k < pts.length; k++) if (pts[k].s <= pts[k - 1].s) return null;
    var first = pts[0], last = pts[pts.length - 1];
    function vref(a, b) {
      var dt = b.dep - a.dep, ds = b.s - a.s;
      return (dt > 0 && ds > 0) ? ds / dt : 8;
    }
    // expIdx: last stop the trip should have served by nowSec
    var expIdx = -1;
    for (var e = 0; e < pts.length; e++) if (pts[e].dep <= nowSec) expIdx = e;
    if (nowSec < first.dep) return { sE: first.s, vRef: vref(first, pts[1]), pts: pts, expIdx: -1 };
    if (nowSec > last.arr) return null;
    for (var m = 0; m + 1 < pts.length; m++) {
      var a = pts[m], b = pts[m + 1];
      if (nowSec >= a.dep && nowSec <= b.dep) {
        var f = (b.dep > a.dep) ? (nowSec - a.dep) / (b.dep - a.dep) : 0;
        return { sE: a.s + f * (b.s - a.s), vRef: vref(a, b), pts: pts, expIdx: expIdx };
      }
    }
    return { sE: last.s, vRef: vref(pts[pts.length - 2], last), pts: pts, expIdx: expIdx };
  }

  function headsignMatch(dest, h) {
    if (!dest || !h) return false;
    function norm(x) { return String(x).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
    var d = norm(dest), hh = norm(h);
    if (!d || !hh) return false;
    if (hh.indexOf(d) >= 0 || d.indexOf(hh) >= 0) return true;
    return d.split(' ')[0] === hh.split(' ')[0];
  }

  function candidateTrips(tt, ridx, svc, prevSvc, nowSec) {
    var out = [];
    for (var pi = 0; pi < tt.patterns.length; pi++) {
      var pat = tt.patterns[pi];
      if (pat.route !== ridx) continue;
      for (var ti = 0; ti < pat.trips.length; ti++) {
        var t = pat.trips[ti];
        if (t.s !== svc && t.s !== prevSvc) continue;
        if (nowSec >= t.dep[0] - 1800 && nowSec <= t.arr[t.arr.length - 1] + 300) out.push(t);
      }
    }
    return out;
  }

  function updateLiveDelays() {
    if (!tripTT || !tripRaptor || !tripRaptor.setLiveDelays) return;
    var tt = tripTT;
    // Phase 2b-ii (dormant): empirical baseline substitution, hourly.
    var nowMs = Date.now();
    if (nowMs - lastEmpiricalRun > 3600000) {
      lastEmpiricalRun = nowMs;
      applyEmpiricalBaseline();
    }
    if (!ttRouteIdxById) {
      ttRouteIdxById = {};
      tt.routes.forEach(function (r, i) { ttRouteIdxById[String(r.id)] = i; });
    }
    var dp = detroitParts(nowMs);
    var dpPrev = detroitParts(nowMs - 86400000);
    var svc = tripRaptor.serviceFor(tt, dp.ymd, dp.dow);
    var prevSvc = tripRaptor.serviceFor(tt, dpPrev.ymd, dpPrev.dow);
    var nowSec = dp.sec;
    // Candidate trips per route, once per poll.
    var candsByRoute = {};
    function candsFor(ridx) {
      if (!candsByRoute[ridx]) candsByRoute[ridx] = candidateTrips(tt, ridx, svc, prevSvc, nowSec);
      return candsByRoute[ridx];
    }
    var matches = []; // {trip, vehicleId, delaySec, disrupted, score}
    var nowPerf = performance.now();
    for (var vid in busTrackers) {
      var tr = busTrackers[vid];
      if (!tr || !tr.arc || !tr.vehicle) continue;
      if (pollSeq - tr.bornSeq < 2) continue; // just appeared / changed routes
      if (nowPerf - tr.fixT > 180000) continue; // vanished from feed
      var v = tr.vehicle;
      // Gate on the vehicle's GPS fix age, not poll receipt: a frozen feed
      // must not keep feeding delay measurements. 150s matches the
      // dead-reckoning horizon (PREDICT_HORIZON_S).
      var fixAgeMs = v.updated_at ? (Date.now() - new Date(v.updated_at).getTime()) : 0;
      if (fixAgeMs > 150000) continue; // GPS fix too old to measure delay
      var routeStr = String(v.route_id);
      var ridx = ttRouteIdxById[routeStr];
      if (ridx == null) continue; // ghost route: nothing to match against
      var stopS = stopArcMap(routeStr, tr.pathIdx);
      var cands = candsFor(ridx);
      if (!cands.length) continue;
      var best = null, second = null;
      for (var ci = 0; ci < cands.length; ci++) {
        var trip = cands[ci];
        var exp = tripExpected(trip, stopS, nowSec);
        if (!exp) continue;
        // Stop-index gate: the bus can't be 2+ stops early, nor absurdly late.
        var vIdx = -1;
        for (var q = 0; q < exp.pts.length; q++) {
          if (exp.pts[q].s <= tr.s + 30) vIdx = q; else break;
        }
        var gate = vIdx - exp.expIdx;
        if (gate > 1 || gate < -8) continue;
        var score = Math.abs(tr.s - exp.sE) - (headsignMatch(v.destination, trip.h) ? 500 : 0);
        if (!best || score < best.score) { second = best; best = { trip: trip, score: score, exp: exp }; }
        else if (!second || score < second.score) { second = { trip: trip, score: score }; }
      }
      // Clear margin or no match. 4000 m bound: beyond that the residual is
      // not a credible delay measurement.
      if (!best || best.score >= 4000) continue;
      if (second && (second.score - best.score) <= 300) continue;
      var ds = tr.s - best.exp.sE;
      var vRef = Math.max(best.exp.vRef, 2);
      var delaySec = Math.round(-ds / vRef);
      var disrupted = delaySec < -300 || delaySec > 1800;
      matches.push({
        trip: best.trip, vehicleId: v.vehicle_id,
        delaySec: disrupted ? 0 : delaySec, disrupted: disrupted, score: best.score,
        fixStamp: v.updated_at ? new Date(v.updated_at).getTime() : 0
      });
    }
    // One vehicle per trip: best score wins (bus bunching).
    var byTrip = new Map();
    matches.forEach(function (m) {
      var cur = byTrip.get(m.trip);
      if (!cur || m.score < cur.score) byTrip.set(m.trip, m);
    });
    var matchedTrips = new Set(byTrip.keys());
    byTrip.forEach(function (m, trip) {
      var st = tripDelayState.get(trip);
      if (m.disrupted) {
        tripDelayState.set(trip, { delaySec: 0, vehicleId: m.vehicleId, misses: 0, disrupted: true, fixStamp: m.fixStamp });
      } else if (!st || st.vehicleId !== m.vehicleId || st.disrupted) {
        tripDelayState.set(trip, { delaySec: m.delaySec, vehicleId: m.vehicleId, misses: 0, disrupted: false, fixStamp: m.fixStamp });
      } else {
        st.delaySec = Math.round(st.delaySec * 0.5 + m.delaySec * 0.5);
        st.fixStamp = m.fixStamp;
        st.misses = 0;
      }
    });
    tripDelayState.forEach(function (st, trip) {
      if (!matchedTrips.has(trip)) {
        st.misses++;
        if (st.misses >= 3) tripDelayState.delete(trip); // quiet: revert to scheduled
      }
    });
    var delayMap = new Map();
    tripDelayState.forEach(function (st, trip) {
      delayMap.set(trip, { delaySec: st.delaySec, disrupted: st.disrupted, vehicleId: st.vehicleId, fixStamp: st.fixStamp || 0 });
    });
    tripRaptor.setLiveDelays(tt, delayMap, nowMs);
    // Keep the open trip card live: re-plan "leave now" queries per poll.
    if (tripMode && tripJourneys.length && !(tripLeaveMode === 'at' && tripLeaveTime)) replanLive();
    updateGuidance(); // Phase 2c: board/alight/missed-transfer banners
  }

  // --- Phase 2b-ii: empirical timetable substitution ---------------------------
  // Replaces scheduled segment times with mature timing-cell means. The timing
  // builder emits observed anchor-switch pairs, which can span several
  // scheduled stops, so each adjacent pair first tries its exact cell key and
  // then falls back to the tightest observed span covering it. A spanning
  // cell's measured total is apportioned across its scheduled intervals by
  // scheduled-time share (uniform split if the schedule gives no times), so
  // the measured total is always preserved. No-ops until cells mature.
  // The delay layer measures against this baseline when present, else against
  // the raw schedule.
  // Timetable stop entries are page indices into ddot-routes-3d.json;
  // timing cells are keyed by GTFS stop_id. Translate before lookup —
  // the numeric spaces overlap but are not the same (e.g. page 741 is
  // GTFS 846).
  function ttStopId(pageIdx) {
    var s = stopData && stopData[pageIdx];
    return (s && s.id != null) ? String(s.id) : String(pageIdx);
  }

  function applyEmpiricalBaseline() {
    if (!tripTT) return 0;
    var tt = tripTT;
    var bucket = detroitBucket(new Date());
    var nSub = 0;
    var hasCells = false;
    if (timingCells) {
      for (var k in timingCells) {
        if (k.indexOf('|') >= 0) { hasCells = true; break; }
      }
    }
    tt.patterns.forEach(function (pat) {
      var routeId = String(tt.routes[pat.route].id);
      pat.trips.forEach(function (t) {
        var dep2 = null, arr2 = null;
        if (hasCells) {
          // Index this trip's observed spans by stop position (GTFS IDs).
          var gids = [];
          for (var s = 0; s < t.stops.length; s++) gids.push(ttStopId(t.stops[s]));
          var stopPos = {};
          for (var s2 = 0; s2 < gids.length; s2++) stopPos[gids[s2]] = s2;
          var spans = [];
          for (var k in timingCells) {
            var p = k.split('|');
            if (p.length !== 4 || p[0] !== routeId || p[3] !== bucket) continue;
            var sc = timingCells[k];
            if (!sc || !(sc.n >= 3) || !(sc.mean_s > 0)) continue;
            var ia = stopPos[p[1]], ib = stopPos[p[2]];
            if (ia == null || ib == null || ib <= ia) continue;
            spans.push({ ia: ia, ib: ib, mean_s: sc.mean_s, n: sc.n });
          }
          for (var j = 0; j + 1 < t.stops.length; j++) {
            var emp = null;
            var exact = timingCells[routeId + '|' + gids[j] + '|' + gids[j + 1] + '|' + bucket];
            if (exact && exact.n >= 3 && exact.mean_s > 0) {
              emp = exact.mean_s;
            } else {
              var bestS = null;
              for (var q = 0; q < spans.length; q++) {
                var sp = spans[q];
                if (sp.ia <= j && j + 1 <= sp.ib) {
                  if (!bestS || (sp.ib - sp.ia) < (bestS.ib - bestS.ia) ||
                      ((sp.ib - sp.ia) === (bestS.ib - bestS.ia) && sp.n > bestS.n)) bestS = sp;
                }
              }
              if (bestS) {
                var spanSched = t.dep[bestS.ib] - t.dep[bestS.ia];
                var pairSched = t.dep[j + 1] - t.dep[j];
                if (spanSched > 0 && pairSched >= 0) {
                  emp = bestS.mean_s * (pairSched / spanSched);
                } else {
                  emp = bestS.mean_s / (bestS.ib - bestS.ia);
                }
              }
            }
            if (emp != null && emp > 0) {
              var delta = emp - (t.dep[j + 1] - t.dep[j]);
              if (Math.abs(delta) >= 1) {
                if (!dep2) { dep2 = t.dep.slice(); arr2 = t.arr.slice(); }
                for (var m = j + 1; m < dep2.length; m++) { dep2[m] += delta; arr2[m] += delta; }
                nSub++;
              }
            }
          }
        }
        t.depL2 = dep2;
        t.arrL2 = arr2;
      });
    });
    return nSub;
  }

  function updateBuses(vehicles) {
    var now = performance.now();
    var seen = {};
    busSlots = [];
    for (var i = 0; i < vehicles.length && busSlots.length < BUS_MAX; i++) {
      var v = vehicles[i];
      if (v.lat == null || v.lon == null) continue;
      var grp = routeGroups[v.route_id];
      if (!grp || !grp.visible) continue; // unknown or filtered route: skip
      var p = project(v.lat, v.lon);
      // Reconcile the per-vehicle tracker: new buses start one, existing
      // ones get their fix map-matched and their speed refreshed.
      var tr = busTrackers[v.vehicle_id];
      if (!tr || tr.routeId !== v.route_id) {
        tr = busTrackers[v.vehicle_id] = {
          id: v.vehicle_id, routeId: v.route_id,
          arc: null, pathIdx: -1, s: 0, sCorr: 0,
          speedMps: 0, fixT: 0, lastX: null, lastZ: null, init: false,
          bornSeq: pollSeq, vehicle: null,
          // Kalman state: [kS arc-pos, kV velocity]; kP/kPv/kPvS covariance.
          // Replaces the ad-hoc sCorr easing with optimal gains; snap logic
          // below stays as the outlier gate. Q_* defaults until the Bayesian
          // timing cells land (telemetry-math/bayesian_cells.py).
          kS: 0, kV: 0, kP: 225, kPv: 25, kPvS: 0, kInit: false
        };
      }
      tr.vehicle = v; // fresh record each poll (destination, updated_at)
      var m = matchFix(v.route_id, p[0], p[1], v.bearing, tr.arc ? tr : null);
      if (m && m.dist <= OFFSHAPE_M) {
        if (tr.arc && tr.pathIdx === m.pathIdx && tr.kInit) {
          var delta = m.s - tr.kS;
          if (Math.abs(delta) > SNAP_DIST_M) {
            // Outlier gate: snap and reinit the filter (a plain Kalman
            // filter is not robust to GPS jumps; the gate keeps it honest).
            tr.kS = m.s; tr.kV = tr.speedMps; tr.kP = KALMAN_R; tr.kPv = 25; tr.kPvS = 0;
          } else {
            // Kalman update: H = [1, 0], R = GPS variance. Optimal gain —
            // replaces the old sCorr easing with the MMSE correction.
            var Sk = tr.kP + KALMAN_R;
            var kk0 = tr.kP / Sk, kk1 = tr.kPvS / Sk;
            tr.kS += kk0 * delta;
            tr.kV += kk1 * delta;
            var nkP = tr.kP - kk0 * tr.kP;
            var nkPvS = tr.kPvS - kk0 * tr.kPvS;
            tr.kPv = tr.kPv - kk1 * tr.kPvS;
            tr.kP = nkP; tr.kPvS = nkPvS;
          }
          // Keep the filtered state on the arc.
          if (tr.arc) tr.kS = Math.max(0, Math.min(tr.arc.len, tr.kS));
          tr.s = tr.kS; tr.sCorr = 0; // render from the filtered state
        } else {
          tr.kS = m.s; tr.kV = tr.speedMps; tr.kP = KALMAN_R; tr.kPv = 25; tr.kPvS = 0;
          tr.kInit = true;
          tr.s = m.s; tr.sCorr = 0; // new / re-matched path: snap
        }
        tr.arc = m.arc; tr.pathIdx = m.pathIdx;
      } else {
        tr.arc = null; // detour or no shape: render the raw fix, hold still
      }
      // Learn: observed along-track speed between consecutive matched polls
      // feeds the local segment speed map (the empirical motion prior).
      if (m && m.dist <= OFFSHAPE_M && tr.matchS != null && tr.matchPath === m.pathIdx && lastPollT) {
        var dtP = (now - lastPollT) / 1000;
        if (dtP > 20 && dtP < 150) {
          var obsV = (m.s - tr.matchS) / dtP;
          if (Math.abs(obsV) < 31.3) { // 70 mph sanity: GPS jumps don't teach
            var segMid = segmentAt(v.route_id, m.pathIdx, (m.s + tr.matchS) / 2);
            if (segMid) observeSegment(v.route_id, segMid, Math.max(0, obsV));
          }
        }
      }
      tr.matchS = m ? m.s : null;
      tr.matchPath = m ? m.pathIdx : -1;
      // Speed: prefer the feed's own number; derive from fixes when absent.
      var spMph = parseFloat(v.speed_mph);
      var inst = (!isNaN(spMph) && spMph >= 0) ? spMph * MPH_TO_MPS : null;
      if (inst == null && tr.lastX != null && tr.fixT) {
        var dtF = (now - tr.fixT) / 1000;
        if (dtF > 5) inst = Math.hypot(p[0] - tr.lastX, p[1] - tr.lastZ) / dtF;
      }
      if (inst != null) {
        tr.speedMps = tr.init ? tr.speedMps * 0.4 + inst * 0.6 : inst;
        tr.init = true;
      }
      tr.fixT = now; tr.lastX = p[0]; tr.lastZ = p[1];
      // Render state: matched arc position, else the raw fix.
      var pt = tr.arc ? pointAt(tr.arc, tr.s) : null;
      var rotY = (v.bearing != null && !isNaN(v.bearing))
        ? (90 - v.bearing) * DEG
        : (pt ? Math.atan2(-pt.dz, pt.dx) : 0);
      busSlots.push({
        vehicle: v,
        x: pt ? pt.x : p[0], z: pt ? pt.z : p[1],
        rotY: rotY,
        color: routeColors[v.route_id] || new THREE.Color(0xf5f2ea),
        tracker: tr
      });
      seen[v.vehicle_id] = true;
    }
    for (var id in busTrackers) if (!seen[id]) delete busTrackers[id];
    lastPollT = now;
    pollSeq++;
    updateLiveDelays(); // Phase 2b-i: match vehicles to trips, measure delays
    renderBusInstances();
    if (typeof refreshBrowseBuses === 'function') {
      var bp = document.getElementById('browse-panel');
      if (bp && !bp.hidden) refreshBrowseBuses(false);
    }
    if (selectedStop) renderStopLive();
    if (typeof renderBetaTiles === 'function') renderBetaTiles(); // beta tiles track live positions
    if (typeof refreshTripFusion === 'function') refreshTripFusion(); // live counts on trip legs
    if (selectedVehicleId) refreshBusInfo(); // tapped bus moved / new data
    return busSlots.length;
  }

  // SMART display payload (reactivation, 2026-10-15): the builder
  // publishes SMART vehicles separately (live-data/smart-display.json)
  // because the Swiftly license is display-only — SMART vehicles are
  // never part of the vehicles.json contract. Fetched on the same poll
  // cycle as the main envelope; resolves null on any failure so a SMART
  // outage can never fail or delay-mark the DDOT/QLINE poll.
  function fetchSmartDisplay(proxy) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 8000);
    return fetch(proxy + '/smart-display.json', { cache: 'no-store', signal: ctrl.signal })
      .then(function (r) { clearTimeout(timer); return r.ok ? r.json() : null; },
            function () { clearTimeout(timer); return null; });
  }
  function poll() {
    var proxy = (window.FORGE_LIVE_PROXY || '').replace(/\/$/, '');
    if (!proxy) { setHeader(null, 'connecting…', false); return; }
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 20000);
    fetch(proxy + '/vehicles.json', { cache: 'no-store', signal: ctrl.signal })
      .then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error('http ' + r.status); return r.json(); },
            function (e) { clearTimeout(timer); throw e; })
      .then(function (d) {
        if (!d || !Array.isArray(d.vehicles)) throw new Error('bad payload');
        // SMART (reactivated 2026-10-15) joins here: the display
        // payload's vehicles merge into this poll's live set before
        // every fan-out below (map, counts, ride-along, follow, tiles,
        // delay matching). smartDisplayVehicles drops the payload
        // entirely when it is missing, malformed, or stale, so SMART
        // can only ever add current positions. The envelope itself
        // (sources, generated_at) is untouched: the degradation notice
        // reads it exactly as before and never reads sources.smart.
        return fetchSmartDisplay(proxy).then(function (s) {
          smartAge = computeSmartAge(s, Date.now());
          var sv = smartDisplayVehicles(s, Date.now());
          if (sv.length) d.vehicles = d.vehicles.concat(sv);
          return d;
        });
      })
      .then(function (d) {
        lastVehicles = d.vehicles;
        liveEverOk = true;
        if (typeof window.__setRideVehicles === 'function') window.__setRideVehicles(d.vehicles);
        liveCounts = countByRoute(d.vehicles); // raw counts first: filters must not starve the state engine
        var n = updateBuses(d.vehicles);
        if (updateRunningState()) {
          applyFilters();   // re-applies visibility + dimming, re-renders buses
          syncFilterUI();
        }
        refreshFilterCounts();
        lastTotal = n;
        setHeader(n, 'updated ' + fmtTime(d.generated_at ? new Date(d.generated_at) : null), false);
        svcFeedOk(d); // service degradation notice: evaluate source states + freshness
        // SMART freshness surfaces track every successful poll (S6).
        applySmartAgeUI();
      })
      .catch(function () {
        var text = liveEverOk
          ? 'live feed retrying…'
          : (historyOk ? 'showing last logged positions · live feed retrying…' : 'live feed retrying…');
        setHeader(lastTotal, text, true);
        svcFeedFail(); // service degradation notice: feed unreachable
      });
  }

  // === SVC-NOTICE-BEGIN ===
  // --- service degradation notice -------------------------------------------
  // Fail-safe rider notice for live-data degradation (staged candidate;
  // record: files/service-notice/service-notice.md). Detection uses only
  // data the vehicles poll already receives: the envelope's per-agency
  // source states (sources.ddot / sources.qline), the envelope's
  // generated_at age, and the poll's own success or failure. No new
  // fetches, no new endpoints. sources.smart is never read here: it
  // reports the SMART display leg (SMART reactivated 2026-10-15), whose
  // freshness is labelled by the SMART freshness graft on its own
  // surfaces (S6); a SMART state change is not a degradation of the
  // DDOT/QLINE envelope this notice guards. A source reporting ok
  // with zero vehicles is NOT a degradation — overnight truth is zero
  // vehicles — so vehicle counts are never a signal. S6: the notice
  // claims only the freshness and source state the envelope measures,
  // and names the data's age whenever positions may be old.
  var SVC_STALE_MS = 15 * 60 * 1000; // 3x the feed's 5-minute build cadence
  var svcAttempted = false;   // at least one poll attempt has completed
  var svcLastOk = false;      // the most recent poll attempt succeeded
  var svcLastPayload = null;  // last successfully parsed vehicles envelope
  var svcDismissedSig = null; // signature of the dismissed condition set
  var svcShownSig = null;     // signature currently rendered (null = hidden)
  var svcExpanded = false;

  var SVC_SHORT = {
    'stale': 'positions out of date',
    'ddot-not-configured': 'DDOT positions not connected',
    'ddot-down': 'DDOT positions unavailable',
    'ddot-partial': 'DDOT positions incomplete',
    'qline-down': 'QLINE positions unavailable'
  };
  var SVC_TAIL = 'What still works: the map, all stop and route information, and the trip planner are unaffected. The planner computes journeys from the published DDOT timetable (DDOT schedule data current through February 7, 2027), not from live positions. While live positions are degraded, scheduled times are the reliable basis for planning a trip. This notice concerns the live data feed only. Bus and streetcar service is not cancelled, and this page does not announce service cancellations.';

  function svcConditions() {
    var out = [];
    if (!svcAttempted) return out;
    if (!svcLastOk) { out.push({ key: 'unreachable' }); return out; }
    var d = svcLastPayload;
    if (!d) return out;
    var genT = Date.parse(d.generated_at || '');
    if (!isNaN(genT)) {
      var ageMs = Date.now() - genT;
      if (ageMs > SVC_STALE_MS) {
        out.push({ key: 'stale', genAt: d.generated_at, ageMin: Math.floor(ageMs / 60000) });
      }
    }
    var src = d.sources || {};
    var dd = src.ddot;
    if (dd) {
      if (dd.ok === false && dd.configured === false) {
        out.push({ key: 'ddot-not-configured' });
      } else if (dd.ok === false) {
        out.push({ key: 'ddot-down' });
      } else {
        // The builder reports ok:true for the DDOT leg whenever the leg
        // ran; a leg whose every route-group request failed is visible
        // only in the batch counters, so the counters are the signal.
        var bo = Number(dd.batches_ok), bf = Number(dd.batches_failed);
        if (isFinite(bo) && isFinite(bf) && (bo + bf) > 0) {
          if (bo === 0) out.push({ key: 'ddot-down' });
          else if (bf > 0) out.push({ key: 'ddot-partial', ok: bo, total: bo + bf });
        }
      }
    }
    var ql = src.qline;
    if (ql && ql.ok === false) out.push({ key: 'qline-down' });
    return out;
  }

  function svcHeadline(c) {
    switch (c.key) {
      case 'unreachable':
        return 'Live vehicle positions unavailable. The live feed cannot be reached.';
      case 'stale':
        return 'Live vehicle positions are out of date. Last updated ' +
          fmtTime(new Date(c.genAt)) + ', ' + c.ageMin +
          (c.ageMin === 1 ? ' minute' : ' minutes') + ' ago.';
      case 'ddot-not-configured':
        return 'DDOT live positions are not available on this map.';
      case 'ddot-down':
        return 'DDOT live positions unavailable. The DDOT feed is not reporting.';
      case 'ddot-partial':
        return 'DDOT live positions are incomplete. Some DDOT routes are not reporting.';
      case 'qline-down':
        return 'QLINE live positions unavailable. The QLINE feed is not reporting.';
    }
    return '';
  }

  function svcDetailText(c) {
    switch (c.key) {
      case 'unreachable':
        if (typeof liveEverOk !== 'undefined' && liveEverOk && svcLastPayload) {
          return 'The live data file this page reads could not be loaded. The vehicle positions on the map are from the last successful update (' +
            fmtTime(new Date(svcLastPayload.generated_at)) + ') and are not being refreshed.';
        }
        if (typeof historyOk !== 'undefined' && historyOk) {
          return 'The live data file this page reads could not be loaded. Any vehicle positions shown come from the most recent logged snapshot. They are not current positions and are not being refreshed.';
        }
        return 'The live data file this page reads could not be loaded, and no live update has been received yet. No live vehicle positions are shown.';
      case 'stale':
        return 'The live feed is rebuilt every five minutes. The newest file available is from ' +
          fmtTime(new Date(c.genAt)) + ' (' + c.ageMin + ' minutes old). The positions on the map are exactly the positions in that file. They are not advanced or estimated between updates.';
      case 'ddot-not-configured':
        return 'The DDOT live position feed is not connected to this map in its current configuration, so DDOT vehicles do not appear. This is a data connection state. It is not a change to DDOT service, and it does not affect QLINE positions, the map, or the trip planner.';
      case 'ddot-down':
        return 'The DDOT position source returned no data for the most recent update. DDOT vehicles are removed from the map while the source is not reporting, and they return when the source resumes. A source outage is not a service suspension. DDOT buses continue to run on their published schedules.';
      case 'ddot-partial':
        return 'The DDOT position source returned data for ' + c.ok + ' of ' + c.total +
          ' route groups in the most recent update. Vehicles on the remaining routes do not appear in this update. Routes that are reporting are shown at their measured positions.';
      case 'qline-down':
        return 'The QLINE position source returned no data for the most recent update. QLINE streetcars are removed from the map while the source is not reporting, and they return when the source resumes. A source outage is not a service suspension.';
    }
    return '';
  }

  function svcSig(conds) {
    return conds.map(function (c) {
      return c.key +
        (c.key === 'stale' ? '@' + c.genAt : '') +
        (c.key === 'ddot-partial' ? ':' + c.ok + '/' + c.total : '');
    }).join('|');
  }

  function svcRender() {
    var box = $('svc-notice');
    if (!box) return;
    var conds = svcConditions();
    if (!conds.length) {
      box.hidden = true;
      svcShownSig = null;
      svcDismissedSig = null; // a cleared condition re-arms the notice
      svcExpanded = false;
      return;
    }
    var sig = svcSig(conds);
    if (sig === svcDismissedSig) {
      box.hidden = true;
      svcShownSig = null;
      return;
    }
    var head = svcHeadline(conds[0]);
    if (conds.length > 1) {
      head += ' Also: ' + conds.slice(1).map(function (c) { return SVC_SHORT[c.key]; }).join('; ') + '.';
    }
    if (!box.hidden && svcShownSig === sig && $('svc-headline').textContent === head) return;
    $('svc-headline').textContent = head;
    var det = $('svc-details');
    det.innerHTML = '';
    conds.forEach(function (c) {
      var p = document.createElement('p');
      p.textContent = svcDetailText(c);
      det.appendChild(p);
    });
    var tail = document.createElement('p');
    tail.textContent = SVC_TAIL;
    det.appendChild(tail);
    det.hidden = !svcExpanded;
    $('svc-details-btn').setAttribute('aria-expanded', svcExpanded ? 'true' : 'false');
    box.hidden = false;
    svcShownSig = sig;
  }

  // Poll hooks: called from poll()'s success and failure paths only.
  function svcFeedOk(d) {
    svcAttempted = true;
    svcLastOk = true;
    svcLastPayload = d;
    svcRender();
  }
  function svcFeedFail() {
    svcAttempted = true;
    svcLastOk = false;
    svcRender();
  }

  (function svcWire() {
    var btn = $('svc-details-btn'), dis = $('svc-dismiss');
    if (btn) btn.addEventListener('click', function () {
      svcExpanded = !svcExpanded;
      $('svc-details').hidden = !svcExpanded;
      btn.setAttribute('aria-expanded', svcExpanded ? 'true' : 'false');
    });
    if (dis) dis.addEventListener('click', function () {
      if (svcShownSig != null) svcDismissedSig = svcShownSig;
      var box = $('svc-notice');
      if (box) box.hidden = true;
      svcShownSig = null;
    });
    // Re-evaluate between polls so a stale condition surfaces (and its
    // stated age stays current) without waiting for the next 60 s poll.
    // Renders from stored state only; this timer never fetches.
    setInterval(function () { svcRender(); }, 30000);
  })();
  // === SVC-NOTICE-END ===

  // --- service alerts (phase 1) — presentation: Map-Native (concept B) ------
  // Consumes the proxy's /api/alerts (DDOT BusTime bulletins, kind
  // 'realtime'). Presentation
  // follows concept B as selected 2026-10-14: there is NO global strip.
  // Alerts live where they apply — severity badges on route chips, alert
  // bands in the stop card, "what changed" lines in the planner, and
  // glyph + dashed overlays on the 3D map itself. Planned (bulletin-board)
  // alerts tint ONLY the chip: they never draw map geometry, because the
  // board carries no stop- or path-level precision. Zero-state is absence:
  // no badges, no bands, no overlays. Every treatment pairs color with a
  // glyph and words (see ALERT_FX and the help card's vocabulary list);
  // nothing is carried by color alone. Feature-detect by design: the
  // endpoint does not exist on the proxy until phase 1 deploys, and every
  // failure path here degrades silently, so the map behaves as before.
  var alertsState = { ok: false, alerts: [], sources: [], misses: {} };
  var ALERT_EFFECT_RANK = {
    NO_SERVICE: 5, REDUCED_SERVICE: 4, SIGNIFICANT_DELAYS: 3, DETOUR: 3,
    ACCESSIBILITY_ISSUE: 2, STOP_MOVED: 2, MODIFIED_SERVICE: 2,
    ADDITIONAL_SERVICE: 1, OTHER_EFFECT: 1, UNKNOWN_EFFECT: 0, NO_EFFECT: 0
  };
  var ALERT_AGENCY = { ddot: 'DDOT', qline: 'QLINE' };
  // The five-effect vocabulary (design samples, shared table). cls keys
  // the CSS treatments; css is the glyph color used on map sprites.
  var ALERT_FX = {
    NO_SERVICE: { glyph: '✕', label: 'No service', cls: 'nostop', css: '#FF8A80' },
    DETOUR: { glyph: '↪', label: 'Detour', cls: 'detour', css: '#FF8A80' },
    REDUCED_SERVICE: { glyph: '◑', label: 'Reduced service', cls: 'reduced', css: '#FFB000' },
    STOP_MOVED: { glyph: '⇄', label: 'Stop moved', cls: 'moved', css: '#4D96FF' },
    INFO: { glyph: 'ℹ', label: 'Notice', cls: 'info', css: '#9AA0A6' }
  };
  var ALERT_FX_FALLBACK = { glyph: '⚠', label: 'Service alert', cls: 'detour', css: '#FF8A80' };
  function alertFx(a) {
    var e = a && a.effect;
    if (e && ALERT_FX[e]) return ALERT_FX[e];
    if (e === 'SIGNIFICANT_DELAYS') return { glyph: '⚠', label: 'Significant delays', cls: 'detour', css: '#FF8A80' };
    if (e === 'MODIFIED_SERVICE') return { glyph: '⚠', label: 'Modified service', cls: 'detour', css: '#FF8A80' };
    if (e === 'ACCESSIBILITY_ISSUE') return { glyph: '⚠', label: 'Accessibility issue', cls: 'detour', css: '#FF8A80' };
    if (e === 'ADDITIONAL_SERVICE') return { glyph: 'ℹ', label: 'Additional service', cls: 'info', css: '#9AA0A6' };
    if (e) return { glyph: '⚠', label: e.replace(/_/g, ' ').toLowerCase(), cls: 'detour', css: '#FF8A80' };
    return ALERT_FX_FALLBACK;
  }
  function alertParseT(s) { var t = s ? Date.parse(s) : NaN; return isNaN(t) ? null : t; }
  function alertIsActive(a, nowMs) {
    if (!a) return false;
    var p = a.active_period || {};
    var st = alertParseT(p.start), en = alertParseT(p.end);
    if (st !== null && nowMs < st) return false;   // not yet in force
    if (en !== null && nowMs > en) return false;   // period ended
    return true;
  }
  function activeAlerts() {
    var n = Date.now();
    return alertsState.alerts.filter(function (a) { return alertIsActive(a, n); });
  }
  function alertsForRoute(rid) {
    if (!rid) return [];
    var id = String(rid);
    return activeAlerts().filter(function (a) { return (a.routes || []).indexOf(id) >= 0; });
  }
  function alertsForStop(stid) {
    if (stid === null || stid === undefined || stid === '') return [];
    var id = String(stid);
    return activeAlerts().filter(function (a) { return (a.stops || []).indexOf(id) >= 0; });
  }
  function alertWorstEffect(list) {
    var w = null, wr = -1;
    (list || []).forEach(function (a) {
      var r = ALERT_EFFECT_RANK[a.effect] || 0;
      if (r > wr) { wr = r; w = a.effect; }
    });
    return w;
  }
  function alertWindowText(a) {
    var p = a.active_period || {};
    var st = alertParseT(p.start), en = alertParseT(p.end);
    if (st === null && en === null) return '';
    var f = function (t) { return fmtTime(new Date(t)); };
    if (st !== null && en !== null) return f(st) + ' – ' + f(en);
    if (st !== null) return 'from ' + f(st);
    return 'until ' + f(en);
  }
  // Plain-language "what changed" sentence for one alert — the words that
  // accompany every glyph, in the planner, the stop card, and the
  // screen-reader list. Built only from fields the feed actually carries.
  function alertWhatChanged(a) {
    var fx = alertFx(a);
    var s = fx.label + ' — ' + (a.header || 'Service alert');
    var bits = [ALERT_AGENCY[a.agency] || a.agency || '',
      a.kind === 'planned' ? 'planned notice' : 'live'];
    var win = alertWindowText(a);
    if (win) bits.push(win);
    s += ' (' + bits.filter(Boolean).join(' · ') + ')';
    if (a.description) s += ' ' + a.description;
    return s;
  }
  function alertSrText(a) {
    var fx = alertFx(a);
    var s = fx.label + ': ' + (a.header || 'Service alert') + ' — ' +
      (ALERT_AGENCY[a.agency] || a.agency || '') + ', ' +
      (a.kind === 'planned' ? 'planned notice' : 'live alert');
    if (a.routes && a.routes.length) s += ', route' + (a.routes.length === 1 ? ' ' : 's ') + a.routes.map(routeLabel).join(', ');
    if (a.stops && a.stops.length) s += ', stop' + (a.stops.length === 1 ? ' ' : 's ') + a.stops.join(', ');
    var win = alertWindowText(a);
    if (win) s += ', ' + win;
    if (a.description) s += '. ' + a.description;
    return s;
  }
  // Retire an alert only after it is absent from two consecutive fetches
  // (design rule) — a single flaky fetch never flickers the UI.
  function mergeAlerts(fresh) {
    var seen = {};
    (fresh || []).forEach(function (a) {
      if (a && a.id) { seen[a.id] = true; alertsState.misses[a.id] = 0; }
    });
    var kept = (fresh || []).slice();
    alertsState.alerts.forEach(function (old) {
      if (old.id && !seen[old.id]) {
        alertsState.misses[old.id] = (alertsState.misses[old.id] || 0) + 1;
        if (alertsState.misses[old.id] < 2) kept.push(old);
        else delete alertsState.misses[old.id];
      }
    });
    alertsState.alerts = kept;
  }

  // --- accessible text equivalent -------------------------------------------
  // #alerts-sr is a visually-hidden list naming every active alert in
  // words, rebuilt by this same render path whenever the alert set
  // changes; #alerts-live announces only set changes (never the 120 s
  // re-poll), so screen-reader users get the alerts without the noise.
  var alertsSrSig = '', alertsLiveIds = null;
  function renderAlertSr() {
    var list = $('alerts-sr-list');
    if (!list) return;
    var act = alertsState.ok ? activeAlerts() : [];
    var sig = (alertsState.ok ? 'ok' : 'down') + '|' + act.map(function (a) {
      return a.id + ':' + (a.effect || '') + ':' + (a.header || '');
    }).join(';;');
    if (sig !== alertsSrSig) {
      alertsSrSig = sig;
      list.innerHTML = '';
      act.forEach(function (a) {
        var li = document.createElement('li');
        li.textContent = alertSrText(a);
        list.appendChild(li);
      });
      var src = $('alerts-sr-sources');
      if (src) {
        src.textContent = alertsState.sources.map(function (s) {
          var name = (ALERT_AGENCY[s.agency] || s.agency || '').toUpperCase();
          if (!s.ok) return name + ' alerts unavailable';
          return name + ' updated ' + fmtTime(s.fetched_at ? new Date(s.fetched_at) : null) +
            (s.kind === 'planned' ? ' · bulletin board (planned notices)' : ' · live feed');
        }).join(' · ');
      }
      var ids = act.map(function (a) { return a.id; }).sort().join(',');
      if (alertsLiveIds !== null && ids !== alertsLiveIds) {
        var lv = $('alerts-live');
        if (lv) {
          lv.textContent = act.length
            ? 'Service alerts updated: ' + act.length + ' active. Most severe: ' +
              alertFx({ effect: alertWorstEffect(act) }).label.toLowerCase() + '.'
            : 'All service alerts have cleared.';
        }
      }
      alertsLiveIds = ids;
    }
  }

  // --- route chip badges ------------------------------------------------------
  // Per the samples: a red ✕ badge when any alert on the route is
  // NO_SERVICE; an amber count badge for live alerts; a hollow "P" when
  // the route carries only planned notices. The badge glyph is
  // aria-hidden — the same information is written into the chip's
  // aria-label and title, so the chip never speaks in color alone.
  function renderChipBadges() {
    var chips = document.querySelectorAll('.f-chip[data-route]');
    for (var i = 0; i < chips.length; i++) {
      var chip = chips[i], rid = chip.getAttribute('data-route');
      var list = (alertsState.ok && rid) ? alertsForRoute(rid) : [];
      var olds = chip.querySelectorAll('.alert-badge');
      for (var j = olds.length - 1; j >= 0; j--) olds[j].remove();
      chip.classList.toggle('has-alert', list.length > 0);
      var worst = list.length ? alertWorstEffect(list) : null;
      chip.classList.toggle('alert-severe', worst === 'NO_SERVICE');
      if (!list.length) {
        chip.removeAttribute('aria-label');
        chip.removeAttribute('title');
        continue;
      }
      var live = list.filter(function (a) { return a.kind !== 'planned'; });
      var badge = document.createElement('span');
      badge.className = 'alert-badge';
      badge.setAttribute('aria-hidden', 'true');
      if (worst === 'NO_SERVICE') { badge.classList.add('ab-nostop'); badge.textContent = '✕'; }
      else if (live.length) { badge.classList.add('ab-live'); badge.textContent = String(live.length); }
      else { badge.classList.add('ab-planned'); badge.textContent = 'P'; }
      chip.appendChild(badge);
      var fx = alertFx({ effect: worst });
      var nameEl = chip.querySelector('b');
      var nm = nameEl ? nameEl.textContent : ('Route ' + rid);
      chip.setAttribute('aria-label', nm + ' — service alert: ' + fx.label.toLowerCase() +
        (list.length > 1 ? ', ' + list.length + ' alerts active' : '') +
        (!live.length ? ' (planned notice)' : ''));
      chip.title = 'Service alert: ' + fx.label + (!live.length ? ' (planned notice)' : '');
    }
  }

  // --- map overlays (3D) ------------------------------------------------------
  // Treatments, per the vocabulary: NO_SERVICE — the affected span is
  // muted by a dark fade ribbon and overdrawn with a red-white dashed
  // ribbon (never amber: route 4's own color IS #FFB000) plus a ✕ sprite;
  // DETOUR — the same red-white dashed ribbon over the affected span plus
  // a ↪ sprite, and pulsing amber rings on the bypassed stops the
  // bulletin names; REDUCED_SERVICE — a dim ribbon over the route;
  // STOP_MOVED — a hollow blue ring and ⇄ sprite at the named stop (the
  // feed carries no replacement-stop coordinates, so no new boarding
  // point is drawn — the words live in the stop card); INFO — none.
  // Spans come from the alert's own stop list snapped to the route path;
  // a route-wide alert with no stops spans the whole route. The bulletin
  // carries no detour path geometry, so no diversion line is invented.
  // Overlays are children of the route's own group, so route/group
  // filter toggles hide them with their route.
  var alertOverlaySubs = {};   // rid -> THREE.Group child of routeGroups[rid]
  var alertPulseRings = [];    // ring meshes animated by alertPulseTick
  var alertPulseRaf = 0;
  var alertDashTex = null;
  var alertReducedMotion = (typeof window !== 'undefined' && window.matchMedia)
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;
  var alertStopById = null, alertStopDataRef = null;
  function alertStopsById() {
    if (typeof stopData === 'undefined' || !stopData) return {};
    if (alertStopById && alertStopDataRef === stopData) return alertStopById;
    var m = {};
    stopData.forEach(function (s) { if (s && s.id !== undefined && s.id !== null) m[String(s.id)] = s; });
    alertStopById = m; alertStopDataRef = stopData;
    return m;
  }
  function alertStopsForRoute(a, rid) {
    var byId = alertStopsById(), out = [];
    (a.stops || []).forEach(function (sid) {
      var st = byId[String(sid)];
      if (st && (st.r || []).indexOf(rid) >= 0) out.push(st);
    });
    return out;
  }
  function alertSpanFor(route, a, rid) {
    var stops = alertStopsForRoute(a, rid);
    if (!stops.length || typeof nearestOnPath !== 'function') return route.paths || [];
    var best = null;
    (route.paths || []).forEach(function (path) {
      if (!path || path.length < 2) return;
      var idx = [];
      stops.forEach(function (st) {
        var i = nearestOnPath(path, st.x, st.z);
        var dx = path[i][0] - st.x, dz = path[i][1] - st.z;
        if (dx * dx + dz * dz <= 600 * 600) idx.push(i);
      });
      if (idx.length && (!best || idx.length > best.idx.length)) best = { path: path, idx: idx };
    });
    if (!best) return route.paths || [];
    var lo = Math.min.apply(null, best.idx), hi = Math.max.apply(null, best.idx);
    lo = Math.max(0, lo - 1); hi = Math.min(best.path.length - 1, hi + 1);
    if (hi - lo < 1) { lo = Math.max(0, lo - 1); hi = Math.min(best.path.length - 1, hi + 1); }
    return [best.path.slice(lo, hi + 1)];
  }
  function alertDashTexture() {
    if (alertDashTex) return alertDashTex;
    var c = document.createElement('canvas');
    c.width = 256; c.height = 16;
    var x = c.getContext('2d');
    x.fillStyle = '#B3261E'; x.fillRect(0, 0, 128, 16);   // red dash
    x.fillStyle = '#F5F2EA'; x.fillRect(128, 0, 42, 16);  // white dash
    // remainder transparent: the route deck shows through the gap
    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    alertDashTex = tex;
    return tex;
  }
  function alertDashRibbon(pts, y) {
    var g = ribbonGeometry(pts, 78, y);
    var pos = g.getAttribute('position');
    var pairs = pos.count / 2;
    var len = 0;
    for (var i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    var reps = Math.max(2, Math.round(len / 300));
    var uv = new Float32Array(pos.count * 2);
    for (var k = 0; k < pairs; k++) {
      var u = pairs > 1 ? (k / (pairs - 1)) * reps : 0;
      uv[k * 4] = u; uv[k * 4 + 1] = 0; uv[k * 4 + 2] = u; uv[k * 4 + 3] = 1;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  }
  function alertGlyphSprite(glyph, colorCss, scale) {
    var c = document.createElement('canvas');
    c.width = 192; c.height = 192;
    var x = c.getContext('2d');
    x.font = '700 124px "Inter", sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.lineWidth = 16; x.strokeStyle = 'rgba(12,17,22,.92)';
    x.strokeText(glyph, 96, 102);
    x.fillStyle = colorCss;
    x.fillText(glyph, 96, 102);
    var tex = new THREE.CanvasTexture(c);
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.scale.set(scale, scale, 1);
    sp.renderOrder = 6;
    return sp;
  }
  function addAlertPulseRing(parent, st) {
    var ring = new THREE.Mesh(
      new THREE.RingGeometry(34, 58, 40),
      new THREE.MeshBasicMaterial({ color: 0xffb000, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(st.x, 22, st.z);
    ring.userData.phase = Math.random() * Math.PI * 2;
    parent.add(ring);
    alertPulseRings.push(ring);
  }
  function alertPulseTick() {
    if (!alertPulseRings.length) { alertPulseRaf = 0; return; }
    var t = performance.now() / 420;
    for (var i = 0; i < alertPulseRings.length; i++) {
      var r = alertPulseRings[i];
      var s = 1 + 0.3 * Math.sin(t + r.userData.phase);
      r.scale.set(s, s, 1);
      r.material.opacity = 0.95 - 0.4 * (0.5 + 0.5 * Math.sin(t + r.userData.phase));
    }
    alertPulseRaf = requestAnimationFrame(alertPulseTick);
  }
  function disposeAlertSub(sub) {
    sub.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();  // disposes the material only; the shared dash texture survives
    });
  }
  function renderAlertMap() {
    if (typeof THREE === 'undefined' || typeof scene === 'undefined' ||
        typeof routeById === 'undefined' || typeof routeGroups === 'undefined') return;
    Object.keys(alertOverlaySubs).forEach(function (rid) {
      var sub = alertOverlaySubs[rid];
      if (sub.parent) sub.parent.remove(sub);
      disposeAlertSub(sub);
      delete alertOverlaySubs[rid];
    });
    alertPulseRings = [];
    if (alertPulseRaf) { cancelAnimationFrame(alertPulseRaf); alertPulseRaf = 0; }
    if (!alertsState.ok) return;
    activeAlerts().forEach(function (a) {
      if (a.kind === 'planned') return;  // planned: chip tint only, never geometry
      (a.routes || []).forEach(function (rid) {
        var route = routeById[rid];
        var host = routeGroups[rid];
        if (!route || !route.paths || !host) return;
        var ri = routeOrder.indexOf(rid);
        var y = 66 + (ri < 0 ? 0 : ri) * 1.2 + 3;
        var fx = alertFx(a);
        var sub = alertOverlaySubs[rid];
        if (!sub) { sub = new THREE.Group(); sub.name = 'alert-overlay'; host.add(sub); alertOverlaySubs[rid] = sub; }
        if (a.effect === 'NO_SERVICE' || a.effect === 'DETOUR') {
          alertSpanFor(route, a, rid).forEach(function (span) {
            if (!span || span.length < 2) return;
            if (a.effect === 'NO_SERVICE') {
              sub.add(new THREE.Mesh(ribbonGeometry(span, 78, y),
                new THREE.MeshBasicMaterial({ color: 0x05070a, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false })));
            }
            sub.add(new THREE.Mesh(alertDashRibbon(span, y + 0.7),
              new THREE.MeshBasicMaterial({ map: alertDashTexture(), transparent: true, side: THREE.DoubleSide, depthWrite: false })));
            var mid = span[Math.floor(span.length / 2)];
            var spr = alertGlyphSprite(fx.glyph, fx.css, 160);
            spr.position.set(mid[0], y + 130, mid[1]);
            sub.add(spr);
          });
          alertStopsForRoute(a, rid).forEach(function (st) { addAlertPulseRing(sub, st); });
        } else if (a.effect === 'REDUCED_SERVICE') {
          (route.paths || []).forEach(function (p) {
            if (!p || p.length < 2) return;
            sub.add(new THREE.Mesh(ribbonGeometry(p, 78, y),
              new THREE.MeshBasicMaterial({ color: 0x05070a, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false })));
          });
        } else if (a.effect === 'STOP_MOVED') {
          alertStopsForRoute(a, rid).forEach(function (st) {
            var ring = new THREE.Mesh(
              new THREE.RingGeometry(26, 42, 32),
              new THREE.MeshBasicMaterial({ color: 0x4d96ff, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false })
            );
            ring.rotation.x = -Math.PI / 2;
            ring.position.set(st.x, 22, st.z);
            sub.add(ring);
            var spr2 = alertGlyphSprite(fx.glyph, fx.css, 120);
            spr2.position.set(st.x, y + 100, st.z);
            sub.add(spr2);
          });
        }
        // INFO and unlisted effects: no map geometry (vocabulary rule).
      });
    });
    if (alertPulseRings.length && !alertReducedMotion && !alertPulseRaf) {
      alertPulseRaf = requestAnimationFrame(alertPulseTick);
    }
  }

  // --- stop card bands ---------------------------------------------------------
  // One band per alert scoped to this stop: glyph, a bold plain-language
  // first line, then the alert's own words with agency + kind. Route-level
  // alerts that do not name this stop are NOT shown here — the stop card
  // never claims stop precision the feed does not have.
  function renderStopAlerts(st) {
    var box = $('stop-alerts'), list = $('stop-alerts-list');
    if (!box || !list) return;
    var mine = (st && alertsState.ok) ? alertsForStop(st.id) : [];
    if (!mine.length) { box.hidden = true; list.innerHTML = ''; return; }
    box.hidden = false;
    list.innerHTML = '';
    mine.forEach(function (a) {
      var fx = alertFx(a);
      var band = document.createElement('div');
      band.className = 'sa-band' + (a.effect === 'NO_SERVICE' ? ' severe' : '') +
        (a.effect === 'STOP_MOVED' ? ' moved' : '');
      var ico = document.createElement('span');
      ico.className = 'sa-ico';
      ico.setAttribute('aria-hidden', 'true');
      ico.textContent = fx.glyph;
      band.appendChild(ico);
      var p = document.createElement('p');
      var lead = document.createElement('b');
      var win = alertWindowText(a);
      lead.textContent =
        a.effect === 'DETOUR' ? 'This stop is bypassed' + (win ? ' ' + win : '') + '.'
        : a.effect === 'NO_SERVICE' ? 'No service at this stop' + (win ? ' ' + win : '') + '.'
        : a.effect === 'STOP_MOVED' ? 'Boarding point moved from this stop' + (win ? ' ' + win : '') + '.'
        : fx.label + ' at this stop' + (win ? ' ' + win : '') + '.';
      p.appendChild(lead);
      var rest = document.createElement('span');
      rest.textContent = ' ' + (a.header || 'Service alert') +
        ' (' + (ALERT_AGENCY[a.agency] || a.agency || '') + ' · ' +
        (a.kind === 'planned' ? 'planned notice' : 'live') + ')' +
        (a.description ? ' ' + a.description : '');
      p.appendChild(rest);
      band.appendChild(p);
      list.appendChild(band);
    });
  }
  function refreshAlertSurfaces() {
    renderAlertSr();
    renderChipBadges();
    try { renderAlertMap(); } catch (e) { /* overlay failure must never mark the feed down */ }
    if (typeof selectedStop !== 'undefined' && selectedStop) {
      var sc = $('stop-card');
      if (sc && !sc.hidden) renderStopAlerts(selectedStop);
    }
    if (typeof tripJourneys !== 'undefined' && tripJourneys && tripJourneys.length &&
        typeof tripSel !== 'undefined' && tripSel >= 0 && typeof renderTripDetail === 'function') {
      renderTripDetail();
    }
    var bp = $('browse-panel');
    if (bp && !bp.hidden) {
      if (typeof buildBrowseStops === 'function') buildBrowseStops();
      if (typeof refreshBrowseBuses === 'function') refreshBrowseBuses(true);
    }
  }
  function pollAlerts() {
    var proxy = (window.FORGE_LIVE_PROXY || '').replace(/\/$/, '');
    if (!proxy) return;
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 15000);
    fetch(proxy + '/alerts.json', { cache: 'no-store', signal: ctrl.signal })
      .then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error('http ' + r.status); return r.json(); },
            function (e) { clearTimeout(timer); throw e; })
      .then(function (d) {
        if (!d || !Array.isArray(d.alerts)) throw new Error('bad payload');
        // SMART service alerts are not published to this feed: the
        // Swiftly grant does not enable service alerts, and no SMART
        // alerts design exists. Any SMART record is dropped at ingest,
        // with its source line, as a standing guard.
        mergeAlerts(d.alerts.filter(function (a) { return a && a.agency !== 'smart'; }));
        alertsState.sources = (Array.isArray(d.sources) ? d.sources : [])
          .filter(function (s) { return s && s.agency !== 'smart'; });
        alertsState.ok = true;
        try { refreshAlertSurfaces(); } catch (e) { /* UI refresh must never mark the feed down */ }
      })
      .catch(function () {
        // Endpoint absent (proxy not yet deployed) or fetch failed:
        // silent degradation — badges, bands and overlays all clear.
        alertsState.ok = false;
        try { refreshAlertSurfaces(); } catch (e) { /* never throw from the poll */ }
      });
  }
  function startAlertsPoll() {
    pollAlerts();
    setInterval(function () { if (!document.hidden) pollAlerts(); }, 120000);
  }

  // --- beta tiles (filed 2026-10-09; approved 2026-10-14) ------------------
  // Three live-help surfaces, each with its own named opt-in toggle in
  // the filter panel (Justin's direction 2026-10-15: the umbrella "Beta
  // tiles" gate was ambiguous, so the features are named and switched
  // individually). Each defaults OFF until the rider opts in, and each
  // choice persists in its own localStorage key ('lt-stop-tiles',
  // 'lt-upcoming-stops', 'lt-suggest-transfer'). Migration: the retired
  // umbrella key 'lt-beta-tiles' is read once on first load \u2014 a feature
  // with no stored key of its own starts from the umbrella value, which
  // is then persisted under the feature's own key, and the umbrella key
  // is removed. (1) Stop tiles: the stop card's live rows add the bus
  // number (renderStopLive, above). (2) Upcoming stops: the bus card
  // lists the selected bus's next stops with time estimates from its
  // matched arc position and the empirical segment speeds. (3) Suggest
  // transfer: a tile in the trip planner ranks live buses approaching
  // stops near the trip origin by walk + wait, recomputed from live
  // positions on every poll \u2014 dynamic rerouting from real-time
  // intersecting-route ETAs, not scheduled times.
  var stopTilesOn = false, upcomingStopsOn = false, suggestTransferOn = false;
  try {
    var _tileUmbrella = localStorage.getItem('lt-beta-tiles');
    var _tileInit = function (key) {
      var v = localStorage.getItem(key);
      if (v === null) {
        v = _tileUmbrella === '1' ? '1' : '0';
        try { localStorage.setItem(key, v); } catch (e) {}
      }
      return v === '1';
    };
    stopTilesOn = _tileInit('lt-stop-tiles');
    upcomingStopsOn = _tileInit('lt-upcoming-stops');
    suggestTransferOn = _tileInit('lt-suggest-transfer');
    if (_tileUmbrella !== null) { try { localStorage.removeItem('lt-beta-tiles'); } catch (e) {} }
  } catch (e) {}
  var BETA_WALK_MPS = 1.4;      // the timetable's walk speed (build-timetable.py)
  var BETA_RADIUS_M = 1250;     // NEAR_ME_M \u2014 the "routes near me" radius
  var BETA_FALLBACK_MPS = 8.9;  // ~20 mph when no empirical speed is known

  // Seconds to ride along pathIdx from arc s0 to s1 (s1 > s0), summing
  // per-segment times at empirical speeds; the stretch past the last
  // mapped segment rides at the fallback speed. null when there is no
  // segment coverage and no fallback speed to ride at.
  function betaRideSecs(routeId, pathIdx, s0, s1, fallbackMps) {
    if (s1 <= s0) return 0;
    var segs = routeSegments(routeId), covered = 0, secs = 0;
    for (var i = 0; i < segs.length; i++) {
      var g = segs[i];
      if (g.pathIdx !== pathIdx) continue;
      var a = Math.max(s0, g.s0), b = Math.min(s1, g.s1);
      if (b <= a) continue;
      var v = empiricalSpeed(routeId, g) || fallbackMps || BETA_FALLBACK_MPS;
      secs += (b - a) / v; covered += (b - a);
    }
    var fb = fallbackMps || BETA_FALLBACK_MPS;
    if (!covered && !fb) return null;
    if (covered < (s1 - s0) - 1) secs += ((s1 - s0) - covered) / fb;
    return secs;
  }

  function betaMins(secs) {
    if (secs == null) return '\u2014';
    var m = Math.round(secs / 60);
    return m < 1 ? '<1 min' : m + ' min';
  }

  function betaNoteRow(list, text) {
    var p = document.createElement('p');
    p.className = 'beta-note';
    p.textContent = text;
    list.appendChild(p);
  }

  // (2) Upcoming stops for the selected bus: stops ahead of the bus's
  // filtered arc position on its current path, in order, with cumulative
  // time estimates. Honest states: unmatched (off the mapped shape) and
  // terminus (no stops ahead) say so in words instead of listing nothing.
  function betaUpcoming(v) {
    var tr = busTrackers[v.vehicle_id];
    if (!tr || !tr.arc || tr.pathIdx < 0) return { state: 'unmatched' };
    var smap = stopArcMap(v.route_id, tr.pathIdx);
    var byId = {};
    stopsByRoute(v.route_id).forEach(function (st) { byId[st.id] = st; });
    var ups = [];
    for (var sid in smap) {
      if (smap[sid] > tr.s + 25 && byId[sid]) ups.push({ stop: byId[sid], s: smap[sid] });
    }
    ups.sort(function (a, b) { return a.s - b.s; });
    if (!ups.length) return { state: 'terminus' };
    var fb = tr.speedMps > 0.5 ? tr.speedMps : null;
    var out = [], cum = 0, prev = tr.s, ok = true;
    ups.slice(0, 6).forEach(function (u) {
      var leg = betaRideSecs(v.route_id, tr.pathIdx, prev, u.s, fb);
      if (leg == null) ok = false; else cum += leg;
      out.push({ name: u.stop.n || 'Stop', secs: ok ? cum : null });
      prev = u.s;
    });
    return { state: 'ok', stops: out };
  }

  function renderBusUpcoming() {
    var host = $('bus-upcoming'), list = $('bus-upcoming-list');
    if (!host || !list) return;
    var v = null;
    if (upcomingStopsOn && selectedVehicleId && lastVehicles) {
      for (var i = 0; i < lastVehicles.length; i++) {
        if (lastVehicles[i].vehicle_id === selectedVehicleId) { v = lastVehicles[i]; break; }
      }
    }
    if (!v) { host.hidden = true; return; }
    var r = betaUpcoming(v);
    host.hidden = false;
    list.innerHTML = '';
    if (r.state !== 'ok') {
      betaNoteRow(list, r.state === 'terminus'
        ? 'This bus is at the end of its trip \u2014 no more stops on this run.'
        : 'This bus is off its mapped route right now, so its upcoming stops cannot be estimated.');
      return;
    }
    r.stops.forEach(function (u, i) {
      var row = document.createElement('div');
      row.className = 'beta-row';
      var b = document.createElement('b');
      b.textContent = (i === 0 ? 'Next: ' : '') + u.name;
      row.appendChild(b);
      var t = document.createElement('span');
      t.textContent = '~' + betaMins(u.secs);
      row.appendChild(t);
      list.appendChild(row);
    });
  }

  // (3) Suggest transfer: from the trip origin (the From point, else the
  // rider's located position), take each route's nearest stop, find the
  // soonest live bus still approaching that stop, and rank routes by
  // walk time + wait. A bus that has already passed the stop is excluded
  // \u2014 the suggestion must be catchable, which is the filed point of
  // the tile: efficient transfers despite schedule deviations.
  function betaOrigin() {
    if (tripFrom) {
      if (tripFrom.kind === 'stop') {
        var st = stopData && stopData[tripFrom.idx];
        if (st) return { x: st.x, z: st.z };
      }
      if (tripFrom.kind === 'loc') return { x: tripFrom.x, z: tripFrom.z };
    }
    if (typeof userXZ !== 'undefined' && userXZ) return { x: userXZ[0], z: userXZ[1] };
    return null;
  }

  function betaSuggest() {
    var o = betaOrigin();
    if (!o) return { state: 'no-origin' };
    if (!stopData || !lastVehicles) return { state: 'no-data' };
    var near = {}; // rid -> [{stop, dist}...] nearest first: the tile
    // boards at the nearest stop a live bus is still approaching (the
    // nearest stop overall may already have been served by that bus).
    for (var i = 0; i < stopData.length; i++) {
      var st = stopData[i];
      var d = Math.hypot(st.x - o.x, st.z - o.z);
      if (d > BETA_RADIUS_M) continue;
      (st.r || []).forEach(function (rid) {
        (near[rid] = near[rid] || []).push({ stop: st, dist: d });
      });
    }
    for (var r0 in near) near[r0].sort(function (a, b) { return a.dist - b.dist; });
    // Optional signal: routes that also stop within the radius of the
    // trip destination \u2014 proximity only, stated as proximity.
    var destNear = {};
    if (tripTo && tripTo.kind === 'stop' && stopData[tripTo.idx]) {
      var ds = stopData[tripTo.idx];
      for (var j = 0; j < stopData.length; j++) {
        var s2 = stopData[j];
        if (Math.hypot(s2.x - ds.x, s2.z - ds.z) > BETA_RADIUS_M) continue;
        (s2.r || []).forEach(function (rid) { destNear[rid] = true; });
      }
    }
    var out = [];
    for (var rid in near) {
      var best = null;
      for (var ci = 0; ci < near[rid].length && !best; ci++) {
        var cand = near[rid][ci];
        for (var k = 0; k < lastVehicles.length; k++) {
          var v = lastVehicles[k];
          if (v.route_id !== rid) continue;
          var tr = busTrackers[v.vehicle_id];
          if (!tr || !tr.arc || tr.pathIdx < 0) continue;
          var ss = stopArcMap(rid, tr.pathIdx)[cand.stop.id];
          if (ss == null || ss <= tr.s + 10) continue; // already passed this stop
          var eta = betaRideSecs(rid, tr.pathIdx, tr.s, ss, tr.speedMps > 0.5 ? tr.speedMps : null);
          if (eta == null) continue;
          var total = cand.dist / BETA_WALK_MPS + eta;
          if (!best || total < best.total) best = { v: v, eta: eta, total: total, stop: cand.stop, walk: cand.dist / BETA_WALK_MPS };
        }
      }
      if (best) out.push({ rid: rid, stop: best.stop, walk: best.walk, eta: best.eta, bus: best.v.vehicle_id, nearDest: !!destNear[rid] });
    }
    out.sort(function (a, b) { return a.total - b.total; });
    return { state: 'ok', options: out.slice(0, 4) };
  }

  function renderSuggest() {
    var host = $('suggest-tile'), list = $('suggest-list'), note = $('suggest-note');
    if (!host || !list) return;
    if (!suggestTransferOn || !tripMode) { host.hidden = true; return; }
    var r = betaSuggest();
    host.hidden = false;
    list.innerHTML = '';
    if (note) note.textContent = 'Live estimates from bus positions right now. The planner above uses scheduled times.';
    if (r.state === 'no-origin') { betaNoteRow(list, 'Set a From point \u2014 or tap Locate \u2014 so this tile can work from where you are.'); return; }
    if (r.state !== 'ok' || !r.options.length) { betaNoteRow(list, 'No live buses are approaching stops near the start point right now.'); return; }
    r.options.forEach(function (op) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'beta-row beta-suggest-row';
      row.setAttribute('aria-label', 'Begin trip: board ' + routeLabel(op.rid) + ' bus ' + op.bus + ' at ' + (op.stop.n || 'stop'));
      var b = document.createElement('b');
      b.textContent = routeLabel(op.rid) + ' · Bus ' + op.bus + ' at ' + (op.stop.n || 'stop');
      row.appendChild(b);
      var t = document.createElement('span');
      t.textContent = 'bus ~' + betaMins(op.eta) + ' \u00b7 ' + betaMins(op.walk) + ' walk';
      row.appendChild(t);
      // Begin trip: the suggestion names a specific catchable bus at a
      // specific stop, so tapping it starts the trip from that stop —
      // the same origin path as tapping the stop on the map (setTripFrom
      // + replan), keeping the rider inside the planner. The bus card is
      // deliberately not opened here: showBus() covers the trip card
      // (exclCover), which would hide the plan the rider just started.
      row.addEventListener('click', function () {
        tapBuzz();
        var idx = stopData ? stopData.indexOf(op.stop) : -1;
        if (idx < 0) return;
        setTripFrom({ kind: 'stop', idx: idx });
        renderTripFields();
        updateTripMarkers();
        maybeReplan();
        announceSr('Trip origin set to ' + (op.stop.n || 'stop') + '. Board ' + routeLabel(op.rid) + ' bus ' + op.bus + ' there.');
      });
      list.appendChild(row);
      if (op.nearDest) {
        var s = document.createElement('div');
        s.className = 'beta-sub';
        s.textContent = 'Route ' + routeLabel(op.rid) + ' also stops near your destination.';
        list.appendChild(s);
      }
    });
  }

  function renderBetaTiles() {
    renderBusUpcoming();
    renderSuggest();
  }

  // Toggle wiring \u2014 one aria-pressed toggle per feature in the
  // filter panel, each persisting its own key.
  (function wireTileToggles() {
    var defs = [
      { id: 'stop-tiles-toggle', key: 'lt-stop-tiles',
        get: function () { return stopTilesOn; }, set: function (v) { stopTilesOn = v; } },
      { id: 'upcoming-stops-toggle', key: 'lt-upcoming-stops',
        get: function () { return upcomingStopsOn; }, set: function (v) { upcomingStopsOn = v; } },
      { id: 'suggest-transfer-toggle', key: 'lt-suggest-transfer',
        get: function () { return suggestTransferOn; }, set: function (v) { suggestTransferOn = v; } }
    ];
    defs.forEach(function (d) {
      var btn = $(d.id);
      if (!btn) return;
      var sync = function () { btn.setAttribute('aria-pressed', String(d.get())); };
      btn.addEventListener('click', function () {
        d.set(!d.get());
        try { localStorage.setItem(d.key, d.get() ? '1' : '0'); } catch (e) {}
        sync();
        if (selectedStop) renderStopLive();
        renderBetaTiles();
      });
      sync();
    });
  })();

  // --- MoGo bikeshare station layer ---------------------------------------
  // Live station availability from MoGo's public GBFS v3.0 feed
  // (detroit.publicbikesystem.net), rendered as its own THREE group with
  // its own filter-panel toggle — the People Mover layer's pattern, except
  // this feed is live: station_status polls every 60 s on the bus cadence.
  //
  // Transport: DIRECT client-side fetch, no proxy. Verified 2026-10-14:
  // GET station_information / station_status with an Origin header for
  // this site returns 200 with `Access-Control-Allow-Origin: *`; the feed
  // is no-auth and the request is a simple GET (no preflight), so the
  // browser can read it itself. Client-side also holds the privacy bar:
  // nothing about the rider leaves the device. (A curl HEAD probe from a
  // shell returned 403 — a probe artifact; the GET evidence governs.)
  //
  // Data rules (recon 2026-10-05, enforced by the station-layer suite):
  // canonical availability is the v3.0 vehicle count + per-type rows; the
  // deprecated v2.x availability field is zero everywhere upstream and is
  // never read. Stations whose last_reported is over 5 minutes old (or
  // which are not installed) are QUARANTINED: grey, flattened markers,
  // excluded from planner bike legs, and their cards say so in words.
  // Zero-bike stations stay visible, dimmed and shortened — a rider's
  // corner station reading empty is information, not noise. Stations that
  // can neither rent nor return are not rendered.
  //
  // Nothing is carried by color alone: marker HEIGHT encodes state
  // (full = bikes available, half = empty, low = stale), an e-assist ring
  // circles stations with an EFIT available, a count badge ("🚲 N", or
  // the word "stale") appears at close zoom, the stop card states bikes,
  // docks and status in words, and #mogo-sr names every shown station's
  // state in text for screen readers. Feed failure is an honest state,
  // not a silent one: markers clear, the toggle reads "unavailable", and
  // the SR note says the feed could not be loaded. No toast on the map.
  var MOGO_GBFS_BASE = 'https://detroit.publicbikesystem.net/customer/gbfs/v3.0';
  var MOGO_POLL_MS = 60000;
  var MOGO_INFO_RECHECK_MS = 60 * 60 * 1000;
  var MOGO_FETCH_TIMEOUT_MS = 20000;
  var MOGO_STALE_MS = 5 * 60 * 1000;
  var MOGO_LIVE_TYPES = ['ICONIC', 'EFIT'];
  var MOGO_DOT_COLORS = { green: '#2ecc71', amber: '#f5a623', red: '#e5484d', grey: '#8a8f98' };
  var MOGO_BASE_H = 75; // same base height as a single-route stop pylon
  var mogoState = { ok: false, layer: null, fetchedAtMs: 0 };
  var mogoVisible = false; // default OFF per Justin 2026-10-14 (design of record was ON, design 2026-10-05)
  var mogoInfoCache = null, mogoInfoFetchedAtMs = 0;
  var mogoGroup = null, mogoIM = null, mogoRingIM = null;
  var mogoBadges = [];     // one THREE.Sprite per rendered station
  var mogoPickList = [];   // {id, n, x, z, r:[], mogo:true, station}
  var mogoBadgeTexCache = {};
  var _mogoM4 = null, _mogoP3 = null, _mogoQ = null, _mogoS3 = null, _mogoCol = null, _mogoV3 = null;

  // --- data layer: ES5 port of hidden_files/mogo/station-layer/lib/mogo.js
  // (the suite-tested module; the client harness re-verifies equivalence
  // against it on the pinned fixtures — do not let the two drift).
  function mogoEnName(localized) {
    if (typeof localized === 'string') return localized;
    if (!Array.isArray(localized)) return '';
    var en = null, i;
    for (i = 0; i < localized.length; i++) {
      if (localized[i] && localized[i].language === 'en') { en = localized[i]; break; }
    }
    var pick = en || localized[0];
    return (pick && pick.text) || '';
  }
  function mogoTypeCounts(vehicleTypesAvailable) {
    var counts = {};
    (vehicleTypesAvailable || []).forEach(function (row) {
      if (row && row.vehicle_type_id) counts[row.vehicle_type_id] = Number(row.count) || 0;
    });
    return counts;
  }
  function mogoBuildStation(info, status, nowMs) {
    var st = status || {};
    var reported = st.last_reported ? new Date(st.last_reported).getTime() : NaN;
    var stale = !isFinite(reported) || (nowMs - reported) > MOGO_STALE_MS;
    var installed = st.is_installed === true;
    var renting = st.is_renting === true;
    var returning = st.is_returning === true;
    var vehiclesTotal = Number(st.num_vehicles_available) || 0;
    var docksTotal = Number(st.num_docks_available) || 0;
    var counts = mogoTypeCounts(st.vehicle_types_available);
    var iconic = counts.ICONIC || 0;
    var efit = counts.EFIT || 0;
    var retiredNonzero = {};
    Object.keys(counts).forEach(function (t) {
      if (MOGO_LIVE_TYPES.indexOf(t) < 0 && counts[t] > 0) retiredNonzero[t] = counts[t];
    });
    return {
      id: String(info.station_id),
      name: mogoEnName(info.name),
      lat: Number(info.lat),
      lon: Number(info.lon),
      address: info.address || '',
      capacity: Number(info.capacity) || 0,
      installed: installed, renting: renting, returning: returning, stale: stale,
      vehiclesTotal: vehiclesTotal, docksTotal: docksTotal,
      iconic: iconic, efit: efit, otherNonzero: retiredNonzero,
      vehicleDocksAvailable: st.vehicle_docks_available || [],
      eligiblePickup: installed && renting && vehiclesTotal >= 1 && !stale,
      eligibleDropoff: installed && returning && docksTotal >= 1 && !stale,
      statusClass: (!installed || stale) ? 'quarantined'
        : vehiclesTotal >= 5 ? 'plenty' : vehiclesTotal >= 1 ? 'low' : 'empty',
      statusHue: (!installed || stale) ? 'grey'
        : vehiclesTotal >= 5 ? 'green' : vehiclesTotal >= 1 ? 'amber' : 'red',
      efitRing: efit >= 1,
      visible: installed && (renting || returning),
      lastReported: st.last_reported || null,
      updatedAgeMs: isFinite(reported) ? Math.max(0, nowMs - reported) : null
    };
  }
  function mogoBuildLayer(infoPayload, statusPayload, nowMs) {
    var infos = (infoPayload && infoPayload.data && infoPayload.data.stations) || [];
    var statusById = {};
    ((statusPayload && statusPayload.data && statusPayload.data.stations) || []).forEach(function (s) {
      statusById[String(s.station_id)] = s;
    });
    var stations = infos.map(function (info) {
      return mogoBuildStation(info, statusById[String(info.station_id)], nowMs);
    });
    var byId = {};
    stations.forEach(function (s) { byId[s.id] = s; });
    function sum(f) { return stations.reduce(function (a, s) { return a + f(s); }, 0); }
    function cnt(f) { return stations.filter(f).length; }
    var summary = {
      stationCount: stations.length,
      visible: cnt(function (s) { return s.visible; }),
      renting: cnt(function (s) { return s.renting && s.installed; }),
      withVehicles: cnt(function (s) { return s.vehiclesTotal >= 1; }),
      totalVehicles: sum(function (s) { return s.vehiclesTotal; }),
      totalIconic: sum(function (s) { return s.iconic; }),
      totalEfit: sum(function (s) { return s.efit; }),
      totalDocks: sum(function (s) { return s.docksTotal; }),
      quarantined: cnt(function (s) { return s.stale || !s.installed; }),
      pickupEligible: cnt(function (s) { return s.eligiblePickup; }),
      dropoffEligible: cnt(function (s) { return s.eligibleDropoff; })
    };
    return { stations: stations, byId: byId, summary: summary };
  }
  function mogoPanelTally(summary) {
    var v = summary ? summary.totalVehicles : 0;
    var s = summary ? summary.withVehicles : 0;
    return v + ' bike' + (v === 1 ? '' : 's') + ' · ' + s + ' station' + (s === 1 ? '' : 's') + ' live';
  }
  // Plain-language status sentence — the words that accompany every
  // marker treatment, in the card, the SR list, and the toggle note.
  function mogoStatusSentence(st) {
    if (!st.installed) return 'This station is not installed.';
    if (st.stale) return 'This station\u2019s feed reports are stale \u2014 its counts may be out of date, and it is excluded from trip-planner bike legs.';
    if (st.renting && st.returning) return 'Renting and accepting returns.';
    if (st.renting) return 'Renting only \u2014 returns are not accepted here.';
    if (st.returning) return 'Returns only \u2014 no rentals here.';
    return 'Not renting or accepting returns.';
  }
  function mogoSrText(st) {
    var s = st.name + ': ';
    if (!st.installed) return s + 'not installed.';
    if (st.stale) return s + 'station reports are stale; availability may be out of date.';
    if (st.vehiclesTotal === 0) s += 'no bikes available';
    else {
      s += st.vehiclesTotal + (st.vehiclesTotal === 1 ? ' bike' : ' bikes') + ' available';
      var parts = [];
      if (st.iconic > 0) parts.push(st.iconic + ' standard');
      if (st.efit > 0) parts.push(st.efit + ' e-assist');
      if (parts.length) s += ' (' + parts.join(', ') + ')';
    }
    s += ', ' + st.docksTotal + (st.docksTotal === 1 ? ' dock' : ' docks') + ' available.';
    return s;
  }
  function mogoBadgeText(st) {
    if (!st.installed || st.stale) return 'stale';
    return '\uD83D\uDEB2 ' + st.vehiclesTotal; // "🚲 N" — count text, not color alone
  }
  // Stop-card model: mirrors lib buildStationCard; zero rows for vehicle
  // types are omitted (retired fleets are noise), the total is always
  // stated in the card's Bikes line by the caller.
  function mogoCardModel(station, nowMs) {
    if (!station) return null;
    var lines = [];
    if (station.iconic > 0) lines.push({ label: 'Standard bikes', value: String(station.iconic) });
    if (station.efit > 0) lines.push({ label: 'E-assist bikes', value: String(station.efit) });
    Object.keys(station.otherNonzero || {}).forEach(function (t) {
      if (station.otherNonzero[t] > 0) lines.push({ label: t, value: String(station.otherNonzero[t]) });
    });
    lines.push({ label: 'Docks available', value: String(station.docksTotal) });
    var ageMs = station.updatedAgeMs;
    var updated = (station.stale || ageMs === null || ageMs === undefined) ? 'stale'
      : ageMs < 60000 ? 'updated just now'
      : 'updated ' + Math.round(ageMs / 60000) + ' min ago';
    return {
      title: station.name,
      address: station.address || '',
      bikesLine: station.stale ? 'Counts may be out of date'
        : station.vehiclesTotal === 0 ? 'No bikes available'
        : station.vehiclesTotal + (station.vehiclesTotal === 1 ? ' bike available' : ' bikes available'),
      lines: lines,
      status: mogoStatusSentence(station),
      updated: updated,
      pickupEligible: station.eligiblePickup,
      dropoffEligible: station.eligibleDropoff
    };
  }

  // --- rendering ------------------------------------------------------------
  function mogoEnsureMeshes() {
    if (mogoGroup) return;
    _mogoM4 = new THREE.Matrix4(); _mogoP3 = new THREE.Vector3();
    _mogoQ = new THREE.Quaternion(); _mogoS3 = new THREE.Vector3();
    _mogoCol = new THREE.Color(); _mogoV3 = new THREE.Vector3();
    mogoGroup = new THREE.Group();
    mogoGroup.name = 'mogo-bikeshare';
    mogoIM = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(16, 20, 1, 10),
      new THREE.MeshLambertMaterial({ color: 0xffffff }), 96);
    mogoIM.frustumCulled = false;
    mogoIM.count = 0;
    mogoGroup.add(mogoIM);
    var ringGeo = new THREE.RingGeometry(30, 44, 28);
    if (ringGeo.rotateX) ringGeo.rotateX(-Math.PI / 2);
    mogoRingIM = new THREE.InstancedMesh(ringGeo,
      new THREE.MeshBasicMaterial({ color: 0xF5F2EA, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }), 96);
    mogoRingIM.frustumCulled = false;
    mogoRingIM.count = 0;
    mogoGroup.add(mogoRingIM);
    mogoGroup.visible = false;
    scene.add(mogoGroup);
  }
  function mogoHeightFor(st) {
    // Height encodes state alongside color: full = bikes available,
    // half = empty, low = quarantined (stale / not installed).
    if (st.statusClass === 'quarantined') return 22;
    if (st.vehiclesTotal === 0) return 40;
    return MOGO_BASE_H;
  }
  function mogoBadgeTexture(text) {
    var hit = mogoBadgeTexCache[text];
    if (hit) return hit;
    var c = document.createElement('canvas');
    var x = c.getContext('2d');
    x.font = '600 30px system-ui, -apple-system, sans-serif';
    var w = Math.ceil(x.measureText(text).width) + 40;
    c.width = w; c.height = 54;
    var g = x;
    g.fillStyle = 'rgba(10,14,18,0.85)';
    g.beginPath();
    if (g.roundRect) g.roundRect(0, 0, c.width, c.height, 13); else g.rect(0, 0, c.width, c.height);
    g.fill();
    g.font = '600 30px system-ui, -apple-system, sans-serif';
    g.fillStyle = '#F5F2EA'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, c.width / 2, c.height / 2 + 1);
    var t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    var o = { tex: t, aspect: c.width / c.height };
    mogoBadgeTexCache[text] = o;
    return o;
  }
  function mogoWriteMarkers() {
    mogoEnsureMeshes();
    var layer = mogoState.layer;
    var list = layer ? layer.stations.filter(function (s) { return s.visible; }) : [];
    mogoPickList = [];
    var ringIdx = 0;
    for (var i = 0; i < list.length; i++) {
      var st = list[i];
      var xy = project(st.lat, st.lon);
      var h = mogoHeightFor(st) * stopYS;
      _mogoP3.set(xy[0], STOP_BASE_Y + h / 2, xy[1]);
      _mogoQ.identity();
      _mogoS3.set(1, h, 1);
      _mogoM4.compose(_mogoP3, _mogoQ, _mogoS3);
      mogoIM.setMatrixAt(i, _mogoM4);
      _mogoCol.set(MOGO_DOT_COLORS[st.statusHue] || MOGO_DOT_COLORS.grey);
      if (st.statusClass === 'quarantined') _mogoCol.multiplyScalar(0.6);
      else if (st.vehiclesTotal === 0) _mogoCol.multiplyScalar(0.5);
      mogoIM.setColorAt(i, _mogoCol);
      if (st.efitRing) {
        _mogoP3.set(xy[0], STOP_BASE_Y + 4, xy[1]);
        _mogoS3.set(1, 1, 1);
        _mogoM4.compose(_mogoP3, _mogoQ, _mogoS3);
        mogoRingIM.setMatrixAt(ringIdx++, _mogoM4);
      }
      var rec = { id: st.id, n: st.name, x: xy[0], z: xy[1], r: [], mogo: true, station: st };
      mogoPickList.push(rec);
      var badge = mogoBadges[i];
      if (!badge) {
        badge = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 }));
        badge.renderOrder = 35;
        badge.visible = false;
        mogoGroup.add(badge);
        mogoBadges[i] = badge;
      }
      var bt = mogoBadgeText(st);
      if (badge.userData.text !== bt) {
        var o = mogoBadgeTexture(bt);
        badge.material.map = o.tex;
        badge.material.needsUpdate = true;
        badge.userData.text = bt;
        badge.userData.aspect = o.aspect;
      }
      badge.scale.set(46 * (badge.userData.aspect || 1), 46, 1);
      badge.position.set(xy[0], STOP_BASE_Y + h + 48, xy[1]);
    }
    mogoIM.count = list.length;
    mogoIM.instanceMatrix.needsUpdate = true;
    if (mogoIM.instanceColor) mogoIM.instanceColor.needsUpdate = true;
    mogoRingIM.count = ringIdx;
    mogoRingIM.instanceMatrix.needsUpdate = true;
    for (var j = list.length; j < mogoBadges.length; j++) {
      if (mogoBadges[j]) mogoBadges[j].visible = false;
    }
    mogoGroup.visible = !!(mogoVisible && mogoState.ok && list.length);
  }
  // Zoom-coupled rescale, called from easeStopScale: station markers are
  // the stop family, so they ride the same eased scale.
  function mogoRescale() {
    if (!mogoGroup || !mogoState.layer) return;
    mogoWriteMarkers();
  }
  // Per-frame hook from the animate loop: count badges follow the
  // street-zoom declutter rule — visible at close zoom only, never all
  // 81 citywide at once.
  function mogoFrameTick(camDist) {
    if (!mogoGroup) return;
    var show = mogoGroup.visible && camDist < 9000;
    for (var i = 0; i < mogoPickList.length; i++) {
      var b = mogoBadges[i];
      if (b && b.visible !== show) b.visible = show;
    }
  }
  // Screen-space nearest station (mirrors pickPMStation: proximity, not
  // raycast — the markers are small and raycasting them would be fiddly).
  function pickMogoStation(cx, cy, isTouch) {
    if (!mogoGroup || !mogoGroup.visible || !mogoPickList.length) return null;
    var r = renderer.domElement.getBoundingClientRect();
    var sx = cx - r.left, sy = cy - r.top;
    var best = null, bestD = isTouch ? 48 : 26;
    for (var i = 0; i < mogoPickList.length; i++) {
      var s = mogoPickList[i];
      _mogoV3.set(s.x, STOP_BASE_Y + 40, s.z).project(camera);
      if (_mogoV3.z > 1 || _mogoV3.z < -1) continue;
      var px = (_mogoV3.x * 0.5 + 0.5) * r.width, py = (-_mogoV3.y * 0.5 + 0.5) * r.height;
      var d = Math.hypot(px - sx, py - sy);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  // --- stop-card section ------------------------------------------------------
  // The stop card is the shared detail surface (People Mover stations use
  // it too). For a MoGo record, renderStopMogo fills the bikeshare section
  // and relabels the two generic rows; for any other stop it hides the
  // section and restores the labels.
  function renderStopMogo(st) {
    var sec = $('stop-mogo');
    if (!sec) return;
    var idDt = $('stop-id-dt'), srvDt = $('stop-nroutes-dt');
    if (!st || !st.mogo || !st.station) {
      sec.hidden = true;
      if (idDt) idDt.textContent = 'Stop ID';
      if (srvDt) srvDt.textContent = 'Serving';
      return;
    }
    var m = mogoCardModel(st.station, Date.now());
    if (idDt) idDt.textContent = 'Station ID';
    if (srvDt) srvDt.textContent = 'Bikes';
    $('stop-id').textContent = st.station.id;
    $('stop-nroutes').textContent = m.bikesLine;
    var dl = $('stop-mogo-dl');
    dl.innerHTML = '';
    m.lines.forEach(function (ln) {
      var dt = document.createElement('dt'); dt.textContent = ln.label;
      var dd = document.createElement('dd'); dd.textContent = ln.value;
      dl.appendChild(dt); dl.appendChild(dd);
    });
    var note = $('stop-mogo-note');
    var bits = [];
    // Address bit: this feed's address field duplicates the station name
    // for nearly every station (74 of 81 in the pinned 2026-10-14
    // snapshot; most of the rest differ only by the feed's leading '*'
    // marker), so printing it verbatim put a garbled name-duplicate —
    // asterisk included — ahead of the status sentence, directly under
    // the Docks row. Show the address only when it says something the
    // card title does not.
    var addrBit = (m.address || '').replace(/^\*\s*/, '');
    var nameBit = (m.title || '').replace(/^\*\s*/, '');
    if (addrBit && addrBit !== nameBit) bits.push(addrBit);
    bits.push(m.status);
    bits.push('Availability ' + m.updated + '.');
    note.textContent = bits.join(' ');
    sec.hidden = false;
  }

  // --- screen-reader surface --------------------------------------------------
  // #mogo-sr names every shown station's state in words (signature-gated,
  // like #alerts-sr); #mogo-live announces only availability transitions,
  // never the 60 s re-poll.
  var mogoSrSig = '', mogoLiveOk = null;
  function renderMogoSr() {
    var list = $('mogo-sr-list');
    if (!list) return;
    var layer = mogoState.layer;
    var shown = (mogoState.ok && layer) ? layer.stations.filter(function (s) { return s.visible; }) : [];
    var sig = (mogoState.ok ? 'ok' : 'down') + '|' + shown.map(function (s) {
      return s.id + ':' + s.vehiclesTotal + ':' + s.docksTotal + ':' + s.statusClass;
    }).join(',');
    if (sig !== mogoSrSig) {
      mogoSrSig = sig;
      list.innerHTML = '';
      shown.forEach(function (st) {
        var li = document.createElement('li');
        li.textContent = mogoSrText(st);
        list.appendChild(li);
      });
      var src = $('mogo-sr-note');
      if (src) {
        src.textContent = !mogoState.ok
          ? 'MoGo bikeshare availability is unavailable \u2014 the GBFS feed could not be loaded.'
          : 'MoGo GBFS feed: ' + layer.summary.stationCount + ' stations, ' + shown.length + ' shown, ' +
            layer.summary.quarantined + ' with stale reports.';
      }
    }
    if (mogoLiveOk !== mogoState.ok) {
      var live = $('mogo-live');
      if (live && mogoLiveOk !== null) {
        live.textContent = mogoState.ok
          ? 'MoGo bikeshare availability loaded: ' + mogoPanelTally(mogoState.layer.summary) + '.'
          : 'MoGo bikeshare availability is unavailable right now.';
      }
      mogoLiveOk = mogoState.ok;
    }
  }

  // --- toggle -----------------------------------------------------------------
  function mogoSyncToggle() {
    var t = $('mogo-toggle');
    if (!t) return;
    t.setAttribute('aria-pressed', String(mogoVisible));
    var c = $('mogo-count');
    if (c) {
      c.textContent = !mogoState.ok ? 'unavailable'
        : mogoState.layer ? mogoPanelTally(mogoState.layer.summary) : 'loading';
    }
  }
  var mogoToggleEl = $('mogo-toggle');
  if (mogoToggleEl && mogoToggleEl.addEventListener) {
    mogoToggleEl.addEventListener('click', function () {
      mogoVisible = !mogoVisible;
      if (mogoGroup) mogoGroup.visible = !!(mogoVisible && mogoState.ok && mogoPickList.length);
      mogoSyncToggle();
      if (!mogoVisible && typeof selectedStop !== 'undefined' && selectedStop && selectedStop.mogo &&
          typeof hideStop === 'function') hideStop();
    });
  }

  // --- poll -------------------------------------------------------------------
  function mogoFetchJson(url) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, MOGO_FETCH_TIMEOUT_MS);
    return fetch(url, { cache: 'no-store', signal: ctrl.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('gbfs http ' + r.status);
        return r.json();
      }, function (e) { clearTimeout(timer); throw e; });
  }
  // station_information geometry moves slowly: re-fetch on a slow
  // cadence, replace the cache only when the feed's last_updated changes.
  function mogoRefreshInfo(force) {
    var t = Date.now();
    if (mogoInfoCache && !force && (t - mogoInfoFetchedAtMs) < MOGO_INFO_RECHECK_MS) {
      return Promise.resolve(mogoInfoCache);
    }
    return mogoFetchJson(MOGO_GBFS_BASE + '/station_information.json').then(function (payload) {
      mogoInfoFetchedAtMs = t;
      if (!mogoInfoCache || payload.last_updated !== mogoInfoCache.last_updated) {
        mogoInfoCache = payload;
      }
      return mogoInfoCache;
    });
  }
  function mogoSetLayer(layer, ok) {
    mogoState.ok = !!ok;
    if (layer) { mogoState.layer = layer; mogoState.fetchedAtMs = Date.now(); }
    // On failure the last layer is kept for the card/SR bookkeeping, but
    try { mogoWriteMarkers(); } catch (e) { /* marker failure must never break the poll */ }
    try { renderMogoSr(); } catch (e) { /* SR failure must never break the poll */ }
    try { mogoSyncToggle(); } catch (e) { /* toggle failure must never break the poll */ }
    if (typeof selectedStop !== 'undefined' && selectedStop && selectedStop.mogo &&
        typeof renderStopMogo === 'function') {
      var fresh = mogoState.layer && mogoState.layer.byId[selectedStop.id];
      if (fresh) { selectedStop.station = fresh; renderStopMogo(selectedStop); }
    }
  }
  function pollMogo() {
    mogoRefreshInfo(false)
      .then(function (info) {
        return mogoFetchJson(MOGO_GBFS_BASE + '/station_status.json').then(function (status) {
          mogoSetLayer(mogoBuildLayer(info, status, Date.now()), true);
        });
      })
      .catch(function () {
        // Feed down: honest unavailable state — markers clear (group hides
        // on ok=false), the toggle reads "unavailable", the SR note says
        // the feed could not be loaded. The next tick retries.
        mogoSetLayer(null, false);
      });
  }
  function startMogoPoll() {
    pollMogo();
    setInterval(function () { if (!document.hidden) pollMogo(); }, MOGO_POLL_MS);
  }
  // Boot: the projection arrives with the route data — start polling as
  // soon as it exists so markers can be placed.
  var mogoBootTimer = setInterval(function () {
    if (typeof proj !== 'undefined' && proj) {
      clearInterval(mogoBootTimer);
      startMogoPoll();
    }
  }, 500);

  // --- Places layer: Starbucks + Planet Fitness ------------------------------
  // Coffee shops and gyms as a static layer over the same street map, on the
  // MoGo layer's pattern: its own THREE group, its own filter-panel toggle,
  // details in the shared stop card, screen-reader text surfaces. Unlike
  // MoGo there is no live feed and no staleness: the dataset is baked at
  // build time into places.json (repo root) and fetched lazily the first
  // time the toggle is enabled.
  //
  // Source data: OpenStreetMap, via the Overpass API (© OpenStreetMap
  // contributors, ODbL — attribution ships in the dataset, the filter-panel
  // note, and every place card). Query: amenity=cafe / leisure=fitness_centre
  // with brand or name matching Starbucks / Planet Fitness. "Within map
  // boundaries" = inside the street-mosaic extent in
  // assets/detroit-streets.json (lat 42.178–42.47997522924901,
  // lon −83.385–−82.8992288); the extent declared in the removed SMART dataset
  // was stale and was not used. Raw pull 118 elements, 44 inside the
  // boundary, 2 building-way/node duplicate pairs deduplicated to a final
  // 42 locations: 31 Starbucks, 11 Planet Fitness. Baking record and the
  // coverage spot checks (OSM reads ~85–88% of in-boundary storefronts;
  // licensed counters inside other stores are the likeliest gaps) live in
  // the places-layer build report.
  //
  // Visual identity: a flat disc, wider and flatter than every pylon on the
  // map (stops and MoGo stations are cylinders on the stop family's height
  // scale; a place is a puck 16 units tall and 64–72 across), colored per
  // brand AND lettered — a canvas badge reading "S" or "PF" appears at
  // close zoom on the same declutter rule as the MoGo count badges, so
  // identity is never carried by color alone. The card and the SR list
  // state brand and address in words wherever the data carries them.
  //
  // Height and glow (2026-10-15, Justin's direction: "Add visual height
  // and glow to POIs for easier identification"): a slim pillar rises
  // from each disc and the letter badge rides at its top, and a soft
  // brand-tinted halo surrounds each marker at every zoom. The pillar is
  // 48 units tall on the stop family's height scale (rides stopYS like
  // the disc height), so the whole marker tops out at (16 + 48) * stopYS
  // = 64 * stopYS — below the stop family's own 75-unit base height
  // before per-route additions (a single-route stop pylon is 103 *
  // stopYS, a bus pillar 220): a place reads as a pin, never as a
  // second skyline, at every zoom, because pillar and stops scale
  // together. The pillar height is deliberately NOT distance-scaled
  // like the footprint: subordination is a world-space property, and
  // far-zoom identification is the glow's job — a distance-growing
  // pillar stacked on the distance-growing disc would rebuild the
  // skyline the height cap exists to prevent. The glow is an
  // additive-blended radial-gradient sprite, diameter 2.2x the disc's,
  // so it tracks the footprint's distance scaling and carries brand
  // identity at the default and city-wide distances where the letter
  // badges are decluttered away. Fair use unchanged: brand colors and
  // letter badges only — no logos or trademarked artwork.
  var PLACES_DATA_URL = 'places.json?v=' + STAMP;
  var PLACES_DISC_H = 16;   // place puck height before the stop family's zoom scale
  var PLACES_PILLAR_H = 48; // pillar height above the disc top, before stopYS
  var PLACES_PILLAR_R = 5;  // pillar radius at the footprint floor; scales with the footprint (~disc diameter / 13)
  var PLACES_GLOW_K = 2.2;  // glow sprite diameter as a multiple of the disc diameter
  var PLACES_GLOW_OPACITY = 0.5; // additive halo strength — a glow, not a blob
  var PLACES_DISC_BASE_D = 64;  // disc diameter at the close-zoom floor (the geometry's own width)
  // Distance-scaling coefficient (2026-10-15 legibility fix): beyond the
  // floor the disc diameter grows in proportion to camera distance —
  // diameter = camDist * K — the street labels' constant-screen-size
  // idiom, so a disc holds ≈16 px on an 844 px-high viewport at every
  // wider zoom. At the pre-fix fixed 64 units a disc projected to
  // ≈3.8 px wide at the default camera distance (18.5k) and ≈1.3 px at
  // maximum zoom-out, which is why enabling the layer produced no
  // visible change on the map. The coefficient matches the POI v2
  // candidate's treatment (files/places-layer/v2/) so the two agree
  // where they overlap.
  var PLACES_DISC_K = 0.0146;
  var placesDiscScaleV = 1;     // current eased disc footprint scale (1 = base diameter)
  var PLACES_BRANDS = {
    starbucks:     { name: 'Starbucks',      kind: 'Coffee shop',    badge: 'S',  color: '#00704A' },
    planetfitness: { name: 'Planet Fitness', kind: 'Fitness centre', badge: 'PF', color: '#5E2590' }
  };
  var placesData = null;          // parsed places.json once loaded
  var placesLoadState = 'idle';   // idle | loading | ok | error
  var placesOn = { starbucks: false, planetfitness: false }; // DEFAULT OFF, session-only (no localStorage) — Justin's MoGo rulings, 2026-10-14
  var placesGroup = null, placesDiscIM = null, placesPillarIM = null;
  var placesBadges = [];          // one THREE.Sprite per rendered place
  var placesGlows = [];           // one additive halo sprite per rendered place
  var placesGlowTex = null;       // shared radial-gradient texture (brand tint is per-sprite)
  var placesPickList = [];        // {id, n, x, z, r: [], place: true, pdata}
  var placesBadgeTexCache = {};
  var _placesM4 = null, _placesP3 = null, _placesQ = null, _placesS3 = null, _placesCol = null, _placesV3 = null;

  function placesEnabledPlaces() {
    if (!placesData || !Array.isArray(placesData.places)) return [];
    return placesData.places.filter(function (p) { return !!placesOn[p.brand]; });
  }

  // --- data -------------------------------------------------------------------
  // Static site file, fetched once, lazily, on the first enable of the
  // toggle (the MoGo layer fetches on enable too — there the feed is
  // live; here the fetch is the whole load). Failure is an honest state:
  // toggles read "unavailable", the SR note says the data could not be
  // loaded, and the next enable retries.
  function placesEnsureData() {
    if (placesData || placesLoadState === 'loading') return;
    placesLoadState = 'loading';
    placesSyncToggles();
    fetch(PLACES_DATA_URL, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('places http ' + r.status);
        return r.json();
      })
      .then(function (d) {
        if (!d || !Array.isArray(d.places)) throw new Error('bad places payload');
        placesData = d;
        placesLoadState = 'ok';
        try { placesWriteMarkers(); } catch (e) { /* marker failure must not break the load */ }
        try { renderPlacesSr(); } catch (e) { /* SR failure must not break the load */ }
        try { placesSyncToggles(); } catch (e) { /* toggle failure must not break the load */ }
      })
      .catch(function () {
        placesLoadState = 'error';
        try { renderPlacesSr(); } catch (e) { /* SR failure must not break the load */ }
        try { placesSyncToggles(); } catch (e) { /* toggle failure must not break the load */ }
        placesAnnounce('Points of interest data could not be loaded.');
      });
  }

  // --- rendering ---------------------------------------------------------------
  // Disc diameter for a camera distance, in world units: the geometry's
  // own 64 below camDist ≈ 4400, distance-proportional beyond it.
  function placesDiscDiamFor(camDist) {
    return Math.max(PLACES_DISC_BASE_D, camDist * PLACES_DISC_K);
  }
  // Rendered disc diameter in CSS pixels (the page's own pixel measure:
  // viewport height over the frustum height at the target distance).
  // Exposed for verification of the legibility fix.
  function placesDiscPx(camDist, viewportH) {
    return placesDiscDiamFor(camDist) * viewportH / (2 * camDist * Math.tan(camera.fov * 0.5 * DEG));
  }
  // Glow diameter for a camera distance, in world units: the disc's
  // distance-scaled diameter times the glow multiple, so the halo holds
  // the same screen size as the disc at every wider zoom.
  function placesGlowDiamFor(camDist) {
    return placesDiscDiamFor(camDist) * PLACES_GLOW_K;
  }
  // Rendered glow diameter in CSS pixels. Exposed for verification of
  // the height-and-glow build, like placesDiscPx.
  function placesGlowPx(camDist, viewportH) {
    return placesGlowDiamFor(camDist) * viewportH / (2 * camDist * Math.tan(camera.fov * 0.5 * DEG));
  }
  function placesEnsureMeshes() {
    if (placesGroup) return;
    _placesM4 = new THREE.Matrix4(); _placesP3 = new THREE.Vector3();
    _placesQ = new THREE.Quaternion(); _placesS3 = new THREE.Vector3();
    _placesCol = new THREE.Color(); _placesV3 = new THREE.Vector3();
    placesGroup = new THREE.Group();
    placesGroup.name = 'places';
    placesDiscIM = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(32, 36, 1, 20),
      new THREE.MeshLambertMaterial({ color: 0xffffff }), 64);
    placesDiscIM.frustumCulled = false;
    placesDiscIM.count = 0;
    placesGroup.add(placesDiscIM);
    // Pillar: unit cylinder with the stop family's taper (14/18 ≈ 1/1.25),
    // instanced like the disc; per-instance scale carries the radius
    // (footprint-coupled) and the height (stopYS-coupled).
    placesPillarIM = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1, 1.25, 1, 10),
      new THREE.MeshLambertMaterial({ color: 0xffffff }), 64);
    placesPillarIM.frustumCulled = false;
    placesPillarIM.count = 0;
    placesGroup.add(placesPillarIM);
    placesGroup.visible = false;
    scene.add(placesGroup);
  }
  // Shared radial-gradient texture for the glow sprites: a white core
  // falling to transparency, tinted per sprite by the material color.
  // One texture for all places — the brand lives in the tint, so no
  // per-brand canvas work is needed.
  function placesGlowTexture() {
    if (placesGlowTex) return placesGlowTex;
    var c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.32)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    placesGlowTex = new THREE.CanvasTexture(c);
    return placesGlowTex;
  }
  function placesBadgeTexture(text) {
    var hit = placesBadgeTexCache[text];
    if (hit) return hit;
    var c = document.createElement('canvas');
    var x = c.getContext('2d');
    x.font = '700 34px system-ui, -apple-system, sans-serif';
    var w = Math.ceil(x.measureText(text).width) + 36;
    c.width = w; c.height = 54;
    var g = x;
    g.fillStyle = 'rgba(10,14,18,0.85)';
    g.beginPath();
    if (g.roundRect) g.roundRect(0, 0, c.width, c.height, 13); else g.rect(0, 0, c.width, c.height);
    g.fill();
    g.font = '700 34px system-ui, -apple-system, sans-serif';
    g.fillStyle = '#F5F2EA'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, c.width / 2, c.height / 2 + 1);
    var t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    var o = { tex: t, aspect: c.width / c.height };
    placesBadgeTexCache[text] = o;
    return o;
  }
  // Disc instance matrices from the pick list, at the current eased
  // footprint scale and the stop family's height scale. Split out of
  // placesWriteMarkers so the per-frame hook can re-scale the discs as
  // the camera distance changes without rebuilding the pick list.
  function placesWriteDiscInstances() {
    if (!placesDiscIM) return;
    var h = PLACES_DISC_H * stopYS;
    for (var i = 0; i < placesPickList.length; i++) {
      var s = placesPickList[i];
      _placesP3.set(s.x, STOP_BASE_Y + h / 2, s.z);
      _placesQ.identity();
      _placesS3.set(placesDiscScaleV, h, placesDiscScaleV);
      _placesM4.compose(_placesP3, _placesQ, _placesS3);
      placesDiscIM.setMatrixAt(i, _placesM4);
    }
    placesDiscIM.count = placesPickList.length;
    placesDiscIM.instanceMatrix.needsUpdate = true;
  }
  // Pillar instance matrices from the pick list: the radius rides the
  // eased footprint scale (a pillar stays ~1/13 of its disc's width at
  // every zoom) and the height rides stopYS (the stop family's scale),
  // so the writer runs wherever the disc writer runs.
  function placesWritePillarInstances() {
    if (!placesPillarIM) return;
    var dh = PLACES_DISC_H * stopYS, ph = PLACES_PILLAR_H * stopYS;
    var r = PLACES_PILLAR_R * placesDiscScaleV;
    for (var i = 0; i < placesPickList.length; i++) {
      var s = placesPickList[i];
      _placesP3.set(s.x, STOP_BASE_Y + dh + ph / 2, s.z);
      _placesQ.identity();
      _placesS3.set(r, ph, r);
      _placesM4.compose(_placesP3, _placesQ, _placesS3);
      placesPillarIM.setMatrixAt(i, _placesM4);
    }
    placesPillarIM.count = placesPickList.length;
    placesPillarIM.instanceMatrix.needsUpdate = true;
  }
  // Glow sprite placement: centered on the marker's vertical span, with
  // the diameter tracking the eased footprint scale. Sprites have no
  // instance buffer, so this is a plain per-sprite loop over at most 42
  // entries; it runs on marker writes and on the per-frame hook (the
  // diameter eases with the footprint).
  function placesSyncGlows() {
    var diam = PLACES_DISC_BASE_D * placesDiscScaleV * PLACES_GLOW_K;
    var cy = STOP_BASE_Y + (PLACES_DISC_H + PLACES_PILLAR_H) * stopYS / 2;
    for (var i = 0; i < placesPickList.length; i++) {
      var glow = placesGlows[i];
      if (!glow) continue;
      var s = placesPickList[i];
      glow.position.set(s.x, cy, s.z);
      glow.scale.set(diam, diam, 1);
      glow.visible = !!(placesGroup && placesGroup.visible);
    }
    for (var j = placesPickList.length; j < placesGlows.length; j++) {
      if (placesGlows[j]) placesGlows[j].visible = false;
    }
  }
  // Static geometry: instance buffers are rebuilt only when the enabled
  // brand set or the zoom scale changes — nothing is allocated per frame.
  function placesWriteMarkers() {
    placesEnsureMeshes();
    var list = placesEnabledPlaces();
    placesPickList = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var b = PLACES_BRANDS[p.brand];
      var xy = project(p.lat, p.lon);
      var h = PLACES_DISC_H * stopYS;
      _placesCol.set(b ? b.color : '#8a8f98');
      placesDiscIM.setColorAt(i, _placesCol);
      placesPillarIM.setColorAt(i, _placesCol);
      placesPickList.push({ id: p.id, n: p.n, x: xy[0], z: xy[1], r: [], place: true, pdata: p });
      var badge = placesBadges[i];
      if (!badge) {
        badge = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 }));
        badge.renderOrder = 35;
        badge.visible = false;
        placesGroup.add(badge);
        placesBadges[i] = badge;
      }
      var bt = b ? b.badge : '?';
      if (badge.userData.text !== bt) {
        var o = placesBadgeTexture(bt);
        badge.material.map = o.tex;
        badge.material.needsUpdate = true;
        badge.userData.text = bt;
        badge.userData.aspect = o.aspect;
      }
      badge.scale.set(40 * (badge.userData.aspect || 1), 40, 1);
      // The badge rides at the pillar's top (disc top + pillar height),
      // with its center one badge-radius and a small gap above it.
      badge.position.set(xy[0], STOP_BASE_Y + h + PLACES_PILLAR_H * stopYS + 26, xy[1]);
      var glow = placesGlows[i];
      if (!glow) {
        glow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: placesGlowTexture(), color: new THREE.Color(b ? b.color : '#8a8f98'),
          blending: THREE.AdditiveBlending, depthWrite: false,
          transparent: true, opacity: PLACES_GLOW_OPACITY }));
        glow.renderOrder = 34; // under the letter badges (35)
        glow.visible = false;
        placesGroup.add(glow);
        placesGlows[i] = glow;
      }
      if (glow.userData.brand !== p.brand) {
        glow.material.color.set(b ? b.color : '#8a8f98');
        glow.userData.brand = p.brand;
      }
    }
    placesWriteDiscInstances();
    placesWritePillarInstances();
    if (placesDiscIM.instanceColor) placesDiscIM.instanceColor.needsUpdate = true;
    if (placesPillarIM.instanceColor) placesPillarIM.instanceColor.needsUpdate = true;
    for (var j = list.length; j < placesBadges.length; j++) {
      if (placesBadges[j]) placesBadges[j].visible = false;
    }
    placesGroup.visible = !!(placesData && placesLoadState === 'ok' && list.length &&
      (placesOn.starbucks || placesOn.planetfitness));
    // Glows sync last: visibility reads the group's final state.
    placesSyncGlows();
  }
  // Zoom-coupled rescale, called from easeStopScale: place pucks are flat
  // members of the ground-marker family and ride the same eased scale.
  function placesRescale() {
    if (!placesGroup || !placesData) return;
    placesWriteMarkers();
  }
  // Per-frame hook from the animate loop: the disc footprint scale
  // eases toward the distance-proportional target (the easeStopScale
  // idiom), and letter badges follow the street-zoom declutter rule —
  // visible at close zoom only (camDist < 9000, the MoGo badge
  // threshold), never all 42 citywide at once.
  function placesFrameTick(camDist) {
    if (!placesGroup) return;
    var target = placesDiscDiamFor(camDist) / PLACES_DISC_BASE_D;
    var dS = target - placesDiscScaleV;
    // The pillar radius and the glow diameter ride the same eased
    // footprint scale, so both are rewritten wherever the discs are.
    if (Math.abs(dS) > 0.003) {
      placesDiscScaleV += dS * 0.16;
      try { placesWriteDiscInstances(); placesWritePillarInstances(); placesSyncGlows(); } catch (e) { /* a failed rewrite retries next frame */ }
    } else if (placesDiscScaleV !== target) {
      placesDiscScaleV = target;
      try { placesWriteDiscInstances(); placesWritePillarInstances(); placesSyncGlows(); } catch (e) { /* a failed rewrite retries next frame */ }
    }
    var show = placesGroup.visible && camDist < 9000;
    for (var i = 0; i < placesPickList.length; i++) {
      var b = placesBadges[i];
      if (b && b.visible !== show) b.visible = show;
    }
  }
  // Screen-space nearest place (mirrors pickMogoStation: proximity, not
  // raycast — the pucks are low and raycasting them would be fiddly).
  function pickPlace(cx, cy, isTouch) {
    if (!placesGroup || !placesGroup.visible || !placesPickList.length) return null;
    var r = renderer.domElement.getBoundingClientRect();
    var sx = cx - r.left, sy = cy - r.top;
    var best = null, bestD = isTouch ? 48 : 26;
    for (var i = 0; i < placesPickList.length; i++) {
      var s = placesPickList[i];
      // Anchor at the pillar's mid-height: the visible column runs from
      // the ground to the pillar top, so the pick target sits mid-column
      // (the bus pillars' idiom — a tap anywhere along the column is
      // closest to its middle). The existing radii (26 px mouse, 48 px
      // touch) already cover the glow at distance-scaled zooms, whose
      // radius is ≈18 px at the default and city-wide distances.
      _placesV3.set(s.x, STOP_BASE_Y + (PLACES_DISC_H + PLACES_PILLAR_H) * stopYS / 2, s.z).project(camera);
      if (_placesV3.z > 1 || _placesV3.z < -1) continue;
      var px = (_placesV3.x * 0.5 + 0.5) * r.width, py = (-_placesV3.y * 0.5 + 0.5) * r.height;
      var d = Math.hypot(px - sx, py - sy);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  // --- stop-card section ---------------------------------------------------------
  // The stop card is the shared detail surface. For a place record,
  // renderStopPlace fills the PLACE section and relabels the two generic
  // rows (Type / Address); the section DL carries the Brand row plus the
  // enrichment rows the record has (Hours / Phone / Website — only rows
  // that have data). For any other record it hides the section, and
  // restores the labels only when a place card was the one showing (the
  // restore is flag-gated so the MoGo branch's labels are never clobbered —
  // showStop calls renderStopMogo first, then this).
  var placeCardActive = false;
  function placesCardModel(p) {
    if (!p) return null;
    var b = PLACES_BRANDS[p.brand] || { name: p.brand || 'Place', kind: 'Place' };
    return {
      title: p.n || b.name,
      brandName: b.name,
      kind: b.kind,
      address: p.addr || null,
      hours: p.hours || null,
      phone: p.phone || null,
      website: p.website || null,
      note: b.name + ' ' + b.kind.toLowerCase() + '. Location from OpenStreetMap ' +
        '(\u00A9 OpenStreetMap contributors, ODbL) \u2014 community map data, which may not list every location.'
    };
  }
  // Screen-reader announcement text for a place card (showStop calls this
  // in place of its generic "routes serve this stop" sentence).
  function placesCardText(st) {
    if (!st || !st.pdata) return 'Place details opened.';
    var m = placesCardModel(st.pdata);
    return 'Place details opened. ' + m.title + '. ' + m.kind +
      (m.address ? '. ' + m.address : '. Address not listed') + '.';
  }
  function placesDlRow(dl, label, value) {
    var dt = document.createElement('dt'); dt.textContent = label;
    var dd = document.createElement('dd'); dd.textContent = value;
    dl.appendChild(dt); dl.appendChild(dd);
  }
  function placesDlLinkRow(dl, label, url) {
    var dt = document.createElement('dt'); dt.textContent = label;
    var dd = document.createElement('dd');
    if (/^https?:\/\//i.test(url)) {
      var a = document.createElement('a');
      a.href = url;
      a.textContent = url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      dd.appendChild(a);
    } else {
      dd.textContent = url;
    }
    dl.appendChild(dt); dl.appendChild(dd);
  }
  function renderStopPlace(st) {
    var sec = $('stop-place');
    if (!sec) return;
    var idDt = $('stop-id-dt'), srvDt = $('stop-nroutes-dt');
    if (!st || !st.place || !st.pdata) {
      sec.hidden = true;
      if (placeCardActive) {
        if (idDt) idDt.textContent = 'Stop ID';
        if (srvDt) srvDt.textContent = 'Serving';
        placeCardActive = false;
      }
      return;
    }
    var m = placesCardModel(st.pdata);
    if (idDt) idDt.textContent = 'Type';
    if (srvDt) srvDt.textContent = 'Address';
    $('stop-id').textContent = m.kind;
    $('stop-nroutes').textContent = m.address || 'Not listed in OpenStreetMap';
    var dl = $('stop-place-dl');
    dl.innerHTML = '';
    placesDlRow(dl, 'Brand', m.brandName);
    if (m.hours) placesDlRow(dl, 'Hours', m.hours);
    if (m.phone) placesDlRow(dl, 'Phone', m.phone);
    if (m.website) placesDlLinkRow(dl, 'Website', m.website);
    $('stop-place-note').textContent = m.note;
    sec.hidden = false;
    placeCardActive = true;
  }

  // --- screen-reader surface -----------------------------------------------------
  // #places-sr names every shown place in words (signature-gated, like
  // #mogo-sr); #places-live announces toggle changes and load failure only —
  // the dataset is static, so there is nothing else to announce.
  var placesSrSig = '';
  function placesSrText(p) {
    var b = PLACES_BRANDS[p.brand];
    return (p.n || (b ? b.name : 'Place')) + (p.addr ? ', ' + p.addr : ' \u2014 address not listed') + '.';
  }
  function renderPlacesSr() {
    var list = $('places-sr-list');
    if (!list) return;
    var shown = placesEnabledPlaces();
    var sig = placesLoadState + '|' + shown.map(function (p) { return p.id; }).join(',');
    if (sig === placesSrSig) return;
    placesSrSig = sig;
    list.innerHTML = '';
    shown.forEach(function (p) {
      var li = document.createElement('li');
      li.textContent = placesSrText(p);
      list.appendChild(li);
    });
    var note = $('places-sr-note');
    if (note) {
      note.textContent = placesLoadState === 'error'
        ? 'Points of interest data is unavailable \u2014 places.json could not be loaded.'
        : placesLoadState === 'ok'
          ? 'Points of interest from OpenStreetMap (\u00A9 OpenStreetMap contributors, ODbL): ' +
            (placesData.meta && placesData.meta.counts ? placesData.meta.counts.total : placesData.places.length) +
            ' points of interest in the dataset, ' + shown.length + ' shown.'
          : 'Points of interest are off. Enable Points of interest in the filter panel to list them here.';
    }
  }
  function placesAnnounce(msg) {
    var live = $('places-live');
    if (live) live.textContent = msg;
  }

  // --- toggle ----------------------------------------------------------------------
  // One "Points of interest" switch in the filter panel drives both
  // brands together, with the group's baked dataset tally. Justin's
  // direction, 2026-10-15: a single toggle for the whole group — the
  // two per-brand sub-toggles were removed; the per-brand distinction
  // lives on the map (disc colors and the S/PF letter badges) and in
  // the dataset, not in panel controls. Default OFF and session-only,
  // matching Justin's MoGo rulings of 2026-10-14: nothing is written
  // to localStorage.
  function placesAllOn() { return !!(placesOn.starbucks && placesOn.planetfitness); }
  function placesSyncToggles() {
    var t = $('places-toggle');
    if (t) t.setAttribute('aria-pressed', String(placesAllOn()));
    var err = placesLoadState === 'error';
    var counts = (placesData && placesData.meta && placesData.meta.counts) || null;
    var allC = $('places-count');
    if (err) {
      if (allC) allC.textContent = 'unavailable';
    } else if (counts) {
      if (allC) allC.textContent = String(counts.total || 0) + ' points of interest';
    }
  }
  (function placesWireToggle() {
    var t = $('places-toggle');
    if (t && t.addEventListener) {
      t.addEventListener('click', function () {
        var on = !placesAllOn();
        placesOn.starbucks = on;
        placesOn.planetfitness = on;
        if (on) placesEnsureData();
        try { placesWriteMarkers(); } catch (e) { /* marker failure must not break the toggle */ }
        placesSyncToggles();
        renderPlacesSr();
        var n = (placesData && placesData.meta && placesData.meta.counts && placesData.meta.counts.total) || 0;
        // On the first enable the lazy fetch has not resolved yet, so the
        // tally is announced only when the dataset is already in hand.
        placesAnnounce(on ? (n ? 'Points of interest shown: ' + n + ' points of interest.' : 'Points of interest shown.') : 'Points of interest hidden.');
        if (!on && typeof selectedStop !== 'undefined' && selectedStop && selectedStop.place &&
            typeof hideStop === 'function') hideStop();
      });
    }
  })();
  placesSyncToggles();
  renderPlacesSr();
  // --- instant paint from logged history ---------------------------------------
  var historyRendered = false;
  function maybeRenderHistory() {
    if (historyRendered || !proj || !historyVehicles) return;
    if (liveEverOk) return; // live data already won the race
    historyRendered = true;
    lastVehicles = historyVehicles;
    var n = updateBuses(historyVehicles);
    historyOk = true;
    lastTotal = n;
    setHeader(n, 'last logged ' + fmtTime(historyAt ? new Date(historyAt) : null) + ' — connecting live…', false);
  }
  var historyVehicles = null;
  var historyAt = null;
  function fetchHistory() {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 10000);
    fetch(HISTORY_URL, { cache: 'no-store', signal: ctrl.signal })
      .then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error('http ' + r.status); return r.json(); },
            function (e) { clearTimeout(timer); throw e; })
      .then(function (d) {
        if (!d || !Array.isArray(d.vehicles)) throw new Error('bad history payload');
        historyVehicles = d.vehicles;
        historyAt = d.polled_at ? new Date(d.polled_at) : null;
        maybeRenderHistory();
      })
      .catch(function () { /* history is a bonus; live poll proceeds regardless */ });
  }

  // --- boot --------------------------------------------------------------------
  function resize() {
    var w = container.clientWidth || 800;
    var h = container.clientHeight || 540;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  Promise.all([
    fetch('ddot-routes-3d.json?v=' + STAMP, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); }),
    fetch('ddot-fleet.json?v=' + STAMP, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }),
    fetch('assets/detroit-streets.json?v=' + STAMP, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }),
    fetch('assets/detroit-street-names.json?v=' + STAMP, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }),
    fetch('peoplemover-3d.json?v=' + STAMP, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }), // static layer is optional: map works without it
    fetch('smart-routes-3d.json?v=' + STAMP, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }), // SMART layer is optional: map works without it, see the merge below
    fetch('qline-3d.json?v=' + STAMP, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }) // QLINE layer is optional
  ])
    .then(function (all) {
      var data = all[0];
      fleetData = all[1];
      streetData = all[2];
      streetNameData = all[3];
      var pmData = all[4];
      var smartData = all[5];
      var qlineData = all[6];
      // SMART REACTIVATED 2026-10-15 (Justin's direction): the segment
      // the removal tombstoned is live again. The routes file was never
      // modified (it stayed in the repo as the rollback substrate), so
      // the pre-removal merge returns verbatim and every registry index
      // is again the pre-removal index (S1): DDOT 0-5123, SMART
      // 5124-10560, QLINE 10561-10582. SMART routes are recolored
      // uniformly to SMART red, as before the removal. If the fetch
      // failed, the map runs DDOT+QLINE only (the pre-removal failure
      // mode); smart-tombstones.json is no longer fetched or served.
      if (smartData && Array.isArray(smartData.routes) && smartData.routes.length) {
        data.groups = (data.groups || []).concat(smartData.groups || []);
        smartData.routes.forEach(function (r) { r.color = '#c30915'; });
        data.routes = (data.routes || []).concat(smartData.routes);
        data.stops = (data.stops || []).concat(smartData.stops || []);
      }
      // QLINE streetcar: merged in the same pattern. The proxy serves QLINE vehicle
      // positions on the same /api/vehicles feed with agency='qline' and
      // route_id='QLINE'. Absent file: the map runs without QLINE, no errors.
      if (qlineData && Array.isArray(qlineData.routes) && qlineData.routes.length) {
        data.groups = (data.groups || []).concat(qlineData.groups || []);
        data.routes = (data.routes || []).concat(qlineData.routes);
        data.stops = (data.stops || []).concat(qlineData.stops || []);
      }
      proj = {
        lat0: data.projection.lat0,
        lon0: data.projection.lon0,
        mLat: 111320,
        mLon: 111320 * Math.cos(data.projection.lat0 * DEG)
      };

      // Vector street map, drawn ourselves: dark ground + tiered Census
      // TIGER/Line highway geometry. Crisp at every zoom; no raster tiles.
      // The mosaic spans MOSAIC_BOUNDS; segments inside STREET_BOUNDS render
      // always, segments outside live in streetExt, displayed only while
      // the SMART group is displayed (see syncStreetExt).
      var streetLocal = null;
      (function buildStreets() {
        // Ground covers the full mosaic bbox permanently. #0d1319 against the
        // #0c1116 scene background is near-identical, so the larger ground is
        // visually a no-op while the extension is hidden.
        var gnw = project(MOSAIC_BOUNDS.latN, MOSAIC_BOUNDS.lonW);
        var gse = project(MOSAIC_BOUNDS.latS, MOSAIC_BOUNDS.lonE);
        var gw = gse[0] - gnw[0], gh = gse[1] - gnw[1];
        var ground = new THREE.Mesh(
          new THREE.PlaneGeometry(gw, gh),
          new THREE.MeshBasicMaterial({ color: 0x0d1319 })
        );
        ground.rotation.x = -Math.PI / 2;
        ground.position.set(gnw[0] + gw / 2, 0, gnw[1] + gh / 2);
        scene.add(ground);
        // Core bounds in meters for the partition test (midpoint-in-core).
        var cnw = project(STREET_BOUNDS.latN, STREET_BOUNDS.lonW);
        var cse = project(STREET_BOUNDS.latS, STREET_BOUNDS.lonE);
        var cx0 = cnw[0], cx1 = cse[0], cz0 = cnw[1], cz1 = cse[1];
        // Safe-zone border: dashed amber perimeter at the coverage bounds so the
        // edge of the mapped area stays visible while panning/scrolling. Floats
        // at y=20 — above the street tiers (14-16), below the route decks (~66).
        // Brand: Amber #FFB000, the academy's signal accent.
        (function addBoundsBorder() {
          var x0 = cx0, x1 = cx1, z0 = cz0, z1 = cz1, yB = 20;
          var g = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(x0, yB, z0),
            new THREE.Vector3(x1, yB, z0),
            new THREE.Vector3(x1, yB, z1),
            new THREE.Vector3(x0, yB, z1)
          ]);
          var border = new THREE.LineLoop(g, new THREE.LineDashedMaterial({
            color: 0xFFB000, dashSize: 220, gapSize: 140,
            transparent: true, opacity: 0.55, depthWrite: false
          }));
          border.computeLineDistances();
          border.renderOrder = 5;
          border.name = 'safe-zone-border';
          scene.add(border);
        })();
        // Extension group: permanently hidden since the SMART removal.
        streetExt = new THREE.Group();
        streetExt.visible = false;
        scene.add(streetExt);
        // Expanded-bounds border: same amber language at the mosaic bounds,
        // faded with the extension group so both states read correctly.
        (function addExtBorder() {
          var x0 = gnw[0], x1 = gse[0], z0 = gnw[1], z1 = gse[1], yB = 20;
          var g = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(x0, yB, z0),
            new THREE.Vector3(x1, yB, z0),
            new THREE.Vector3(x1, yB, z1),
            new THREE.Vector3(x0, yB, z1)
          ]);
          var mat = new THREE.LineDashedMaterial({
            color: 0xFFB000, dashSize: 220, gapSize: 140,
            transparent: true, opacity: 0, depthWrite: false
          });
          var border = new THREE.LineLoop(g, mat);
          border.computeLineDistances();
          border.renderOrder = 5;
          border.name = 'safe-zone-border-ext';
          streetExt.add(border);
          streetExtMats.push({ mat: mat, baseOpacity: 0.55 });
        })();
        if (!streetData) return; // ground still renders; streets absent
        function splitTier(arr) {
          var core = [], ext = [];
          for (var i = 0; i < arr.length; i += 4) {
            var mx = (arr[i] + arr[i + 2]) / 2, mz = (arr[i + 1] + arr[i + 3]) / 2;
            ((mx >= cx0 && mx <= cx1 && mz >= cz0 && mz <= cz1) ? core : ext)
              .push(arr[i], arr[i + 1], arr[i + 2], arr[i + 3]);
          }
          return { core: core, ext: ext };
        }
        function addTier(arr, color, opacity, y, parent) {
          if (!arr || !arr.length) return null;
          var n = arr.length / 4;
          var pos = new Float32Array(n * 6);
          for (var i = 0; i < n; i++) {
            pos[i * 6]     = arr[i * 4];
            pos[i * 6 + 1] = y;
            pos[i * 6 + 2] = arr[i * 4 + 1];
            pos[i * 6 + 3] = arr[i * 4 + 2];
            pos[i * 6 + 4] = y;
            pos[i * 6 + 5] = arr[i * 4 + 3];
          }
          var g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
          var mat = new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: opacity });
          var lines = new THREE.LineSegments(g, mat);
          lines.frustumCulled = false;
          parent.add(lines);
          if (parent === streetExt) streetExtMats.push({ mat: mat, baseOpacity: opacity });
          return lines;
        }
        var fw = splitTier(streetData.freeway);
        addTier(fw.core, 0x8a94a0, 0.95, 16, scene);
        addTier(fw.ext, 0x8a94a0, 0.95, 16, streetExt);
        var ar = splitTier(streetData.arterial);
        addTier(ar.core, 0x4d5763, 0.9, 15, scene);
        addTier(ar.ext, 0x4d5763, 0.9, 15, streetExt);
        var lo = splitTier(streetData.local);
        streetLocal = addTier(lo.core, 0x333c46, 0.8, 14, scene);
        streetExtLocal = addTier(lo.ext, 0x333c46, 0.8, 14, streetExt);
      })();

      var casingMat = new THREE.MeshBasicMaterial({ color: 0x0c1116, transparent: true, opacity: 0.9, side: THREE.DoubleSide });

      // Per-group containers (stops clouds toggle with the group filter).
      groupOrder = data.groups.map(function (g) { return g.id; });
      data.groups.forEach(function (g) {
        groupRoutes[g.id] = g.routes.slice();
        var gr = new THREE.Group();
        scene.add(gr);
        groupObjs[g.id] = gr;
      });

      data.routes.forEach(function (route, ri) {
        var color = new THREE.Color(route.color);
        routeColors[route.id] = color;
        routeNames[route.id] = route.name;
        routeById[route.id] = route;
        routeOrder.push(route.id);
        var grp = new THREE.Group();
        // Stagger ribbon heights per route: coplanar overlapping guideways
        // at crossings z-fight and flicker; a few meters of separation is
        // invisible but kills the shimmer.
        // Deliberate layer cake (meters): every route owns a unique level —
        // 37 routes, no shared slots, so crossing/overlapping decks can never
        // z-fight. Crossings read as clean overpasses, higher route over lower.
        var yDeck = 66 + ri * 1.2;
        var yGlow = 2 + ri * 0.25;
        var yCase = 24 + ri * 0.15;
        // Elevated guideway: the ribbon deck floats at y=66 with solid
        // skirts to the ground, so routes read as 3D structures. Lambert
        // materials let the directional light shade deck vs. sides.
        var deckMat = new THREE.MeshLambertMaterial({ color: color, side: THREE.DoubleSide });
        var skirtMat = new THREE.MeshLambertMaterial({ color: color.clone().multiplyScalar(0.38), side: THREE.DoubleSide });
        // Kept for smart disabling: dim the guideway when the route is not running.
        grp.userData.guideMats = [
          { mat: deckMat, opacity: deckMat.opacity },
          { mat: skirtMat, opacity: skirtMat.opacity }
        ];
        var glowMat = new THREE.MeshBasicMaterial({
          color: color, transparent: true, opacity: 0.13,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
        });
        streetGlowMats.push(glowMat);
        var longest = null;
        route.paths.forEach(function (path) {
          if (path.length < 2) return;
          grp.add(new THREE.Mesh(ribbonGeometry(path, 230, yGlow), glowMat));
          grp.add(new THREE.Mesh(ribbonGeometry(path, 95, yCase), casingMat));
          var deckGeo = ribbonGeometry(path, 72, yDeck);
          deckGeo.computeVertexNormals();
          grp.add(new THREE.Mesh(deckGeo, deckMat));
          grp.add(new THREE.Mesh(skirtGeometry(path, 72, yDeck), skirtMat));
          if (!longest || path.length > longest.length) longest = path;
        });
        if (longest) {
          var mid = longest[Math.floor(longest.length / 2)];
          // Route display name: "name - number" unless they're identical (QLINE).
          var displayName = routeLabel(route.id);
          var label = makeLabel(displayName, route.color);
          label.position.set(mid[0], 1050, mid[1]);
          grp.add(label);
          var tetherGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(mid[0], yDeck, mid[1]),
            new THREE.Vector3(mid[0], 980, mid[1])
          ]);
          var tether = new THREE.Line(tetherGeo, new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: 0.45 }));
          grp.add(tether);
          labelSprites.push({ sprite: label, routeId: route.id, tether: tether });
        }
        scene.add(grp);
        routeGroups[route.id] = grp;
      });

      // Stops are rebuilt from stopData by rebuildStops() (per-route colors,
      // paper-white hubs) whenever filters change; see the stops section.
      stopData = data.stops || [];
      if (typeof window.__setRideData === 'function') {
        window.__setRideData(data.routes || [], stopData);
      }

      // People Mover static layer: built once, toggled independently of the
      // DDOT route filters. Absent (fetch failed) the map simply has no PM layer.
      if (pmData && pmData.loop && pmData.stations) buildPeopleMover(pmData);

      // Belle Isle static layer: built once from the OSM island outline.
      // Absent (fetch failed) the map simply has no island landmass.
      fetch('assets/belle-isle.json?v=' + STAMP, { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
        .then(function (B) { buildBelleIsle(B); })
        .catch(function () { /* island is a bonus; map works without it */ });

      /* LANDMARK-MASSING-BEGIN v20261006-1700 — staging-only Phase A.
         True-form OSM landmark massing (single merged mesh, 1 draw call).
         Geometry: /tmp/build_landmarks.py. Revert: delete this block and
         landmarks.json. */
      (function () {
        if (window.__landmarksA) return; window.__landmarksA = true;
        fetch('landmarks.json?v=' + STAMP, { cache: 'no-store' })
          .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
          .then(function (L) {
            var g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(L.positions, 3));
            g.setIndex(L.index);
            g.computeVertexNormals();
            var mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x3a4a5c }));
            mesh.frustumCulled = false;
            scene.add(mesh);
          })
          .catch(function (e) { console.warn('[landmarks] ' + e.message); });
      })();
      /* LANDMARK-MASSING-END */

      // Alphabetize route lists by route name.
      routeOrder.sort(function (a, b) {
        return (routeNames[a] || '').localeCompare(routeNames[b] || '');
      });
      buildFilterPanel(data.groups);
      applyFilters();
      syncFilterUI();
      rebuildStops();
      // Soft location ask, once the map has settled. The old first-time
      // popup is gone — "?" is the help hub now.
      setTimeout(maybePromptLocation, 4000);
      $('filter-btn').addEventListener('click', function () { togglePanel(); setBrowse(false); });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') togglePanel(false);
      });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setBrowse(false); });

      resize();
      setHeader(null, 'connecting…', false);
      fetchHistory();
      maybeRenderHistory();
      poll();
      startAlertsPoll();
      // Hidden-tab backoff (credit saver): while the tab is hidden, skip the
      // 60 s vehicle poll and re-check every 10 min instead. On return to
      // visible, poll immediately and resume the normal cadence.
      var HIDDEN_POLL_MS = 600000;
      var pollTimer = null;
      function schedulePoll() {
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(function () {
          pollTimer = null;
          if (!document.hidden) poll();
          schedulePoll();
        }, document.hidden ? HIDDEN_POLL_MS : POLL_MS);
      }
      schedulePoll();
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) { poll(); schedulePoll(); }
      });
      // Empirical motion prior: restore the local speed map, fetch the
      // telemetry timing cells now and hourly; persist the map on hide.
      loadSpeedmap();
      fetchTimingCells();
      setInterval(fetchTimingCells, 3600000);
      window.addEventListener('pagehide', function () {
        try { localStorage.setItem('fl-speedmap-v1', JSON.stringify(localSegs)); } catch (err) {}
      });
      var lastBusMode = null;
      renderer.setAnimationLoop(function () {
        controls.update();
        // Camera floor: the zoom-to-cursor dolly walks the lens down the
        // pointer ray, and a large wheel/pinch delta can tunnel it straight
        // through the ground plane before the target re-anchors (radius is
        // clamped to the target, not to the terrain). A hard floor keeps the
        // camera out of the geometry on every device and gesture. Placed
        // before the trip fly-through, which drives the camera itself and
        // is unaffected.
        if (camera.position.y < 30) camera.position.y = 30;
        updateLOD();
        if (typeof stepTripFly === 'function') stepTripFly(performance.now());
        stepStreetTween(performance.now());
        stepStreetExtFade(performance.now());
        // Street-view handoff with hysteresis. The trip fly-through owns the
        // camera while active, so street view yields to it.
        var svDist = camera.position.distanceTo(controls.target);
        if (tripFly && streetView) exitStreetView();
        else if (!streetView && !streetTween && !tripFly && svDist < STREET_ENTER_DIST) enterStreetView();
        else if (streetView && !streetTween && !tripFly && svDist > STREET_EXIT_DIST) exitStreetView();
        if (streetView && !tripFly && camera.position.y < STREET_MIN_Y) camera.position.y = STREET_MIN_Y;
        // Per-vehicle motion prediction: buses glide along their shapes
        // between polls instead of jumping every 60 s.
        updateBusMotion(performance.now());
        followTick(); // selected bus stays on screen as it moves
        if (youMarker.group.visible) {
          var t = performance.now();
          var s = 1 + 0.22 * Math.sin(t / 420);
          youMarker.ring.scale.set(s, s, s);
          youMarker.badge.position.y = YOU_BADGE_Y + YOU_BADGE_BOB * Math.sin(t / 650);
        }
        // Selected bus pulses at the same rate as the user-location ring.
        // Trip-journey highlight breathes at the same shared rate.
        if (tripGroup.visible && tripMats.length) {
          var tp = 0.72 + 0.28 * Math.sin(performance.now() / 420);
          for (var tmi = 0; tmi < tripMats.length; tmi++) {
            tripMats[tmi].opacity = tripMats[tmi].userData.baseOpacity * tp;
          }
        }
        if (selectedVehicleId) {
          placeBusInfo(); // info label tracks the bus every frame
          var pulse = busPulse();
          if (busMode) {
            for (var pi = 0; pi < DETAIL_MAX; pi++) {
              var pd = detailPool[pi];
              if (pd && pd.group.visible && pd.vehicle && pd.vehicle.vehicle_id === selectedVehicleId) {
                pd.group.scale.set(1.45 * pulse, 1.45 * pulse, 1.45 * pulse);
              }
            }
          } else {
            for (var si = 0; si < busSlots.length; si++) {
              if (busSlots[si].vehicle.vehicle_id === selectedVehicleId) {
                writeBusMatrices(si, busSlots[si], pulse);
                break;
              }
            }
            pillarMeshes.forEach(function (im) { im.instanceMatrix.needsUpdate = true; });
          }
        }
        if (busMode !== lastBusMode) {
          lastBusMode = busMode;
          // Leaving busMode: snap the pillar scale to the current zoom before
          // the rewrite, so wide-out pillars don't flash at street-zoom height.
          if (!busMode) pillarYS = pillarScaleFor(camera.position.distanceTo(controls.target));
          renderBusInstances();
        }
        // Label rule: route enabled, not confirmed not-running, AND (live buses
        // on the route OR zoomed far out). Midpoint labels hide at street zoom
        // (< 7 km) where bus badges and street names take over.
        var camDist = camera.position.distanceTo(controls.target);
        // LOD: local streets and stops declutter at city-scale zooms.
        if (streetLocal) streetLocal.visible = camDist < 22000;
        // Extension local tier obeys the same declutter rule (group
        // visibility still gates whether it renders at all).
        if (streetExtLocal) streetExtLocal.visible = camDist < 22000;
        if (stopGroup) stopGroup.visible = camDist < STOP_LOD_DIST;
        for (var i = 0; i < labelSprites.length; i++) {
          var L = labelSprites[i];
          var lvis = runningState[L.routeId] !== 'not-running' &&
            ((liveCounts[L.routeId] > 0) || camDist > 15000) && camDist > 7000 &&
            routeNearOk(L.routeId);
          L.sprite.visible = lvis;
          if (L.tether) L.tether.visible = lvis;
        }
        // People Mover label: static layer, so its visibility follows only
        // the layer toggle and the street-zoom declutter rule — never the
        // live-running state, which must not imply vehicles exist.
        if (pmLabel) {
          var pmLvis = pmGroup.visible && camDist > 7000;
          pmLabel.visible = pmLvis;
          if (pmTether) pmTether.visible = pmLvis;
        }
        // Belle Isle place label: static geography, so visibility follows only
        // the street-zoom declutter rule — hidden at street zoom where street
        // names take over, same as the People Mover label.
        if (belleIsleLabel) {
          var biLvis = camDist > 7000;
          belleIsleLabel.visible = biLvis;
          if (belleIsleTether) belleIsleTether.visible = biLvis;
        }
        // MoGo bikeshare: count badges appear at close zoom only
        // (declutter rule, same family as the route labels above).
        if (typeof mogoFrameTick === 'function') mogoFrameTick(camDist);
        if (typeof placesFrameTick === 'function') placesFrameTick(camDist);
        if (stopHighlight.visible) {
          var shp = busPulse();
          stopHighlight.scale.set(shp, shp, 1);
        }
        updateStreetLabels();
        updateStopLabels();
        easePillarScale(camDist);
        easeStopScale(camDist);
        easeGuideFade();
        smoothBadges();
        renderer.render(scene, camera);
      });
    })
    .catch(function () {
      fail('Could not load route data. Please check your connection and reload.');
    });

  resize();
})();