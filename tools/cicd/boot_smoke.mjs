// boot_smoke.mjs — post-deploy boot smoke check.
//
// The 2026-10-31 P0 S1 failure mode was invisible to every
// byte-level check: the bytes were exactly the assembled bytes,
// and the page still never booted (its shell lacked the app's
// mount points, so boot null-guarded into silence). The only
// instrument that catches that class is a real browser observing
// real boot behaviour. This script is that instrument, run on the
// Actions runner against the PRODUCTION urls after each deploy
// that touches code or shells (and standalone via boot-smoke.yml).
//
// Boot predicate (DOM state, never pixels):
//   modular shell (#lt-status present):
//     - #lt-status text leaves the loading/connecting state and
//       carries live content (count / scheduled-network / updated)
//     - #lt-filter-panel or #lt-browse-panel gains children
//       (route/group UI actually rendered)
//     - the renderer's canvas is live: #lt-map IS a <canvas>
//       element in the modular shell (verified from served
//       bytes 2026-11-01 — the original '#lt-map canvas'
//       descendant selector could never match it and failed
//       eight booted pages; a nested canvas is also accepted)
//   monolith shell (#bus-updated present):
//     - #bus-updated text leaves the static "connecting..." state
//     - a <canvas> exists at/inside #live-map
// Every verdict prints its predicate COMPONENTS (statusOk /
// canvas / panel children) so a false negative names the exact
// sub-condition instead of hiding behind a status string — the
// first fleet run (2026-11-01, run 41277965212) failed five
// pages whose status text already showed live vehicle counts;
// the components are how that gets diagnosed. Page errors are
// collected and printed; the predicate decides.
//
// Robustness rules (same run's lessons): every per-page action
// sits inside the per-city try — a CDP ProtocolError on one
// page is that page's verdict, never the process's death — and
// the summary is rewritten after every city, so a late crash
// cannot erase earlier verdicts.
//
// Usage: node boot_smoke.mjs [--base URL] [--out summary.json]
//        [--only city[,city...]]
// Requires: puppeteer (installed by the workflow step).
import puppeteer from 'puppeteer';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const BASE = opt('--base', 'https://www.detroitautomationacademy.com').replace(/\/$/, '');
const OUT = opt('--out', null);
const ONLY = opt('--only', null);

const PAGES = [
  { city: 'detroit', url: `${BASE}/live-transit.html` },
  { city: 'austin', url: `${BASE}/live-transit/austin/` },
  { city: 'cincinnati', url: `${BASE}/live-transit/cincinnati/` },
  { city: 'columbus', url: `${BASE}/live-transit/columbus/` },
  { city: 'denver', url: `${BASE}/live-transit/denver/` },
  { city: 'philadelphia', url: `${BASE}/live-transit/philadelphia/` },
  { city: 'sacramento', url: `${BASE}/live-transit/sacramento/` },
  { city: 'san-diego', url: `${BASE}/live-transit/san-diego/` },
].filter((p) => !ONLY || ONLY.split(',').includes(p.city));

