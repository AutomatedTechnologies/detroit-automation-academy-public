// modules/ops.mjs — R6 CONTRACT: ops hooks (client-visible half).
// Core module (Cities V2). Label: UNVERIFIED / legacy-unsigned.
//
// R6 (ops parity) stands up the server-side ops chain; this module
// declares the CLIENT-VISIBLE ops contracts the page itself must
// honour, so R6's verification set has something stable to assert
// against:
//   - Hourly production verification set (LT-KAES-42): page/boot/
//     stamp assertions, every live-data file's freshness, silo/fence
//     assertions. The page side of that contract is: the app
//     exposes its governing BUILD_STAMP and boot state on
//     window.__LT_OPS__ (below), and every published file carries
//     the envelope the data layer validates.
//   - Self-heal independence (LT-KAES-43): the heal dependency is
//     DECLARED, in order, never discovered by failure. (The defect
//     case of record, 2026-10-23: a city heal failed because
//     Detroit's egress forwarder (127.0.0.1:8888) was down and had
//     to be restored first — an ordering discovered by failure.)
//     The declared order's SHAPE is platform truth and lives here;
//     the per-city unit names are config data (ops.chainUnits,
//     CV2-D13) — a chainless (static-only) city declares nulls and
//     its order is the forwarder leg alone.
//   - Telemetry (LT-KAES-44, ADAPTABLE): each city's telemetry
//     state is its own config record (ops.telemetry, CV2-D13),
//     never an inherited sentence. A deferral is recorded in the
//     city's config, not silent.
//   - Deploy path (LT-KAES-46): same repo, same Pages workflow,
//     explicit allowlist; page changes ride the city stamp
//     sequence (config/stamp.mjs), data commits ride the chain's
//     cadence. No staging sites, no push-triggered hosted builds.
//
// CG-13 (core fold F6): the client recovery stack — error log,
// recovery ladder, frame watchdog — lives at the end of this
// module. Every piece is CONFIG-GATED by ops.clientRecovery
// (schema v2.2, optional): with the section absent (every fleet
// config today) the resolved config below is all-off, nothing is
// installed at boot, and behaviour is exactly the pre-fold
// behaviour. Semantics are the monolith's (census CG-13), with
// every city-specific value replaced by config or dropped:
// the error log's sessionStorage key is config-supplied, the
// watchdog threshold is config-supplied, and the ladder carries
// no city framing, copy, or storage key of its own.

import { BUILD_STAMP } from '../config/stamp.mjs';
import { CITY_CONFIG } from '../config/city-config.mjs';

export const HEAL_DEPENDENCY_ORDER = Object.freeze([
  'egress-forwarder-127.0.0.1:8888',
  ...(CITY_CONFIG.ops.chainUnits.cityTimerUnit ? [CITY_CONFIG.ops.chainUnits.cityTimerUnit] : []),
  ...(CITY_CONFIG.ops.chainUnits.watchdogHook ? [CITY_CONFIG.ops.chainUnits.watchdogHook] : []),
]);

export const TELEMETRY_STATE = Object.freeze({
  product: CITY_CONFIG.ops.telemetry.state, // KAES-44 state, per-city (OPS-2)
  decisionRecordDue: CITY_CONFIG.ops.telemetry.decisionRecord,
});

/** Boot/stamp assertion surface for the hourly verification set. */
export function opsBootReport(state) {
  return {
    stamp: BUILD_STAMP,
    booted: !!(state && state.booted),
    assetsLoaded: !!(state && state.assetsLoaded),
    firstDataAt: (state && state.firstDataAt) || null,
  };
}

/** Install window.__LT_OPS__ (browser only; no-op elsewhere). */
export function installOpsHooks(state) {
  if (typeof window !== 'undefined') {
    window.__LT_OPS__ = Object.freeze(opsBootReport(state));
  }
  return opsBootReport(state);
}

// =====================================================================
// CG-13 — client recovery stack (all pieces config-gated, see header)
// =====================================================================

