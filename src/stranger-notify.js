// When a non-allowlisted JID DMs the bot, ping the owner once with the
// stranger's WhatsApp name + phone (not the raw @lid), throttled. The owner
// can quote-reply to the ping with "allow" / "yes" / "y" to authorize them.
//
// Env knobs (defaults are sensible):
//   STRANGER_NOTIFY=1                 on by default; 0 disables
//   STRANGER_NOTIFY_TTL_MS=86400000   one ping per stranger per 24h

const ENABLED = process.env.STRANGER_NOTIFY !== '0';
const TTL_MS = Number(process.env.STRANGER_NOTIFY_TTL_MS) || 24 * 60 * 60_000;
const seen = new Map(); // jid -> expiresAt

// Map of our own outbound notification message-id → { strangerJid, strangerName, strangerPhone }
// Used so the owner can quote-reply to the ping with "allow" and we know
// which stranger they meant.
const pending = new Map();
const PENDING_TTL_MS = 7 * 24 * 60 * 60_000; // remember pings for a week

function shouldPing(fromJid) {
  if (!ENABLED || !fromJid) return false;
  const now = Date.now();
  const exp = seen.get(fromJid);
  if (exp && exp > now) return false;
  seen.set(fromJid, now + TTL_MS);
  return true;
}

export function clearStrangerCache() {
  seen.clear();
  pending.clear();
}

// Try to extract a usable phone-style number from a JID for display.
// Returns null if the JID is an @lid (those don't map to phones without
// asking Baileys, which we do via sock.onWhatsApp upstream when possible).
function phoneFromJid(jid) {
  if (!jid) return null;
  if (jid.endsWith('@s.whatsapp.net')) {
    const digits = jid.split('@')[0];
    return digits.replace(/\D+/g, '') || null;
  }
  return null;
}

// Best-effort resolve a friendly "Name • +27 …" string. Uses, in order:
//   1. the message's pushName (the contact's WhatsApp display name)
//   2. wacli's contact DB (covers @lid → real name)
//   3. sock.onWhatsApp() to find the phone behind an @lid
//   4. fall back to the JID itself
async function resolveDisplay({ sock, msg, fromJid }) {
  const pushName = msg?.pushName ? String(msg.pushName).trim() : '';
  let phone = phoneFromJid(fromJid);
  let name = pushName;

  // Try wacli — it knows names for known @lid's too.
  if (!name || !phone) {
    try {
      const { lookupContact } = await import('./contacts.js');
      const c = await lookupContact(fromJid);
      if (c) {
        if (!name && c.name) name = c.name;
        // wacli's "Phone" is sometimes the LID number for @lid contacts —
        // only trust it if the JID looks like @s.whatsapp.net.
        if (!phone && c.phone && fromJid.endsWith('@s.whatsapp.net')) phone = c.phone;
      }
    } catch {}
  }

  // Last resort: ask Baileys to map @lid → @s.whatsapp.net.
  if (!phone && fromJid && fromJid.endsWith('@lid') && sock?.onWhatsApp) {
    try {
      const res = await sock.onWhatsApp(fromJid);
      const first = Array.isArray(res) ? res[0] : null;
      if (first?.jid) phone = phoneFromJid(first.jid);
    } catch {}
  }

  const prettyPhone = phone ? formatPhone(phone) : null;
  let display;
  if (name && prettyPhone) display = `*${name}* • ${prettyPhone}`;
  else if (name) display = `*${name}*\n${fromJid}`;
  else if (prettyPhone) display = prettyPhone;
  else display = fromJid;
  return { display, pushName: name || null, phone, prettyPhone };
}

// "27671234567" → "+27 67 123 4567" (very loose; falls back to "+<digits>")
function formatPhone(digits) {
  if (!digits) return null;
  if (digits.length >= 11) {
    const cc = digits.slice(0, 2);
    const rest = digits.slice(2);
    return `+${cc} ${rest.slice(0, 2)} ${rest.slice(2, 5)} ${rest.slice(5)}`.trim();
  }
  return `+${digits}`;
}

export async function notifyStranger({ sock, ownerJid, fromJid, preview, kind = 'dm', msg = null }) {
  if (!sock || !ownerJid || !fromJid) return false;
  if (fromJid === ownerJid) return false;
  if (!shouldPing(fromJid)) return false;

  const { display, pushName, phone, prettyPhone } = await resolveDisplay({ sock, msg, fromJid });
  const safePreview = String(preview || '').replace(/\s+/g, ' ').trim().slice(0, 200) || '(no text)';

  const text =
    `👋 *New ${kind} from a stranger*\n` +
    `${display}\n` +
    `\n` +
    `_${safePreview}_\n` +
    `\n` +
    `Reply *allow* to this message to let them through, or ignore.`;

  try {
    const sent = await sock.sendMessage(ownerJid, { text });
    const ourMsgId = sent?.key?.id;
    if (ourMsgId) {
      pending.set(ourMsgId, {
        strangerJid: fromJid,
        strangerName: pushName,
        strangerPhone: phone || null,
        prettyPhone: prettyPhone || null,
        createdAt: Date.now(),
      });
      sweepPending();
    }
    return true;
  } catch (err) {
    console.error('stranger-notify: send failed:', err.message);
    return false;
  }
}

function sweepPending() {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [id, entry] of pending) {
    if (entry.createdAt < cutoff) pending.delete(id);
  }
}

// Lookup the stranger info for a previous ping by its message-id (the one
// being quoted in a reply). Returns null if not found / expired.
export function lookupPendingPing(ourMsgId) {
  if (!ourMsgId) return null;
  return pending.get(ourMsgId) || null;
}

export function consumePendingPing(ourMsgId) {
  const entry = pending.get(ourMsgId);
  if (entry) pending.delete(ourMsgId);
  return entry || null;
}

// Return the most-recent pending stranger ping (used by /allow when invoked
// without an explicit JID — the owner just types "allow" after a notice).
export function mostRecentPending() {
  let latest = null;
  for (const entry of pending.values()) {
    if (!latest || entry.createdAt > latest.createdAt) latest = entry;
  }
  return latest;
}

// Test helper.
export function _pendingSize() { return pending.size; }
