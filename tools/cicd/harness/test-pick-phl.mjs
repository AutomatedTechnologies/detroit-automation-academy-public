// test-pick-phl.mjs — Philadelphia port of the certifying LT-U5
// fixture harness, for the REBUILD tree Philadelphia now ships
// (stamp 20261026-1449). Ported 2026-10-30 for the city
// conformance loop, Philadelphia tranche. UNVERIFIED /
// legacy-unsigned.
//
// Lineage: Philadelphia's own single-file harness
// (files/uplift-fixes/test-pick.js, 22 checks, 22/22 on the F2
// bytes of the OUTGOING build) is the template every other city
// port descends from — via Cincinnati (test-pick-cin.mjs),
// Austin, and Sacramento (test-pick-sac.mjs). The outgoing
// build is gone; the rebuild ships the modular architecture
// those ports were adapted to, so this port carries the
// Sacramento modular port home to Philadelphia's rebuild tree,
// re-fixtured to SEPTA's served shapes. The 22 checks are the
// same checks, with the same ids, asserting the same contract.
//
// LT-U5 contract (live-transit standard §5.3): drive the REAL
// event handlers, load the REAL assets and the target bytes,
// assert state immediately after each event, and run the
// identical harness against the unpatched production bytes as
// a control. This file is placed as a SIBLING of the tree it
// tests: it imports ./modules/* and reads the asset JSONs from
// its own directory, so the target run and the control run
// execute byte-identical harness code against their own trees.
//
// Adaptations from the Sacramento port, each forced by what
// Philadelphia's rebuild actually serves:
//  1. Event path: identical to Sacramento's — the modular build
//     binds the canvas pick to a real 'click' listener
//     (surfaces.mount -> pickFromClient -> handlePick); a tap
//     fires pointerdown, pointerup, click at the template's
//     realistic client coordinates (canvas rect offset 23,397).
//     Checkbox toggles fire the real 'change' listeners
//     renderFilterPanel bound. Nothing in the interaction path
//     is stubbed.
//  2. Envelope shape: Philadelphia's served KAES-24 envelope
//     carries TWO source families (bus / rail) with legs
//     bus-vp/-tu/-sa and rail-vp/-tu/-sa, per-source
//     classification blocks, and a top-level classification
//     WITHOUT any suffix-normalized field. The fixture builder
//     mirrors that shape exactly. Vehicle records carry
//     family 'bus' / 'rail' (the served field), not the agency.
//  3. Fixtures are modeled verbatim on real records of the
//     served generation 2026-10-31T01:02:27Z: bus route 97,
//     vehicle 3635, TRIP-MATCHED, at its served position; rail
//     route AIR, vehicle "282,415,372,373" — a multi-car
//     consist id, which is SEPTA Regional Rail's real vehicle
//     id shape in the served file — TRIP-MATCHED, at its
//     served position; one UNASSIGNED bus record, vehicle
//     2328, route_id and trip_id null, at its served position.
//  4. Groups: Philadelphia's shell declares FOUR layer groups
//     (bus / trolley / metro / rail, all checked, reproduced
//     exactly as served). RC10 asserts toggles on bus and
//     rail — the two groups that carry live vehicle families
//     (SEPTA publishes bus and rail VP legs only; trolley and
//     metro routes ride the bus feed file and have no separate
//     vehicle family to toggle). The trolley/metro checkboxes
//     are present and bound; they move no fixture glyph by
//     construction, which is the served design, not a gap.
//  5. Geometry: routesByFeed { bus: septa-bus-routes-3d.json,
//     rail: septa-rail-routes-3d.json } per the served config;
//     geometry JSONs sit at the CITY ROOT, as served.
//  6. Unassigned records: the rebuild's designed state
//     (KAES-25) — a separate, disclosed glyph class, excluded
//     from markers and the status vehicle count, counted and
//     disclosed in the status line. Asserted as designed.
//  7. Guard probe: platform/picking.mjs returns the nearest
//     in-guard candidate by design (16 px band, 20 px guard),
//     so the beyond-guard miss probe sits at 21 px.
//  8. RC9 candidate names: SEPTA stop names are served names
//     ('Roosevelt Blvd & Woodward St' style, '&' intersections);
//     names are admitted as served and the card is asserted
//     against the name AS RENDERED through the module's own
//     esc(), as in the Sacramento port.
//  9. Clock / TZ: harness clock anchored to the fixture
//     generation's minute (2026-10-31T01:02:00Z); runs under
//     TZ=America/New_York.
// Target bytes: served production build, stamp 20261026-1449,
// modules/surfaces.mjs MD5 f6f8a69d245aae5d3a2bc814c33f98eb
// (75,035 B — the rebuild variant, NOT the 75,683 B file the
// platform-clone cities carried).

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
const CLOCK_MS = Date.parse('2026-10-31T01:02:00Z'); // harness clock
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
let clockMs = CLOCK_MS;

