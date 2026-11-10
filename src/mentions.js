// Build WhatsApp mention metadata for outgoing group messages.
//
// WhatsApp only renders a tappable "@Name" mention when TWO things line up:
//   1. the message text contains "@<number>", and
//   2. the send call passes that person's full JID in contextInfo.mentionedJid,
//      whose user-part equals the <number> in the text.
//
// This group (and Baileys v7 groups generally) is LID-addressed: participants
// are identified by "@lid" JIDs, and the numbers we type when tagging
// (e.g. 123454623854799) ARE the LID user-parts we see on incoming messages
// (msg.key.participant). So the correct mention JID for a typed token is
// simply "<token>@lid".
//
// We still consult groupMetadata when we can — a phone-addressed group needs
// "<num>@s.whatsapp.net" instead — but we fall back to the @lid form (which is
// what actually renders in these LID groups) whenever metadata doesn't resolve
// the token. Every call appends a line to data/mentions-debug.log so we can
// see tokens vs participants vs the JIDs we emitted.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEBUG_LOG = path.join(ROOT, 'data', 'mentions-debug.log');

const metaCache = new Map(); // jid -> { at, participants: [fullJid...] }
const TTL_MS = 5 * 60_000;

function isGroup(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

// The user portion of a JID, stripped of device suffix (":12") and domain.
function userPart(jid) {
  return String(jid).split('@')[0].split(':')[0];
}

function debug(line) {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()}  ${line}\n`);
  } catch {}
}

async function participantsFor(sock, jid) {
  const cached = metaCache.get(jid);
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.participants;
  try {
    const meta = await sock.groupMetadata(jid);
    const participants = (meta?.participants || [])
      // v7 participants can carry id / jid / lid / phoneNumber — keep them all
      // so a typed token matches whichever representation the group uses.
      .flatMap((p) => [p.id, p.jid, p.lid, p.phoneNumber])
      .filter(Boolean);
    metaCache.set(jid, { at: now, participants });
    return participants;
  } catch (err) {
    debug(`groupMetadata FAILED for ${jid}: ${err.message}`);
    return cached?.participants || [];
  }
}

/**
 * Given an outgoing chunk of text and the chat JID, return sendMessage options
 * carrying a `mentions` array for any @<number> tokens. Returns {} for
 * non-groups or when there are no taggable tokens, so callers can spread it
 * unconditionally.
 *
 * @param {object} sock - Baileys socket
 * @param {string} jid - chat JID
 * @param {string} text - the exact text being sent in this chunk
 * @returns {Promise<{mentions?: string[]}>}
 */
export async function buildMentions(sock, jid, text) {
  if (!isGroup(jid) || !text) return {};
  const tokens = text.match(/@(\d{5,})/g);
  if (!tokens) return {};
  const wanted = [...new Set(tokens.map((t) => t.slice(1)))]; // strip '@', dedupe

  const participants = await participantsFor(sock, jid);
  const byUser = new Map();
  for (const p of participants) byUser.set(userPart(p), p);

  const mentions = [];
  for (const num of wanted) {
    const matched = byUser.get(num);
    if (matched) {
      mentions.push(matched);
    } else if (num.length >= 11) {
      // No metadata match — treat the token as a LID user-part (that's what it
      // is in these groups) and emit the @lid form, which is what renders.
      mentions.push(`${num}@lid`);
    }
  }

  debug(
    `jid=${jid} tokens=${JSON.stringify(wanted)} ` +
      `participants=${participants.length} ` +
      `sample=${JSON.stringify(participants.slice(0, 6))} ` +
      `emitted=${JSON.stringify(mentions)}`,
  );

  return mentions.length ? { mentions } : {};
}
