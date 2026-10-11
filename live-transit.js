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

  var STAMP = '20261010-2345';
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
  var $ = function (id) { return document.getElementById(id); };

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
  camera.position.set(0, 8500, 16500);

  var controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
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
  // SMART service-area bounds: the expanded street mosaic (Downriver south,
  // suburbs west) that fades in with the SMART filter group.
  var SMART_BOUNDS = { lonW: -83.385, lonE: -82.8992288, latN: 42.47997522924901, latS: 42.178 };

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
  function routeBadgeTexture(rid) {
    var t = badgeTexCache[rid];
    if (t) return t;
    var rc = routeColors[rid];
    var col = '#' + (rc ? rc.getHexString() : '9aa0a6');
    var label = String(rid);
    var c = document.createElement('canvas');
    var mc = c.getContext('2d');
    mc.font = '700 36px system-ui, -apple-system, sans-serif';
    var tw = Math.ceil(mc.measureText(label).width);
    c.width = tw + 60; c.height = 72;
    var x = c.getContext('2d');
    x.fillStyle = 'rgba(9,13,17,0.88)';
    x.beginPath();
    if (x.roundRect) x.roundRect(4, 4, c.width - 8, 64, 16); else x.rect(4, 4, c.width - 8, 64);
    x.fill();
    x.lineWidth = 4; x.strokeStyle = col; x.stroke();
    x.fillStyle = '#ffffff';
    x.font = '700 36px system-ui, -apple-system, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(label, c.width / 2, 38);
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
  function busAgeText(v) {
    if (!v.updated_at) return '–';
    var s = Math.max(0, Math.round((Date.now() - new Date(v.updated_at).getTime()) / 1000));
    return s < 60 ? s + 's ago' : Math.floor(s / 60) + 'm ago';
  }
  function drawBusInfo(v) {
    var col = routeColors[v.route_id] ? '#' + routeColors[v.route_id].getHexString() : '#9aa0a6';
    var dest = formatDest(v.route_id, v.destination);
    var line1 = v.route_id + ' · ' + (routeNames[v.route_id] || 'DDOT') + (dest ? ' → ' + dest : '');
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
      pillarGlowIM.setColorAt(k, b.color);
      pillarCoreIM.setColorAt(k, b.color);
      pillarBeaconIM.setColorAt(k, b.color);
      pillarRingIM.setColorAt(k, b.color);
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
      { id: 'filter-btn', edge: { mobile: 'right', desktop: 'right' }, visible: isShown },
      { id: 'trip-btn', edge: { mobile: 'right', desktop: 'right' }, visible: isShown }
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
  function showBus(v) {
    if (!v) return;
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
    var compactTitle = sn + ' · ' + (routeNames[sn] || 'DDOT') + (dest ? ' → ' + dest : '');
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
    // D1a: on mobile the card opens as a compact route/vehicle bar; tap to expand.
    setBusCardCompact(DisplayBounds.get().deviceClass === 'mobile');
    refreshBusInfo(); // in-scene label beside the bus
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
          follow: (isReselect && followSuppressed) ? 'hold'
            : (DisplayBounds.get().deviceClass === 'mobile' ? 'hold' : 'engage'),
          vehicleId: v.vehicle_id,
          slot: _bs
        });
      }
    }
  }
  function hideBus() {
    selectedVehicleId = null;
    followSuppressed = false;
    setFollow(null); // stop tracking
    $('bus-card').hidden = true;
    busInfoSprite.visible = false;
    renderBusInstances(); // shrink the indicator back
  }
  $('bus-close').addEventListener('click', hideBus);
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
    b.setAttribute('aria-label', 'Bus ' + (v.vehicle_id || '') + ', route ' + v.route_id + ' ' + (routeNames[v.route_id] || '') + (dest ? ', to ' + dest : ''));
    var dot = document.createElement('i'); dot.className = 'b-dot';
    var rc = routeColors[v.route_id];
    dot.style.background = rc ? '#' + rc.getHexString() : '#F5F2EA';
    var main = document.createElement('span'); main.className = 'b-main';
    var name = document.createElement('b');
    name.textContent = v.route_id + ' · ' + (v.vehicle_id || '');
    var sub = document.createElement('span');
    sub.textContent = dest ? 'to ' + dest : (routeNames[v.route_id] || 'DDOT');
    main.appendChild(name); main.appendChild(sub);
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
      var ar = a.vehicle.route_id, br = b.vehicle.route_id;
      var an = numKey(ar), bn = numKey(br);
      if (an !== null && bn !== null && an !== bn) return an - bn;
      var rc = String(ar).localeCompare(String(br));
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
  }
  $('zoom-in').addEventListener('click', function () { zoomStep(1); });
  $('zoom-out').addEventListener('click', function () { zoomStep(-1); });
  $('view-reset').addEventListener('click', resetView);
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
    ['\u2194', 'Drag', 'Move around the city'],
    ['+', 'Pinch', 'Zoom in and out'],
    ['\u27F3', 'Two-finger twist', 'Rotate the view'],
    ['\u25CF', 'Tap a bus', 'Vehicle number, model, speed and heading'],
    [ICO_FINDME, 'Find me', 'Center the map on your location'],
    [ICO_FULL, 'Fullscreen', 'Fill the screen with the map'],
    ['\u29E9', 'Routes', 'Filter by group or individual route'],
    ['\u2302', 'Reset view', 'Return to the full-system view']
  ];
  var NAV_STEPS_DESK = [
    ['\u27F3', 'Drag', 'Orbit the view'],
    ['+', 'Scroll', 'Zoom in and out'],
    ['\u2194', 'Right-drag', 'Pan across the city'],
    ['\u25CF', 'Click a bus', 'Vehicle number, model, speed and heading'],
    [ICO_FINDME, 'Find me', 'Center the map on your location'],
    [ICO_FULL, 'Fullscreen', 'Fill the screen with the map'],
    ['\u29E9', 'Routes', 'Filter by group or individual route'],
    ['\u2302', 'Reset view', 'Return to the full-system view']
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

  // --- fullscreen toggle (native API, CSS fallback for iOS Safari) -----------------
  var stage = document.querySelector('.map-stage');
  var fullBtn = $('view-full');
  function nativeFsEl() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function fsActive() { return !!nativeFsEl() || stage.classList.contains('pseudo-full'); }
  function setFsBtn() {
    var on = fsActive();
    fullBtn.setAttribute('aria-pressed', String(on));
    fullBtn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Enter fullscreen');
  }
  function setPseudoFull(on) {
    stage.classList.toggle('pseudo-full', on);
    document.body.classList.toggle('pseudo-full-lock', on);
    setFsBtn();
    syncFsLock();
    notifyMapResize();
  }
  fullBtn.addEventListener('click', function () {
    if (nativeFsEl()) {
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
      return;
    }
    if (stage.classList.contains('pseudo-full')) { setPseudoFull(false); return; }
    var el = document.documentElement;
    var req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) {
      try {
        var p = req.call(el);
        if (p && p.catch) p.catch(function () { setPseudoFull(true); });
      } catch (e) { setPseudoFull(true); }
    } else {
      setPseudoFull(true);
    }
    setFsBtn();
  });
  function notifyMapResize() {
    try { window.dispatchEvent(new Event('resize')); } catch (e) {}
  }
  function onFsChange() { setFsBtn(); syncFsLock(); notifyMapResize(); }
  function syncFsLock() { document.body.classList.toggle('fs-lock', fsActive()); }
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && stage.classList.contains('pseudo-full')) setPseudoFull(false);
  });
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
  // Coverage = the Detroit street mosaic bounds (DDOT's service area).
  function inCoverage(lat, lon) {
    if (lat <= STREET_BOUNDS.latN && lat >= STREET_BOUNDS.latS &&
        lon >= STREET_BOUNDS.lonW && lon <= STREET_BOUNDS.lonE) return true;
    // SMART suburbs: covered only while the SMART group is displayed, so
    // "routes near you" and other location features work in the suburbs
    // with SMART enabled and stay Detroit-scoped when it is off.
    try {
      if (groupSelState('smart') !== 'none' &&
          lat <= SMART_BOUNDS.latN && lat >= SMART_BOUNDS.latS &&
          lon >= SMART_BOUNDS.lonW && lon <= SMART_BOUNDS.lonE) return true;
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
    var off = camera.position.clone().sub(controls.target);
    controls.target.set(p[0], 0, p[1]);
    camera.position.copy(controls.target).add(off);
    youMarker.group.position.set(p[0], 0, p[1]);
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
  var STOP_MAX = 5120;
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
    if (typeof tripMode !== 'undefined' && tripMode) tripStopTapped(st);
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
      b.textContent = rid + ' · ' + (routeNames[rid] || 'DDOT');
      chip.appendChild(b);
      host.appendChild(chip);
    });
    $('stop-card').hidden = false;
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
      b.textContent = v.route_id + ' · ' + (formatDest(v.route_id, v.destination) || (routeNames[v.route_id] || 'DDOT'));
      row.appendChild(b);
      var t = document.createElement('span');
      var when = v.updated_at ? new Date(v.updated_at) : null;
      var mins = (when && !isNaN(when)) ? Math.max(0, Math.round((now - when.getTime()) / 60000)) : null;
      t.textContent = mins == null ? '' : (mins < 1 ? 'just now' : mins + 'm ago');
      row.appendChild(t);
      list.appendChild(row);
    });
  }
  function hideStop() {
    setStopSelectedColor(selectedStopIndex, false);
    selectedStopIndex = -1;
    selectedStop = null;
    $('stop-card').hidden = true;
    stopHighlight.visible = false;
  }
  $('stop-close').addEventListener('click', hideStop);

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
  var HINT_DEFAULT = 'drag&nbsp;·&nbsp;orbit&nbsp;&nbsp;&nbsp;scroll&nbsp;·&nbsp;zoom&nbsp;&nbsp;&nbsp;tap bus or stop&nbsp;·&nbsp;details';

  function setTripMode(on) {
    tripMode = on;
    $('trip-btn').setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) {
      hideBus(); hideStop();
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
      renderTripFields();
      updateTripMarkers();
      maybeReplan();
    } else {
      cancelTripFly();
      clearTrip();
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
      r.textContent = (h.stop.r || []).slice(0, 4).join(' · ') + ((h.stop.r || []).length > 4 ? ' +' + ((h.stop.r || []).length - 4) : '');
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
      var seeds = tripSeeds();
      var dest = tripTo.idx;
      var when = tripWhen();
      var oF = tripFrom, oT = tripTo; // capture; ignore if the user moved on
      return loaded.then(function (tt) {
        var res = R.plan(tt, seeds, dest, when);
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
      var res = tripRaptor.plan(tripTT, tripSeeds(), tripTo.idx, new Date());
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
        return { kind: 'board', text: 'Route ' + leg.routeId + ' reaches ' +
          tripStopName(leg.board) + ' in ~' + fmtEta(eta) + ' — be ready to board.' };
      }
      return null;
    }
    var left = stopsToAlight(leg, tr, arcMap);
    if (left < 0) return null;
    if (left === 0) return 'passed';
    if (left === 1) {
      return { kind: 'alight', urgent: true, text: 'Route ' + leg.routeId +
        ' arriving at ' + tripStopName(leg.alight) + ' — get off at the next stop.' };
    }
    return { kind: 'riding', text: 'Route ' + leg.routeId + ' — ' + left +
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
        'Missed the Route ' + missed.leg2.routeId + ' connection — replanned from your current position.',
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
        : 'No scheduled trip found between these stops right now. Try a different pair or time.';
      host.appendChild(none);
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
        lbl.textContent = l.routeId;
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
    mergeWalkLegs(tripJourneys[tripSel].legs).forEach(function (l) {
      var row = document.createElement('div');
      row.className = 'trip-leg-row';
      var dot = document.createElement('i');
      var body = document.createElement('div');
      if (l.type === 'bus') {
        dot.style.background = l.color || '#F5F2EA';
        var t = document.createElement('b');
        t.textContent = l.routeId + ' · ' + (l.headsign || l.routeName || 'DDOT');
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
    if (filterState.hideIdle && runningState[rid] === 'not-running') return false;
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
    var dim = runningState[rid] !== 'running' && g.visible;
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

  // --- SMART street extension -------------------------------------------------
  // Street segments outside STREET_BOUNDS (Downriver, western suburbs) live
  // in streetExt, a group that fades in/out with the SMART filter toggle.
  // SMART defaults off, so the group starts invisible.
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

  var transitDataOn = false;
  // Transit badge: minimum-size attribution, shown only when Transit-derived
  // SMART data is both flowing and actually displayed (SMART group not
  // filtered off). Never obscures the map: it lives in the header counter box.
  function syncTransitBadge() {
    var badge = $('transit-badge');
    if (!badge) return;
    var smartShown = false;
    try { smartShown = groupSelState('smart') !== 'none'; } catch (e) {}
    badge.style.display = (transitDataOn && smartShown) ? '' : 'none';
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
    syncTransitBadge();
    syncStreetExt();
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
  }

  function buildFilterPanel(groups) {
    var host = $('filter-groups');
    host.innerHTML = '';
    groups.forEach(function (g) {
      // Calm default: only the ConnectTen core network is on. The panel
      // opens as an accordion (3 rows); route chips expand per group.
      // SMART is a separate beta group, default OFF until the user opts in;
      // the choice persists in localStorage once made.
      var gOn = (g.id === 'connect-ten');
      var gLabel = g.name;
      if (g.id === 'smart') {
        gLabel = g.name + ' (beta)';
        try {
          var savedSmart = localStorage.getItem('lt-smart-on');
          gOn = (savedSmart === '1');
        } catch (e) { gOn = false; }
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
        '<span class="f-count" id="fgc-' + g.id + '">–</span><span class="f-chev">▾</span>';
      label.addEventListener('click', function () {
        var open = sec.classList.toggle('open');
        label.setAttribute('aria-expanded', String(open));
      });
      head.appendChild(check);
      head.appendChild(label);
      var list = document.createElement('div');
      list.className = 'f-routes';
      g.routes.forEach(function (rid) {
        var route = routeById[rid];
        if (!route) return;
        filterState.routes[rid] = gOn;
        var b = document.createElement('button');
        b.className = 'route-chip f-chip';
        b.setAttribute('aria-pressed', 'true');
        b.dataset.route = rid;
        b.innerHTML = '<i style="background:' + route.color + '"></i><b>' +
          rid + ' · ' + route.name + '</b><span class="cnt" id="cnt-' + rid + '">–</span>' +
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
        var betaNote = document.createElement('p');
        betaNote.className = 'f-beta-note';
        betaNote.textContent = 'Beta: 2 of 45 routes have map lines so far. Vehicle positions via the Transit API.';
        sec.appendChild(betaNote);
      }
      host.appendChild(sec);
    });
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

  function togglePanel(force) {
    var panel = $('filter-panel');
    var btn = $('filter-btn');
    var show = (typeof force === 'boolean') ? force : panel.hidden;
    panel.hidden = !show;
    btn.setAttribute('aria-expanded', String(show));
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
    if (typeof refreshTripFusion === 'function') refreshTripFusion(); // live counts on trip legs
    if (selectedVehicleId) refreshBusInfo(); // tapped bus moved / new data
    return busSlots.length;
  }

  function poll() {
    var proxy = (window.FORGE_LIVE_PROXY || '').replace(/\/$/, '');
    if (!proxy) { setHeader(null, 'connecting…', false); return; }
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 20000);
    fetch(proxy + '/api/vehicles', { cache: 'no-store', signal: ctrl.signal })
      .then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error('http ' + r.status); return r.json(); },
            function (e) { clearTimeout(timer); throw e; })
      .then(function (d) {
        if (!d || !Array.isArray(d.vehicles)) throw new Error('bad payload');
        lastVehicles = d.vehicles;
        liveEverOk = true;
        liveCounts = countByRoute(d.vehicles); // raw counts first: filters must not starve the state engine
        var n = updateBuses(d.vehicles);
        if (updateRunningState()) {
          applyFilters();   // re-applies visibility + dimming, re-renders buses
          syncFilterUI();
        }
        refreshFilterCounts();
        lastTotal = n;
        setHeader(n, 'updated ' + fmtTime(d.generated_at ? new Date(d.generated_at) : null), false);
        // Transit attribution (API terms): visible only while SMART data is
        // actually served from the Transit API.
        transitDataOn = !!(d.sources && d.sources.smart && d.sources.smart.via === 'transit'
          && d.sources.smart.vehicles > 0);
        syncTransitBadge();
      })
      .catch(function () {
        var text = liveEverOk
          ? 'live feed retrying…'
          : (historyOk ? 'showing last logged positions · live feed retrying…' : 'live feed retrying…');
        setHeader(lastTotal, text, true);
      });
  }

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
      .catch(function () { return null; }) // SMART layer is optional: map works DDOT-only without it
  ])
    .then(function (all) {
      var data = all[0];
      fleetData = all[1];
      streetData = all[2];
      streetNameData = all[3];
      var pmData = all[4];
      var smartData = all[5];
      // SMART routes via the Transit API: merged into the DDOT dataset so
      // route groups, filters, stops, and labels all work unchanged. The
      // proxy serves SMART vehicle snapshots on the same /api/vehicles feed;
      // route_id values (SMART short names) match the proxy's Transit mapping.
      // Absent file: the map runs DDOT-only, no errors.
      if (smartData && Array.isArray(smartData.routes) && smartData.routes.length) {
        data.groups = (data.groups || []).concat(smartData.groups || []);
        // Unified SMART identity: every SMART visual — route lines, bus
        // pillars, stop pylons, labels, filter chips, DOM dots — renders in
        // SMART red. Applied once here so all downstream color resolution
        // inherits it. Exempt: multi-route hub paper-white pylons and the
        // selected-stop white highlight (state indicators, not route colors).
        smartData.routes.forEach(function (r) { r.color = '#c30915'; });
        data.routes = (data.routes || []).concat(smartData.routes);
        data.stops = (data.stops || []).concat(smartData.stops || []);
      }
      proj = {
        lat0: data.projection.lat0,
        lon0: data.projection.lon0,
        mLat: 111320,
        mLon: 111320 * Math.cos(data.projection.lat0 * DEG)
      };

      // Vector street map, drawn ourselves: dark ground + tiered Census
      // TIGER/Line highway geometry. Crisp at every zoom; no raster tiles.
      // The mosaic spans SMART_BOUNDS; segments inside STREET_BOUNDS render
      // always, segments outside live in streetExt and fade with the SMART
      // filter toggle (see syncStreetExt).
      var streetLocal = null;
      (function buildStreets() {
        // Ground covers the full SMART bbox permanently. #0d1319 against the
        // #0c1116 scene background is near-identical, so the larger ground is
        // visually a no-op while the extension is hidden.
        var gnw = project(SMART_BOUNDS.latN, SMART_BOUNDS.lonW);
        var gse = project(SMART_BOUNDS.latS, SMART_BOUNDS.lonE);
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
        // Extension group: hidden until the SMART toggle fades it in.
        streetExt = new THREE.Group();
        streetExt.visible = false;
        scene.add(streetExt);
        // Expanded-bounds border: same amber language at the SMART bounds,
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
          var label = makeLabel(route.id + ' · ' + route.name, route.color);
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