// Monolith constants (census CG-13 evidence): the error log ring
// holds 50 entries / 64 KiB persisted, burst de-dupe is 5 s, a
// recovery reload is guarded by a 30 s window (a second recovery
// inside it stands down instead of reloading), the reload fires
// after a 600 ms stand-down check, ladder rung counters reset
// after the rung's condition has stayed clear for 60 s, and the
// frame watchdog polls every 2 s.
export const ERRLOG_MAX = 50;
export const ERRLOG_BYTES = 65536;
export const ERRLOG_DEDUPE_MS = 5000;
export const RECOVERY_GUARD_MS = 30000;
export const RECOVERY_RELOAD_DELAY_MS = 600;
export const LADDER_MAX_RELOADS = 3;
export const LADDER_RESET_MS = 60000;
export const WATCHDOG_TICK_MS = 2000;
// Generic (city-neutral) sessionStorage key for the ladder's
// persisted attempt state {count, at}. The error log's key, by
// contrast, is config-supplied (clientRecovery.errorLogKey).
export const RECOVERY_STORAGE_KEY = 'lt-recover-state';

/** Normalise a raw ops.clientRecovery value; absent/garbled = off. */
export function normalizeClientRecoveryConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : null;
  return Object.freeze({
    errorLogKey: cfg && typeof cfg.errorLogKey === 'string' && cfg.errorLogKey
      ? cfg.errorLogKey : null,
    ladder: !!(cfg && cfg.ladder === true),
    frameWatchdogMs: cfg && typeof cfg.frameWatchdogMs === 'number'
      && Number.isFinite(cfg.frameWatchdogMs) && cfg.frameWatchdogMs > 0
      ? cfg.frameWatchdogMs : null,
  });
}

export const CLIENT_RECOVERY = normalizeClientRecoveryConfig(
  CITY_CONFIG.ops ? CITY_CONFIG.ops.clientRecovery : null,
);

export const CLIENT_RECOVERY_CONFIGURED = !!(
  CLIENT_RECOVERY.errorLogKey || CLIENT_RECOVERY.ladder
  || CLIENT_RECOVERY.frameWatchdogMs
);

// --- small environment resolvers (never throw) ----------------------

function resolveWindow(explicit) {
  if (explicit) return explicit;
  return typeof window !== 'undefined' ? window : null;
}

function resolveStorage(explicit) {
  if (explicit) return explicit;
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch (e) { return null; }
}

function storageGet(storage, key) {
  try { return storage ? storage.getItem(key) : null; } catch (e) { return null; }
}

function storageSet(storage, key, value) {
  try { if (storage) storage.setItem(key, value); } catch (e) { /* memory-only */ }
}

function defaultReload(win) {
  const w = resolveWindow(win);
  try { if (w && w.location && w.location.reload) w.location.reload(); } catch (e) {}
}

// --- error log ------------------------------------------------------

/**
 * Pure ring bound: at most maxEntries entries, and (when serialized)
 * at most maxBytes bytes, always keeping at least the newest entry.
 * Returns a new array; the input is not mutated.
 */
export function boundErrorEntries(entries, maxEntries = ERRLOG_MAX, maxBytes = ERRLOG_BYTES) {
  const max = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : ERRLOG_MAX;
  let out = Array.isArray(entries) ? entries.slice(-max) : [];
  if (Number.isFinite(maxBytes) && maxBytes > 0) {
    while (out.length > 1 && JSON.stringify(out).length > maxBytes) out = out.slice(1);
  }
  return out;
}

/**
 * Bounded in-memory error log with sessionStorage persistence.
 * Semantics (monolith errLog/errLogPersist): entries are
 * {t, cls, msg<=300 chars, stack?<=300 chars}; identical
 * (cls,msg) bursts within ERRLOG_DEDUPE_MS collapse; the ring is
 * bounded by count AND serialized bytes; the previous session's
 * persisted entries are reloaded once, marked prev:1, so a freeze
 * that ends in a tab kill still leaves its antecedents. The
 * logger never throws.
 */
