// planner/worker-entry.mjs — R4 worker host for the planner.
// PHL REBUILD R4. Label: UNVERIFIED / legacy-unsigned.
//
// M2/M3 companion: the planner host (modules/planner-host.mjs) is
// DOM-free, so the SAME module runs inside a worker and planning
// never blocks the client's main thread. This entry speaks one
// message protocol in both runtimes:
//   { id, type: 'load', assetUrl, stopsUrl }      -> { id, ok, feedVersion }
//   { id, type: 'plan', fromIdx, toIdx, departAfter, query?, opts? }
//                                                 -> { id, ok, plan }
//   errors                                        -> { id, ok: false, error }
// Node (harness): worker_threads; workerData may carry
// { assetPath, stopsPath } — local files are then served through
// an injectable fetch so the identical code path runs headless.
// Browser: a Web Worker created from this file; the page posts
// real asset URLs and the worker fetches them itself.
// Results are the host's own objects (plain data, cloneable).

import { createPlannerHost } from '../modules/planner-host.mjs';

const host = createPlannerHost();

async function handle(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false, error: 'bad message' };
  try {
    if (msg.type === 'load') {
      const st = await host.loadPlanner({
        assetUrl: msg.assetUrl, stopsUrl: msg.stopsUrl,
        fetchImpl: hostFetchImpl || undefined,
      });
      return { id: msg.id, ok: true, feedVersion: st.meta && st.meta.feed_version };
    }
    if (msg.type === 'plan') {
      const plan = await host.planTripAsync(msg.fromIdx, msg.toIdx, msg.departAfter, msg.query || {}, msg.opts || {});
      return { id: msg.id, ok: true, plan };
    }
    return { id: msg.id, ok: false, error: 'unknown message type: ' + msg.type };
  } catch (e) {
    return { id: msg && msg.id, ok: false, error: String((e && e.message) || e) };
  }
}

let hostFetchImpl = null;

// ---- Node worker_threads mode (the R4 harness path) -------------
let isNodeWorker = false;
try {
  const wt = await import('node:worker_threads');
  if (wt && wt.parentPort && !wt.isMainThread) {
    isNodeWorker = true;
    const { readFile } = await import('node:fs/promises');
    const wd = wt.workerData || {};
    if (wd.assetPath && wd.stopsPath) {
      hostFetchImpl = async (url) => {
        const clean = String(url).split('?')[0].split('#')[0];
        const path = clean.endsWith('.json') && clean.includes('stops') ? wd.stopsPath : wd.assetPath;
        try {
          const text = await readFile(path, 'utf8');
          return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
        } catch {
          return { ok: false, status: 404, json: async () => ({}) };
        }
      };
    }
    wt.parentPort.on('message', async (msg) => {
      wt.parentPort.postMessage(await handle(msg));
    });
  }
} catch { /* not Node — fall through to the browser branch */ }

// ---- Browser Web Worker mode -------------------------------------
if (!isNodeWorker &&
    typeof self !== 'undefined' &&
    typeof window === 'undefined' &&
    typeof self.postMessage === 'function' &&
    typeof self.addEventListener === 'function') {
  self.addEventListener('message', async (ev) => {
    self.postMessage(await handle(ev.data));
  });
}
