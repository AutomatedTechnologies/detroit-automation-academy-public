// boot_smoke.mjs — post-deploy boot smoke check.
//
// The 2026-10-31 P0 S1 failure mode was invisible to every
// byte-level check: the bytes were exactly the assembled bytes,
// and the page still never booted (its shell lacked the app's
// mount points, so boot null-guarded into silence). The only
// instrument that catches that class is a real browser observing
// real boot behaviour. This script is that instrument, run on the
// Actions runner against the PRODUCTION urls after each deploy
// that touches code or shells.
//
// Boot predicate (DOM state, never pixels):
//   modular shell (#lt-status present):
//     - #lt-status text leaves the loading/connecting state and
//       carries live content (count / scheduled-network / updated)
//     - #lt-filter-panel or #lt-browse-panel gains children
//       (route/group UI actually rendered)
//     - a <canvas> exists inside #lt-map (renderer materialised)
//   monolith shell (#bus-updated present):
//     - #bus-updated text leaves the static "connecting..." state
//     - a <canvas> exists inside #live-map
// Page errors are collected and printed; the predicate decides.
//
// Usage: node boot_smoke.mjs [--base URL] [--out summary.json]
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

const PAGES = [
  { city: 'detroit', url: `${BASE}/live-transit.html` },
  { city: 'austin', url: `${BASE}/live-transit/austin/` },
  { city: 'cincinnati', url: `${BASE}/live-transit/cincinnati/` },
  { city: 'columbus', url: `${BASE}/live-transit/columbus/` },
  { city: 'denver', url: `${BASE}/live-transit/denver/` },
  { city: 'philadelphia', url: `${BASE}/live-transit/philadelphia/` },
  { city: 'sacramento', url: `${BASE}/live-transit/sacramento/` },
  { city: 'san-diego', url: `${BASE}/live-transit/san-diego/` },
];

const BOOT_FN = () => {
  const text = (el) => (el ? el.textContent.trim() : '');
  const status = document.getElementById('lt-status');
  if (status) {
    const t = text(status);
    const panel =
      document.getElementById('lt-filter-panel') ||
      document.getElementById('lt-browse-panel');
    const canvas = document.querySelector('#lt-map canvas');
    return {
      shell: 'modular',
      booted:
        t.length > 0 &&
        !/loading|connecting/i.test(t) &&
        !!canvas &&
        !!panel &&
        panel.childElementCount > 0,
      detail: t.slice(0, 120),
    };
  }
  const updated = document.getElementById('bus-updated');
  if (updated) {
    const t = text(updated);
    const canvas = document.querySelector('#live-map canvas');
    return {
      shell: 'monolith',
      booted: t.length > 0 && !/connecting/i.test(t) && !!canvas,
      detail: t.slice(0, 120),
    };
  }
  return { shell: 'unknown', booted: false, detail: 'no known status element' };
};

const browser = await puppeteer.launch({
  headless: true,
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
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
  let verdict;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Wait until the boot predicate (BOOT_FN's logic, inlined for
    // serialization) reports booted; on timeout, evaluate once for
    // the record so the failure output carries the stuck state.
    const handle = await page
      .waitForFunction(
        () => {
          const text = (el) => (el ? el.textContent.trim() : '');
          const status = document.getElementById('lt-status');
          if (status) {
            const t = text(status);
            const panel =
              document.getElementById('lt-filter-panel') ||
              document.getElementById('lt-browse-panel');
            const canvas = document.querySelector('#lt-map canvas');
            const booted =
              t.length > 0 &&
              !/loading|connecting/i.test(t) &&
              !!canvas &&
              !!panel &&
              panel.childElementCount > 0;
            return booted
              ? { shell: 'modular', booted, detail: t.slice(0, 120) }
              : false;
          }
          const updated = document.getElementById('bus-updated');
          if (updated) {
            const t = text(updated);
            const canvas = document.querySelector('#live-map canvas');
            const booted =
              t.length > 0 && !/connecting/i.test(t) && !!canvas;
            return booted
              ? { shell: 'monolith', booted, detail: t.slice(0, 120) }
              : false;
          }
          return false;
        },
        { timeout: 90000, polling: 1000 },
      )
      .catch(() => null);
    const state = handle ? await handle.jsonValue() : await page.evaluate(BOOT_FN);
    verdict = { city, url, ...state, pageErrors };
  } catch (e) {
    verdict = {
      city, url, shell: 'error', booted: false,
      detail: String(e).slice(0, 300), pageErrors,
    };
  }
  verdict.evidenceClass = 'behavior';
  results.push(verdict);
  console.log(
    `${verdict.booted ? 'PASS' : 'FAIL'} ${city} [${verdict.shell}] ${verdict.detail}`,
  );
  if (pageErrors.length) {
    console.log(`     pageerrors: ${pageErrors.slice(0, 3).join(' | ')}`);
  }
  await page.close();
}
await browser.close();

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