export function createErrorLog(options = {}) {
  const storageKey = typeof options.storageKey === 'string' && options.storageKey
    ? options.storageKey : null;
  const storage = resolveStorage(options.storage);
  const maxEntries = options.maxEntries || ERRLOG_MAX;
  const maxBytes = options.maxBytes || ERRLOG_BYTES;
  const nowFn = options.nowFn || (() => Date.now());
  let ring = [];
  let lastKey = '';
  let lastAt = 0;

  try {
    const prev = JSON.parse(storageGet(storage, storageKey) || '[]');
    if (Array.isArray(prev) && prev.length) {
      prev.forEach((en) => { if (en && typeof en === 'object') en.prev = 1; });
      ring = boundErrorEntries(prev, maxEntries, maxBytes);
    }
  } catch (e) { ring = []; }

  function persist() {
    if (!storageKey) return;
    try {
      ring = boundErrorEntries(ring, maxEntries, maxBytes);
      storageSet(storage, storageKey, JSON.stringify(ring));
    } catch (e) { /* storage unavailable: the log stays memory-only */ }
  }

  function log(cls, msg, err) {
    try {
      const m = String(msg == null ? '' : msg).slice(0, 300);
      const key = `${cls}|${m}`;
      const now = nowFn();
      if (key === lastKey && now - lastAt < ERRLOG_DEDUPE_MS) return null;
      lastKey = key; lastAt = now;
      const entry = { t: now, cls: String(cls || 'error'), msg: m };
      if (err && err.stack) {
        entry.stack = String(err.stack).split('\n').slice(0, 3).join(' | ').slice(0, 300);
      }
      ring.push(entry);
      ring = boundErrorEntries(ring, maxEntries, maxBytes);
      persist();
      return entry;
    } catch (e) { return null; /* the logger must never throw */ }
  }

  return {
    key: storageKey,
    maxEntries,
    maxBytes,
    log,
    persist,
    entries() { return ring.slice(); },
    uninstall() {},
  };
}

let activeErrorLog = null;

/**
 * Install the global error capture (window 'error' +
 * 'unhandledrejection') into the log persisted under the
 * configured key. No key configured (and none passed) = no-op,
 * returns null. Also exposes a read-only copy hook as
 * window.__LT_ERRLOG__ (gated installs only).
 */
export function installErrorLog(options = {}) {
  const storageKey = options.storageKey !== undefined
    ? options.storageKey : CLIENT_RECOVERY.errorLogKey;
  if (typeof storageKey !== 'string' || !storageKey) return null;
  if (activeErrorLog && activeErrorLog.key === storageKey && !options.force) {
    return activeErrorLog;
  }
  const log = createErrorLog({ ...options, storageKey });
  const win = resolveWindow(options.window);
  const listeners = [];
  if (win && typeof win.addEventListener === 'function') {
    const onError = (e) => {
      try {
        if (e && e.error) {
          log.log('error', String(e.message || e.error).slice(0, 300), e.error);
        } else if (e && e.target && e.target !== win) {
          log.log('background', `resource error: ${(e.target && e.target.tagName) || 'unknown'}`);
        }
      } catch (e2) {}
    };
    const onRejection = (e) => {
      try {
        const r = e && e.reason;
        log.log('rejection', String((r && r.message) || r).slice(0, 300), r);
      } catch (e2) {}
    };
    try { win.addEventListener('error', onError, true); listeners.push(['error', onError, true]); } catch (e) {}
    try { win.addEventListener('unhandledrejection', onRejection); listeners.push(['unhandledrejection', onRejection, undefined]); } catch (e) {}
    try { win.__LT_ERRLOG__ = () => log.entries(); } catch (e) {}
  }
  log.uninstall = () => {
    if (win && typeof win.removeEventListener === 'function') {
      for (const [type, fn, opts] of listeners) {
        try { win.removeEventListener(type, fn, opts); } catch (e) {}
      }
    }
    if (activeErrorLog === log) activeErrorLog = null;
  };
  activeErrorLog = log;
  return log;
}

// --- recovery ladder --------------------------------------------------

