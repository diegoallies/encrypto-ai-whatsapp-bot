// Heartbeat plugin: Missed Relay Check
// Every 5 minutes, syncs wacli and checks for conversations with external
// contacts that weren't relayed to the owner. Alerts them of any slips.
//
// Owner identity is read from env so the repo stays generic:
//   OWNER_JID       the owner's WhatsApp JID (…@lid or …@s.whatsapp.net)
//   OWNER_PHONE_JID optional second JID for the same person

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execCb);
const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, '../../memory/missed-relay-state.json');

const FIVE_MINUTES = 5 * 60 * 1000;
const OWNER_JID = process.env.OWNER_JID || '';
const OWNER_PHONE_JID = process.env.OWNER_PHONE_JID || '';

// JIDs to ignore (system, bots, the owner)
const IGNORE_JIDS = new Set([
  OWNER_JID,
  OWNER_PHONE_JID,
  '0@s.whatsapp.net',
  'status@broadcast',
].filter(Boolean));

async function loadState() {
  try {
    const data = await readFile(STATE_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return { lastCheck: null, notifiedConvos: [] };
  }
}

async function saveState(state) {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function getRecentBotMessages(store) {
  // Get messages sent BY the bot (from me) in the last hour
  try {
    const { stdout } = await exec(
      `wacli --store ${JSON.stringify(store)} messages list --json --limit 100 2>/dev/null || echo "[]"`,
      { timeout: 30000 }
    );
    const messages = JSON.parse(stdout || '[]');
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    return messages.filter(m => {
      const ts = m.messageTimestamp ? m.messageTimestamp * 1000 : 0;
      return m.key?.fromMe && ts > oneHourAgo;
    });
  } catch {
    return [];
  }
}

async function getRecentOwnerMessages(store) {
  // Check what was sent TO the owner in the last hour
  if (!OWNER_JID) return [];
  try {
    const { stdout } = await exec(
      `wacli --store ${JSON.stringify(store)} messages list --chat ${OWNER_JID} --json --limit 50 2>/dev/null || echo "[]"`,
      { timeout: 30000 }
    );
    return JSON.parse(stdout || '[]');
  } catch {
    return [];
  }
}

export default {
  name: 'missed-relay-check',
  intervalMs: FIVE_MINUTES,
  async run({ send }) {
    const store = process.env.WACLI_STORE;
    if (!store) return null;

    const state = await loadState();

    const botMessages = await getRecentBotMessages(store);

    const externalChats = new Map();
    for (const msg of botMessages) {
      const jid = msg.key?.remoteJid;
      if (!jid || IGNORE_JIDS.has(jid) || jid.endsWith('@g.us')) continue;
      if (!externalChats.has(jid)) externalChats.set(jid, []);
      externalChats.get(jid).push(msg);
    }

    if (externalChats.size === 0) {
      state.lastCheck = new Date().toISOString();
      await saveState(state);
      return null;
    }

    const ownerMessages = await getRecentOwnerMessages(store);
    const ownerMsgTexts = ownerMessages
      .map(m => m.message?.conversation || m.message?.extendedTextMessage?.text || '')
      .join(' ')
      .toLowerCase();

    const missedRelays = [];
    for (const [jid, msgs] of externalChats) {
      if (state.notifiedConvos.includes(jid)) continue;
      const contactId = jid.replace(/@.*/, '');
      const wasRelayed = ownerMsgTexts.includes(contactId) ||
                         ownerMsgTexts.includes('message from') ||
                         ownerMsgTexts.includes(jid);
      if (!wasRelayed && msgs.length > 0) {
        const lastMsg = msgs[0];
        const preview = lastMsg.message?.conversation ||
                       lastMsg.message?.extendedTextMessage?.text ||
                       '[media/other]';
        missedRelays.push({ jid, contactId, msgCount: msgs.length, preview: preview.slice(0, 50) });
        state.notifiedConvos.push(jid);
      }
    }

    if (state.notifiedConvos.length > 50) {
      state.notifiedConvos = state.notifiedConvos.slice(-50);
    }

    state.lastCheck = new Date().toISOString();
    await saveState(state);

    if (missedRelays.length === 0) return null;

    const lines = ['Heads up - I had convos with these contacts but may not have updated you:'];
    for (const r of missedRelays) {
      lines.push(`- ${r.contactId}: ${r.msgCount} msg(s) - "${r.preview}..."`);
    }
    lines.push('\nLet me know if you need details on any of these.');
    return lines.join('\n');
  }
};
