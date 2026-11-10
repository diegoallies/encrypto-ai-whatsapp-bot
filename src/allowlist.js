// Allowlist backed by the postgres `contacts` table. is_allowed=true rows
// drive a small in-memory pattern cache so per-message checks stay
// synchronous. Adds/removes write through to the DB.
//
// Patterns supported: exact JIDs and globs like `*@s.whatsapp.net`.
// A pattern is just a row whose `jid` column holds the pattern string.
//
// On first boot we migrate the legacy `.env ALLOWED_JIDS` list into the
// table; subsequent boots load from the table only.

import fs from 'node:fs';
import path from 'node:path';
import * as db from './db.js';

const ENV_FILE = path.resolve(process.cwd(), '.env');

function compilePattern(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (!s.includes('*')) return { raw: s, test: (jid) => jid === s };
  const re = new RegExp(
    '^' + s.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
  );
  return { raw: s, test: (jid) => re.test(jid) };
}

let patterns = [];
let loaded = false;

function envEntries() {
  return String(process.env.ALLOWED_JIDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function migrateFromEnvIfNeeded() {
  const r = await db.query(
    `SELECT COUNT(*)::int AS c FROM contacts WHERE is_allowed = TRUE`,
  ).catch(() => ({ rows: [{ c: 0 }] }));
  if (Number(r.rows[0]?.c) > 0) return;
  const entries = envEntries();
  if (entries.length === 0) return;
  for (const e of entries) {
    await db.setContactAllowed(e, true).catch(() => {});
  }
  console.log(`allowlist: migrated ${entries.length} entry/entries from .env ALLOWED_JIDS into postgres`);
}

export async function initAllowlist() {
  if (loaded) return;
  try {
    await migrateFromEnvIfNeeded();
    const jids = await db.listAllowedJids();
    patterns = jids.map(compilePattern).filter(Boolean);
    loaded = true;
  } catch (err) {
    console.error('allowlist: init failed', err?.message || err);
    // Fall back to the env list so the bot still runs.
    patterns = envEntries().map(compilePattern).filter(Boolean);
    loaded = true;
  }
}

// Force reload from postgres (call after adding contacts via psql/webui)
export async function reloadAllowlist() {
  try {
    const jids = await db.listAllowedJids();
    patterns = jids.map(compilePattern).filter(Boolean);
    console.log(`allowlist: reloaded ${patterns.length} entries from postgres`);
    return patterns.length;
  } catch (err) {
    console.error('allowlist: reload failed', err?.message || err);
    return -1;
  }
}

// Best-effort sync-warm at module import — bot's start() also awaits initAllowlist().
initAllowlist().catch(() => {});

function persistEnvMirror() {
  // Mirror the current set back to .env so legacy tools that still read
  // ALLOWED_JIDS keep seeing the latest list. Best-effort.
  let lines;
  try { lines = fs.readFileSync(ENV_FILE, 'utf-8').split('\n'); }
  catch { lines = ['ALLOWED_JIDS=']; }
  const next = patterns.map((p) => p.raw).join(',');
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^ALLOWED_JIDS=/.test(lines[i])) {
      lines[i] = `ALLOWED_JIDS=${next}`;
      found = true;
      break;
    }
  }
  if (!found) lines.unshift(`ALLOWED_JIDS=${next}`);
  try { fs.writeFileSync(ENV_FILE, lines.join('\n')); } catch {}
  process.env.ALLOWED_JIDS = next;
}

export function isAllowed(jid) {
  if (!jid) return false;
  if (patterns.length === 0) return false;
  return patterns.some((p) => p.test(jid));
}

export function allowlistSize() {
  return patterns.length;
}

export function listAllowed() {
  return patterns.map((p) => p.raw);
}

export function addAllowed(jid) {
  if (!jid) return false;
  const j = String(jid).trim();
  if (!j) return false;
  if (patterns.some((p) => p.raw === j)) return false;
  const compiled = compilePattern(j);
  if (!compiled) return false;
  patterns.push(compiled);
  db.setContactAllowed(j, true).catch((err) =>
    console.error('allowlist: db write failed', err?.message || err),
  );
  persistEnvMirror();
  return true;
}

export function removeAllowed(jid) {
  const before = patterns.length;
  patterns = patterns.filter((p) => p.raw !== jid);
  if (patterns.length === before) return false;
  // Don't delete the contact row — they may have human metadata. Just
  // flip the flag. For pattern-only rows the row is harmless to leave.
  db.setContactAllowed(jid, false).catch((err) =>
    console.error('allowlist: db write failed', err?.message || err),
  );
  persistEnvMirror();
  return true;
}

// Test-only helper.
export function createAllowlist(raw) {
  const compiled = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(compilePattern)
    .filter(Boolean);
  return {
    isAllowed: (jid) => Boolean(jid) && compiled.length > 0 && compiled.some((p) => p.test(jid)),
    size: () => compiled.length,
  };
}