/**
 * Pure ladder decision (monolith ladderReload/recoverReload):
 * given the persisted attempt count for this recovery episode and
 * how long ago the last recovery reload fired, decide the next
 * step. The sequence always terminates:
 *   - attempts older than LADDER_RESET_MS start a fresh episode
 *     (the rung's condition stayed clear; monolith resets rung
 *     counters after 60 s clear);
 *   - a further reload inside RECOVERY_GUARD_MS stands down
 *     (monolith: a second loss within 30 s of a recovery reload
 *     shows the fallback instead of looping);
 *   - at LADDER_MAX_RELOADS the ladder stops — no reload, ever,
 *     for this episode.
 * `opts` may be a number (msSinceLastReload) or an object
 * {msSinceLastReload, maxReloads, guardMs, resetMs}.
 */
export function nextLadderStep(attempts, opts = {}) {
  const o = typeof opts === 'number' ? { msSinceLastReload: opts } : (opts || {});
  const maxReloads = Number.isFinite(o.maxReloads) ? o.maxReloads : LADDER_MAX_RELOADS;
  const guardMs = Number.isFinite(o.guardMs) ? o.guardMs : RECOVERY_GUARD_MS;
  const resetMs = Number.isFinite(o.resetMs) ? o.resetMs : LADDER_RESET_MS;
  const msSince = typeof o.msSinceLastReload === 'number' && Number.isFinite(o.msSinceLastReload)
    ? o.msSinceLastReload : null;
  let n = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0;
  if (msSince !== null && msSince >= resetMs) n = 0; // episode cleared
  if (n >= maxReloads) {
    return Object.freeze({ action: 'stop', reload: false, attempt: n, nextAttempts: n, reason: 'max-attempts' });
  }
  if (n > 0 && msSince !== null && msSince < guardMs) {
    return Object.freeze({ action: 'stop', reload: false, attempt: n, nextAttempts: n, reason: 'guard-window' });
  }
  return Object.freeze({ action: 'reload', reload: true, attempt: n + 1, nextAttempts: n + 1, reason: 'reload' });
}

function readRecoveryState(storage) {
  try {
    const raw = JSON.parse(storageGet(storage, RECOVERY_STORAGE_KEY) || 'null');
    if (raw && Number.isFinite(raw.count)) {
      return { count: Math.max(0, Math.floor(raw.count)), at: Number.isFinite(raw.at) ? raw.at : 0 };
    }
  } catch (e) {}
  return { count: 0, at: 0 };
}

/**
 * Request one ladder-guarded recovery reload. The persisted
 * attempt state is written only once the reload is certain
 * (after the stand-down check — monolith token fix: a stand-down
 * must not consume the recovery). Injectable for tests:
 * {storage, nowFn, reload, schedule, delayMs, shouldStandDown,
 * ladder:{...nextLadderStep opts}}.
 */
export function requestRecoveryReload(reason = 'recovery', options = {}) {
  const storage = resolveStorage(options.storage);
  const nowFn = options.nowFn || (() => Date.now());
  const state = readRecoveryState(storage);
  const now = nowFn();
  const step = nextLadderStep(state.count, {
    ...(options.ladder || {}),
    msSinceLastReload: state.at ? now - state.at : null,
  });
  if (activeErrorLog) {
    try {
      activeErrorLog.log('recovery', step.reload
        ? `reload requested: ${reason}` : `reload suppressed (${step.reason}): ${reason}`);
    } catch (e) {}
  }
  if (!step.reload) {
    if (typeof options.onStop === 'function') {
      try { options.onStop(step, reason); } catch (e) {}
    }
    return { ...step, reason, performed: false, scheduled: false };
  }
  const perform = () => {
    // Written here, once the reload is certain (see header note).
    storageSet(storage, RECOVERY_STORAGE_KEY, JSON.stringify({ count: step.nextAttempts, at: nowFn() }));
    if (typeof options.reload === 'function') options.reload(reason, step);
    else defaultReload(options.window);
  };
  const delayMs = typeof options.delayMs === 'number'
    ? options.delayMs : RECOVERY_RELOAD_DELAY_MS;
  if (delayMs > 0 || typeof options.shouldStandDown === 'function') {
    const schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms));
    schedule(() => {
      if (typeof options.shouldStandDown === 'function') {
        let down = false;
        try { down = options.shouldStandDown() === true; } catch (e) {}
        if (down) return; // recovered on its own: stand down, consume nothing
      }
      perform();
    }, delayMs);
    return { ...step, reason, performed: false, scheduled: true };
  }
  perform();
  return { ...step, reason, performed: true, scheduled: false };
}