const BUS = {
  agency: 'septa', family: 'bus', route_id: '97', vehicle_id: '3635',
  lat: 40.113541, lon: -75.344879, bearing: null, speed_mph: 0.0,
  destination: 'Norristown Transit Center',
  trip_id: '842416', classification: 'TRIP-MATCHED',
};
const RAIL = {
  agency: 'septa', family: 'rail', route_id: 'AIR', vehicle_id: '282,415,372,373',
  lat: 40.131924, lon: -75.119202, bearing: 17.5, speed_mph: null,
  destination: 'Center City Philadelphia',
  trip_id: 'AIR460_20261019_SID189798', classification: 'TRIP-MATCHED',
};
const UNASSIGNED = {
  agency: 'septa', family: 'bus', route_id: null, vehicle_id: '2328',
  lat: 39.967628, lon: -75.236839, bearing: null, speed_mph: 0.1,
  destination: null, trip_id: null, classification: 'UNASSIGNED',
};
function envelope(records, generatedMs) {
  const vehicles = records.map((r) => ({ ...r, updated_at: iso(generatedMs) }));
  const clsOf = (recs) => {
    const c = { 'TRIP-MATCHED': 0, 'ROUTE-MATCHED': 0, 'UNASSIGNED': 0 };
    for (const v of recs) c[v.classification] = (c[v.classification] || 0) + 1;
    return c;
  };
  const bus = vehicles.filter((v) => v.family === 'bus');
  const rail = vehicles.filter((v) => v.family === 'rail');
  const src = (recs, leg) => ({
    ok: true, error: null, count: recs.length,
    feed_header_at: iso(generatedMs), leg, classification: clsOf(recs),
  });
  const legOk = (n) => ({ ok: true, error: null, count: n, feed_header_at: iso(generatedMs) });
  const cls = clsOf(vehicles);
  return {
    generated_at: iso(generatedMs),
    count: vehicles.length,
    vehicles,
    sources: { bus: src(bus, 'bus-vp'), rail: src(rail, 'rail-vp') },
    legs: {
      'bus-vp': legOk(bus.length), 'bus-tu': legOk(0), 'bus-sa': legOk(0),
      'rail-vp': legOk(rail.length), 'rail-tu': legOk(0), 'rail-sa': legOk(0),
    },
    classification: { ...cls, total: vehicles.length, unresolved_trip_ids: 0 },
  };
}
const EMPTY_ALERTS = {
  generated_at: iso(CLOCK_MS), count: 0, alerts: [],
  sources: { bus: { ok: true, error: null, count: 0 }, rail: { ok: true, error: null, count: 0 } },
};
const EMPTY_TU = {
  generated_at: iso(CLOCK_MS), count: 0, trip_updates: [],
  sources: { bus: { ok: true, error: null, count: 0 }, rail: { ok: true, error: null, count: 0 } },
};
const feed = (records, generatedMs) => api.setData({
  vehicles: envelope(records, generatedMs), alerts: EMPTY_ALERTS, tripUpdates: EMPTY_TU,
});

