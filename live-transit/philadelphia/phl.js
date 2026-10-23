/* Live Transit — Philadelphia (MVP, 2026-10-23).
   One city, one config: this file is Philadelphia's instance of the
   Live Transit page family. Data files are Philadelphia's own assets
   (silo rule): philadelphia-streets.json (A4 basemap, TIGER/Line 2025),
   septa-routes-3d.json + septa-stops.json (compiled from SEPTA's agency
   GTFS v202609271 under Geometry Pipeline v2 gates), and
   data/vehicles.json (SEPTA agency-direct GTFS-RT, republished by the
   city collect workflow; bus and rail remain separate feed sections). */
(function () {
  "use strict";
  var STREETS = "philadelphia-streets.json";
  var ROUTES = "septa-routes-3d.json";
  var STOPS = "septa-stops.json";
  var VEHICLES = "data/vehicles.json";
  var POLL_MS = 60000;

  var state = {
    streets: null, routes: null, stops: null, veh: null,
    cam: { x: 0, z: 0, scale: 0.02 },
    groups: { bus: true, trolley: true, metro: true, rail: true },
    showRoutes: true, showStops: true,
    selected: null, // {kind:'vehicle'|'stop', ...}
    routeById: {}, stopList: [],
    extent: null, // basemap extent (projected) — drawing is held to it
    stats: { segments: 0, paths: 0, markers: 0 }
  };
  window.PHL = { state: state };

  // ---- projection (same convention as the assets' compiler) -------------
  function projector(lat0, lon0) {
    var kx = 111320 * Math.cos(lat0 * Math.PI / 180);
    return function (lat, lon) {
      return [(lon - lon0) * kx, -(lat - lat0) * 111320];
    };
  }
  var project = null; // set from the routes asset's projection

  // ---- route resolution for live vehicles -------------------------------
  function resolveRoute(routeId) {
    if (!routeId) return null;
    if (state.routeById[routeId]) return state.routeById[routeId];
    var base = routeId.replace(/_.*$/, ""); // e.g. L1_OWL -> L1
    if (state.routeById[base]) return state.routeById[base];
    return null;
  }
  window.PHL.resolveRoute = resolveRoute;
  window.PHL.projector = projector;

  // ---- vehicle markers (pure; exercised by the smoke harness) -----------
  function buildMarkers(vehDoc) {
    var out = [];
    if (!vehDoc || !vehDoc.feeds) return out;
    Object.keys(vehDoc.feeds).forEach(function (feedId) {
      var feed = vehDoc.feeds[feedId];
      (feed.vehicles || []).forEach(function (v) {
        if (v.lat == null || v.lon == null) return;
        var p = project(v.lat, v.lon);
        var r = resolveRoute(v.route);
        // RC8: a record whose route does not resolve to a known route
        // gets NO marker -- it is not drawn, not counted in the status
        // line, and not pickable. In the served snapshot that is 274
        // septa-bus records (24% of the feed) carrying no TripDescriptor
        // at all (route and trip both null): unassigned positions,
        // depot-clustered (73% in ~250 m cells of 5+ at depot sites)
        // and 82% bearing-less, i.e. parked/yard fleet, not service a
        // rider can board. The pre-fix code emitted them with
        // group:null, which every consumer's "if (m.group && ...)"
        // test waved through -- so they rendered gray under every
        // toggle state and inflated the headline count. Detroit's
        // reference build applies the same rule (updateBuses:
        // gateHidden = !grp || !grp.visible -> skip; "unknown or
        // filtered route: skip").
        if (!r) return;
        out.push({
          feed: feedId, x: p[0], z: p[1], route: v.route || null,
          routeObj: r, label: v.label || v.entity || "",
          color: r ? r.color : null, group: r ? r.group : null,
          trip: v.trip || null, ts: v.ts || null
        });
      });
    });
    return out;
  }
  window.PHL.buildMarkers = buildMarkers;

  function inExtent(x, z) {
    var e = state.extent;
    return !e || (x >= e.xMin && x <= e.xMax && z >= e.zMin && z <= e.zMax);
  }

  // ---- boot --------------------------------------------------------------
  function boot(fixture) {
    var jobs;
    if (fixture) {
      state.streets = fixture.streets; state.routes = fixture.routes;
      state.stops = fixture.stops; state.veh = fixture.vehicles;
      afterAssets();
      return Promise.resolve();
    }
    jobs = [STREETS, ROUTES, STOPS].map(function (u) {
      return fetch(u).then(function (r) { return r.json(); });
    });
    return Promise.all(jobs).then(function (docs) {
      state.streets = docs[0]; state.routes = docs[1]; state.stops = docs[2];
      afterAssets();
      pollVehicles();
      setInterval(pollVehicles, POLL_MS);
    });
  }

  function afterAssets() {
    var rp = state.routes.projection;
    project = projector(rp.lat0, rp.lon0);
    state.routes.routes.forEach(function (r) { state.routeById[r.id] = r; });
    state.stopList = (state.stops && state.stops.stops) || [];
    // Basemap extent from the streets meta bbox (A4 staged extent). All
    // drawing is held to it: NJ/DE rail reach is a recorded residual and
    // never renders over blank ground.
    var bb = state.streets.meta.bbox; // {lonW, lonE, latN, latS}
    var c1 = project(bb.latS, bb.lonW), c2 = project(bb.latN, bb.lonE);
    state.extent = {
      xMin: Math.min(c1[0], c2[0]), xMax: Math.max(c1[0], c2[0]),
      zMin: Math.min(c1[1], c2[1]), zMax: Math.max(c1[1], c2[1])
    };
    fitView();
    wireUi();
    render();
    updateStatus();
  }

  function fitView() {
    var cv = canvas(), e = state.routes.extent;
    var w = cv.clientWidth || 960, h = cv.clientHeight || 640;
    var sx = w / (e.xMax - e.xMin), sz = h / (e.zMax - e.zMin);
    state.cam.scale = Math.min(sx, sz) * 1.02;
    state.cam.x = (e.xMin + e.xMax) / 2;
    state.cam.z = (e.zMin + e.zMax) / 2;
  }

  function pollVehicles() {
    fetch(VEHICLES, { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (doc) { state.veh = doc; render(); updateStatus(); })
      .catch(function () { updateStatus("update failed — showing last good data"); });
  }

  // ---- rendering -----------------------------------------------------------
  var cvEl = null, ctx = null;
  function canvas() {
    if (!cvEl) {
      cvEl = document.getElementById("map");
      ctx = cvEl.getContext("2d");
    }
    return cvEl;
  }
  // Pointer events report viewport (client) coordinates; the view math
  // works in canvas coordinates. Convert at the event boundary. (The
  // pre-fix code compared clientX/clientY directly against canvas
  // pixels, offsetting every tap by the canvas's page position --
  // several hundred px against a 16 px pick tolerance.)
  function evtPos(e) {
    var r = canvas().getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function view() {
    var cv = canvas();
    var w = cv.clientWidth || cv.width, h = cv.clientHeight || cv.height;
    var s = state.cam.scale;
    return {
      w: w, h: h, s: s,
      x0: state.cam.x - w / 2 / s, x1: state.cam.x + w / 2 / s,
      z0: state.cam.z - h / 2 / s, z1: state.cam.z + h / 2 / s,
      px: function (x) { return (x - state.cam.x) * s + w / 2; },
      pz: function (z) { return (z - state.cam.z) * s + h / 2; }
    };
  }

  function drawStreets(v) {
    var tiers = [
      ["local", "#1c222d", 1],
      ["arterial", "#2b3342", 1.4],
      ["freeway", "#3d465a", 2]
    ];
    var n = 0;
    tiers.forEach(function (t) {
      var name = t[0];
      // Fit-view scale is ~0.0084 (desktop) / ~0.0040 (phone); the old
      // 0.07 cutoff hid the local tier -- 87% of the basemap -- until an
      // 8x zoom, leaving a street-less skeleton at city view.
      if (name === "local" && v.s < 0.0035) return;
      var arr = state.streets[name];
      ctx.strokeStyle = t[1]; ctx.lineWidth = t[2];
      ctx.beginPath();
      for (var i = 0; i < arr.length; i += 4) {
        var x1 = arr[i], z1 = arr[i + 1], x2 = arr[i + 2], z2 = arr[i + 3];
        if ((x1 < v.x0 && x2 < v.x0) || (x1 > v.x1 && x2 > v.x1) ||
            (z1 < v.z0 && z2 < v.z0) || (z1 > v.z1 && z2 > v.z1)) continue;
        ctx.moveTo(v.px(x1), v.pz(z1)); ctx.lineTo(v.px(x2), v.pz(z2));
        n++;
      }
      ctx.stroke();
    });
    state.stats.segments = n;
  }

  function drawRoutes(v) {
    if (!state.showRoutes) { state.stats.paths = 0; return; }
    var n = 0;
    state.routes.routes.forEach(function (r) {
      if (!state.groups[r.group]) return;
      ctx.strokeStyle = r.color; ctx.globalAlpha = 0.8;
      ctx.lineWidth = (r.group === "bus") ? 1.6 : 2.6;
      r.paths.forEach(function (path) {
        ctx.beginPath();
        var prevIn = false;
        for (var i = 0; i < path.length; i++) {
          var X = v.px(path[i][0]), Y = v.pz(path[i][1]);
          var inE = inExtent(path[i][0], path[i][1]);
          if (i === 0 || (!inE && !prevIn)) ctx.moveTo(X, Y);
          else ctx.lineTo(X, Y);
          prevIn = inE;
        }
        ctx.stroke(); n++;
      });
    });
    ctx.globalAlpha = 1;
    state.stats.paths = n;
  }

  function drawStops(v) {
    if (!state.showStops || v.s < 0.22) return;
    ctx.fillStyle = "#9fb4c8";
    state.stopList.forEach(function (st) {
      if (!inExtent(st.x, st.z)) return;
      if (st.x < v.x0 || st.x > v.x1 || st.z < v.z0 || st.z > v.z1) return;
      ctx.fillRect(v.px(st.x) - 1.5, v.pz(st.z) - 1.5, 3, 3);
    });
  }

  function drawVehicles(v) {
    var markers = buildMarkers(state.veh);
    var drawn = 0;
    markers.forEach(function (m) {
      if (!inExtent(m.x, m.z)) return;
      if (m.group && !state.groups[m.group]) return;
      var X = v.px(m.x), Y = v.pz(m.z);
      if (X < -20 || Y < -20 || X > v.w + 20 || Y > v.h + 20) return;
      ctx.beginPath();
      ctx.arc(X, Y, 5, 0, Math.PI * 2);
      ctx.fillStyle = m.color || "#8a8f98";
      ctx.fill();
      ctx.lineWidth = 1.4; ctx.strokeStyle = "#0b0e13"; ctx.stroke();
      if (v.s > 0.03 && m.route) {
        ctx.font = "600 9px system-ui, sans-serif";
        ctx.fillStyle = "#e8edf2";
        ctx.fillText(m.routeObj ? m.routeObj.short : m.route, X + 7, Y + 3);
      }
      drawn++;
    });
    state.stats.markers = drawn;
    return markers;
  }

  function render() {
    var cv = canvas();
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth || 960, h = cv.clientHeight || 640;
    if (cv.width !== Math.round(w * dpr)) { cv.width = w * dpr; cv.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0b0e13"; ctx.fillRect(0, 0, w, h);
    var v = view();
    drawStreets(v); drawRoutes(v); drawStops(v); drawVehicles(v);
  }
  window.PHL.render = render;
  window.PHL.pick = pick;

  // ---- status + info -------------------------------------------------------
  function fmtET(tsSec) {
    try {
      return new Date(tsSec * 1000).toLocaleTimeString("en-US",
        { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
    } catch (e) { return ""; }
  }
  function updateStatus(note) {
    var el = document.getElementById("status");
    if (!el) return;
    if (!state.veh) { el.textContent = note || "Loading live vehicles…"; return; }
    var parts = [];
    Object.keys(state.veh.feeds).forEach(function (fid) {
      var f = state.veh.feeds[fid];
      var name = fid === "septa-bus" ? "Bus feed" : "Rail feed";
      var drawn = buildMarkers({ feeds: (function () { var o = {}; o[fid] = f; return o; })() })
        .filter(function (m) {
          return inExtent(m.x, m.z) && (!m.group || state.groups[m.group]);
        }).length;
      parts.push(name + " " + fmtET(Date.parse(f.feed_header_at) / 1000) +
        " ET · " + drawn + " vehicles on the map");
    });
    var staleNote = "";
    if (state.veh.fetched_at) {
      var ageSec = (Date.now() - Date.parse(state.veh.fetched_at)) / 1000;
      if (ageSec > 600) {
        staleNote = "Live updates are delayed \u2014 this data is from " +
          fmtET(Date.parse(state.veh.fetched_at) / 1000) + " ET (" +
          Math.round(ageSec / 60) + " min old)";
      }
    }
    el.textContent = parts.join("  ·  ") +
      (staleNote ? "  ·  " + staleNote : "") + (note ? "  ·  " + note : "");
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function showInfo(html) {
    var el = document.getElementById("info");
    if (el) { el.innerHTML = html; el.style.display = html ? "block" : "none"; }
  }
  window.PHL.showInfo = showInfo;

  // ---- interaction ---------------------------------------------------------
  function wireUi() {
    var cv = canvas();
    var drag = null;
    cv.addEventListener("pointerdown", function (e) {
      var p0 = evtPos(e);
      drag = { x: p0.x, y: p0.y, moved: false };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener("pointermove", function (e) {
      if (!drag) return;
      var p1 = evtPos(e);
      var dx = p1.x - drag.x, dy = p1.y - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved) {
        state.cam.x -= dx / state.cam.scale;
        state.cam.z -= dy / state.cam.scale;
        drag.x = p1.x; drag.y = p1.y;
        render();
      }
    });
    cv.addEventListener("pointerup", function (e) {
      if (drag && !drag.moved) { var pu = evtPos(e); pick(pu.x, pu.y); }
      drag = null;
    });
    cv.addEventListener("wheel", function (e) {
      e.preventDefault();
      var f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      var pw = evtPos(e);
      zoomAt(pw.x, pw.y, f);
    }, { passive: false });
    document.querySelectorAll("[data-group]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        state.groups[cb.getAttribute("data-group")] = cb.checked; render();
      });
    });
    var zIn = document.getElementById("zin"), zOut = document.getElementById("zout");
    if (zIn) zIn.addEventListener("click", function () { zoomAt(null, null, 1.3); });
    if (zOut) zOut.addEventListener("click", function () { zoomAt(null, null, 1 / 1.3); });
    window.addEventListener("resize", render);
  }
  function zoomAt(cx, cy, f) {
    var cv = canvas(), v = view();
    var mx = cx == null ? state.cam.x : state.cam.x + (cx - v.w / 2) / v.s;
    var mz = cy == null ? state.cam.z : state.cam.z + (cy - v.h / 2) / v.s;
    state.cam.scale = Math.max(0.004, Math.min(2.5, state.cam.scale * f));
    if (cx != null) {
      state.cam.x = mx - (cx - v.w / 2) / state.cam.scale;
      state.cam.z = mz - (cy - v.h / 2) / state.cam.scale;
    }
    render();
  }
  function pick(cx, cy) {
    var v = view();
    var markers = buildMarkers(state.veh);
    var best = null, bd = 16;
    markers.forEach(function (m) {
      if (!inExtent(m.x, m.z)) return;
      var d = Math.hypot(v.px(m.x) - cx, v.pz(m.z) - cy);
      if (d < bd) { bd = d; best = m; }
    });
    if (best) {
      showInfo("<strong>" + (best.routeObj ? esc(best.routeObj.short) + " — " + esc(best.routeObj.name) : "Vehicle " + esc(best.label)) + "</strong><br>" +
        "Vehicle " + esc(best.label) + (best.route ? " · feed route " + esc(best.route) : " · no route assignment on this record") +
        "<br>" + (best.feed === "septa-bus" ? "SEPTA bus feed" : "SEPTA rail feed") +
        (best.ts ? " · position as of " + fmtET(best.ts) + " ET" : ""));
      return;
    }
    if (state.showStops && v.s >= 0.22) {
      var bs = null; bd = 10;
      state.stopList.forEach(function (st) {
        var d = Math.hypot(v.px(st.x) - cx, v.pz(st.z) - cy);
        if (d < bd) { bd = d; bs = st; }
      });
      if (bs) {
        showInfo("<strong>" + esc(bs.n) + "</strong><br>Routes: " + (bs.r.map(esc).join(", ") || "—"));
        return;
      }
    }
    showInfo("");
  }

  window.PHL.boot = boot;
  if (typeof document !== "undefined" && document.getElementById("map")) {
    if (window.__PHL_FIXTURE__) boot(window.__PHL_FIXTURE__);
    else document.addEventListener("DOMContentLoaded", function () { boot(); });
  }
})();