/** Install the ladder handle. Not configured = no-op, returns null. */
export function installRecoveryLadder(options = {}) {
  const cfg = options.config
    ? normalizeClientRecoveryConfig(options.config) : CLIENT_RECOVERY;
  if (!cfg.ladder && !options.force) return null;
  const request = (reason) => requestRecoveryReload(reason, options);
  return Object.freeze({
    request,
    recoverReload: request,
    state() { return readRecoveryState(resolveStorage(options.storage)); },
  });
}

// --- frame watchdog ---------------------------------------------------

/**
 * Pure watchdog decision (monolith frame watchdog): fire when the
 * GL context is lost, or when the frame gap reaches the configured
 * threshold. A missing/invalid threshold or an unstarted clock
 * (gap not a finite number) never fires.
 */
export function shouldWatchdogFire(gapMs, thresholdMs, contextLost = false) {
  const lost = contextLost === true
    || !!(contextLost && typeof contextLost === 'object' && contextLost.contextLost === true);
  if (lost) return true;
  if (typeof thresholdMs !== 'number' || !Number.isFinite(thresholdMs) || thresholdMs <= 0) return false;
  if (typeof gapMs !== 'number' || !Number.isFinite(gapMs)) return false;
  return gapMs >= thresholdMs;
}

/**
 * Frame-gap / context-lost watchdog. Self-contained: a
 * requestAnimationFrame loop (when available) supplies the frame
 * clock — rAF cadence mirrors frame production and pauses with
 * the tab, exactly the signal the watchdog needs — and any
 * renderer may additionally drive handle.noteFrame(t) (exposed
 * as window.__LT_FRAME_TICK__ on gated installs). Hidden time
 * never counts as staleness; becoming visible resets the clock.
 * Firing routes through the recovery ladder when one is supplied,
 * so the watchdog can never spin a reload loop on its own.
 * Returns null when no valid threshold is configured.
 */
