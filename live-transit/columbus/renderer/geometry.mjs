// renderer/geometry.mjs — pure geometry for the 3D deck-ribbon renderer.
// PHL REBUILD R3 (LT-KAES-09/13). Label: UNVERIFIED / legacy-unsigned.
//
// KAES-07 seam-adjacent: the ribbon algorithm is the platform's
// reference geometry (transcribed from Detroit's production
// ribbonGeometry/chaikin/miterOffset semantics — see the R3 record
// for the LT-G13 equivalence measurement). No THREE imports here:
// everything is plain arrays, so Node harnesses exercise the exact
// code that builds the browser meshes.
//
// Units: x/z projected metres; y up in metres.

// Chaikin corner-cutting x2 (reference semantics): each iteration
// replaces every segment with two quarter-points.
export function chaikin(pts) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const out = [pts[0]];
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
    out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
  }
  out.push(pts[n - 1]);
  return out;
}

// True miter offset at point i (reference semantics): offset along
// the angle bisector, scaled by 1/cos(half-angle), clamped to 2x so
// the ribbon holds constant width through turns without spikes.
export function miterOffset(pts, i, hw) {
  const n = pts.length;
  const p = pts[i];
  const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
  let d0x = p[0] - a[0], d0z = p[1] - a[1];
  let d1x = b[0] - p[0], d1z = b[1] - p[1];
  const l0 = Math.hypot(d0x, d0z), l1 = Math.hypot(d1x, d1z);
  let nx, nz, m;
  if (l0 < 1e-6 || l1 < 1e-6) {
    const ex = l0 >= l1 ? d0x : d1x, ez = l0 >= l1 ? d0z : d1z;
    const el = Math.hypot(ex, ez) || 1;
    nx = -ez / el; nz = ex / el; m = 1;
  } else {
    d0x /= l0; d0z /= l0; d1x /= l1; d1z /= l1;
    let tx = d0x + d1x, tz = d0z + d1z;
    const tl = Math.hypot(tx, tz);
    if (tl < 1e-6) { nx = -d0z; nz = d0x; m = 1; }
    else {
      tx /= tl; tz /= tl; nx = -tz; nz = tx;
      m = 1 / Math.max(0.5, nx * -d0z + nz * d0x);
    }
  }
  return [nx * hw * m, nz * hw * m];
}

/**
 * Deck ribbon: flat strip of constant width through miter offsets,
 * over the Chaikin x2-smoothed path. Returns {positions: Float32Array
 * (x,y,z triples, 2 per station), index: Uint32Array}.
 */
export function ribbonGeometry(pts, width, y) {
  const s = chaikin(chaikin(pts));
  const n = s.length;
  const pos = new Float32Array(n * 2 * 3);
  const idx = new Uint32Array(Math.max(0, (n - 1) * 6));
  const hw = width / 2;
  for (let i = 0; i < n; i++) {
    const p = s[i], o = miterOffset(s, i, hw);
    pos.set([p[0] + o[0], y, p[1] + o[1]], i * 6);
    pos.set([p[0] - o[0], y, p[1] - o[1]], i * 6 + 3);
    if (i < n - 1) {
      const k = i * 2, j = i * 6;
      idx[j] = k; idx[j + 1] = k + 1; idx[j + 2] = k + 2;
      idx[j + 3] = k + 1; idx[j + 4] = k + 3; idx[j + 5] = k + 2;
    }
  }
  return { positions: pos, index: idx, stations: n };
}

/**
 * Vertical skirts under an elevated ribbon (both edges, y=0 to yTop).
 */
export function skirtGeometry(pts, width, yTop) {
  const s = chaikin(chaikin(pts));
  const n = s.length;
  const hw = width / 2;
  const pos = new Float32Array(n * 2 * 2 * 3);
  const idx = new Uint32Array(Math.max(0, (n - 1) * 2 * 6));
  let w = 0, iw = 0;
  for (const side of [1, -1]) {
    const base = w / 3;
    for (let i = 0; i < n; i++) {
      const p = s[i], o = miterOffset(s, i, hw);
      pos.set([p[0] + o[0] * side, 0, p[1] + o[1] * side], w); w += 3;
      pos.set([p[0] + o[0] * side, yTop, p[1] + o[1] * side], w); w += 3;
      if (i < n - 1) {
        const k = base + i * 2;
        idx[iw++] = k; idx[iw++] = k + 2; idx[iw++] = k + 1;
        idx[iw++] = k + 1; idx[iw++] = k + 2; idx[iw++] = k + 3;
      }
    }
  }
  return { positions: pos.subarray(0, w), index: idx.subarray(0, iw) };
}

