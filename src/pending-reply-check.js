// pending-reply-check.js - Heartbeat plugin to notify the owner when pending replies come in
//
// Every 10 minutes, check if anyone we're tracking has replied.
// If so, send the owner a summary and remove from tracking.

import fs from 'node:fs';
import path from 'node:path';
import { loadPending, removePending, markNotified, cleanup } from './pending-replies.js';

const TEN_MINUTES = 10 * 60 * 1000;

// Map JID patterns for matching (phone@s.whatsapp.net vs @lid)
function jidToPhone(jid) {
  return jid.replace(/@.*$/, '');
}

// Find chat files that might match a JID (could be @s.whatsapp.net or @lid)
function findChatFile(jid) {
  const chatsDir = path.resolve('data', 'chats');
  const phone = jidToPhone(jid);

  try {
    const files = fs.readdirSync(chatsDir);

    // First try exact match
    const exact = files.find(f => f.startsWith(jid));
    if (exact) return path.join(chatsDir, exact);

    // Try phone number match for @lid files
    for (const f of files) {
      if (f.endsWith('.jsonl')) {
        // Read last few lines to see if this chat involves this phone
        const content = fs.readFileSync(path.join(chatsDir, f), 'utf-8');
        // Check if any message mentions this phone in the file name or content
        if (content.includes(phone)) {
          return path.join(chatsDir, f);
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

// Check if there are new messages from a JID since askedAt
function hasReplySince(jid, askedAt) {
  const chatsDir = path.resolve('data', 'chats');
  const phone = jidToPhone(jid);
  const askedTime = new Date(askedAt).getTime();

  try {
    const files = fs.readdirSync(chatsDir);

    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;

      const filePath = path.join(chatsDir, f);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');

      // Check last 20 messages
      const recent = lines.slice(-20);
      for (const line of recent) {
        try {
          const msg = JSON.parse(line);
          if (msg.role !== 'user') continue;

          const msgTime = new Date(msg.t).getTime();
          if (msgTime <= askedTime) continue;

          // Check if this file could be from the person we're tracking
          // (either the filename contains their phone, or it's an @lid file
          // and the conversation context suggests it's them)
          const filePhone = f.replace(/@.*$/, '').replace('.jsonl', '');

          if (filePhone === phone || f.includes(phone)) {
            return { replied: true, text: msg.text?.slice(0, 200), at: msg.t };
          }
        } catch {}
      }
    }

    return { replied: false };
  } catch {
    return { replied: false };
  }
}

// Get label for a JID from contacts
async function getLabel(jid) {
  try {
    const { Pool } = await import('pg');
    const pool = new Pool({
      host: process.env.PG_HOST || 'localhost',
      port: Number(process.env.PG_PORT) || 5432,
      database: process.env.PG_DATABASE || 'encrypto_bot',
      user: process.env.PG_USER || 'encrypto',
      password: process.env.PG_PASSWORD,
    });

    const phone = jidToPhone(jid);
    const res = await pool.query(
      'SELECT label, name FROM contacts WHERE jid = $1 OR phone = $2 LIMIT 1',
      [jid, phone]
    );
    await pool.end();

    if (res.rows[0]) {
      return res.rows[0].label || res.rows[0].name || phone;
    }
    return phone;
  } catch {
    return jidToPhone(jid);
  }
}

export const pendingReplyPlugin = {
  name: 'pending-reply-check',
  intervalMs: TEN_MINUTES,

  async run({ send }) {
    // Cleanup old entries first
    cleanup();

    const pending = loadPending();
    if (pending.length === 0) return;

    const notifications = [];

    for (const entry of pending) {
      // Skip if already notified
      if (entry.notifiedAt) continue;

      const result = hasReplySince(entry.jid, entry.askedAt);
      if (result.replied) {
        const label = await getLabel(entry.jid);
        notifications.push({
          label,
          topic: entry.topic,
          preview: result.text,
          jid: entry.jid,
        });
        markNotified(entry.jid);
      }
    }

    if (notifications.length === 0) return;

    // Build notification message
    const lines = ['📩 **Pending reply update:**', ''];
    for (const n of notifications) {
      lines.push(`**${n.label}** replied (re: ${n.topic}):`);
      lines.push(`> ${n.preview || '[no text]'}`);
      lines.push('');
    }

    return lines.join('\n').trim();
  },
};
