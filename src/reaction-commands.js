// Incoming-reaction handlers. Acts on emoji reactions the owner adds to messages:
//
//   📌 / 📍  save the target message into MEMORY.md under "## Saved"
//   🔁 / 🔄  re-ask Claude about the target message
//   ❌ / 🗑️  remove the target message text from MEMORY.md
//
// Anything else (👍 ❤️ 😂 …) is ignored so casual reactions don't trigger.
// Un-reactions (empty text) are ignored.

import { promises as fs } from 'node:fs';
import { appendDailyNote } from './memory.js';
import { getMessageByMsgId } from './db.js';

const SAVE = ['📌', '📍'];
const ASK = ['🔁', '🔄'];
const FORGET = ['❌', '🗑️', '🗑'];
const INBOX = ['🔖', '📝'];

const MEMORY_FILE = 'MEMORY.md';

// Look up a message we previously logged by its WhatsApp msgId. Reads from
// the Postgres `messages` table; reactions only work on bot-logged messages.
async function lookupTarget(chatJid, msgId) {
  const row = await getMessageByMsgId(chatJid, msgId).catch(() => null);
  if (!row) return null;
  // Shape match against the old JSONL entry the rest of this file expects.
  return { role: row.role, text: row.content, msgId: row.msg_id };
}

async function appendToMemorySection(section, line) {
  let body = '';
  try { body = await fs.readFile(MEMORY_FILE, 'utf-8'); } catch {}
  const header = `## ${section}`;
  if (!body.includes(header)) {
    body = body.trimEnd() + `\n\n${header}\n`;
  }
  const lines = body.split('\n');
  let hdrIdx = lines.findIndex((l) => l.trim() === header);
  // Insert just after the header (or at the start of the section's content).
  if (hdrIdx < 0) hdrIdx = lines.length - 1;
  lines.splice(hdrIdx + 1, 0, line);
  await fs.writeFile(MEMORY_FILE, lines.join('\n'));
}

async function removeFromMemoryByNeedle(needle) {
  let body = '';
  try { body = await fs.readFile(MEMORY_FILE, 'utf-8'); } catch { return false; }
  const n = needle.slice(0, 60);
  const lines = body.split('\n');
  const kept = lines.filter((l) => !l.includes(n));
  if (kept.length === lines.length) return false;
  await fs.writeFile(MEMORY_FILE, kept.join('\n'));
  return true;
}

// Returns true if the reaction was recognised and handled.
export async function handleReaction({ sock, msg, agent }) {
  const r = msg?.message?.reactionMessage;
  if (!r) return false;
  const emoji = r.text || '';
  if (!emoji) return false; // un-reaction
  const targetJid = msg.key?.remoteJid;
  const targetId = r.key?.id;
  if (!targetJid || !targetId) return false;

  const target = await lookupTarget(targetJid, targetId);
  if (!target) {
    // Older than the bot, or never logged. Quietly do nothing.
    return false;
  }

  const targetText = target.text || '';
  if (!targetText.trim()) return false;

  if (SAVE.includes(emoji)) {
    const role = target.role === 'assistant' ? 'bot' : 'user';
    const date = new Date().toISOString().slice(0, 10);
    const oneLine = targetText.replace(/\s+/g, ' ').slice(0, 240);
    await appendToMemorySection('Saved', `- ${date} (${role}): ${oneLine}`);
    appendDailyNote(`saved via 📌 reaction: ${oneLine.slice(0, 100)}`).catch(() => {});
    await sock.sendMessage(targetJid, { text: `📌 Saved to memory.` }).catch(() => {});
    return true;
  }

  if (ASK.includes(emoji)) {
    const prompt = `the owner just reacted 🔁 to this earlier message — handle it now:\n\n"${targetText.slice(0, 1500)}"`;
    try {
      const result = await agent.askClaude(targetJid, prompt);
      const reply = typeof result === 'string' ? result : result?.text || '(no reply)';
      // Send the reply — handler.js handles streaming, but we're outside it
      // here, so just send the assembled text in one go.
      await sock.sendMessage(targetJid, { text: reply });
    } catch (err) {
      await sock.sendMessage(targetJid, { text: `Couldn't re-process: ${err.message}` }).catch(() => {});
    }
    return true;
  }

  if (FORGET.includes(emoji)) {
    const removed = await removeFromMemoryByNeedle(targetText);
    await sock.sendMessage(targetJid, {
      text: removed ? '🗑️ Removed from memory.' : 'Nothing matching to forget.',
    }).catch(() => {});
    return true;
  }

  if (INBOX.includes(emoji)) {
    // Free-form quick-capture — append verbatim to inbox.md (no curation,
    // no MEMORY.md section). For things you want to think about later.
    const ts = new Date().toISOString();
    const line = `\n- ${ts.slice(0, 16).replace('T', ' ')}  ${targetText.replace(/\s+/g, ' ').slice(0, 500)}\n`;
    try {
      const fs = await import('node:fs/promises');
      await fs.appendFile('inbox.md', line);
      appendDailyNote(`inbox capture via 🔖: ${targetText.slice(0, 100)}`).catch(() => {});
      await sock.sendMessage(targetJid, { text: '🔖 Captured to inbox.md.' }).catch(() => {});
    } catch (err) {
      await sock.sendMessage(targetJid, { text: `Inbox capture failed: ${err.message}` }).catch(() => {});
    }
    return true;
  }

  return false; // unknown emoji — let normal flow ignore it
}
