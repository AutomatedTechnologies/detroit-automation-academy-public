// platform/picking.mjs — Shared-platform seam: interaction geometry.
// PHL REBUILD R1 foundation. Label: UNVERIFIED / legacy-unsigned.
//
// LT-KAES-14 / LT-G14 (Interaction Geometry): picking resolves
// against the rendered scene's own geometry; interaction
// coordinates are converted through the canvas rect BEFORE any
// comparison (defect class RC1 — the defect that made the outgoing
// MVP's taps miss: the handler passed viewport coordinates to a
// picker expecting canvas coordinates); the tolerance is the
// shared constant PICK_TOL_PX = 16 bounded by the 20 px no-hit
// guard (RC9); a tap that resolves to nothing is a clean no-op.
//
// Under the KAES-09 3D renderer the mechanism becomes scene
// raycasting (R3). The CONSTANTS and the coordinate-conversion
// contract in this file are the platform half that does not change.
//
// Interface (the contract R3/R5 build against):
//   PICK_TOL_PX, NO_HIT_GUARD_PX — platform constants
//   toCanvasPoint(event, canvasRect) -> {x, y} in canvas pixels
//   withinPickBand(distancePx) -> boolean (hit inside the band,
//     miss beyond the guard; between band and guard is the
//     renderer's nearest-candidate decision, never a second
//     tolerance invented per feature)

export const PICK_TOL_PX = 16; // shared: stops and vehicles (LT-G14)
export const NO_HIT_GUARD_PX = 20; // beyond this, no hit is possible (RC9)

/** RC1: viewport/client coordinates -> canvas pixel coordinates. */
export function toCanvasPoint(clientX, clientY, canvasRect) {
  return { x: clientX - canvasRect.left, y: clientY - canvasRect.top };
}

export function withinPickBand(distancePx) {
  return typeof distancePx === 'number' && distancePx <= PICK_TOL_PX;
}

export function beyondNoHitGuard(distancePx) {
  return typeof distancePx !== 'number' || distancePx > NO_HIT_GUARD_PX;
}
