// harness/verify-exception-added.mjs — PHL REPAIR TRANCHE
// (2026-10-25) acceptance for the planner-host ymd defect.
//
// Defect: planner-host dayTimetable passed ymdOf(d) — a NUMBER —
// to ENGINE.servicesFor, whose exception test is the strict
// string compare `e.date !== ymd`. calendar_dates exceptions
// therefore never matched on the day-compiled basis: services
// that run ONLY via an exception (added: 1) were silently
// dropped from every day plan. Fix: String(ymdOf(d)).
//
// Case (from the R5 live probe pair): BSL Express trip on
// service B:210181000 — base mask all-zero, runs only via
// exceptions (20261026 included). Fern Rock Transit Center
// (sidecar idx 4925) -> Broad-Spring Garden (idx 272), Monday
// 2026-10-26, depart after 17:55. The exception trip departs
// 18:10 (65400 s), arrives 18:22, route B2, headsign "NRG".
//
// AMENDMENT (Board 65 item 3 refresh, 2026-10-26): the asset is
// now the union compile of SEPTA waves v202609271 + v202611010.
// The old wave's copy of the service carries the union rename
// B:210181000_w27 (it is the service of record for 2026-10-26),
// and Fern Rock Transit Center (bus stop 20965) sits at sidecar
// idx 4929 in the refreshed registry (Broad-Spring Garden, bus
// stop 1279, is unchanged at idx 272). Premises below assert the
// renamed id and the re-derived indices against the new asset;
// expected times, route, and headsign are unchanged.
//
// Control property: on the UNPATCHED host this script FAILS
// (no 18:10 express journey on the day basis; day != full).
// On the patched host it PASSES and day == full.
// Run: TZ=America/New_York node harness/verify-exception-added.mjs
// Label: UNVERIFIED / legacy-unsigned.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSET_PATH = join(ROOT, 'planner/assets/planner-timetable-v202609271u202611010-v202609271u202611010.json');
const STOPS_PATH = join(ROOT, 'planner/assets/stops-sidecar.json');

let fails = 0;
const chk = (name, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

// Premise, read from the asset itself: the service exists with an
// all-zero base mask and an added:1 exception on 20261026.
const asset = JSON.parse(readFileSync(ASSET_PATH, 'utf8'));
const svc = asset.services.find((s) => s.id === 'B:210181000_w27');
chk('premise: service B:210181000_w27 (old-wave copy) exists with an all-zero base mask',
  !!svc && svc.mask.every((m) => m === 0),
  svc ? `mask=${JSON.stringify(svc.mask)} window=${svc.start}..${svc.end}` : 'missing');
chk('premise: an added:1 exception names B:210181000_w27 on 20261026',
  asset.service_exceptions.some((e) => e.service === 'B:210181000_w27' && e.date === '20261026' && e.added === 1));

const stops = JSON.parse(readFileSync(STOPS_PATH, 'utf8'));
chk('premise: sidecar idx 4929 is Fern Rock, idx 272 is Broad-Spring Garden',
  /Fern Rock/.test(stops[4929].name) && /Broad-Spring Garden/.test(stops[272].name),
  `${stops[4929].name} -> ${stops[272].name}`);

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
await host.loadPlanner({
  assetUrl: 'mem://planner/planner-timetable-v202609271u202611010-v202609271u202611010.json',
  stopsUrl: 'mem://planner/planner-stops.json', fetchImpl: fileFetch,
});

const desc = {
  id: 'EXC-ADDED-BSL-EXPRESS', kind: 'acceptance', expect: 'any',
  originName: stops[4929].name, destinationName: stops[272].name,
};
const WHEN = '2026-10-26T17:55:00';
const day = await host.planTripAsync(4929, 272, WHEN, desc, { useMemo: false, ttBasis: 'day' });
const full = await host.planTripAsync(4929, 272, WHEN, desc, { useMemo: false, ttBasis: 'full' });

const rideLegs = (plan) => (plan.matched || [])
  .flatMap((m) => (m.journey && m.journey.legs) || [])
  .filter((l) => l.type !== 'walk');
const dayExpress = rideLegs(day).find((l) => l.boardSec === 65400);
const fullExpress = rideLegs(full).find((l) => l.boardSec === 65400);

chk('full basis presents the 18:10 exception-added express (engine ground truth)',
  !!fullExpress, fullExpress ? `route=${fullExpress.routeName || fullExpress.routeId} headsign=${fullExpress.headsign}` : 'absent');
chk('day basis presents the 18:10 exception-added express (the repair)',
  !!dayExpress, dayExpress ? `route=${dayExpress.routeName || dayExpress.routeId} headsign=${dayExpress.headsign}` : 'absent — exception service dropped by day compilation');
chk('the express leg is the BSL Express trip (arrives 18:22)',
  !!dayExpress && dayExpress.alightSec === 66120,
  dayExpress ? `alightSec=${dayExpress.alightSec}` : 'no leg');
chk('day == full on matched journeys for the exception pair',
  JSON.stringify((day.matched || []).map((m) => m.journey)) === JSON.stringify((full.matched || []).map((m) => m.journey)),
  `day kept ${day.meta.tripsKept}/${day.meta.tripsTotal} trips`);

console.log(fails === 0 ? 'TEST PASS' : `TEST FAIL ${fails}`);
process.exit(fails === 0 ? 0 : 1);