/** Extrude a footprint ring to a prism of given height (landmarks). */
export function prismGeometry(ring, height) {
  const n = ring.length;
  const pos = new Float32Array((n * 2 + n) * 3);
  const idx = [];
  let w = 0;
  for (let i = 0; i < n; i++) {
    pos.set([ring[i][0], 0, ring[i][1]], w); w += 3;
    pos.set([ring[i][0], height, ring[i][1]], w); w += 3;
  }
  const topBase = n * 2 * 3;
  for (let i = 0; i < n; i++) {
    pos.set([ring[i][0], height, ring[i][1]], topBase + i * 3);
    if (i < n - 1) {
      const a = i * 2, b = i * 2 + 1, c = ((i + 1) % n) * 2, d = ((i + 1) % n) * 2 + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  // top cap: fan around vertex 0
  for (let i = 1; i < n - 1; i++) {
    idx.push(n * 2, n * 2 + i, n * 2 + i + 1);
  }
  return { positions: pos, index: new Uint32Array(idx) };
}

/**
 * Simple ear-clipping triangulation of a simple polygon ring
 * ([x,z] pairs, any winding; first point need not repeat).
 * Returns index array into the ring's vertex order.
 */
export function triangulateRing(ring) {
  let pts = ring.slice();
  if (pts.length >= 2 && pts[0][0] === pts[pts.length - 1][0]
      && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  const n = pts.length;
  if (n < 3) return [];
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const order = [];
  for (let i = 0; i < n; i++) order.push(i);
  if (area < 0) order.reverse();
  const V = order.slice();
  const idx = [];
  let guard = 0;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (p, a, b, c) => {
    const d1 = cross(p, a, b), d2 = cross(p, b, c), d3 = cross(p, c, a);
    return !((d1 < 0) !== (d2 < 0) || (d2 < 0) !== (d3 < 0));
  };
  while (V.length > 3 && guard++ < n * n) {
    let ear = -1;
    for (let i = 0; i < V.length; i++) {
      const a = pts[V[(i + V.length - 1) % V.length]];
      const b = pts[V[i]];
      const c = pts[V[(i + 1) % V.length]];
      if (cross(a, b, c) <= 0) continue;
      let inside = false;
      for (let j = 0; j < V.length; j++) {
        if (j === (i + V.length - 1) % V.length || j === i || j === (i + 1) % V.length) continue;
        if (inTri(pts[V[j]], a, b, c)) { inside = true; break; }
      }
      if (!inside) { ear = i; break; }
    }
    if (ear < 0) break; // degenerate; stop rather than loop
    const i0 = V[(ear + V.length - 1) % V.length], i1 = V[ear], i2 = V[(ear + 1) % V.length];
    idx.push(i0, i1, i2);
    V.splice(ear, 1);
  }
  if (V.length === 3) idx.push(V[0], V[1], V[2]);
  return idx;
}

/** Compute the extent of all route path points (LT-S2.3: measured, never stored). */
export function extentOfRoutes(routesByFeed) {
  let xMin = Infinity, xMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (const doc of Object.values(routesByFeed)) {
    for (const r of doc.routes) {
      for (const path of r.paths) {
        for (const p of path) {
          if (p[0] < xMin) xMin = p[0];
          if (p[0] > xMax) xMax = p[0];
          if (p[1] < zMin) zMin = p[1];
          if (p[1] > zMax) zMax = p[1];
        }
      }
    }
  }
  return { xMin, xMax, zMin, zMax };
}

/** Point-to-polyline distance in projected metres (audit / label use). */
export function polylineDistance(x, z, line) {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const ax = line[i][0], az = line[i][1], bx = line[i + 1][0], bz = line[i + 1][1];
    const dx = bx - ax, dz = bz - az;
    const L2 = dx * dx + dz * dz;
    let t = L2 === 0 ? 0 : ((x - ax) * dx + (z - az) * dz) / L2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - (ax + t * dx), z - (az + t * dz));
    if (d < best) best = d;
  }
  return best;
}
