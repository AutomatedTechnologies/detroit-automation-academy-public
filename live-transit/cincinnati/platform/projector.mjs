// platform/projector.mjs — Shared-platform seam: equirectangular projector.
// PHL REBUILD R1 foundation. Label: UNVERIFIED / legacy-unsigned.
//
// LT-KAES-07 (Shared Platform Code, No Per-City Forks): the
// projector is a PLATFORM concept. Detroit and Philadelphia both
// project lat/lon onto one shared plane per city (Standard S10);
// the outgoing PHL build reimplemented it privately inside phl.js.
// In the rebuilt structure the projector lives behind this platform
// seam: the implementation below is the platform formula (the same
// convention the SEPTA assets' compiler used — carried from the
// outgoing build's projector(lat0, lon0), which was itself correct),
// and when the shared platform package lands, this file becomes a
// re-export of it. City code never reimplements it again.
//
// Interface (the contract R3 builds against):
//   createProjector({lat0, lon0}) -> { project(lat, lon) -> [x, z],
//                                      unproject(x, z) -> [lat, lon],
//                                      lat0, lon0, kx }
// Units: x/z in projected metres; z is NEGATED latitude (north is
// -z), matching the LT-G2/G3 asset format family.

export function createProjector({ lat0, lon0 }) {
  if (typeof lat0 !== 'number' || typeof lon0 !== 'number') {
    throw new TypeError('createProjector requires numeric {lat0, lon0}');
  }
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return Object.freeze({
    lat0,
    lon0,
    kx,
    project(lat, lon) {
      return [(lon - lon0) * kx, -(lat - lat0) * 111320];
    },
    unproject(x, z) {
      return [lat0 - z / 111320, lon0 + x / kx];
    },
  });
}
