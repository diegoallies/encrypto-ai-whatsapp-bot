// Group-chat behaviour. By default, in groups the bot stays silent unless
// it's @-mentioned or the message quotes a bot message. the owner can toggle a
// chat into "awake" mode via /wake (replies to everything) and back with
// /sleep. State persists in memory/group-modes.json.

import fs from 'node:fs/promises';
import path from 'node:path';
import { isGroup } from './parse.js';
import { getAppState, setAppState } from './db.js';

const LEGACY_FILE = path.join('memory', 'group-modes.json');
const STATE_KEY = 'group_modes';

let state = null;
let writeChain = Promise.resolve();

async function migrateLegacyIfNeeded() {
  const existing = await getAppState(STATE_KEY).catch(() => null);
  if (existing) return;
  try {
    const text = await fs.readFile(LEGACY_FILE, 'utf-8');
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.awakeJids)) {
      await setAppState(STATE_KEY, parsed);
      await fs.rename(LEGACY_FILE, `${LEGACY_FILE}.imported-${Date.now()}`).catch(() => {});
      console.log(`group-mode: migrated ${LEGACY_FILE} to postgres`);
    }
  } catch { /* no legacy file, fine */ }
}

async function load() {
  if (state) return state;
  await migrateLegacyIfNeeded();
  const v = await getAppState(STATE_KEY).catch(() => null);
  state = v && Array.isArray(v.awakeJids) ? v : { awakeJids: [] };
  return state;
}

function persist() {
  writeChain = writeChain.then(() => setAppState(STATE_KEY, state)).catch((err) => {
    console.error('group-mode: persist failed', err?.message || err);
  });
  return writeChain;
}

export async function isAwake(jid) {
  const s = await load();
  return s.awakeJids.includes(jid);
}

export async function setAwake(jid, awake) {
  const s = await load();
  const has = s.awakeJids.includes(jid);
  if (awake && !has) s.awakeJids.push(jid);
  else if (!awake && has) s.awakeJids = s.awakeJids.filter((j) => j !== jid);
  else return false;
  await persist();
  return true;
}

// Extract the list of JIDs mentioned in an incoming message (Baileys parks
// these on the contextInfo of extendedTextMessage / image / video, etc).
function mentionedJids(msg) {
  const m = msg?.message;
  if (!m) return [];
  const ctx =
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    null;
  return ctx?.mentionedJid || [];
}

// True if the incoming group message looks like it's directed at the bot:
// either it @-mentions the bot's own number/LID, or it quotes a bot message.
export function isAddressedToBot(msg, ownNumber, ownLid) {
  if (!ownNumber) return false;
  const own = String(ownNumber);
  const lid = ownLid ? String(ownLid) : null;

  const isOwnId = (id) => {
    const s = String(id || '');
    if (!s) return false;
    if (s.startsWith(own)) return true;
    if (lid && s.startsWith(lid)) return true;
    return false;
  };

  // 1. Explicit @-mention of the bot → always respond.
  const mentions = mentionedJids(msg);
  for (const m of mentions) {
    if (isOwnId(m)) return true;
  }

  // 2. Reply that quotes one of the bot's own messages → respond ONLY if the
  //    message isn't also @-mentioning someone else. People often reply to the
  //    bot's message while tagging another person; that's directed at THAT
  //    person, not the bot, so the bot must stay out of it. (This was the
  //    "replying when not mentioned" bug.)
  const ctx = msg?.message?.extendedTextMessage?.contextInfo;
  const qStanza = ctx?.stanzaId;
  if (qStanza && ctx?.participant && isOwnId(ctx.participant)) {
    const mentionsSomeoneElse = mentions.some((m) => !isOwnId(m));
    if (!mentionsSomeoneElse) return true;
  }

  return false;
}

// Decide whether to engage Claude on a group message. Always true for DMs.
export async function shouldRespond(msg, ownNumber, ownLid) {
  const jid = msg?.key?.remoteJid;
  if (!jid) return false;
  if (!isGroup(jid)) return true; // DMs always
  if (await isAwake(jid)) return true; // /wake'd
  return isAddressedToBot(msg, ownNumber, ownLid);
}
