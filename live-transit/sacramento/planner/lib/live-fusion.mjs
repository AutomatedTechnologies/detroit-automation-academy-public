// planner/lib/live-fusion.mjs — live context for scheduled journeys.
// Cities V2 core fold, tranche F3 (CG-8). City-neutral port of the
// reference page's standalone fusion module (served as a sibling
// script beside the monolith planner page; fetched and read at F3
// build time). Every city-specific literal is stripped: this module
// knows only journey records, vehicle records, route ids and leg
// types — all values arrive from the caller.
//
// Two phases, exactly as the source module frames them:
//
// Phase 2a (IMPLEMENTED in the source, ported verbatim in logic):
// annotate every bus leg with the number of live vehicles currently
// reporting on its route. Honest and useful — "3 live" tells the
// rider their bus is actually out there — with zero fake ETAs.
//
// Phase 2b-i (delay propagation) does NOT live here: per poll, the
// host matches live vehicles to scheduled trips and hands the
// engine an adjusted timetable via setLiveDelays(); plan() reads
// times through the delay accessors, so legs carry provenance
// 'live' with delay + data-age metadata. Disrupted trips are
// flagged, never shifted. The matcher is the planner host's
// (modules/planner-host.mjs); this module's propagateDelays()
// remains the scaffold entry point the source shipped — it returns
// journeys unchanged, because rewriting journey times here would
// double-apply what the engine already applied at plan time.
//
//   Trip matching / delay / propagation / UI / revert semantics
//   are specified in the host matcher's header comment; the five
//   rules the source module states are preserved there:
//   clear margin or no match; delay clamp [-300 s, +1800 s] with
//   out-of-range trips marked disrupted, not shifted; propagation
//   only to stop times after now; live legs render as live;
//   three quiet polls revert a trip to scheduled.

/** Count live vehicles per route id. Pure. Input records carry the
 *  canonical live-layer shape ({ route_id, ... }); ids are compared
 *  as strings, as in the source. */
export function countLiveByRoute(vehicles) {
  var counts = Object.create(null);
  (vehicles || []).forEach(function (v) {
    if (v && v.route_id != null) {
      var rid = String(v.route_id);
      counts[rid] = (counts[rid] || 0) + 1;
    }
  });
  return counts;
}

/** Phase 2a: annotate every bus leg of every journey with the
 *  number of live vehicles currently reporting on its route
 *  (leg.liveVehicles). Mutates and returns the journeys array —
 *  the source module's contract, kept: the host calls this on the
 *  presented journey records it retains. */
export function fuseJourneys(journeys, vehicles) {
  var counts = countLiveByRoute(vehicles);
  (journeys || []).forEach(function (j) {
    (j.legs || []).forEach(function (l) {
      if (l.type === 'bus') l.liveVehicles = counts[String(l.routeId)] || 0;
    });
  });
  return journeys;
}

/** The host's applyTripFusion equivalent (the monolith page's
 *  wrapper): fuse the retained journeys against the latest vehicle
 *  set. Fusion never breaks planning — a malformed input yields
 *  the journeys back unannotated rather than a throw. */
export function applyTripFusion(journeys, vehicles) {
  try {
    return fuseJourneys(journeys, vehicles);
  } catch (e) {
    return journeys;
  }
}

// Phase 2b entry point (scaffold in the source, kept as scaffold):
// delay propagation is the engine's, via the host matcher's
// setLiveDelays() hand-off at plan time — returns journeys
// unchanged, exactly as the source module ships it.
export function propagateDelays(journeys /* , vehicles, timetable, nowSec */) {
  return journeys;
}