// ---------------- compose the app the way bootBrowser does -----
const rendererMod = await imp('modules/renderer.mjs');
const surfacesMod = await imp('modules/surfaces.mjs');
const hostMod = await imp('modules/planner-host.mjs');
const renderer = await rendererMod.createRenderer(null, { width: 960, height: 640 });
await renderer.loadGeometry({
  streets: readJson(join(ROOT, 'philadelphia-streets.json')),
  routesByFeed: {
    bus: readJson(join(ROOT, 'septa-bus-routes-3d.json')),
    rail: readJson(join(ROOT, 'septa-rail-routes-3d.json')),
  },
  stops: readJson(join(ROOT, 'septa-stops.json')),
  water: readJson(join(ROOT, 'philadelphia-water.json')),
  landmarks: readJson(join(ROOT, 'philadelphia-landmarks.json')),
  names: readJson(join(ROOT, 'philadelphia-street-names.json')),
});
const host = hostMod.createPlannerHost();
const doc = new FakeDocument(surfacesMod.SURFACE_MOUNTS);
// The shell hides the info and degraded regions until first render.
el0('lt-info').style.display = 'none';
el0('lt-degraded').style.display = 'none';
function el0(id) { return doc.getElementById(id); }
// The served shell's filter panel (index.html) declares the four
// group checkboxes; reproduce them exactly as served.
{
  const panel = el0('lt-filter-panel');
  for (const g of ['bus', 'trolley', 'metro', 'rail']) {
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
  const g = renderer.model.state.glyphs.find((x) => x.record && x.record.vehicle_id === '3635');
  renderer.camera.target = { x: g.x, z: g.z };
  renderer.camera.distance = 900;
  const sp = renderer.model.screenOf(g.x, 66, g.z);
  const casePick = renderer.pick({ x: sp.x, y: sp.y });
  tap(sp.x, sp.y);
  check('U5-04', casePick && casePick.kind === 'vehicle'
    && api.state.card && api.state.card.kind === 'vehicle'
    && api.state.card.id === 'septa|3635'
    && el('lt-info').style.display === 'block'
    && el('lt-info').innerHTML.includes('Vehicle 3635'),
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
check('U5-07', /^No vehicles live right now/.test(status()),
  `empty status reads 0: "${status()}"`);
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
check('U5-13', /^No vehicles live right now/.test(status()),
  `toggle-off status reads 0 immediately after the change event: "${status()}"`);
setGroup('bus', true);
check('U5-14', stats().markers === 1 && /^1 vehicle live/.test(status()),
  `toggle back on restores the assigned record only (markers=${stats().markers})`);

// ------- RC10: per-group toggle immediacy -----------------------
// Philadelphia asserts the two groups carrying live vehicle
// families (bus / rail); trolley and metro carry none (header,
// adaptation 4).
feed([BUS, RAIL], CLOCK_MS);
check('U5-15', stats().markers === 2 && /^2 vehicles live/.test(status()),
  `two-group baseline: "${status()}"`);
setGroup('bus', false);
check('U5-16', stats().markers === 1 && /^1 vehicle live/.test(status())
  && visibleResolvedByGroup('bus') === 0 && visibleResolvedByGroup('rail') === 1,
  `bus off -> status 1 immediately, counts follow per group: "${status()}"`);
setGroup('bus', true);
check('U5-17', stats().markers === 2 && /^2 vehicles live/.test(status()),
  `bus on -> status back to 2 immediately: "${status()}"`);
setGroup('rail', false);
check('U5-18', stats().markers === 1 && /^1 vehicle live/.test(status())
  && visibleResolvedByGroup('rail') === 0 && visibleResolvedByGroup('bus') === 1,
  `rail off -> status 1 immediately, counts follow per group: "${status()}"`);
setGroup('rail', true);
check('U5-19', stats().markers === 2 && /^2 vehicles live/.test(status()),
  `rail on -> status back to 2 immediately: "${status()}"`);

// ------- RC9 (adapted): bounded pick tolerance ------------------
// Band 16 px, guard 20 px (platform/picking.mjs); the miss probe
// sits at 21 px, beyond the guard. Tap points are case-selected
// through the real pick, then driven through the real canvas events.
feed([], CLOCK_MS);
{
  const S = renderer.model.state;
  let stop = null; let sp = null;
  for (const cand of S.stops) {
    if (!cand.n) continue; // names admitted as served (adaptation 8)
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
    if (nearest <= 60) continue;
    // Philadelphia case selection: the stop must also offer a
    // beyond-guard null point at a cardinal 21 px offset — a stop
    // sitting on its own route's centreline can have all four
    // offsets inside the route pick band (routes are pick
    // candidates too), leaving no honest U5-22 probe. Same class
    // of case-selection criterion as the isolation rule above;
    // the check itself is unchanged.
    const has21 = [[21, 0], [-21, 0], [0, 21], [0, -21]]
      .some(([dx, dy]) => renderer.pick({ x: c.x + dx, y: c.y + dy }) === null);
    if (has21) { stop = cand; sp = c; break; }
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
