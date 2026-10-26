// extension_probes.mjs — Board 65 item 3 refresh acceptance: probes
// proving (a) the old book still governs its segment, (b) the new book
// governs from 2026-11-01, and (c) rail service now runs past the old
// 2026-11-21 cliff through 2027-02-20 — on the compiled union asset
// through the production planner host (day basis).
// Run: TZ=America/New_York ASSET_PATH=<asset> node extension_probes.mjs
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(process.env.REBUILD_ROOT ||
  '/home/hatch/workspace/goals/live-transit-philadelphia/hidden_files/rebuild');
const ASSET_PATH = process.env.ASSET_PATH;
const STOPS_PATH = join(ROOT, 'planner/assets/stops-sidecar.json');
const stops = JSON.parse(readFileSync(STOPS_PATH, 'utf8'));
const idxByFeedStop = new Map();
stops.forEach((s, i) => idxByFeedStop.set(s.feed + ':' + s.stop_id, i));
const idx = (feed, sid) => idxByFeedStop.get(feed + ':' + sid);
const idxByName = (feed, pat) => {
  const hits = [];
  stops.forEach((s, i) => { if (s.feed === feed && pat.test(s.name)) hits.push(i); });
  return hits;
};

const HOST = await import(pathToFileURL(join(ROOT, 'modules/planner-host.mjs')).href);
const fileFetch = async (url) => {
  const clean = String(url).split('?')[0].split('#')[0];
  const path = clean.includes('planner-stops') ? STOPS_PATH : ASSET_PATH;
  try {
    const text = readFileSync(path, 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
  } catch { return { ok: false, status: 404, json: async () => ({}) }; }
};
const host = HOST.createPlannerHost();
await host.loadPlanner({ assetUrl: 'mem://planner/' + ASSET_PATH.split('/').pop(), stopsUrl: 'mem://planner/planner-stops.json', fetchImpl: fileFetch });

const fernRock = idxByName(0, /Fern Rock/);
const broadSpring = idxByName(0, /Broad-Spring Garden/);
console.log('name resolution: Fern Rock idx=' + JSON.stringify(fernRock.map((i) => [i, stops[i].stop_id, stops[i].name])) +
  ' Broad-Spring Garden idx=' + JSON.stringify(broadSpring.map((i) => [i, stops[i].stop_id, stops[i].name])));
const CASES = [
  ['OLD-BOOK Fri 2026-10-30 bus Fern Rock -> Broad-Spring Garden', 0, stops[fernRock[0]].stop_id, 0, stops[broadSpring[0]].stop_id, '2026-10-30T17:55:00', 0],
  ['NEW-BOOK Mon 2026-11-02 bus Frankford TC -> 13th St', 0, '21204', 0, '283', '2026-11-02T08:15:00', 0],
  ['RAIL-EXT Mon 2026-11-23 Suburban -> Lansdale', 1, '90005', 1, '90531', '2026-11-23T08:00:00', 1],
  ['RAIL-EXT Wed 2026-12-02 Temple -> Suburban', 1, '90007', 1, '90005', '2026-12-02T08:00:00', 1],
  ['RAIL-EXT Wed 2027-01-06 Temple -> Suburban', 1, '90007', 1, '90005', '2027-01-06T08:00:00', 1],
  ['RAIL-EXT Fri 2027-02-19 Suburban -> Airport B', 1, '90005', 1, '90403', '2027-02-19T08:00:00', 1],
];
let fails = 0;
for (const [label, of, os, df, ds, when, wantFeed] of CASES) {
  const oi = idx(of, os), di = idx(df, ds);
  if (oi === undefined || di === undefined) { console.log(`FAIL  ${label} — stop id unresolved`); fails++; continue; }
  const plan = await host.planTripAsync(oi, di, when,
    { id: label, kind: 'probe', expect: 'any', originName: stops[oi].name, destinationName: stops[di].name },
    { useMemo: false });
  const legs = (plan.matched || []).flatMap((m) => (m.journey && m.journey.legs) || []);
  const ride = legs.find((l) => l.type !== 'walk' && stops[l.board] && stops[l.board].feed === wantFeed);
  const ok = plan.ok === true && !!ride;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ok=${plan.ok} matched=${(plan.matched || []).length} rideLeg=${ride ? `route=${ride.routeId} board=${ride.boardSec} alight=${ride.alightSec}` : 'none'}`);
}
console.log(fails === 0 ? 'EXTENSION PROBES: PASS' : `EXTENSION PROBES: FAIL ${fails}`);
process.exit(fails === 0 ? 0 : 1);
