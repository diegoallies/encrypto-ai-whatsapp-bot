// In-memory scheduler backed by PostgreSQL. Jobs survive restarts. Other
// processes (e.g. scripts/cron.mjs) can also write to the DB; the bot polls
// a cheap fingerprint every 5s and reloads when something changed.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Cron } from 'croner';
import { parseDuration } from './cron-time.js';
import * as db from './db.js';

const POLL_MS = 5_000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const LEGACY_FILE = 'data/scheduled.json';

let jobs = [];
let timers = new Map();
let pollTimer = null;
let onFire = null;
let lastFingerprint = { maxMs: 0, count: -1 };

function clearTimers() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

async function loadFromDb() {
  jobs = await db.listScheduledJobs();
  lastFingerprint = await db.scheduledJobsFingerprint();
}

// One-shot migration: if the DB has no rows but data/scheduled.json exists
// with jobs, import them so we don't lose state.
async function migrateLegacyFileIfNeeded() {
  const fp = await db.scheduledJobsFingerprint();
  if (fp.count > 0) return;
  let text;
  try {
    text = await fs.readFile(LEGACY_FILE, 'utf-8');
  } catch {
    return;
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return; }
  if (!Array.isArray(parsed) || parsed.length === 0) return;
  console.log(`scheduler: migrating ${parsed.length} job(s) from ${LEGACY_FILE} into postgres`);
  for (const j of parsed) {
    if (!j?.id || !j?.jid || !j?.runAt || !j?.text) continue;
    await db.upsertScheduledJob(j);
  }
  // Move the old file out of the way so future boots don't re-migrate.
  const backup = `${LEGACY_FILE}.imported-${Date.now()}`;
  await fs.rename(LEGACY_FILE, backup).catch(() => {});
}

function rescheduleAll() {
  clearTimers();
  const now = Date.now();
  for (const job of [...jobs]) {
    if (job.paused) continue;
    const runAt = new Date(job.runAt).getTime();
    if (Number.isNaN(runAt)) continue;
    const delay = runAt - now;
    if (delay <= 0) {
      if (delay > -STALE_THRESHOLD_MS) {
        setImmediate(() => fire(job));
      } else {
        console.warn(`scheduler: skipping stale job ${job.id} (was due ${job.runAt})`);
        jobs = jobs.filter((j) => j.id !== job.id);
        db.deleteScheduledJob(job.id).catch(() => {});
      }
    } else if (delay < MAX_TIMEOUT_MS) {
      const t = setTimeout(() => fire(job), delay);
      t.unref();
      timers.set(job.id, t);
    }
    // delay >= MAX_TIMEOUT_MS: armed on the next reload
  }
}

function computeNextRunAt(job, from = new Date()) {
  if (!job.recurring) return null;
  if (job.recurring.every) {
    try {
      const ms = parseDuration(job.recurring.every);
      return new Date(from.getTime() + ms).toISOString();
    } catch {
      return null;
    }
  }
  if (job.recurring.cron) {
    try {
      const c = new Cron(job.recurring.cron, { paused: true });
      const next = c.nextRun(from);
      return next ? next.toISOString() : null;
    } catch {
      return null;
    }
  }
  return null;
}

// Guards against the same job firing twice (e.g. a poll-triggered reschedule
// re-arming a job while its first run is still awaiting onFire).
const inFlight = new Set();
const DUP_WINDOW_MS = 10 * 60 * 1000;

async function fire(job) {
  timers.delete(job.id);
  if (inFlight.has(job.id)) return;
  const current = jobs.find((j) => j.id === job.id);
  const last = current?.lastFiredAt ? new Date(current.lastFiredAt).getTime() : 0;
  if (job.recurring && last && Date.now() - last < DUP_WINDOW_MS) {
    console.warn(`scheduler: skipping duplicate fire of ${job.id} (last fired ${current.lastFiredAt})`);
    return;
  }
  inFlight.add(job.id);
  try {
    await fireInner(job);
  } finally {
    inFlight.delete(job.id);
  }
}

async function fireInner(job) {
  const firedAt = new Date().toISOString();
  if (job.recurring) {
    const next = computeNextRunAt(job, new Date());
    if (next) {
      const updated = { ...job, runAt: next, lastFiredAt: firedAt };
      jobs = jobs.map((j) => (j.id === job.id ? updated : j));
      await db.upsertScheduledJob(updated);
    } else {
      jobs = jobs.filter((j) => j.id !== job.id);
      await db.deleteScheduledJob(job.id);
    }
  } else {
    jobs = jobs.filter((j) => j.id !== job.id);
    await db.deleteScheduledJob(job.id);
  }

  let ok = true;
  let errMsg = null;
  if (onFire) {
    try {
      await onFire(job);
    } catch (err) {
      ok = false;
      errMsg = (err?.message || String(err)).slice(0, 200);
      console.error('scheduler: onFire threw', err);
    }
  }

  if (job.recurring) {
    const idx = jobs.findIndex((j) => j.id === job.id);
    if (idx !== -1) {
      const withStatus = { ...jobs[idx], lastFiredAt: firedAt, lastFireOk: ok, lastFireError: errMsg };
      jobs = jobs.map((j, i) => (i === idx ? withStatus : j));
      await db.upsertScheduledJob(withStatus);
    }
    rescheduleAll();
  }
  // After the fingerprint changed, sync our local view to stay in sync with other writers.
  lastFingerprint = await db.scheduledJobsFingerprint();
}

