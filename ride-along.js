/* Ride Along widget — upcoming stops and intersections from a bus rider's perspective.
 *
 * Data contracts (matches live-transit.js):
 *   routes: [{ id, name, color, paths: [[[x, z], ...], ...] }]
 *   stops:  [{ id, n (name), x, z, r: [routeId, ...] }]
 *   vehicle: { vehicle_id, route_id, destination, x, z, bearing, speed }
 *
 * Usage:
 *   var widget = RideAlong.create(document.getElementById('ride-along-mount'));
 *   widget.setData({ routes: [...], stops: [...] });
 *   widget.setVehicles([...]);          // live vehicle list
 *   widget.board(vehicleId);            // pick a bus to ride
 *   widget.updateVehicle(vehicle);      // refresh position each poll
 *
 * Optional callbacks (assigned by the host page):
 *   widget.onBoard(vehicleId)  — fired by board(), from any surface.
 *   widget.onAlight(vehicleId) — fired by alight() with the bus left.
 */

(function (global) {
  'use strict';

  // ---- geometry helpers ----

  function dist2(ax, az, bx, bz) {
    var dx = ax - bx, dz = az - bz;
    return dx * dx + dz * dz;
  }

  // Project point (px, pz) onto segment (ax,az)-(bx,bz).
  // Returns { x, z, t, d2 } where t is 0..1 along the segment.
  function projectSegment(px, pz, ax, az, bx, bz) {
    var dx = bx - ax, dz = bz - az;
    var len2 = dx * dx + dz * dz;
    var t = len2 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    var x = ax + t * dx, z = az + t * dz;
    return { x: x, z: z, t: t, d2: dist2(px, pz, x, z) };
  }

  // Flatten a route's paths into one ordered point list with cumulative
  // arc-length. Returns { pts: [[x,z]...], cum: [meters...], total }.
  function flattenPath(route) {
    var pts = [];
    (route.paths || []).forEach(function (path) {
      path.forEach(function (p) { pts.push(p); });
    });
    var cum = [0];
    for (var i = 1; i < pts.length; i++) {
      var dx = pts[i][0] - pts[i - 1][0], dz = pts[i][1] - pts[i - 1][1];
      cum.push(cum[i - 1] + Math.sqrt(dx * dx + dz * dz));
    }
    return { pts: pts, cum: cum, total: cum[cum.length - 1] || 0 };
  }

  // Find the bus's position along the flattened path.
  // Returns { segIndex, arcLen, x, z, pathBearing }.
  function locateOnPath(flat, bx, bz) {
    var best = null;
    for (var i = 0; i < flat.pts.length - 1; i++) {
      var p = projectSegment(bx, bz,
        flat.pts[i][0], flat.pts[i][1],
        flat.pts[i + 1][0], flat.pts[i + 1][1]);
      if (!best || p.d2 < best.d2) {
        var segLen = flat.cum[i + 1] - flat.cum[i];
        best = {
          segIndex: i, d2: p.d2,
          arcLen: flat.cum[i] + p.t * segLen,
          x: p.x, z: p.z,
          dx: flat.pts[i + 1][0] - flat.pts[i][0],
          dz: flat.pts[i + 1][1] - flat.pts[i][1]
        };
      }
    }
    if (best) {
      // Bearing of path direction at this segment (degrees, 0 = north).
      best.pathBearing = (Math.atan2(best.dx, -best.dz) * 180 / Math.PI + 360) % 360;
    }
    return best;
  }

  // Bearing difference in degrees, signed -180..180.
  function bearingDiff(a, b) {
    var d = ((a - b + 540) % 360) - 180;
    return d;
  }

  // ---- stop ordering ----

  // For each stop on the route, compute its arc-length position on the path.
  // Returns [{ stop, arcLen }] sorted by arcLen.
  function stopsAlongPath(flat, stops, routeId) {
    var out = [];
    stops.forEach(function (s) {
      if (!s.r || s.r.indexOf(routeId) < 0) return;
      var loc = locateOnPath(flat, s.x, s.z);
      if (loc) out.push({ stop: s, arcLen: loc.arcLen, x: loc.x, z: loc.z });
    });
    out.sort(function (a, b) { return a.arcLen - b.arcLen; });
    return out;
  }

  // Upcoming stops from the bus's position, in travel direction.
  // direction: +1 = forward along path, -1 = backward.
  function upcomingStops(stopsOnPath, busArcLen, direction, limit) {
    var out = [];
    if (direction > 0) {
      for (var i = 0; i < stopsOnPath.length && out.length < limit; i++) {
        if (stopsOnPath[i].arcLen > busArcLen + 5) out.push(stopsOnPath[i]);
      }
    } else {
      for (var j = stopsOnPath.length - 1; j >= 0 && out.length < limit; j--) {
        if (stopsOnPath[j].arcLen < busArcLen - 5) out.push(stopsOnPath[j]);
      }
    }
    return out;
  }

  // ---- intersections ----

  // Extract street names from a stop name like "Manchester & Woodward".
  // Returns array of street names, or [] if the name is not an intersection.
  function streetsFromStopName(name) {
    if (!name || name.indexOf('&') < 0) return [];
    return name.split('&').map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  // Intersections the bus will pass, derived from upcoming stop names.
  // Returns [{ streets: [...], stopName, arcLen }] deduplicated.
  function upcomingIntersections(upcoming) {
    var seen = {}, out = [];
    upcoming.forEach(function (u) {
      var streets = streetsFromStopName(u.stop.n);
      if (!streets.length) return;
      var key = streets.slice().sort().join('|').toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push({ streets: streets, stopName: u.stop.n, arcLen: u.arcLen });
    });
    return out;
  }

  // ---- widget ----

  function RideAlong(mount) {
    this.mount = mount;
    this.routes = [];
    this.stops = [];
    this.vehicles = [];
    this.routeById = {};
    this.flatById = {};
    this.currentVehicleId = null;
    this.render();
  }

  RideAlong.prototype.setData = function (data) {
    this.routes = data.routes || [];
    this.stops = data.stops || [];
    var self = this;
    this.routeById = {};
    this.flatById = {};
    this.routes.forEach(function (r) {
      self.routeById[r.id] = r;
      self.flatById[r.id] = flattenPath(r);
    });
    this.renderPicker();
  };

  RideAlong.prototype.setVehicles = function (vehicles) {
    this.vehicles = vehicles || [];
    this.renderPicker();
    if (this.currentVehicleId) this.refresh();
  };

  RideAlong.prototype.board = function (vehicleId) {
    this.currentVehicleId = vehicleId;
    this.refresh();
    // Rebuild the picker so the <select> shows the boarded bus. refresh()
    // renders only the ride body; without this, a programmatic board
    // (the host's selection state, not the dropdown) leaves the select
    // displaying "-- choose a bus --" until the next setVehicles
    // re-render — the widget looks un-boarded while it is riding.
    this.renderPicker();
    if (typeof this.onBoard === 'function') {
      try { this.onBoard(vehicleId); } catch (e) {}
    }
  };

  RideAlong.prototype.alight = function () {
    var prev = this.currentVehicleId;
    this.currentVehicleId = null;
    this.render();
    this.renderPicker();
    if (prev && typeof this.onAlight === 'function') {
      try { this.onAlight(prev); } catch (e) {}
    }
  };

  RideAlong.prototype.updateVehicle = function (vehicle) {
    var i = this.vehicles.findIndex(function (v) {
      return v.vehicle_id === vehicle.vehicle_id;
    });
    if (i >= 0) this.vehicles[i] = vehicle;
    else this.vehicles.push(vehicle);
    if (vehicle.vehicle_id === this.currentVehicleId) this.refresh();
  };

  RideAlong.prototype.currentVehicle = function () {
    var id = this.currentVehicleId;
    return this.vehicles.find(function (v) { return v.vehicle_id === id; }) || null;
  };

  RideAlong.prototype.refresh = function () {
    var v = this.currentVehicle();
    if (!v) { this.render(); return; }
    var route = this.routeById[v.route_id];
    var flat = this.flatById[v.route_id];
    if (!route || !flat || !flat.pts.length) { this.renderEmpty(v); return; }

    var loc = locateOnPath(flat, v.x, v.z);
    if (!loc) { this.renderEmpty(v); return; }

    // Travel direction: compare vehicle bearing to path bearing.
    var direction = 1;
    if (v.bearing != null && !isNaN(v.bearing)) {
      direction = Math.abs(bearingDiff(v.bearing, loc.pathBearing)) <= 90 ? 1 : -1;
    }

    var onPath = stopsAlongPath(flat, this.stops, v.route_id);
    var upcoming = upcomingStops(onPath, loc.arcLen, direction, 12);
    var intersections = upcomingIntersections(upcoming);
    this.renderRide(v, route, upcoming, intersections, direction);
  };

  // ---- rendering ----

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  RideAlong.prototype.render = function () {
    this.mount.innerHTML = '';
    var wrap = el('div', 'ra-wrap');
    wrap.appendChild(el('h3', 'ra-title', 'Ride Along'));
    wrap.appendChild(el('p', 'ra-hint', 'Pick a bus to see upcoming stops from the rider\u2019s seat.'));
    var picker = el('div', 'ra-picker'); picker.id = 'ra-picker';
    wrap.appendChild(picker);
    var body = el('div', 'ra-body'); body.id = 'ra-body';
    wrap.appendChild(body);
    this.mount.appendChild(wrap);
    this.renderPicker();
  };

  RideAlong.prototype.renderPicker = function () {
    var picker = this.mount.querySelector('#ra-picker');
    if (!picker) return;
    picker.innerHTML = '';
    if (!this.vehicles.length) {
      picker.appendChild(el('p', 'ra-empty', 'No buses reporting right now.'));
      return;
    }
    var sel = el('select', 'ra-select');
    sel.setAttribute('aria-label', 'Choose a bus to ride');
    sel.appendChild(el('option', '', '-- choose a bus --'));
    var self = this;
    // Sort by the displayed label with numeric-aware natural ordering, so
    // route numbers order 4, 7, 9, 10, 16 (and 200 before 210) instead of
    // lexicographic 10, 16, 4, 7, 9. Vehicle id is the final tiebreak.
    var labeled = this.vehicles.map(function (v) {
      var route = self.routeById[v.route_id];
      return {
        v: v,
        label: (route ? route.name + ' - ' + route.id : v.route_id) +
          ' · Bus ' + v.vehicle_id +
          (v.destination ? ' → ' + v.destination : '')
      };
    });
    labeled.sort(function (a, b) {
      return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }) ||
        String(a.v.vehicle_id).localeCompare(String(b.v.vehicle_id), undefined, { numeric: true });
    });
    labeled.forEach(function (item) {
      var v = item.v;
      var opt = el('option', '', item.label);
      opt.value = v.vehicle_id;
      if (v.vehicle_id === self.currentVehicleId) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () {
      if (sel.value) self.board(sel.value);
      else self.alight();
    });
    picker.appendChild(sel);
  };

  RideAlong.prototype.renderEmpty = function (v) {
    var body = this.mount.querySelector('#ra-body');
    if (!body) return;
    body.innerHTML = '';
    body.appendChild(el('p', 'ra-empty',
      'Bus ' + v.vehicle_id + ' is on route ' + v.route_id +
      ', but the route path is not loaded yet.'));
  };

  RideAlong.prototype.renderRide = function (v, route, upcoming, intersections, direction) {
    var body = this.mount.querySelector('#ra-body');
    if (!body) return;
    body.innerHTML = '';

    var head = el('div', 'ra-head');
    var dot = el('i', 'ra-dot');
    dot.style.background = route.color || '#9aa0a6';
    head.appendChild(dot);
    head.appendChild(el('b', 'ra-route', route.name + ' - ' + route.id));
    if (v.destination) head.appendChild(el('span', 'ra-dest', '→ ' + v.destination));
    body.appendChild(head);
    body.appendChild(el('p', 'ra-bus', 'Bus ' + v.vehicle_id +
      (v.speed != null ? ' · ' + Math.round(v.speed) + ' mph' : '')));

    if (!upcoming.length) {
      body.appendChild(el('p', 'ra-empty', 'No further stops ahead on this run.'));
      return;
    }

    // Next stop card.
    var next = upcoming[0];
    var nextCard = el('div', 'ra-next');
    nextCard.appendChild(el('p', 'ra-next-kicker', 'Next stop'));
    nextCard.appendChild(el('p', 'ra-next-name', next.stop.n));
    var streets = streetsFromStopName(next.stop.n);
    if (streets.length > 1) {
      nextCard.appendChild(el('p', 'ra-next-x',
        'Intersection of ' + streets.join(' and ')));
    }
    body.appendChild(nextCard);

    // Upcoming stops list.
    body.appendChild(el('h4', 'ra-sub', 'Upcoming stops'));
    var list = el('ol', 'ra-stops');
    for (var i = 1; i < upcoming.length; i++) {
      var li = el('li', 'ra-stop', upcoming[i].stop.n);
      var st = streetsFromStopName(upcoming[i].stop.n);
      if (st.length > 1) li.title = 'Intersection of ' + st.join(' and ');
      list.appendChild(li);
    }
    body.appendChild(list);

    // Intersections ahead.
    if (intersections.length) {
      body.appendChild(el('h4', 'ra-sub', 'Intersections ahead'));
      var xl = el('ul', 'ra-xlist');
      intersections.forEach(function (x) {
        xl.appendChild(el('li', 'ra-x', x.streets.join(' & ')));
      });
      body.appendChild(xl);
    }

    var leave = el('button', 'ra-leave', 'Get off this bus');
    var self = this;
    leave.addEventListener('click', function () { self.alight(); });
    body.appendChild(leave);
  };

  global.RideAlong = {
    create: function (mount) { return new RideAlong(mount); },
    // Exposed for unit testing.
    _flattenPath: flattenPath,
    _locateOnPath: locateOnPath,
    _stopsAlongPath: stopsAlongPath,
    _upcomingStops: upcomingStops,
    _streetsFromStopName: streetsFromStopName,
    _upcomingIntersections: upcomingIntersections
  };

})(typeof window !== 'undefined' ? window : this);
