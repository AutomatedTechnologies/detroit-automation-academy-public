// modules/ride-along.mjs — Ride Along (LT-KAES-32 / LT-S6).
// PHL REBUILD R5 implementation. Label: UNVERIFIED / legacy-unsigned.
//
// Ride Along is its own module (KAES-32), behind the host
// interface the R1 surfaces contract declared. Boarding is ALWAYS
// an explicit rider action (LT-S6.1) — nothing in this module
// boards on its own; surfaces call board() from a picker tap, a
// stop card's "Live on these routes" row, a direction row, or a
// vehicle card.
//
// Derivation (LT-S6.2): upcoming stops come from the vehicle's
// route path — registry stops carrying the route, projected onto
// the path the vehicle is nearest to, ordered by arc length. A
// stop is upcoming iff its arc position is > 5 m ahead of the
// vehicle's; the position row reads "at" within 25 m, else "just
// past". When the vehicle's trip is matched in the trip-updates
// family, the trip's remaining stops RESTRICT the list; a
// restriction that would empty the list is ignored — geometry is
// the floor.
//
// Time display is coverage-honest (LT-S6.3), per stop:
//   live      — the trip-updates family carries a time for the
//               stop on this trip (the SEPTA TU leg produces them);
//   scheduled — no TU time, but the trip resolves in the compiled
//               timetable (trip-map) and carries a scheduled time;
//   none      — no time is published to this view for the stop;
//               the row shows the sequence only and the card
//               carries the named note. Nothing is synthesized
//               (LT-F7).
// Transfers at each upcoming stop read from the stop's own
// served-route list, own route excluded (LT-S6.4); surfaces render
// the labels (Standard S2/S3 live there).

import { resolveRouteId } from '../renderer/scene-model.mjs';

export const RA_CONSTANTS = Object.freeze({
  aheadM: 5, //        LT-S6.2: upcoming iff arc > vehicle arc + 5 m
  atWindowM: 25, //    LT-S6.2: position row reads "at" within 25 m
});

/** Vehicle-number order (LT-S6.1 / Standard S3): numeric ascending
 *  when both numbers are numeric, (agency, route) tiebreak. */
export function compareVehiclesS3(a, b) {
  const na = Number(a.vehicle_id), nb = Number(b.vehicle_id);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  const sa = String(a.vehicle_id), sb = String(b.vehicle_id);
  if (sa !== sb) return sa < sb ? -1 : 1;
  const aa = `${a.agency}|${a.route_id || ''}`, ab = `${b.agency}|${b.route_id || ''}`;
  return aa < ab ? -1 : aa > ab ? 1 : 0;
}

