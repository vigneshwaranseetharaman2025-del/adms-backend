const engine = require('./engine');
const { setNudge } = require('./triggers');

/**
 * In-process background worker. All state lives in PostgreSQL, so:
 *  - nothing depends on a browser being open,
 *  - a restart resumes exactly where it stopped (expired locks are reclaimed),
 *  - several API instances can run this safely (rows are claimed with SKIP LOCKED).
 * Set AUTOMATION_WORKER_ENABLED=false on instances that should not run jobs.
 */
const INTERVAL_MS = Math.max(2000, parseInt(process.env.AUTOMATION_TICK_MS || '15000', 10));

const state = {
  enabled: false,
  running: false,
  startedAt: null,
  lastTickAt: null,
  lastTickMs: null,
  lastError: null,
  ticks: 0,
  lastResult: null,
};
let timer = null;
let pendingNudge = null;
let current = null; // promise of the tick in progress

const runTick = async () => {
  state.running = true;
  const started = Date.now();
  try {
    const result = {
      scheduledTriggers: await engine.processScheduledTriggers(),
      scheduledEmails: await engine.processScheduledEmails(),
      enrollments: 0,
      emails: 0,
    };
    // Drain in a few rounds so a burst (e.g. bulk registration) does not wait a full interval.
    for (let round = 0; round < 5; round += 1) {
      const enrollments = await engine.processEnrollments();
      const emails = await engine.processEmailQueue();
      result.enrollments += enrollments;
      result.emails += emails;
      if (!enrollments && !emails) break;
    }
    state.lastResult = result;
    state.lastError = null;
  } catch (error) {
    state.lastError = error.message;
    console.error('[automation] scheduler tick failed:', error.message);
  } finally {
    state.ticks += 1;
    state.lastTickAt = new Date();
    state.lastTickMs = Date.now() - started;
    state.running = false;
  }
};

/**
 * Ticks never overlap. If one is in progress, the caller waits for it and then
 * gets a fresh tick, so "Run now" always processes work that is due right now.
 */
const tick = async () => {
  while (current) await current;
  current = runTick().finally(() => { current = null; });
  return current;
};

/** Runs a tick soon (debounced) — used right after a trigger enrolls someone. */
const nudge = () => {
  if (!state.enabled || pendingNudge) return;
  pendingNudge = setTimeout(() => { pendingNudge = null; void tick(); }, 500);
};

const start = () => {
  if (String(process.env.AUTOMATION_WORKER_ENABLED || 'true').toLowerCase() === 'false') {
    console.log('[automation] worker disabled on this instance (AUTOMATION_WORKER_ENABLED=false).');
    return;
  }
  if (timer) return;
  state.enabled = true;
  state.startedAt = new Date();
  setNudge(nudge);
  timer = setInterval(() => { void tick(); }, INTERVAL_MS);
  void tick();
  console.log(`[automation] worker ${engine.WORKER_ID} started, tick every ${INTERVAL_MS / 1000}s.`);
};

const stop = () => {
  if (timer) clearInterval(timer);
  if (pendingNudge) clearTimeout(pendingNudge);
  timer = null;
  pendingNudge = null;
  state.enabled = false;
};

const getStatus = () => ({ ...state, intervalMs: INTERVAL_MS, workerId: engine.WORKER_ID });

module.exports = { start, stop, tick, nudge, getStatus };