export function installFrameWatchdog(options = {}) {
  const thresholdMs = options.frameWatchdogMs !== undefined
    ? options.frameWatchdogMs
    : (options.thresholdMs !== undefined ? options.thresholdMs : CLIENT_RECOVERY.frameWatchdogMs);
  if (typeof thresholdMs !== 'number' || !Number.isFinite(thresholdMs) || thresholdMs <= 0) {
    return null;
  }
  const nowFn = options.nowFn
    || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const win = resolveWindow(options.window);
  let lastFrameAt = nowFn();
  let contextLostFlag = false;
  let stopped = false;
  let intervalId = null;
  let rafId = null;

  const fire = (fireReason) => {
    if (typeof options.onFire === 'function') {
      options.onFire(fireReason);
    } else if (options.ladder && typeof options.ladder.request === 'function') {
      options.ladder.request(fireReason);
    } else {
      requestRecoveryReload(fireReason, {
        storage: options.storage, window: win,
        reload: options.reload, schedule: options.schedule,
        delayMs: options.delayMs, ladder: options.ladderStep,
        shouldStandDown: () => !shouldWatchdogFire(nowFn() - lastFrameAt, thresholdMs, contextLostFlag),
      });
    }
  };

  const handle = {
    installed: true,
    thresholdMs,
    noteFrame(t) {
      lastFrameAt = typeof t === 'number' && Number.isFinite(t) ? t : nowFn();
      return lastFrameAt;
    },
    tick(t) { return handle.noteFrame(t); },
    lastFrameAt() { return lastFrameAt; },
    contextLost() {
      contextLostFlag = true;
      return handle.check(nowFn(), { contextLost: true });
    },
    contextRestored() { contextLostFlag = false; handle.noteFrame(); },
    check(t, checkOpts = {}) {
      if (stopped) return false;
      const hidden = typeof options.isHidden === 'function'
        ? options.isHidden()
        : (typeof document !== 'undefined' && !!document.hidden);
      if (hidden) return false; // hidden time never counts as staleness
      const now = typeof t === 'number' && Number.isFinite(t) ? t : nowFn();
      const lost = checkOpts.contextLost !== undefined ? checkOpts.contextLost : contextLostFlag;
      if (shouldWatchdogFire(now - lastFrameAt, thresholdMs, lost)) {
        fire(lost ? 'context' : 'watchdog');
        return true;
      }
      return false;
    },
    stop() {
      stopped = true;
      if (intervalId !== null) { try { clearInterval(intervalId); } catch (e) {} intervalId = null; }
      if (rafId !== null && typeof cancelAnimationFrame === 'function') {
        try { cancelAnimationFrame(rafId); } catch (e) {}
        rafId = null;
      }
      try {
        if (win && win.__LT_FRAME_TICK__ === handle.noteFrame) delete win.__LT_FRAME_TICK__;
      } catch (e) {}
    },
  };
  handle.noteFrame = handle.noteFrame.bind(handle);

  try { if (win) win.__LT_FRAME_TICK__ = handle.noteFrame; } catch (e) {}

  if (options.useAnimationFrame !== false && typeof requestAnimationFrame === 'function') {
    const loop = (t) => {
      if (stopped) return;
      handle.noteFrame(typeof t === 'number' ? t : undefined);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }
  if (options.useInterval !== false && typeof setInterval === 'function') {
    intervalId = setInterval(() => handle.check(), Math.min(WATCHDOG_TICK_MS, thresholdMs));
    if (intervalId && typeof intervalId.unref === 'function') intervalId.unref();
  }
  const doc = options.document
    || (typeof document !== 'undefined' ? document : null);
  if (doc && typeof doc.addEventListener === 'function') {
    try {
      doc.addEventListener('visibilitychange', () => {
        if (!doc.hidden) handle.noteFrame(); // becoming visible resets the clock
      });
    } catch (e) {}
  }
  if (options.canvas && typeof options.canvas.addEventListener === 'function') {
    try {
      options.canvas.addEventListener('webglcontextlost', (e) => {
        if (e && e.preventDefault) e.preventDefault();
        handle.contextLost();
      });
      options.canvas.addEventListener('webglcontextrestored', () => handle.contextRestored());
    } catch (e) {}
  }
  return handle;
}

// --- aggregator (what app boot calls) ---------------------------------

let activeClientRecovery = null;

/**
 * Install every configured clientRecovery piece. With
 * ops.clientRecovery absent (every fleet config) this installs
 * NOTHING — no listeners, no storage writes, no timers — and
 * returns {installed:false, ...}. Boot report shape is untouched:
 * this handle is separate from window.__LT_OPS__.
 */
export function installClientRecovery(options = {}) {
  if (activeClientRecovery && !options.force) return activeClientRecovery;
  const cfg = options.config
    ? normalizeClientRecoveryConfig(options.config) : CLIENT_RECOVERY;
  const errorLog = cfg.errorLogKey
    ? installErrorLog({ ...options, storageKey: cfg.errorLogKey, force: options.force })
    : null;
  const ladder = cfg.ladder
    ? installRecoveryLadder({ ...options, config: cfg, force: true })
    : null;
  const watchdog = cfg.frameWatchdogMs
    ? installFrameWatchdog({
      ...options, frameWatchdogMs: cfg.frameWatchdogMs, ladder,
    })
    : null;
  if (!errorLog && !ladder && !watchdog) {
    return Object.freeze({ installed: false, errorLog: null, ladder: null, watchdog: null, recoverReload: null });
  }
  const handle = {
    installed: true,
    config: cfg,
    errorLog,
    ladder,
    watchdog,
    recoverReload: ladder ? ladder.request : null,
    stop() { if (watchdog) watchdog.stop(); },
  };
  activeClientRecovery = handle;
  return handle;
}
