// harness/verify-foundation.mjs — R1 foundation verification.
// PHL REBUILD R1. Label: UNVERIFIED / legacy-unsigned.
// Run: node harness/verify-foundation.mjs   (from the rebuild tree)
//
// Asserts, against the scaffold ON DISK:
//   A. Config schema + required keys (LT-F5(d) object completeness)
//   B. D1(b) policy constant present WITH its decision citation,
//      and the planner-host enforcement point behaves as branch (b)
//   C. Module graph resolves — every relative import in every
//      module exists on disk, every module loads, every contract
//      export the later tranches build against is present
//   D. Stamp scheme applied consistently (LT-KAES-04/03): one
//      definition site, shell echoes it, estate stamps current,
//      no forbidden estate script, no bare fetch() outside the
//      loader (LT-KAES-05)
//   E. Shell completeness (LT-KAES-02): every surface mount the
//      surfaces contract declares is present in the shell, filter
//      groups mirror config, meta-CSP present, one module entry
// Exit 0 = all checks pass. A failure here blocks R2 from building
// on the foundation until it is fixed.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: !!ok, detail: detail || '' });
}
function read(rel) { return readFileSync(join(ROOT, rel), 'utf8'); }
function listMjs(dir) {
  const out = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...listMjs(join(dir, e.name)));
    else if (e.name.endsWith('.mjs')) out.push(join(dir, e.name));
  }
  return out;
}

const config = await import(pathToFileURL(join(ROOT, 'config/city-config.mjs')).href);
const stamp = await import(pathToFileURL(join(ROOT, 'config/stamp.mjs')).href);
const C = config.CITY_CONFIG;
const STAMP = stamp.BUILD_STAMP;

// ---------- A. Config schema + required keys ----------
for (const k of config.REQUIRED_CONFIG_KEYS) {
  check(`A.config-key.${k}`, Object.prototype.hasOwnProperty.call(C, k), 'LT-F5(d) required key');
}
check('A.city-identity', C.city.slug === 'philadelphia' && C.city.prd === 'PRD-006'
  && C.city.canonicalPath === '/live-transit/philadelphia/', 'slug/PRD/canonical path (KAES-01)');
check('A.agency-keyless-pass', C.agency.keyPosture === 'keyless' && C.agency.licenseVerdict === 'PASS',
  'A3 custody: keyless, A1 PASS');
check('A.swiftly-excluded', C.agency.excludedSources.includes('api.goswift.ly')
  && ![...C.feeds.static, ...C.feeds.realtime].some((f) => f.url.includes('goswift')),
  'Swiftly mirrors excluded from every feed path (A3)');
check('A.statics', C.feeds.static.length === 2 && C.feeds.static.every((f) =>
  f.url.startsWith('https://www3.septa.org/developer/') && f.feedVersion && f.validity.end && f.md5),
  'two static zips with version/validity/MD5 (A3)');
const kinds = C.feeds.realtime.map((f) => `${f.family}:${f.kind}`).sort();
check('A.realtime-legs', C.feeds.realtime.length === 6
  && ['bus:service-alerts', 'bus:trip-updates', 'bus:vehicle-positions',
      'rail:service-alerts', 'rail:trip-updates', 'rail:vehicle-positions']
      .every((k) => kinds.includes(k))
  && C.feeds.realtime.every((f) => f.url.startsWith('https://www3.septa.org/gtfsrt/')),
  'complete leg set VP+TU+SA x bus/rail (KAES-16)');
check('A.layer-groups', ['bus', 'trolley', 'metro', 'rail'].every((g) =>
  C.layerGroups.some((x) => x.id === g && x.storageKey)), 'four layer groups w/ storage keys (KAES-37/38)');
check('A.assets', !!(C.assets.streets && C.assets.routesByFeed.bus && C.assets.routesByFeed.rail
  && C.assets.stops && C.assets.provenanceManifest && C.assets.plannerTimetable
  && C.assets.liveData.vehicles && C.assets.liveData.alerts),
  'geometry/stops/planner/live-data paths declared (KAES-12/21)');
check('A.projection', C.assets.projection.lat0 === 40.016519 && C.assets.projection.lon0 === -75.197812,
  'projection origin from A4 record (PRD-006 §3)');
check('A.commercial', C.commercial.ridersPay === false && C.commercial.adsOnMap === false
  && C.commercial.placesPrice === null && C.commercial.placesPriceState === 'UNDECIDED',
  'LT-F1/F2 stated; Places price honestly UNDECIDED (LT-F6/S9.3)');
