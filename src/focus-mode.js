// Owner-priority focus mode. When the owner says one of the trigger phrases
// ("stop", "drop everything", "focus on me", "full attention", etc.), the
// bot enters focus mode for FOCUS_TTL_MS — during which non-owner messages
// are silently queued/dropped so Claude isn't busy with other chats while
// the owner needs it.
//
// Owner can end focus with "resume", "back to normal", or wait for the TTL.

import fs from 'node:fs/promises';
import path from 'node:path';
import { getAppState, setAppState } from './db.js';

const LEGACY_FILE = path.join('memory', 'focus-state.json');
const STATE_KEY = 'focus_state';
const TTL_MS = Number(process.env.FOCUS_TTL_MS) || 30 * 60_000; // 30 min default

let cached = null;
let writeChain = Promise.resolve();

async function migrateLegacyIfNeeded() {
  const existing = await getAppState(STATE_KEY).catch(() => null);
  if (existing) return;
  try {
    const t = await fs.readFile(LEGACY_FILE, 'utf-8');
    const parsed = JSON.parse(t);
    if (parsed && typeof parsed === 'object') {
      await setAppState(STATE_KEY, parsed);
      await fs.rename(LEGACY_FILE, `${LEGACY_FILE}.imported-${Date.now()}`).catch(() => {});
      console.log(`focus-mode: migrated ${LEGACY_FILE} to postgres`);
    }
  } catch { /* no legacy file, fine */ }
}

async function load() {
  if (cached) return cached;
  await migrateLegacyIfNeeded();
  const v = await getAppState(STATE_KEY).catch(() => null);
  cached = v && typeof v === 'object'
    ? v
    : { activeUntil: 0, reason: null, ownerJid: null };
  return cached;
}

function persist() {
  writeChain = writeChain.then(() => setAppState(STATE_KEY, cached)).catch((err) => {
    console.error('focus-mode: persist failed', err?.message || err);
  });
  return writeChain;
}

// Trigger / release phrase detection. Loose: anchored at message start,
// case-insensitive, allows light punctuation around the phrase.
const TRIGGER = /^\s*(stop|drop everything|focus on me|focus|full attention|pause everything|just (you|focus) and me|stop what you'?re doing)\b/i;
const RELEASE = /^\s*(resume|back to normal|carry on|ok continue|done|unpause)\b/i;

export function detectTrigger(text) {
  if (!text) return null;
  if (TRIGGER.test(text)) return 'enter';
  if (RELEASE.test(text)) return 'exit';
  return null;
}

export async function enter({ ownerJid, reason = null }) {
  cached = { activeUntil: Date.now() + TTL_MS, reason, ownerJid };
  await persist();
  return cached;
}

export async function exit() {
  cached = { activeUntil: 0, reason: null, ownerJid: null };
  await persist();
}

export async function isActive() {
  const s = await load();
  if (!s.activeUntil) return false;
  if (Date.now() > s.activeUntil) {
    cached = { activeUntil: 0, reason: null, ownerJid: null };
    persist().catch(() => {});
    return false;
  }
  return true;
}

export async function status() {
  const s = await load();
  const active = await isActive();
  return {
    active,
    activeUntil: s.activeUntil,
    ownerJid: s.ownerJid,
    reason: s.reason,
    remainingMs: active ? s.activeUntil - Date.now() : 0,
  };
}
