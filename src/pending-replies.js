// pending-replies.js - Track outbound messages that expect replies
//
// When the owner asks me to message someone, log it here. When they reply,
// notify the owner with a summary. Heartbeat checks every 10 min.

import fs from 'node:fs';
import path from 'node:path';

const PENDING_FILE = path.resolve('memory', 'pending-replies.json');

// Ensure file exists
function ensureFile() {
  try {
    if (!fs.existsSync(PENDING_FILE)) {
      fs.writeFileSync(PENDING_FILE, '[]', 'utf-8');
    }
  } catch {}
}

/**
 * Load pending replies from disk
 * @returns {Array<{jid: string, topic: string, askedAt: string, notifiedAt?: string}>}
 */
export function loadPending() {
  ensureFile();
  try {
    const raw = fs.readFileSync(PENDING_FILE, 'utf-8');
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
}

/**
 * Save pending replies to disk
 */
function savePending(entries) {
  ensureFile();
  try {
    fs.writeFileSync(PENDING_FILE, JSON.stringify(entries, null, 2), 'utf-8');
  } catch (err) {
    console.error('pending-replies: save error', err.message);
  }
}

/**
 * Add a pending reply expectation
 * @param {string} jid - The JID we messaged
 * @param {string} topic - What we asked about (for context in notification)
 */
export function addPending(jid, topic) {
  const entries = loadPending();

  // Normalize JID - strip @s.whatsapp.net or @lid for comparison
  const normalizedJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;

  // Don't duplicate - update topic if already pending
  const existing = entries.findIndex(e => e.jid === normalizedJid);
  if (existing >= 0) {
    entries[existing].topic = topic;
    entries[existing].askedAt = new Date().toISOString();
  } else {
    entries.push({
      jid: normalizedJid,
      topic,
      askedAt: new Date().toISOString(),
    });
  }

  savePending(entries);
  console.log(`pending-replies: added ${normalizedJid} - "${topic}"`);
}

/**
 * Check if a JID has a pending reply we're waiting for
 * @param {string} jid - The JID to check (can be @s.whatsapp.net or @lid)
 * @returns {{jid: string, topic: string, askedAt: string} | null}
 */
export function getPending(jid) {
  const entries = loadPending();

  // Need to match both @s.whatsapp.net and @lid versions
  // Extract the phone number part for comparison
  const phoneFromJid = jid.replace(/@.*$/, '');

  return entries.find(e => {
    const entryPhone = e.jid.replace(/@.*$/, '');
    return entryPhone === phoneFromJid || e.jid === jid;
  }) || null;
}

/**
 * Remove a pending reply (after the owner has been notified)
 * @param {string} jid - The JID to remove
 */
export function removePending(jid) {
  const entries = loadPending();
  const phoneFromJid = jid.replace(/@.*$/, '');

  const filtered = entries.filter(e => {
    const entryPhone = e.jid.replace(/@.*$/, '');
    return entryPhone !== phoneFromJid && e.jid !== jid;
  });

  savePending(filtered);
  console.log(`pending-replies: removed ${jid}`);
}

/**
 * Mark a pending reply as notified (but keep for reference)
 * @param {string} jid - The JID that replied
 */
export function markNotified(jid) {
  const entries = loadPending();
  const phoneFromJid = jid.replace(/@.*$/, '');

  for (const e of entries) {
    const entryPhone = e.jid.replace(/@.*$/, '');
    if (entryPhone === phoneFromJid || e.jid === jid) {
      e.notifiedAt = new Date().toISOString();
    }
  }

  savePending(entries);
}

/**
 * Get all pending replies that haven't been notified yet
 * @returns {Array<{jid: string, topic: string, askedAt: string}>}
 */
export function getUnnotified() {
  const entries = loadPending();
  return entries.filter(e => !e.notifiedAt);
}

/**
 * Cleanup old entries (older than 48 hours)
 */
export function cleanup() {
  const entries = loadPending();
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;

  const filtered = entries.filter(e => {
    const ts = new Date(e.askedAt).getTime();
    return ts > cutoff;
  });

  if (filtered.length !== entries.length) {
    savePending(filtered);
    console.log(`pending-replies: cleaned up ${entries.length - filtered.length} old entries`);
  }
}
