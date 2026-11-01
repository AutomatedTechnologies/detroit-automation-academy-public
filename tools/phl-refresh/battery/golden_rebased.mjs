// golden_rebased.mjs — Board 65 item 3 refresh acceptance: the R4
// golden pairs re-based onto the refreshed asset's registry.
// The recorded experiment (results-phl-set-v2-2026-10-22-freqbound.json)
// keys pairs by page_idx into the OLD registry; the refresh changes
// the registry (9 new bus stops), so indices are re-derived here from
// the stop ids named in od-pairs.json, resolved in the NEW sidecar.
// Comparison of record: baselineBestArriveSec per pair (Ruling 5's
// single-optimum arrival) — equality expected; any drift is reported
// per pair for investigation, never waved.
// Run from the rebuild tree AFTER re-staging:
//   TZ=America/New_York node /tmp/phl-rail-refresh/golden_rebased.mjs
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(process.env.REBUILD_ROOT ||
  '/home/hatch/workspace/goals/live-transit-philadelphia/hidden_files/rebuild');
const PHL = resolve(ROOT, '..', '..');
const OD = JSON.parse(readFileSync(join(PHL,
  'hidden_files/integration-staging/verification/od-pairs.json'), 'utf8'));
const SAVED = JSON.parse(readFileSync(join(PHL,
  'hidden_files/nav-harness/experiment-v2/results-phl-set-v2-2026-10-22-freqbound.json'), 'utf8'));
const ASSET_PATH = process.env.ASSET_PATH;
const STOPS_PATH = join(ROOT, 'planner/assets/stops-sidecar.json');
const stops = JSON.parse(readFileSync(STOPS_PATH, 'utf8'));

const idxByFeedStop = new Map();
stops.forEach((s, i) => idxByFeedStop.set(s.feed + ':' + s.stop_id, i));
const resolveIdx = (name) => {
  const m = name.match(/\((bus|rail) ([^)]+)\)/);
  if (!m) throw new Error('no stop id in name: ' + name);
  const feed = m[1] === 'bus' ? 0 : 1;
  const idx = idxByFeedStop.get(feed + ':' + m[2]);
  if (idx === undefined) throw new Error('stop not in new sidecar: ' + name);
  return idx;
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
const assetName = ASSET_PATH.split('/').pop();
await host.loadPlanner({ assetUrl: 'mem://planner/' + assetName, stopsUrl: 'mem://planner/planner-stops.json', fetchImpl: fileFetch });

let drift = 0;
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const QUERIES = ONLY ? OD.queries.filter((q) => ONLY.split(',').includes(q.id)) : OD.queries;
for (const q of QUERIES) {
  const oi = resolveIdx(q.origin.name);
  const di = resolveIdx(q.destination.name);
  const want = SAVED.queries.find((x) => x.id === q.id);
  const plan = await host.planTripAsync(oi, di, q.depart_after,
    { id: q.id, kind: q.kind, expect: q.expect, originName: q.origin.name, destinationName: q.destination.name },
    { useMemo: false });
  const got = plan.ok ? plan.result.baselineBestArriveSec : null;
  const ruling5 = plan.ok ? (plan.result.freq.fastestVsBaselineDeltaSec === 0 && plan.result.flat.fastestVsBaselineDeltaSec === 0) : false;
  const eq = got === want.baselineBestArriveSec;
  if (!eq) drift++;
  console.log(`${eq ? 'MATCH' : 'DRIFT'}  ${q.id}  recorded=${want.baselineBestArriveSec} new=${got} ruling5=${ruling5} ok=${plan.ok} idx ${q.origin.page_idx}->${oi} ${q.destination.page_idx}->${di} (${plan.meta ? plan.meta.planMs : '?'} ms)`);
}
console.log(drift === 0 ? `GOLDEN REBASED: ALL ${QUERIES.length} MATCH` : `GOLDEN REBASED: ${drift} DRIFTED PAIRS`);
process.exit(drift === 0 ? 0 : 1);