const wsum = Object.values(C.planner.constants.distanceWeights).reduce((a, b) => a + b, 0);
check('A.planner-weights', Math.abs(wsum - 1) < 1e-9 && C.planner.constants.adoptedSet === 'W0-default-T35-P15',
  `calibrated weights sum to ${wsum} (LT-N3/N8)`);
check('A.walk-model', C.planner.walkModel.maxWalkSecsPerRound === 1800
  && C.planner.walkModel.edgeRadiusM === 400, 'walk model platform constants (LT-N10)');

// ---------- B. D1(b) ----------
const pol = C.planner.policy;
check('B.d1-value', pol.walkOnlyPresentation === 'B', "walkOnlyPresentation === 'B'");
check('B.d1-citation', pol.walkOnlyDecision.decidedBy === 'Justin'
  && pol.walkOnlyDecision.decidedAt === '2026-10-23 23:07 EDT'
  && pol.walkOnlyDecision.branch === 'B'
  && /no transit journey exists/.test(pol.walkOnlyDecision.rule),
  'decision citation: Justin, 2026-10-23 23:07 EDT, rule verbatim');
const host = await import(pathToFileURL(join(ROOT, 'modules/planner-host.mjs')).href);
check('B.host-constant', host.WALK_ONLY_PRESENTATION === 'B', 'planner-host mirrors config (single source)');
const b1 = host.resolveWalkOnlyPresentation({ walkOnlyFastest: true, hasTransitJourney: true });
const b2 = host.resolveWalkOnlyPresentation({ walkOnlyFastest: true, hasTransitJourney: false });
const b3 = host.resolveWalkOnlyPresentation({ walkOnlyFastest: false, hasTransitJourney: false });
check('B.branch-b-transit-exists', b1.showWalkOnly === false && b1.pending === false,
  'walk-only WITHHELD when a transit journey exists');
check('B.branch-b-no-transit', b2.showWalkOnly === true && b2.pending === false,
  'walk-only PRESENTED when no transit journey exists');
check('B.no-flag', b3.walkOnlyFastest === false && b3.showWalkOnly === false, 'unflagged result untouched');

// ---------- C. Module graph ----------
const mjsFiles = ['config/stamp.mjs', 'config/city-config.mjs',
  ...listMjs('platform'), ...listMjs('modules')];
