// Full-window service-resolution audit for the Philadelphia
// service-set asset (Board 47 item 7 tranche 1; design section 1
// acceptance 3, superset of the first pass's 16-cell audit).
// For every date in the union published window (2026-09-27 ->
// 2027-02-20) and every feed: resolve the day's service SET through
// the SET engine's servicesFor, take the asset trips the engine
// would run (trip.s in the set, mapped to GTFS ids via the
// compiler's trip-map), and compare against the independent GTFS
// truth (audit-truth-full.json). Exact set equality on all 294
// (date x feed) cells is the gate; the first pass's 16 cells
// (2026-10-11..18) are reported as a named subset.
// Run: TZ=America/New_York node audit-services-set.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HERE = new URL('.', import.meta.url).pathname;
const BASE = 'local://harness';
globalThis.fetch = async (url) => {
  const rel = String(url).replace(`${BASE}/`, '').split('?')[0];
  try {
    const text = readFileSync(HERE + rel, 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  } catch {
    return { ok: false, status: 404, json: async () => ({}) };
  }
};

const ASSET = 'inputs-set/planner-timetable-v202609271u202611010-v202609271u202611010.json';
const rawTT = JSON.parse(readFileSync(HERE + ASSET, 'utf8'));
const tripMap = JSON.parse(readFileSync(HERE + 'inputs-set/trip-map.json', 'utf8'));
const truth = JSON.parse(readFileSync(HERE + 'audit-truth-full.json', 'utf8'));
const R = await import(pathToFileURL(HERE + 'inputs/raptor-v2-set.js').href + '?auditset=1');
const tt = await R.loadTimetable(`${BASE}/${ASSET}`);

// Pairing guard (design section 1 acceptance 4): a "set" asset must
// never be planned by an engine without set resolution.
if (rawTT.meta.service_model === 'set' && typeof R.servicesFor !== 'function') {
  console.error('PAIRING FAILURE: service_model "set" asset under a legacy engine — refusing to plan a subset silently');
  process.exit(3);
}

const fmtYMD = (d) =>
  d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate() + '';

const cells = [];
let allOk = true, subsetOk = true, subsetCount = 0;
const start = new Date(2026, 8, 27, 12, 0, 0);
for (let n = 0; n < 147; n++) {
  const when = new Date(start.getTime() + n * 86400000);
  const ymd = fmtYMD(when);
  const inSubset = ymd >= '20261011' && ymd <= '20261018';
  for (const feed of [0, 1]) {
    const set = R.servicesFor(tt, ymd, when.getDay(), feed);
    const setIdx = new Set(set);
    const engineSet = new Set();
    rawTT.trips.forEach((t, i) => {
      if (setIdx.has(t.s) && tripMap[i][0] === feed) engineSet.add(tripMap[i][1]);
    });
    const truthSet = new Set(truth[String(feed)][ymd] || []);
    const missing = [...truthSet].filter((x) => !engineSet.has(x));
    const extra = [...engineSet].filter((x) => !truthSet.has(x));
    const ok = missing.length === 0 && extra.length === 0;
    if (!ok) allOk = false;
    if (inSubset) { subsetCount++; if (!ok) subsetOk = false; }
    cells.push({
      date: ymd, feed, setSize: set.length,
      engineTrips: engineSet.size, truthTrips: truthSet.size,
      missing: missing.length, extra: extra.length, ok,
      missingSample: missing.slice(0, 5), extraSample: extra.slice(0, 5),
    });
    if (!ok) console.log(`MISMATCH ${ymd} feed ${feed}: set=${set.length} engine=${engineSet.size} truth=${truthSet.size} missing=${missing.length} extra=${extra.length}`);
  }
}
const verdict = allOk
  ? `PASS — engine set resolution reproduces the GTFS-active trip set exactly on all ${cells.length} date x feed cells (full published windows)`
  : 'FAIL — see cells';
const subsetVerdict = subsetOk
  ? `PASS — the first pass's 16 cells (2026-10-11..18) are exact under set resolution`
  : 'FAIL — see cells';
writeFileSync(HERE + 'audit-result-set.json',
  JSON.stringify({ verdict, subsetVerdict, subsetCells: subsetCount, cells }, null, 2));
console.log(`cells=${cells.length} subsetCells=${subsetCount}`);
console.log('AUDIT (full window):', verdict);
console.log('AUDIT (16-cell subset):', subsetVerdict);
