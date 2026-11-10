// Persists Claude Agent SDK session IDs across bot restarts so we don't lose
// conversation context on every PM2 reload. Backed by postgres app_state
// (key prefix `session:`) with an in-memory mirror for sync reads at the
// call site. A one-shot migration imports data/sessions.json on first boot.

import fs from 'node:fs/promises';
import path from 'node:path';
import * as db from './db.js';
import { atomicWrite } from './atomic-write.js';

const LEGACY_FILE = path.join('data', 'sessions.json');
// Durable on-disk mirror. Postgres is primary, but if a DB write is lost (DB
// down, or crash right after replying) this file still has the session id so we
// don't lose conversation context. Written atomically on every change.
const MIRROR_FILE = path.join('data', 'sessions-mirror.json');
const KEY_PREFIX = 'session:';

const map = new Map();
let loaded = false;

function writeMirror() {
  const obj = Object.fromEntries(map);
  return atomicWrite(MIRROR_FILE, JSON.stringify(obj, null, 2)).catch(() => {});
}

async function readMirror() {
  try {
    const text = await fs.readFile(MIRROR_FILE, 'utf-8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function _setFileForTest() {
  // Kept for backward-compat with tests; the file path is no longer used.
  loaded = false;
  map.clear();
}

async function migrateLegacyFileIfNeeded() {
  // Only migrate if we have no session rows in the DB.
  const probe = await db.query(
    `SELECT 1 FROM app_state WHERE key LIKE 'session:%' LIMIT 1`,
  ).catch(() => ({ rows: [] }));
  if (probe.rows.length > 0) return;

  let text;
  try { text = await fs.readFile(LEGACY_FILE, 'utf-8'); }
  catch { return; }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return; }
  if (!parsed || typeof parsed !== 'object') return;
  let migrated = 0;
  for (const [jid, sid] of Object.entries(parsed)) {
    if (typeof sid !== 'string' || !sid) continue;
    await db.setAppState(`${KEY_PREFIX}${jid}`, { sessionId: sid });
    migrated++;
  }
  if (migrated > 0) {
    console.log(`sessions-store: migrated ${migrated} session(s) from ${LEGACY_FILE} to postgres`);
    await fs.rename(LEGACY_FILE, `${LEGACY_FILE}.imported-${Date.now()}`).catch(() => {});
  }
}

async function loadOnce() {
  if (loaded) return;
  loaded = true;
  try {
    await migrateLegacyFileIfNeeded();
    const r = await db.query(`SELECT key, value FROM app_state WHERE key LIKE 'session:%'`);
    for (const row of r.rows) {
      const jid = row.key.slice(KEY_PREFIX.length);
      const sid = row.value?.sessionId;
      if (typeof sid === 'string' && sid) map.set(jid, sid);
    }
  } catch (err) {
    console.error('sessions-store: load failed', err?.message || err);
  }
  // Fill in anything the DB is missing from the durable disk mirror (covers
  // lost DB writes / crashes). Write recovered entries back to the DB.
  try {
    const mirror = await readMirror();
    for (const [jid, sid] of Object.entries(mirror)) {
      if (typeof sid === 'string' && sid && !map.has(jid)) {
        map.set(jid, sid);
        db.setAppState(`${KEY_PREFIX}${jid}`, { sessionId: sid, recovered: true }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('sessions-store: mirror load failed', err?.message || err);
  }
}

// Fire-and-forget load on import. The bot also awaits ready() in start().
loadOnce().catch(() => {});

export function get(jid) {
  return map.get(jid);
}

export function set(jid, sessionId) {
  if (!jid || !sessionId) return;
  if (map.get(jid) === sessionId) return;
  map.set(jid, sessionId);
  // Durable disk mirror first (atomic), then the DB. Either alone is enough to
  // survive a restart; together they cover a DB outage or a crash-after-reply.
  writeMirror();
  db.setAppState(`${KEY_PREFIX}${jid}`, { sessionId, updatedAt: new Date().toISOString() })
    .catch((err) => console.error('sessions-store: write failed', err?.message || err));
}

export function del(jid) {
  if (!map.delete(jid)) return;
  writeMirror();
  db.query(`DELETE FROM app_state WHERE key = $1`, [`${KEY_PREFIX}${jid}`])
    .catch((err) => console.error('sessions-store: delete failed', err?.message || err));
}

export async function ready() {
  await loadOnce();
}

export function _reset() { map.clear(); loaded = false; }
export function _size() { return map.size; }