const importRe = /(?:import|export)[^'"]*?from\s*'([^']+)'|import\s*\(\s*'([^']+)'\s*\)/g;
let missing = [];
for (const rel of mjsFiles) {
  const src = read(rel);
  for (const m of src.matchAll(importRe)) {
    const spec = m[1] || m[2];
    if (spec && spec.startsWith('.')) {
      const target = resolve(dirname(join(ROOT, rel)), spec);
      if (!existsSync(target)) missing.push(`${rel} -> ${spec}`);
    }
  }
}
check('C.graph-resolves', missing.length === 0, missing.length ? `missing: ${missing.join('; ')}` : `${mjsFiles.length} modules, all relative imports resolve`);
const expectedExports = {
  'platform/projector.mjs': ['createProjector'],
  'platform/picking.mjs': ['PICK_TOL_PX', 'NO_HIT_GUARD_PX', 'toCanvasPoint'],
  'platform/loader.mjs': ['stampedFetch', 'stampedJson', 'loadFeature', 'LoadError'],
  'modules/data-layer.mjs': ['validateVehicleEnvelope', 'validateAlertsEnvelope', 'CLASSIFICATION'],
  'modules/renderer.mjs': ['createRenderer', 'geometryAssetPaths', 'RENDER_CONSTANTS'],
  'modules/planner-host.mjs': ['resolveWalkOnlyPresentation', 'WALK_ONLY_PRESENTATION', 'plannerConstants'],
  'modules/surfaces.mjs': ['SURFACE_MOUNTS', 'mountSurfaces'],
  'modules/ops.mjs': ['opsBootReport', 'HEAL_DEPENDENCY_ORDER', 'TELEMETRY_STATE'],
  'modules/app.mjs': ['createApp', 'APP_MODULES'],
};
for (const [rel, names] of Object.entries(expectedExports)) {
  try {
    const mod = await import(pathToFileURL(join(ROOT, rel)).href);
    const absent = names.filter((n) => !(n in mod));
    check(`C.exports.${rel}`, absent.length === 0, absent.length ? `missing exports: ${absent.join(',')}` : 'contract exports present');
  } catch (e) {
    check(`C.exports.${rel}`, false, `import failed: ${e.message}`);
  }
}
const app = await import(pathToFileURL(join(ROOT, 'modules/app.mjs')).href);
const ctx = app.createApp();
check('C.app-boots', ctx.stamp === STAMP && ctx.config === C && ctx.ops.stamp === STAMP,
  'createApp wires config + stamp + ops hooks');
const dl = await import(pathToFileURL(join(ROOT, 'modules/data-layer.mjs')).href);
check('C.envelope-validator', dl.validateVehicleEnvelope({
  generated_at: '2026-10-24T00:00:00Z', count: 1,
  vehicles: [{ agency: 'septa' }], sources: { bus: { ok: true }, rail: { ok: false } },
}).length === 0 && dl.validateVehicleEnvelope({ city: 'x', feeds: {} }).length > 0,
  'KAES-24 validator accepts canonical envelope, rejects outgoing shape');

// ---------- D. Stamp scheme ----------
const stampLiteralSites = mjsFiles.filter((rel) => rel !== 'config/stamp.mjs' && read(rel).includes(STAMP));
check('D.single-definition', stampLiteralSites.length === 0,
  stampLiteralSites.length ? `stamp literal also in: ${stampLiteralSites.join(', ')}` : 'BUILD_STAMP defined only in config/stamp.mjs');
const shell = read('index.html');
const vrefs = [...shell.matchAll(/([^\s"']+)\?v=([^\s"']+)/g)].map((m) => ({ path: m[1], v: m[2] }));
const estateExpect = { '/styles.css': stamp.ESTATE_STAMPS.stylesheet, '/nav.js': stamp.ESTATE_STAMPS.nav, '/assets/measure.js': stamp.ESTATE_STAMPS.measure };
let stampProblems = [];
for (const r of vrefs) {
  if (r.path in estateExpect) {
    if (r.v !== estateExpect[r.path]) stampProblems.push(`${r.path} estate stamp ${r.v} != current ${estateExpect[r.path]}`);
  } else if (r.v !== STAMP) stampProblems.push(`${r.path} ?v=${r.v} != BUILD_STAMP ${STAMP}`);
}
check('D.shell-stamps', stampProblems.length === 0 && vrefs.length >= 5,
  stampProblems.length ? stampProblems.join('; ') : `${vrefs.length} versioned refs: estate current, local == BUILD_STAMP`);
check('D.no-forbidden-script', stamp.FORBIDDEN_ESTATE_SCRIPTS.every((s) => !shell.includes(`src="${s}`)),
  'shell loads no estate script the reference app does not (KAES-03)');
const bareFetch = mjsFiles.filter((rel) => rel !== 'platform/loader.mjs' && /(^|[^.\w])fetch\s*\(/.test(read(rel)));
check('D.fetch-only-via-loader', bareFetch.length === 0,
  bareFetch.length ? `bare fetch() in: ${bareFetch.join(', ')}` : 'all fetches route through stampedFetch (KAES-05)');
check('D.withStamp', stamp.withStamp('data/vehicles.json') === `data/vehicles.json?v=${STAMP}`,
  'withStamp appends the governing stamp');

// ---------- E. Shell completeness ----------
const surfaces = await import(pathToFileURL(join(ROOT, 'modules/surfaces.mjs')).href);
const absentMounts = surfaces.SURFACE_MOUNTS.filter((id) => !shell.includes(`id="${id}"`));
check('E.surface-mounts', absentMounts.length === 0,
  absentMounts.length ? `mounts missing from shell: ${absentMounts.join(', ')}` : `all ${surfaces.SURFACE_MOUNTS.length} surface mounts declared (KAES-02)`);
const shellGroups = [...shell.matchAll(/data-group="([^"]+)"/g)].map((m) => m[1]).sort();
const cfgGroups = C.layerGroups.map((g) => g.id).sort();
check('E.filter-groups-mirror-config', JSON.stringify(shellGroups) === JSON.stringify(cfgGroups),
  `shell groups [${shellGroups}] == config groups [${cfgGroups}] (LT-S4.1)`);
check('E.meta-csp', shell.includes('Content-Security-Policy') && shell.includes("default-src 'self'"),
  'estate meta-CSP present (KAES-03)');
check('E.one-module-entry', (shell.match(/type="module"/g) || []).length === 1
  && shell.includes('type="importmap"') && shell.includes('"three"'),
  'one ES-module entry + importmap library declaration (KAES-05/06)');

// ---------- Report ----------
let fails = 0;
for (const r of results) {
  if (!r.ok) fails++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${results.length - fails}/${results.length} checks PASS${fails ? `, ${fails} FAIL` : ''}`);
process.exit(fails ? 1 : 0);
