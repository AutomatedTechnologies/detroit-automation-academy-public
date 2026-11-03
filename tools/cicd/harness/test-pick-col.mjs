// test-pick-col.mjs — Columbus port of Philadelphia's certifying
// LT-U5 fixture harness (PHL: uplift-fixes/test-pick.js, 22 checks),
// via the Cincinnati / Austin / Sacramento ports
// (test-pick-sac.mjs). Ported 2026-10-30 for the city conformance
// loop, Columbus tranche. UNVERIFIED / legacy-unsigned.
//
// LT-U5 contract (live-transit standard §5.3): drive the REAL event
// handlers, load the REAL assets and the target bytes, assert state
// immediately after each event, and run the identical harness
// against the unpatched production bytes as a control. This file is
// placed as a SIBLING of the tree it tests: it imports ./modules/*
// and reads the asset JSONs from its own directory, so the target
// run and the control run execute byte-identical harness code
// against their own trees.
//
// Adaptations 1-5 (modular event path, single resolved status
// total, KAES-25 unassigned class, 21 px guard probe) are carried
// from the Sacramento port unchanged. Columbus-specific
// adaptations, each forced by a measured fact of this city:
//
//  6. STATIC-ONLY CITY (charter LT-F7; build record §7(e)).
//     Columbus ships NO live vehicle layer: COTA publishes no
//     VP/TU population in any regime, and the served data family
//     is the build snapshot (generated_at 2026-10-27T00:18:19Z,
//     vehicles 0, TU 0, alerts 6). Consequences for the port:
//     (a) There are NO real served vehicle records to model
//     fixtures on (Sacramento modeled its bus fixture on a real
//     record and had to synthesize only the rail one). All three
//     vehicle fixtures here are SYNTHETIC records in the served
//     envelope's exact shape, placed on real served geometry:
//     BUS_A on route 001's own path (mid vertex of path 0,
//     unprojected via platform/projector.mjs), BUS_B likewise on
//     route 002, UNASSIGNED at the real HANMAIN stop position.
//     Their trip_ids are synthetic and marked. The fixtures test
//     the interaction machinery the build ships (pick, card,
//     classification disclosure, group/route immediacy); they do
//     not assert that COTA publishes vehicles — the page's own
//     static posture is asserted separately (adaptation 7).
//     (b) The empty-state status is Columbus's own static copy,
//     not the live cities' "No vehicles live right now": the
//     served statusModel reads "COTA does not publish live
//     vehicle positions — showing the scheduled network" at zero
//     markers. U5-07 and U5-13 bind to that copy.
//     (c) Staleness (U5-01/02) is unchanged in substance: the
//     shared evaluateDegradation carries no static exemption and
//     the config threshold is the platform 900,000 ms, so the
//     harness clock is anchored at the fixture generation and
//     the stale/fresh pair behaves exactly as in the live
//     cities. (Whether the production page's permanently-old
//     snapshot also raises the banner in a real browser is a
//     Pass 2 observation item, recorded in the run record —
//     not asserted here either way.)
//  7. Groups: Columbus has ONE layer group (bus; config
//     layerGroups, served shell carries a single data-group="bus"
//     checkbox; all 43 routes are group bus). The RC10 family is
//     reshaped to the dimensions this city actually has, inside
//     the same 22-check envelope: U5-15 single-group baseline
//     (two bus fixtures on routes 001/002), U5-16/17 the group
//     off/on pair, U5-18/19 the per-route visibility pair driven
//     through the browse panel's REAL route-vis checkboxes
//     (data-role="route-vis", the production change listener
//     renderBrowse binds) — route-level immediacy is the second
//     immediacy dimension the Columbus build exposes.
//  8. Envelope: sources key `cota`, legs cota-vp / cota-tu /
//     cota-sa, classification WITHOUT suffix_normalized_trip_ids
//     (the served Columbus envelope's shape, matching Austin /
//     Sacramento). Compiled assets carry "feed": "cota" on all
//     43 routes (verified in the port probe).
//  9. RC9 stop names: COTA names are ALL-CAPS intersections with
//     '&' (e.g. "HANSON ST & E MAIN ST"); as in Sacramento, names
//     are admitted as served and the card is asserted against the
//     name AS RENDERED through the module's own esc().
// 10. Clock / TZ: harness clock anchored at the tranche instant
//     2026-10-30T21:00:00Z; runs under TZ=America/New_York.
// Target bytes: served production build, stamp 20261026-2046,
// surfaces.mjs MD5 41488dcf18d03fced52766a7e1fe05ac (76,281 B —
// a DISTINCT variant from the other cities' 75,683 B pre-fix
// file: Columbus's build adds the §7(e) static copy; it carries
// the same DEFECT-U5-05 null-pick shape and the same unadapted
// 'rtd' clone remnants — see the run record).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

