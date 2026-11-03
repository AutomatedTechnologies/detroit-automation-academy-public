// renderer/camera.mjs — perspective camera view model (LT-KAES-10).
// PHL REBUILD R3. Label: UNVERIFIED / legacy-unsigned.
//
// One perspective camera model consumed by BOTH the browser renderer
// (which syncs the THREE camera + controls to it) and the picking
// path (which projects through it). That sharing is what makes the
// harness's pick suite a test of the REAL pick path: the projection
// the picker measures in is the projection the rider sees.
//
// View model: { target:{x,z}, distance (m), azimuthDeg,
// tiltDeg (0 = top-down, 90 = horizon) }. Scene axes: x/z are the
// projected plane metres (LT-G2 assets), y is up. The camera sits at
// target + spherical offset(distance, azimuth, tilt) and looks at
// the target point on the ground plane.
//
// Camera-memory (LT-S2.3, at R3 scope): one model object, mutated
// only by pan/zoom/orbit; fitToExtent changes target+distance and
// never resets the rider's azimuth/tilt.

export const DEFAULT_FOV_DEG = 55;

export function createCamera({ fovDeg = DEFAULT_FOV_DEG, width = 960, height = 640 } = {}) {
  const cam = {
    fovDeg, width, height,
    target: { x: 0, z: 0 },
    distance: 40000,
    azimuthDeg: 0,
    tiltDeg: 52,
    setViewport(w, h) { cam.width = w; cam.height = h; },
    // Fit so the extent reads inside the frustum, padded — the
    // street grid is visible at first paint (LT-S2.2 / RC3).
    fitToExtent(extent, pad = 1.08) {
      const cx = (extent.xMin + extent.xMax) / 2;
      const cz = (extent.zMin + extent.zMax) / 2;
      const r = 0.5 * Math.hypot(extent.xMax - extent.xMin, extent.zMax - extent.zMin);
      const t = Math.tan((cam.fovDeg * Math.PI) / 360);
      const aspect = cam.width / Math.max(1, cam.height);
      cam.target = { x: cx, z: cz };
      cam.distance = Math.max(r / t, r / (t * aspect)) * pad;
      return cam;
    },
    panBy(dxM, dzM) { cam.target.x += dxM; cam.target.z += dzM; },
    zoomBy(factor) {
      cam.distance = Math.max(120, Math.min(250000, cam.distance / factor));
    },
    orbitBy(dAzimuthDeg, dTiltDeg) {
      cam.azimuthDeg = (cam.azimuthDeg + dAzimuthDeg) % 360;
      cam.tiltDeg = Math.max(8, Math.min(82, cam.tiltDeg + dTiltDeg));
    },
    /** Camera eye position in scene metres [x, y, z]. */
    eye() {
      const az = (cam.azimuthDeg * Math.PI) / 180;
      const ti = (cam.tiltDeg * Math.PI) / 180;
      const horiz = cam.distance * Math.cos(ti);
      return [
        cam.target.x + horiz * Math.sin(az),
        cam.distance * Math.sin(ti),
        cam.target.z + horiz * Math.cos(az),
      ];
    },
    /** Orthonormal view basis {right, up, forward} (unit vectors). */
    basis() {
      const e = cam.eye();
      let fx = cam.target.x - e[0], fy = -e[1], fz = cam.target.z - e[2];
      const fl = Math.hypot(fx, fy, fz); fx /= fl; fy /= fl; fz /= fl;
      // right = normalize(cross(forward, worldUp=(0,1,0))) = (-fz, 0, fx)/n
      let rx = -fz, rz = fx;
      const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
      // up = cross(right, forward)
      const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
      return { right: [rx, 0, rz], up: [ux, uy, uz], forward: [fx, fy, fz], eye: e };
    },
    /**
     * A projection closure with the view basis computed ONCE —
     * for batch projection (picking, label placement) where the
     * camera does not move between points.
     */
    projectorFn() {
      const { right, up, forward, eye } = cam.basis();
      const t = Math.tan((cam.fovDeg * Math.PI) / 360);
      const aspect = cam.width / Math.max(1, cam.height);
      return (px, py, pz) => {
        const vx = px - eye[0], vy = py - eye[1], vz = pz - eye[2];
        const cx = vx * right[0] + vz * right[2];
        const cy = vx * up[0] + vy * up[1] + vz * up[2];
        const cz = vx * forward[0] + vy * forward[1] + vz * forward[2];
        if (cz <= 0.1) return null;
        return {
          x: ((cx / (cz * t * aspect)) * 0.5 + 0.5) * cam.width,
          y: (0.5 - (cy / (cz * t)) * 0.5) * cam.height,
          depth: cz,
        };
      };
    },
    /**
     * Project a scene point (x, y, z) to canvas pixels {x, y, depth}
     * (y down from top-left; depth = metres along the view ray).
     * Returns null when the point is behind the camera.
     */
    project(px, py, pz) {
      const { right, up, forward, eye } = cam.basis();
      const vx = px - eye[0], vy = py - eye[1], vz = pz - eye[2];
      const cx = vx * right[0] + vz * right[2];
      const cy = vx * up[0] + vy * up[1] + vz * up[2];
      const cz = vx * forward[0] + vy * forward[1] + vz * forward[2];
      if (cz <= 0.1) return null;
      const t = Math.tan((cam.fovDeg * Math.PI) / 360);
      const aspect = cam.width / Math.max(1, cam.height);
      return {
        x: ((cx / (cz * t * aspect)) * 0.5 + 0.5) * cam.width,
        y: (0.5 - (cy / (cz * t)) * 0.5) * cam.height,
        depth: cz,
      };
    },
  };
  return cam;
}
