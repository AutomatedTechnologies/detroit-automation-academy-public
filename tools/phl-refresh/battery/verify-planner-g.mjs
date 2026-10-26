// harness/verify-planner-g.mjs — R4 §G standalone: day-compiled
// vs full-asset equivalence, produced inside one process by the
// host itself (ttBasis 'day' vs 'full'). PHL REBUILD R4.
// Label: UNVERIFIED / legacy-unsigned.
// Run: TZ=America/New_York node harness/verify-planner-g.mjs
//
// verify-planner.mjs §G compares against the baseline driver's
// fresh full-asset records when that file exists; this script is
// the same proof without the cross-process dependency, for the
// three pairs whose full-asset cost is tractable (PHL1, PHL5,
// Paoli). PHL11's day==full equivalence is carried by
// verify-planner.mjs §C: its day-basis record reproduces the
// saved experiment record — which was produced on the full
// asset — field-for-field on all 19 fields.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PHL = resolve(ROOT, '..', '..');
const ASSET_PATH = join(ROOT, 'planner/assets/planner-timetable-v202609271u202611010-v202609271u202611010.json');
const STOPS_PATH = join(ROOT, 'planner/assets/stops-sidecar.json');
const OD = join(PHL, 'hidden_files/integration-staging/verification/od-pairs.json');

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}
const FIELDS = [
  'id', 'kind', 'expect', 'origin', 'destination', 'departAfter',
  'candidates', 'baselineJourneys', 'baselineBestArriveSec', 'rangeMeta',
  'departureAnomalies', 'flatPool', 'freqPool', 'selectionWindowSec',
  'windowExtendedPastFlat', 'windowExtensionSec', 'trigger', 'flat', 'freq',
];

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
const od = JSON.parse(readFileSync(OD, 'utf8'));
const stops = JSON.parse(readFileSync(STOPS_PATH, 'utf8'));
const CASES = [
  { q: od.queries.find((x) => x.id === 'PHL1-CC-TRUNK-RAIL') },
  { q: od.queries.find((x) => x.id === 'PHL5-CROSS-FAMILY-TRANSFER') },
  {
    q: {
      id: 'PAOLI-SUN-NOTRANSIT', kind: 'tail-c-no-transit', expect: 'any',
      origin: { name: stops[3774].name, page_idx: 3774 },
      destination: { name: stops[3775].name, page_idx: 3775 },
      depart_after: '2026-10-18T10:00:00',
    },
  },
];
let fails = 0;
for (const { q } of CASES) {
  const desc = { id: q.id, kind: q.kind, expect: q.expect, originName: q.origin.name, destinationName: q.destination.name };
  const day = await host.planTripAsync(q.origin.page_idx, q.destination.page_idx, q.depart_after, desc, { useMemo: false, ttBasis: 'day' });
  const full = await host.planTripAsync(q.origin.page_idx, q.destination.page_idx, q.depart_after, desc, { useMemo: false, ttBasis: 'full' });
  const drift = FIELDS.filter((f) => !deepEqual(day.result[f], full.result[f]));
  const legsEq = JSON.stringify(day.matched.map((m) => m.journey)) === JSON.stringify(full.matched.map((m) => m.journey));
  const ok = drift.length === 0 && legsEq;
  if (!ok) fails++;
  console.log((ok ? 'PASS' : 'FAIL') + `  G ${q.id}: day == full on 19 fields + matched leg detail` +
    (drift.length ? '  [drift: ' + drift.join(',') + ']' : '') +
    `  [day ${day.meta.planMs} ms vs full ${full.meta.planMs} ms; kept ${day.meta.tripsKept}/${day.meta.tripsTotal}]`);
}
console.log(fails === 0 ? 'TEST PASS' : 'TEST FAIL ' + fails);
process.exit(fails === 0 ? 0 : 1);