async function poll() {
  try {
    const fp = await db.scheduledJobsFingerprint();
    if (fp.maxMs === lastFingerprint.maxMs && fp.count === lastFingerprint.count) return;
    await loadFromDb();
    rescheduleAll();
  } catch (e) {
    console.error('scheduler: poll failed', e?.message || e);
  }
}

export async function initScheduler({ onFire: cb } = {}) {
  onFire = cb || null;
  await migrateLegacyFileIfNeeded();
  await loadFromDb();
  rescheduleAll();
  pollTimer = setInterval(() => poll(), POLL_MS);
  pollTimer.unref();
}

export function shutdownScheduler() {
  clearTimers();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

export async function addJob({ jid, runAt, mode = 'notify', text, recurring = null }) {
  if (!jid) throw new Error('jid required');
  if (!text) throw new Error('text required');
  if (!['notify', 'prompt'].includes(mode)) throw new Error(`invalid mode: ${mode}`);

  let effectiveRunAt = runAt;
  if (!effectiveRunAt && recurring) {
    const next = computeNextRunAt({ recurring }, new Date());
    if (!next) throw new Error('invalid recurrence (cannot compute first run)');
    effectiveRunAt = next;
  }
  if (!effectiveRunAt) throw new Error('runAt or recurring required');

  const job = {
    id: crypto.randomUUID().slice(0, 8),
    jid,
    runAt: new Date(effectiveRunAt).toISOString(),
    mode,
    text,
    createdAt: new Date().toISOString(),
    ...(recurring ? { recurring } : {}),
  };
  await db.upsertScheduledJob(job);
  jobs.push(job);
  rescheduleAll();
  lastFingerprint = await db.scheduledJobsFingerprint();
  return job;
}

export async function removeJob(id) {
  const before = jobs.length;
  jobs = jobs.filter((j) => j.id !== id);
  const ok = await db.deleteScheduledJob(id);
  if (!ok && jobs.length === before) return false;
  rescheduleAll();
  lastFingerprint = await db.scheduledJobsFingerprint();
  return true;
}

export async function removeJobs(ids) {
  if (!ids || ids.length === 0) return 0;
  const set = new Set(ids);
  jobs = jobs.filter((j) => !set.has(j.id));
  const removed = await db.deleteScheduledJobs(ids);
  if (removed === 0) return 0;
  rescheduleAll();
  lastFingerprint = await db.scheduledJobsFingerprint();
  return removed;
}

export async function fireNow(id) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return false;
  await fire({ ...job, paused: false });
  return true;
}

export async function setPaused(id, paused) {
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return false;
  const next = { ...jobs[idx], paused: Boolean(paused) };
  if (!paused && next.recurring) {
    const runAtTs = new Date(next.runAt).getTime();
    if (Number.isNaN(runAtTs) || runAtTs < Date.now()) {
      const recomputed = computeNextRunAt(next, new Date());
      if (recomputed) next.runAt = recomputed;
    }
  }
  jobs = jobs.map((j, i) => (i === idx ? next : j));
  await db.upsertScheduledJob(next);
  rescheduleAll();
  lastFingerprint = await db.scheduledJobsFingerprint();
  return next;
}

export async function updateJob(id, patch) {
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return false;
  const allowed = ['jid', 'text', 'mode', 'runAt', 'recurring'];
  const sanitized = {};
  for (const k of allowed) if (k in patch) sanitized[k] = patch[k];
  if (sanitized.mode && !['notify', 'prompt'].includes(sanitized.mode)) {
    throw new Error(`invalid mode: ${sanitized.mode}`);
  }
  if (sanitized.runAt) sanitized.runAt = new Date(sanitized.runAt).toISOString();
  if (sanitized.recurring && !sanitized.runAt) {
    const computed = computeNextRunAt({ recurring: sanitized.recurring }, new Date());
    if (computed) sanitized.runAt = computed;
  }
  const updated = { ...jobs[idx], ...sanitized };
  jobs = jobs.map((j, i) => (i === idx ? updated : j));
  await db.upsertScheduledJob(updated);
  rescheduleAll();
  lastFingerprint = await db.scheduledJobsFingerprint();
  return updated;
}

export function listJobs() {
  return [...jobs].sort((a, b) => a.runAt.localeCompare(b.runAt));
}

export function listJobsFor(jid) {
  return listJobs().filter((j) => j.jid === jid);
}

export function _resetForTest() {
  clearTimers();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  jobs = [];
  onFire = null;
  lastFingerprint = { maxMs: 0, count: -1 };
}

// Kept for backward-compat with tests that referenced the file-based impl.
export function _setFileForTest() {}
