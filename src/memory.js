// Persistent memory primitives:
//
//   1. MEMORY.md          curated long-term notes; sections injected into the
//                         system prompt by claude-agent.js (Critical lessons +
//                         Open threads). Editable per-section at /memory.
//   2. memory/YYYY-MM-DD.md  bot actions log (restart, allow, saved, etc).
//                         Rx/tx are NOT logged here anymore — chat history lives
//                         in the Postgres `messages` table (see db.js).
//   3. memory/heartbeat-state.json  counters / lastChecks.
//   4. data/chats/<jid>.jsonl  legacy safety mirror for chat history. The DB
//                         is the read source; this is a JSONL fallback.
//
// All paths are relative to the repo root (process.cwd()).

import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicAppend } from './atomic-write.js';

const MEMORY_DIR = 'memory';
const STATE_FILE = path.join(MEMORY_DIR, 'heartbeat-state.json');
const CHATS_DIR = path.join('data', 'chats');
const LONG_TERM = 'MEMORY.md';

const SEED_LONG_TERM = `# MEMORY.md — long-term notes

This file is Encrypto AI's persistent scratchpad. Edit freely.

## About the user
- the owner — owner, primary WhatsApp contact.

## Open threads
_(empty)_

## Done
_(empty)_
`;

function dayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isoLocal(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true }).catch(() => {});
}

export async function ensureMemoryLayout() {
  await ensureDir(MEMORY_DIR);
  await ensureDir(CHATS_DIR);
  try {
    await fs.access(LONG_TERM);
  } catch {
    await fs.writeFile(LONG_TERM, SEED_LONG_TERM);
  }
  try {
    await fs.access(STATE_FILE);
  } catch {
    await fs.writeFile(STATE_FILE, JSON.stringify({ counters: {}, lastChecks: {} }, null, 2));
  }
}

export function dailyNotePath(d = new Date()) {
  return path.join(MEMORY_DIR, `${dayKey(d)}.md`);
}

export async function appendDailyNote(line, d = new Date()) {
  await ensureDir(MEMORY_DIR);
  const file = dailyNotePath(d);
  let header = '';
  try {
    await fs.access(file);
  } catch {
    header = `# ${dayKey(d)}\n\n`;
  }
  await atomicAppend(file, `${header}- ${isoLocal(d)}  ${line}\n`);
}

export async function appendChat(jid, role, text, meta = {}) {
  if (!jid) return;
  await ensureDir(CHATS_DIR);
  const file = path.join(CHATS_DIR, `${jid.replace(/[^\w@.-]/g, '_')}.jsonl`);
  const entry = { t: new Date().toISOString(), role, text, ...meta };
  await atomicAppend(file, `${JSON.stringify(entry)}\n`);
  // Mirror to Postgres. JSONL stays as the safety net; DB failure must not break message logging.
  try {
    const { appendMessage } = await import('./db.js');
    await appendMessage(jid, role, text, meta);
  } catch (err) {
    console.error('[memory] DB mirror failed:', err.message);
  }
  // Notify any /chats/:jid SSE subscribers so the web UI updates live.
  try {
    const { publish } = await import('./chat-events.js');
    publish(jid, { jid, role, content: text, created_at: entry.t, ...meta });
  } catch { /* non-fatal */ }
}

// ─── state (counters + lastChecks) ───────────────────────────────────────────
// Stored in Postgres app_state under key 'heartbeat_state'. The legacy
// memory/heartbeat-state.json is migrated on first read.
// All mutations are serialised through writeChain so concurrent callers
// can't trample each other.

const STATE_KEY = 'heartbeat_state';
let writeChain = Promise.resolve();
let stateMigrated = false;

async function migrateLegacyStateIfNeeded() {
  if (stateMigrated) return;
  stateMigrated = true;
  try {
    const { getAppState, setAppState } = await import('./db.js');
    const existing = await getAppState(STATE_KEY).catch(() => null);
    if (existing) return;
    const text = await fs.readFile(STATE_FILE, 'utf-8').catch(() => null);
    if (!text) return;
    let parsed;
    try { parsed = JSON.parse(text); } catch { return; }
    if (!parsed || typeof parsed !== 'object') return;
    await setAppState(STATE_KEY, parsed);
    await fs.rename(STATE_FILE, `${STATE_FILE}.imported-${Date.now()}`).catch(() => {});
    console.log(`memory: migrated ${STATE_FILE} to postgres`);
  } catch (err) {
    console.error('memory: heartbeat-state migration failed', err?.message || err);
  }
}

export async function getState() {
  try {
    await migrateLegacyStateIfNeeded();
    const { getAppState } = await import('./db.js');
    const v = await getAppState(STATE_KEY);
    if (v && typeof v === 'object') {
      v.counters ||= {};
      v.lastChecks ||= {};
      return v;
    }
  } catch (err) {
    console.error('memory: getState DB read failed', err?.message || err);
  }
  return { counters: {}, lastChecks: {} };
}

export function updateState(mutator) {
  const next = writeChain.then(async () => {
    const state = await getState();
    state.counters ||= {};
    state.lastChecks ||= {};
    const updated = (await mutator(state)) || state;
    const { setAppState } = await import('./db.js');
    await setAppState(STATE_KEY, updated);
    return updated;
  });
  writeChain = next.catch(() => {});
  return next;
}

// Counters auto-reset when crossing a day boundary (local time).
export function incrementCounter(name, by = 1) {
  return updateState((state) => {
    const today = dayKey();
    const c = state.counters[name] || { value: 0, day: today };
    if (c.day !== today) {
      c.value = 0;
      c.day = today;
    }
    c.value += by;
    state.counters[name] = c;
    return state;
  });
}

export async function getCounter(name) {
  const state = await getState();
  const today = dayKey();
  const c = state.counters?.[name];
  if (!c) return 0;
  if (c.day !== today) return 0;
  return c.value;
}

export function setLastCheck(name, ts = new Date().toISOString()) {
  return updateState((state) => {
    state.lastChecks[name] = ts;
    return state;
  });
}

export async function getLastCheck(name) {
  const state = await getState();
  return state.lastChecks?.[name] || null;
}

// Parse the "Open threads" section out of MEMORY.md so the dashboard can
// surface paused tasks. Returns an array of trimmed bullet lines. Returns
// an empty array if the section is missing, empty, or contains the seed
// "_(empty)_" marker.
export async function getOpenThreads() {
  let raw;
  try {
    raw = await fs.readFile(LONG_TERM, 'utf-8');
  } catch {
    return [];
  }
  const lines = raw.split('\n');
  let inSection = false;
  const items = [];
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (inSection) break;
      if (/^##\s+Open threads\b/i.test(line)) inSection = true;
      continue;
    }
    if (!inSection) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^_?\(?empty\)?_?$/i.test(trimmed)) continue;
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      items.push(trimmed.slice(2).trim());
    } else if (items.length > 0) {
      items[items.length - 1] += ' ' + trimmed;
    }
  }
  return items;
}

export { dayKey, isoLocal };