let fails = 0;
let total = 0;
function check(id, cond, detail = '') {
  total += 1;
  if (!cond) fails += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${id}${detail ? ` — ${detail}` : ''}`);
}

// ---------------- fake DOM (harness-only) ----------------
// Same proven machinery as the rebuild's features harness: elements
// support the exact surface the modules use, and fire() dispatches
// the SAME listener registrations production code made. The canvas
// reports the template's realistic page offset (left 23, top 397).
const RECT = { left: 23, top: 397, width: 960, height: 640 };
function datasetOf(attrs) {
  const ds = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!k.startsWith('data-')) continue;
    ds[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return ds;
}
function parseAttrs(s) {
  const attrs = {};
  const re = /([\w-]+)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)')?/g;
  let m;
  while ((m = re.exec(s))) attrs[m[1]] = m[2] != null ? m[2] : (m[3] != null ? m[3] : '');
  return attrs;
}
class FakeEl {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.id = '';
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this._innerHTML = '';
    this._textContent = '';
    this.value = '';
    this.checked = false;
    this.type = '';
    const set = new Set();
    this.classList = {
      add: (...cs) => cs.forEach((c) => set.add(c)),
      remove: (...cs) => cs.forEach((c) => set.delete(c)),
      toggle: (c, force) => { if (force != null) { force ? set.add(c) : set.delete(c); } else if (set.has(c)) set.delete(c); else set.add(c); },
      contains: (c) => set.has(c),
    };
  }
  set innerHTML(html) {
    this._innerHTML = String(html == null ? '' : html);
    this.children = [];
    const re = /<(\w+)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
    let m;
    while ((m = re.exec(this._innerHTML))) {
      const child = new FakeEl(m[1]);
      const attrs = parseAttrs(m[2] || '');
      child.id = attrs.id || '';
      child.type = attrs.type || '';
      child.value = attrs.value != null ? attrs.value : '';
      child.checked = 'checked' in attrs;
      child.dataset = datasetOf(attrs);
      child.parent = this;
      this.children.push(child);
    }
  }
  get innerHTML() { return this._innerHTML; }
  set textContent(t) { this._textContent = String(t); this._innerHTML = ''; this.children = []; }
  get textContent() { return this._textContent || this._innerHTML.replace(/<[^>]*>/g, ''); }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type, ev = {}) {
    const e = { target: this, ...ev };
    for (const fn of this.listeners[type] || []) fn(e);
    return e;
  }
  _walk(out = []) { for (const c of this.children) { out.push(c); c._walk(out); } return out; }
  _matches(sel) {
    let tag = null, rest = sel;
    const tm = sel.match(/^(\w+)(.*)$/);
    if (tm && !sel.startsWith('#') && !sel.startsWith('[')) { tag = tm[1].toUpperCase(); rest = tm[2]; }
    if (tag && this.tagName !== tag) return false;
    if (rest.startsWith('#')) return this.id === rest.slice(1);
    const am = rest.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (am) {
      const key = am[1];
      const val = key.startsWith('data-') ? this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] : this[key];
      return am[2] == null ? val != null : val === am[2];
    }
    return rest === '';
  }
  querySelector(sel) { return this._walk().find((e) => e._matches(sel)) || null; }
  querySelectorAll(sel) { return this._walk().filter((e) => e._matches(sel)); }
  focus() {}
  setSelectionRange() {}
  scrollIntoView() {}
  getBoundingClientRect() {
    return this.id === 'lt-map' ? { ...RECT } : { left: 0, top: 0, width: 960, height: 640 };
  }
}
class FakeDocument {
  constructor(ids) {
    this.byId = new Map();
    this.activeElement = null;
    this.listeners = {};
    this.fullscreenElement = null;
    this.body = new FakeEl('body');
    this.head = new FakeEl('head');
    this.documentElement = new FakeEl('html');
    for (const id of ids) {
      const e = new FakeEl(id === 'lt-map' ? 'canvas' : 'div');
      e.id = id;
      this.byId.set(id, e);
    }
  }
  getElementById(id) { return this.byId.get(id) || null; }
  createElement(tag) { return new FakeEl(tag); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type, ev = {}) { for (const fn of this.listeners[type] || []) fn(ev); }
}
class FakeStorage {
  constructor(init = {}) { this.map = new Map(Object.entries(init)); this.writes = []; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.writes.push(k); this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

// ---------------- fixtures (KAES-24, served shape) -------------
const CLOCK_MS = Date.parse('2026-10-30T21:00:00Z'); // harness clock
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
let clockMs = CLOCK_MS;

// SYNTHETIC records (adaptation 6): Columbus has no real served
// vehicle records to model on. Positions are unprojected from
// real served geometry (route 001 / 002 path mid-vertices; the
// HANMAIN stop for the unassigned record).
const BUS = {
  agency: 'cota', family: 'cota', route_id: '001', vehicle_id: '9001',
  lat: 39.950080, lon: -82.975860, bearing: 235.0, speed_mph: 0.0,
  destination: 'KENNY/LIVINGSTON',
  trip_id: '9900001', classification: 'TRIP-MATCHED',
};
const BUS2 = {
  agency: 'cota', family: 'cota', route_id: '002', vehicle_id: '9002',
  lat: 39.958080, lon: -82.982440, bearing: 90.0, speed_mph: 0.0,
  destination: 'E MAIN/N HIGH',
  trip_id: '9900002', classification: 'TRIP-MATCHED',
};
const UNASSIGNED = {
  agency: 'cota', family: 'cota', route_id: null, vehicle_id: '9003',
  lat: 39.956658, lon: -82.779026, bearing: 186.0, speed_mph: 0.0,
  destination: null, trip_id: null, classification: 'UNASSIGNED',
};
function envelope(records, generatedMs) {
  const vehicles = records.map((r) => ({ ...r, updated_at: iso(generatedMs) }));
  const cls = { 'TRIP-MATCHED': 0, 'ROUTE-MATCHED': 0, 'UNASSIGNED': 0 };
  for (const v of vehicles) cls[v.classification] = (cls[v.classification] || 0) + 1;
  return {
    generated_at: iso(generatedMs),
    count: vehicles.length,
    vehicles,
    sources: {
      cota: {
        ok: true, error: null, count: vehicles.length,
        feed_header_at: iso(generatedMs), leg: 'cota-vp', classification: { ...cls },
      },
    },
    legs: {
      'cota-vp': { ok: true, error: null, count: vehicles.length, feed_header_at: iso(generatedMs) },
      'cota-tu': { ok: true, error: null, count: 0, feed_header_at: iso(generatedMs) },
      'cota-sa': { ok: true, error: null, count: 0, feed_header_at: iso(generatedMs) },
    },
    classification: { ...cls, total: vehicles.length, unresolved_trip_ids: 0 },
  };
}
const EMPTY_ALERTS = { generated_at: iso(CLOCK_MS), count: 0, alerts: [], sources: { cota: { ok: true, error: null, count: 0 } } };
const EMPTY_TU = { generated_at: iso(CLOCK_MS), count: 0, trip_updates: [], sources: { cota: { ok: true, error: null, count: 0 } } };
const feed = (records, generatedMs) => api.setData({
  vehicles: envelope(records, generatedMs), alerts: EMPTY_ALERTS, tripUpdates: EMPTY_TU,
});

// ---------------- compose the app the way bootBrowser does -----
const rendererMod = await imp('modules/renderer.mjs');
const surfacesMod = await imp('modules/surfaces.mjs');
const hostMod = await imp('modules/planner-host.mjs');
const renderer = await rendererMod.createRenderer(null, { width: 960, height: 640 });
await renderer.loadGeometry({
  streets: readJson(join(ROOT, 'columbus-streets.json')),
  routesByFeed: { cota: readJson(join(ROOT, 'cota-routes-3d.json')) },
  stops: readJson(join(ROOT, 'cota-stops.json')),
  water: readJson(join(ROOT, 'columbus-water.json')),
  landmarks: readJson(join(ROOT, 'columbus-landmarks.json')),
  names: readJson(join(ROOT, 'columbus-street-names.json')),
});
const host = hostMod.createPlannerHost();
const doc = new FakeDocument(surfacesMod.SURFACE_MOUNTS);
// The shell hides the info and degraded regions until first render.
el0('lt-info').style.display = 'none';
el0('lt-degraded').style.display = 'none';
function el0(id) { return doc.getElementById(id); }
// The served shell's filter panel (index.html) declares the one
// group checkbox; reproduce it exactly as served.
{
  const panel = el0('lt-filter-panel');
  for (const g of ['bus']) {
    const cb = new FakeEl('input');
    cb.type = 'checkbox'; cb.checked = true; cb.dataset = { group: g };
    panel.appendChild(cb);
  }
}
const storage = new FakeStorage();
const api = surfacesMod.createSurfaces({
  document: doc, storage, renderer, plannerHost: host,
  fetchImpl: async () => ({ ok: false, status: 404, json: async () => { throw new Error('404'); }, text: async () => '' }),
  nowFn: () => clockMs,
});
api.mount();
const el = (id) => doc.getElementById(id);
const status = () => el('lt-status').textContent;
const stats = () => renderer.stats();
// Drawn resolved glyphs per group, counted by the scene model's own
// LT-G15 rule (the same test stats() applies: not per-route hidden,
// and the glyph's group on).
const visibleResolvedByGroup = (g) => {
  const S = renderer.model.state;
  return S.glyphs.filter((x) => x.kind !== 'unassigned' && x.group === g
    && !(x.routeId && S.hiddenRoutes.has(x.routeId)) && S.groups[x.group] !== false).length;
};
const drawnResolved = () => {
  const S = renderer.model.state;
  return S.glyphs.filter((x) => x.kind !== 'unassigned'
    && !(x.routeId && S.hiddenRoutes.has(x.routeId)) && S.groups[x.group] !== false).length;
};

// A tap: the browser's real sequence at realistic client coords.
function tap(x, y) {
  const c = el('lt-map');
  const ev = { clientX: x + RECT.left, clientY: y + RECT.top, target: c };
  c.fire('pointerdown', ev);
  c.fire('pointerup', ev);
  c.fire('click', ev);
}
function setGroup(id, on) {
  const cb = el('lt-filter-panel').querySelectorAll('input[data-group]')
    .find((c) => c.dataset.group === id);
  cb.checked = on;
  cb.fire('change', { target: cb });
}
function closeViaButton() {
  const btn = el('lt-info')._walk().find((e) => e.dataset && e.dataset.action === 'card-close');
  if (btn) el('lt-info').fire('click', { target: btn });
}
function emptyPoint() {
  for (let y = 20; y < 640; y += 20) {
    for (let x = 20; x < 960; x += 20) {
      if (renderer.pick({ x, y }) === null) return { x, y };
    }
  }
  return null;
}

// ------- RC7: staleness flagged / fresh unflagged ---------------
feed([BUS], CLOCK_MS - 6300_000); // envelope 105 minutes old
check('U5-01', el('lt-degraded').style.display === 'block'
  && /minutes old/.test(el('lt-degraded').textContent)
  && api.state.degraded && api.state.degraded.kind === 'stale-envelope',
  `stale envelope flagged: "${el('lt-degraded').textContent.trim().slice(0, 90)}"`);
feed([BUS], CLOCK_MS);
check('U5-02', api.state.degraded === null && el('lt-degraded').style.display === 'none',
  'fresh envelope: no degradation notice');
check('U5-03', stats().markers === 1,
  `fixture vehicle drawn: markers=${stats().markers}`);

// ------- RC6: tap on the fixture vehicle opens info -------------
{
  const g = renderer.model.state.glyphs.find((x) => x.record && x.record.vehicle_id === '9001');
  renderer.camera.target = { x: g.x, z: g.z };
  renderer.camera.distance = 900;
  const sp = renderer.model.screenOf(g.x, 66, g.z);
  const casePick = renderer.pick({ x: sp.x, y: sp.y });
  tap(sp.x, sp.y);
  check('U5-04', casePick && casePick.kind === 'vehicle'
    && api.state.card && api.state.card.kind === 'vehicle'
    && api.state.card.id === 'cota|9001'
    && el('lt-info').style.display === 'block'
    && el('lt-info').innerHTML.includes('Vehicle 9001'),
    `tap at the glyph (${Math.round(sp.x)},${Math.round(sp.y)}) canvas px -> vehicle card, panel shown`);
  const ep = emptyPoint();
  tap(ep.x, ep.y);
  check('U5-05', api.state.card === null && el('lt-info').style.display === 'none',
    `tap on empty (${ep.x},${ep.y}) clears info — observed: card=${JSON.stringify(api.state.card)}, panel display=${el('lt-info').style.display}`);
  closeViaButton();
}

// ------- RC2: empty fixture -------------------------------------
feed([], CLOCK_MS);
check('U5-06', stats().markers === 0 && renderer.model.state.glyphs.length === 0,
  `empty fixture renders 0 markers (glyphs=${renderer.model.state.glyphs.length})`);
check('U5-07', /^COTA does not publish live vehicle positions/.test(status()),
  `empty status reads the static-only copy: "${status()}"`);
{
  const ep = emptyPoint();
  tap(ep.x, ep.y);
  check('U5-08', api.state.card === null && el('lt-info').style.display === 'none',
    'tap on empty map with empty fixture is a clean no-op');
}

// ------- RC8 (adapted): unassigned exclusion --------------------
// KAES-25 designed state: excluded from markers and the status
// vehicle count; counted and disclosed separately, not invisible.
feed([BUS, UNASSIGNED], CLOCK_MS);
check('U5-09', stats().markers === 1 && drawnResolved() === 1,
  `unassigned record produces no resolved marker (markers=${stats().markers})`);
check('U5-10', stats().unassignedMarkers === 1
  && status().includes('1 reporting without a route assignment'),
  `unassigned counted separately and disclosed: "${status()}"`);
check('U5-11', /^1 vehicle live/.test(status()),
  `status count excludes the unassigned record: "${status()}"`);
setGroup('bus', false);
check('U5-12', stats().markers === 0,
  `bus toggle off hides the assigned record too (markers=${stats().markers})`);
check('U5-13', /^COTA does not publish live vehicle positions/.test(status()),
  `toggle-off status reads the static-only copy immediately after the change event: "${status()}"`);
setGroup('bus', true);
check('U5-14', stats().markers === 1 && /^1 vehicle live/.test(status()),
  `toggle back on restores the assigned record only (markers=${stats().markers})`);

// ------- RC10 (adapted): immediacy on the dimensions Columbus
// has — the single group toggle, then per-route visibility
// through the browse panel's real route-vis checkboxes
// (adaptation 7). -----------------------------------------------
feed([BUS, BUS2], CLOCK_MS);
check('U5-15', stats().markers === 2 && /^2 vehicles live/.test(status())
  && visibleResolvedByGroup('bus') === 2,
  `single-group baseline (routes 001+002): "${status()}"`);
setGroup('bus', false);
check('U5-16', stats().markers === 0 && /^COTA does not publish live vehicle positions/.test(status())
  && visibleResolvedByGroup('bus') === 0,
  `bus off -> static status immediately, group count 0: "${status()}"`);
setGroup('bus', true);
check('U5-17', stats().markers === 2 && /^2 vehicles live/.test(status()),
  `bus on -> status back to 2 immediately: "${status()}"`);
function setRouteVis(routeId, on) {
  const cb = el('lt-browse-panel')._walk()
    .find((c) => c.dataset && c.dataset.role === 'route-vis' && c.dataset.route === routeId);
  if (!cb) throw new Error(`route-vis checkbox not found for route ${routeId}`);
  cb.checked = on;
  cb.fire('change', { target: cb });
}
setRouteVis('002', false);
check('U5-18', stats().markers === 1 && /^1 vehicle live/.test(status())
  && visibleResolvedByGroup('bus') === 1,
  `route 002 hidden via its browse checkbox -> status 1 immediately: "${status()}"`);
setRouteVis('002', true);
check('U5-19', stats().markers === 2 && /^2 vehicles live/.test(status()),
  `route 002 shown again -> status back to 2 immediately: "${status()}"`);

// ------- RC9 (adapted): bounded pick tolerance ------------------
// Band 16 px, guard 20 px (platform/picking.mjs); the miss probe
// sits at 21 px, beyond the guard. Tap points are case-selected
// through the real pick, then driven through the real canvas events.
feed([], CLOCK_MS);
{
  const S = renderer.model.state;
  let stop = null; let sp = null;
  for (const cand of S.stops) {
    if (!cand.n) continue; // Columbus: names admitted as served (adaptation 9)
    renderer.camera.target = { x: cand.x, z: cand.z };
    renderer.camera.distance = 900;
    const c = renderer.model.screenOf(cand.x, 66, cand.z);
    if (c.x < 80 || c.x > 880 || c.y < 80 || c.y > 560) continue;
    let nearest = Infinity;
    for (const o of S.stops) {
      if (o === cand) continue;
      const p = renderer.model.screenOf(o.x, 66, o.z);
      if (!p) continue; // off-viewport projection: not a neighbour
      nearest = Math.min(nearest, Math.hypot(p.x - c.x, p.y - c.y));
    }
    if (nearest > 60) { stop = cand; sp = c; break; }
  }
  const hitsStop = (p) => {
    const pk = renderer.pick(p);
    return pk && pk.kind === 'stop' && pk.stop && pk.stop.id === stop.id;
  };
  const off13 = [[13, 0], [-13, 0], [0, 13], [0, -13]].find(([dx, dy]) => hitsStop({ x: sp.x + dx, y: sp.y + dy }));
  tap(sp.x + off13[0], sp.y + off13[1]);
  const escName = stop.n.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  check('U5-20', api.state.card && api.state.card.kind === 'stop' && api.state.card.id === stop.id
    && el('lt-info').style.display === 'block' && el('lt-info').innerHTML.includes(escName),
    `tap 13 px from isolated stop centre opens stop info (${stop.id}, "${stop.n}")`);
  closeViaButton();
  const off99 = [[9, 9], [-9, 9], [9, -9], [-9, -9]].find(([dx, dy]) => hitsStop({ x: sp.x + dx, y: sp.y + dy }));
  tap(sp.x + off99[0], sp.y + off99[1]);
  check('U5-21', api.state.card && api.state.card.kind === 'stop' && api.state.card.id === stop.id
    && el('lt-info').style.display === 'block',
    'tap at (9,9) px from stop centre opens stop info');
  closeViaButton();
  const off21 = [[21, 0], [-21, 0], [0, 21], [0, -21]]
    .find(([dx, dy]) => renderer.pick({ x: sp.x + dx, y: sp.y + dy }) === null);
  tap(sp.x + off21[0], sp.y + off21[1]);
  check('U5-22', api.state.card === null && el('lt-info').style.display === 'none',
    `tap 21 px from stop centre (beyond the 20 px guard) opens nothing — observed: card=${JSON.stringify(api.state.card)}`);
}

console.log(fails === 0 ? `TEST PASS ${total}/${total}` : `TEST FAIL ${fails}`);
process.exit(fails === 0 ? 0 : 1);