function pathArcs(path) {
  const arcs = [0];
  for (let i = 1; i < path.length; i++) {
    arcs.push(arcs[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  }
  return arcs;
}

/** Project (x, z) onto a polyline: { arc, dist } of the closest point. */
function projectOntoPath(x, z, path, arcs) {
  let best = { arc: 0, dist: Infinity };
  for (let i = 1; i < path.length; i++) {
    const [x1, z1] = path[i - 1], [x2, z2] = path[i];
    const dx = x2 - x1, dz = z2 - z1;
    const L2 = dx * dx + dz * dz;
    let t = L2 === 0 ? 0 : ((x - x1) * dx + (z - z1) * dz) / L2;
    t = Math.max(0, Math.min(1, t));
    const px = x1 + t * dx, pz = z1 + t * dz;
    const d = Math.hypot(x - px, z - pz);
    if (d < best.dist) best = { arc: arcs[i - 1] + t * Math.sqrt(L2), dist: d };
  }
  return best;
}

/**
 * Create a Ride Along instance.
 * deps:
 *   model        the R3 scene model (state read LIVE at call time:
 *                state.stops / state.routeById / projector — the
 *                geometry arrays are replaced at load, so nothing
 *                may capture them at construction)
 *   tuByTrip     () -> Map(trip_id -> trip-update record)
 *   scheduledTimeFor(tripId, stop) -> epoch ms | null
 *                (timetable fallback; surfaces owns the asset)
 */
export function createRideAlong(deps) {
  const model = deps.model;
  const stops = () => (model && model.state.stops) || [];
  const routeById = () => (model && model.state.routeById) || {};
  const projector = model.projector;
  const tuByTrip = deps.tuByTrip || (() => new Map());
  let boarded = null; // the live vehicle record (refreshed by update)

  const routeOf = (record) => resolveRouteId(routeById(), record && record.route_id);

  /** Picker model (LT-S6.1): reporting vehicles with a resolvable
   *  route, in vehicle-number order; every other reporting record
   *  is counted with its reason — never silently dropped. */
  function pickerModel(records) {
    const boardable = [];
    const notBoardable = [];
    for (const r of records || []) {
      if (typeof r.lat !== 'number' || typeof r.lon !== 'number') {
        notBoardable.push({ record: r, reason: 'no-position' });
      } else if (!routeOf(r)) {
        notBoardable.push({ record: r, reason: 'no-route-assignment' });
      } else {
        boardable.push(r);
      }
    }
    boardable.sort(compareVehiclesS3);
    return { boardable, notBoardable };
  }

  function board(record) {
    if (!record || !routeOf(record)) {
      return { ok: false, reason: 'no-route-assignment' };
    }
    if (typeof record.lat !== 'number' || typeof record.lon !== 'number') {
      return { ok: false, reason: 'no-position' };
    }
    boarded = record;
    return { ok: true };
  }

  function exit() { boarded = null; }
  function active() { return boarded; }

  /** Refresh the boarded record from a newer envelope (same
   *  vehicle_id). If the vehicle stops reporting, the boarded
   *  state clears and says so. */
  function update(records) {
    if (!boarded) return { ok: true, gone: false };
    const next = (records || []).find((r) => r.vehicle_id === boarded.vehicle_id
      && r.agency === boarded.agency);
    if (!next) { boarded = null; return { ok: true, gone: true }; }
    boarded = next;
    return { ok: true, gone: false };
  }

  /**
   * The derivation for one vehicle record (boarded or previewed —
   * the vehicle card previews the same computation Ride Along
   * runs, so the two surfaces can never disagree).
   * Returns { ok:true, view } | { ok:false, reason }.
   * view Row: { stop, aheadM, timeMs, timeKind, transfers[] }
   * timeKind: 'live' | 'scheduled' | null (sequence-only).
   */
  function computeFor(record) {
    const route = routeOf(record);
    if (!route) return { ok: false, reason: 'no-route-assignment' };
    if (!route.paths || !route.paths.length) return { ok: false, reason: 'no-route-path' };
    if (typeof record.lat !== 'number' || typeof record.lon !== 'number') {
      return { ok: false, reason: 'no-position' };
    }
    const boardedRef = record;
    const [vx, vz] = projector.project(boardedRef.lat, boardedRef.lon);
    // The path the vehicle is nearest to is its direction/pattern.
    let chosen = null;
    for (const path of route.paths) {
      if (path.length < 2) continue;
      const arcs = pathArcs(path);
      const proj = projectOntoPath(vx, vz, path, arcs);
      if (!chosen || proj.dist < chosen.proj.dist) chosen = { path, arcs, proj };
    }
    if (!chosen) return { ok: false, reason: 'no-route-path' };
    const vehArc = chosen.proj.arc;
    // Registry stops carrying this route, projected + arc-ordered.
    const rows = [];
    for (const st of stops()) {
      if (!(st.r || []).includes(route.id)) continue;
      const p = projectOntoPath(st.x, st.z, chosen.path, chosen.arcs);
      rows.push({ stop: st, arc: p.arc, offPathM: p.dist });
    }
    rows.sort((a, b) => a.arc - b.arc);
    // Position row (LT-S6.2): "at" within 25 m, else "just past".
    let position = null;
    for (const r of rows) {
      const delta = r.arc - vehArc;
      if (Math.abs(delta) <= RA_CONSTANTS.atWindowM) {
        position = { stop: r.stop, relation: 'at', deltaM: delta };
        break;
      }
      if (delta < 0) position = { stop: r.stop, relation: 'just-past', deltaM: delta };
    }
    let upcomingRows = rows.filter((r) => r.arc > vehArc + RA_CONSTANTS.aheadM);
    // Trip restriction (LT-S6.2): a matched trip's remaining stops
    // restrict the list; geometry is the floor if that would empty it.
    const tu = record.trip_id ? tuByTrip().get(record.trip_id) : null;
    let restricted = false;
    if (tu && Array.isArray(tu.stop_time_updates) && tu.stop_time_updates.length) {
      const fam = record.family === 'rail' ? 'R:' : 'B:';
      const remainingIds = new Set(tu.stop_time_updates.map((s) => fam + s.stop_id));
      const kept = upcomingRows.filter((r) => remainingIds.has(r.stop.id));
      if (kept.length) { upcomingRows = kept; restricted = true; }
    }
    const out = upcomingRows.map((r) => {
      let timeMs = null, timeKind = null;
      if (tu) {
        const fam = record.family === 'rail' ? 'R:' : 'B:';
        const stu = (tu.stop_time_updates || []).find((s) => fam + s.stop_id === r.stop.id);
        const ev = stu && (stu.arrival || stu.departure);
        if (ev && typeof ev.time === 'number') { timeMs = ev.time * 1000; timeKind = 'live'; }
      }
      if (timeMs === null && record.trip_id && deps.scheduledTimeFor) {
        const t = deps.scheduledTimeFor(record.trip_id, r.stop);
        if (typeof t === 'number') { timeMs = t; timeKind = 'scheduled'; }
      }
      const transfers = (r.stop.r || []).filter((rid) => rid !== route.id);
      return {
        stop: r.stop, aheadM: Math.round(r.arc - vehArc),
        timeMs, timeKind, transfers,
      };
    });
    // Coverage-honest note (LT-S6.3): named, never silent.
    let note = null;
    if (out.length && !out.some((r) => r.timeKind === 'live')) {
      note = out.some((r) => r.timeKind === 'scheduled')
        ? 'Times shown are scheduled — no live estimate for this vehicle right now.'
        : 'No times are published to this view for this vehicle — stops are shown in sequence.';
    }
    return {
      ok: true,
      view: {
        record, route, position,
        upcoming: out, restricted, note,
        hasTimes: out.some((r) => r.timeKind === 'live'),
        hasScheduled: out.some((r) => r.timeKind === 'scheduled'),
      },
    };
  }

  /** The boarded vehicle's view, or null when nothing is boarded. */
  function upcoming() {
    if (!boarded) return null;
    const r = computeFor(boarded);
    return r.ok ? r.view : null;
  }

  /** The same computation for any record, without boarding
   *  (the vehicle card's upcoming-stops list). */
  function preview(record) { return computeFor(record); }

  return { pickerModel, board, exit, active, update, upcoming, preview, routeOf };
}