const BOOT_FN = () => {
  const text = (el) => (el ? el.textContent.trim() : '');
  const status = document.getElementById('lt-status');
  if (status) {
    const t = text(status);
    const panel =
      document.getElementById('lt-filter-panel') ||
      document.getElementById('lt-browse-panel');
    const canvas = document.querySelector('canvas#lt-map, #lt-map canvas');
    const statusOk = t.length > 0 && !/loading|connecting/i.test(t);
    const panelChildren = panel ? panel.childElementCount : -1;
    return {
      shell: 'modular',
      statusOk,
      canvas: !!canvas,
      panelId: panel ? panel.id : null,
      panelChildren,
      booted: statusOk && !!canvas && !!panel && panelChildren > 0,
      detail: t.slice(0, 120),
      ...(() => {
        const all = document.querySelectorAll('canvas');
        let firstCanvasHome = null;
        if (all.length) {
          let el = all[0];
          const chain = [];
          while (el && chain.length < 5) {
            chain.push(el.id ? `#${el.id}` : el.tagName.toLowerCase());
            el = el.parentElement;
          }
          firstCanvasHome = chain.join(' < ');
        }
        let webgl = false;
        try {
          const c = document.createElement('canvas');
          webgl = !!(c.getContext('webgl2') || c.getContext('webgl'));
        } catch {
          webgl = false;
        }
        return { anyCanvas: all.length, firstCanvasHome, webgl };
      })(),
    };
  }
  const updated = document.getElementById('bus-updated');
  if (updated) {
    const t = text(updated);
    const canvas = document.querySelector('canvas#live-map, #live-map canvas');
    const statusOk = t.length > 0 && !/connecting/i.test(t);
    return {
      shell: 'monolith',
      statusOk,
      canvas: !!canvas,
      panelId: null,
      panelChildren: -1,
      booted: statusOk && !!canvas,
      detail: t.slice(0, 120),
      ...(() => {
        const all = document.querySelectorAll('canvas');
        let firstCanvasHome = null;
        if (all.length) {
          let el = all[0];
          const chain = [];
          while (el && chain.length < 5) {
            chain.push(el.id ? `#${el.id}` : el.tagName.toLowerCase());
            el = el.parentElement;
          }
          firstCanvasHome = chain.join(' < ');
        }
        let webgl = false;
        try {
          const c = document.createElement('canvas');
          webgl = !!(c.getContext('webgl2') || c.getContext('webgl'));
        } catch {
          webgl = false;
        }
        return { anyCanvas: all.length, firstCanvasHome, webgl };
      })(),
    };
  }
  return {
    shell: 'unknown',
    statusOk: false,
    canvas: false,
    panelId: null,
    panelChildren: -1,
    booted: false,
    detail: 'no known status element',
    anyCanvas: document.querySelectorAll('canvas').length,
    firstCanvasHome: null,
    webgl: false,
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 180000,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--mute-audio',
  ],
});

const results = [];
for (const { city, url } of PAGES) {
  let verdict;
  let page = null;
  const pageErrors = [];
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Poll the predicate in-page for up to 120 s (Philadelphia's
    // data layer needs longer than 60 s under SwiftShader on a
    // shared runner — run 41280352947 caught it mid-boot with
    // panels rendered and status still loading); a stalled
    // renderer makes individual evaluates throw — that is a
    // not-yet verdict, retried until the deadline.
    const deadline = Date.now() + 120000;
    let state = null;
    while (Date.now() < deadline) {
      try {
        state = await page.evaluate(BOOT_FN);
        if (state && state.booted) break;
      } catch {
        state = state || null;
      }
      await sleep(2000);
    }
    if (!state) {
      state = {
        shell: 'error',
        statusOk: false,
        canvas: false,
        panelId: null,
        panelChildren: -1,
        booted: false,
        detail: 'predicate never evaluated (renderer unresponsive)',
        anyCanvas: -1,
        firstCanvasHome: null,
        webgl: false,
      };
    }
    verdict = { city, url, ...state, pageErrors };
  } catch (e) {
    verdict = {
      city,
      url,
      shell: 'error',
      statusOk: false,
      canvas: false,
      panelId: null,
      panelChildren: -1,
      booted: false,
      detail: String(e).slice(0, 300),
      anyCanvas: -1,
      firstCanvasHome: null,
      webgl: false,
      pageErrors,
    };
  } finally {
    if (page) await page.close().catch(() => {});
  }
  verdict.evidenceClass = 'behavior';
  results.push(verdict);
  if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 1));
  console.log(
    `${verdict.booted ? 'PASS' : 'FAIL'} ${city} [${verdict.shell}] ${verdict.detail}`,
  );
  console.log(
    `     components: statusOk=${verdict.statusOk} canvas=${verdict.canvas} ` +
      `panel=${verdict.panelId} panelChildren=${verdict.panelChildren}`,
  );
  console.log(
    `     diag: anyCanvas=${verdict.anyCanvas} webgl=${verdict.webgl} ` +
      `firstCanvasHome=${verdict.firstCanvasHome}`,
  );
  if (pageErrors.length) {
    console.log(`     pageerrors: ${pageErrors.slice(0, 3).join(' | ')}`);
  }
}
await browser.close().catch(() => {});

if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 1));
const failed = results.filter((r) => !r.booted);
console.log(
  `EVIDENCE gate=boot-smoke class=behavior verdict=${failed.length ? 'fail' : 'pass'}`,
);
if (failed.length) {
  console.error(`boot-smoke: ${failed.length} page(s) did not boot`);
  process.exit(1);
}
console.log('boot-smoke: all pages booted');
