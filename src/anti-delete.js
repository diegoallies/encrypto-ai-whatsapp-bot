// Anti-delete: when someone deletes a message "for everyone", forward the
// original (who, where, text, media) to the owner's DM.
//
// Two sources:
//   1. The bot's own WhatsApp account (Baileys). We keep recent incoming
//      messages in memory and catch the protocolMessage REVOKE that follows.
//   2. the owner's main account, via the live wacli mirror (WACLI_STORE). wacli
//      flags revoked rows (revoked=1, deleted_at) and may wipe the payload, so
//      we snapshot new rows every few seconds and send from the snapshot.
//
// Disable with ANTI_DELETE=0. Poll rate: ANTI_DELETE_POLL_MS (default 2000).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { downloadMediaMessage, downloadContentFromMessage } from 'baileys';
import { liveSocket } from './socket-holder.js';
import { displayName } from './contacts.js';

const MAX_CACHE = Number(process.env.ANTI_DELETE_CACHE_MAX) || 20000;
const CACHE_TTL_MS = 48 * 3600_000;
const OUT_DIR = path.resolve('data/anti-delete');

function ownerJids() {
  return (process.env.OWNER_JIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
}
function ownerJid() {
  return ownerJids()[0] || null;
}
function bare(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}
function isOwner(jid) {
  const b = bare(jid);
  return Boolean(b) && ownerJids().some((o) => bare(o) === b);
}
function phoneOf(jid) {
  return String(jid || '').endsWith('@s.whatsapp.net') ? `+${bare(jid)}` : null;
}
function enabled() {
  return process.env.ANTI_DELETE !== '0';
}

function remember(cache, k, v) {
  if (cache.has(k)) cache.delete(k);
  cache.set(k, { ...v, cachedAt: Date.now() });
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
}
function prune(cache) {
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const [k, v] of cache) {
    if (v.cachedAt >= cutoff) break;
    cache.delete(k);
  }
}

function fmtTime(sec) {
  if (!sec) return '';
  return new Date(sec * 1000).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', hour12: false });
}

// header lines + optional media file → owner DM
async function report({ source, who, phone, chat, isGroup, sentAt, text, mediaKind, mediaPath, mimetype, fileName }) {
  const to = ownerJid();
  if (!to) return;
  const lines = [
    '🗑️ *Deleted message*',
    `*From:* ${who || phone || 'unknown'}${phone && who && who !== phone ? ` (${phone})` : ''}`,
  ];
  if (isGroup && chat) lines.push(`*Group:* ${chat}`);
  if (sentAt) lines.push(`*Sent:* ${fmtTime(sentAt)}`);
  if (source === 'bot') lines.push('*Account:* Encrypto AI');
  if (text) lines.push('', text);
  else if (mediaKind && !mediaPath) lines.push('', `[${mediaKind} - couldn't recover the file]`);
  else if (!mediaKind) lines.push('', '[no text content]');

  const body = lines.join('\n');
  if (!mediaPath) {
    await liveSocket.sendMessage(to, { text: body });
    return;
  }
  const buf = await fs.readFile(mediaPath);
  let content;
  switch (mediaKind) {
    case 'image': content = { image: buf, caption: body }; break;
    case 'video': content = { video: buf, caption: body }; break;
    case 'gif': content = { video: buf, gifPlayback: true, caption: body }; break;
    case 'document': content = { document: buf, mimetype: mimetype || 'application/octet-stream', fileName: fileName || path.basename(mediaPath), caption: body }; break;
    default: content = null;
  }
  if (content) {
    await liveSocket.sendMessage(to, content);
    return;
  }
  // audio / sticker can't carry a caption: header first, then the media.
  await liveSocket.sendMessage(to, { text: body });
  if (mediaKind === 'sticker') await liveSocket.sendMessage(to, { sticker: buf });
  else if (mediaKind === 'audio') await liveSocket.sendMessage(to, { audio: buf, mimetype: mimetype || 'audio/ogg; codecs=opus', ptt: true });
}

async function saveBuffer(id, ext, buf) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const p = path.join(OUT_DIR, `${String(id).replace(/[^\w.-]/g, '_')}.${ext}`);
  await fs.writeFile(p, buf);
  return p;
}

function extFor(kind, mimetype, fileName) {
  if (fileName && fileName.includes('.')) return fileName.split('.').pop();
  const m = String(mimetype || '');
  if (m.includes('jpeg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('pdf')) return 'pdf';
  return kind === 'sticker' ? 'webp' : 'bin';
}

// ---------------------------------------------------------------------------
// Source 1: the bot's own account (Baileys)
// ---------------------------------------------------------------------------

const botCache = new Map();
const unwrapTypes = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage'];

function unwrap(message) {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    const t = unwrapTypes.find((k) => m[k]?.message);
    if (!t) break;
    m = m[t].message;
  }
  return m || {};
}

function botMedia(m) {
  if (m.imageMessage) return { kind: 'image', node: m.imageMessage };
  if (m.videoMessage) return { kind: m.videoMessage.gifPlayback ? 'gif' : 'video', node: m.videoMessage };
  if (m.audioMessage) return { kind: 'audio', node: m.audioMessage };
  if (m.documentMessage) return { kind: 'document', node: m.documentMessage };
  if (m.stickerMessage) return { kind: 'sticker', node: m.stickerMessage };
  return null;
}

function botText(m) {
  return m.conversation || m.extendedTextMessage?.text
    || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || '';
}

async function onBotRevoke(sock, revokeMsg, proto) {
  const target = proto.key;
  const chatJid = target?.remoteJid || revokeMsg.key.remoteJid;
  const orig = botCache.get(`${chatJid}::${target?.id}`) || botCache.get(`*::${target?.id}`);
  if (!orig) return;
  botCache.delete(`${chatJid}::${target.id}`);
  const senderJid = orig.key.participant || orig.key.remoteJid;
  if (orig.key.fromMe || isOwner(senderJid)) return;

  const m = unwrap(orig.message);
  const media = botMedia(m);
  let mediaPath = null;
  if (media) {
    try {
      const buf = await downloadMediaMessage(orig, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage?.bind(sock) });
      mediaPath = await saveBuffer(orig.key.id, extFor(media.kind, media.node.mimetype, media.node.fileName), buf);
    } catch (err) {
      console.error('anti-delete: bot media download failed:', err.message);
    }
  }
  const isGroup = chatJid.endsWith('@g.us');
  let chat = null;
  if (isGroup) {
    try { chat = (await sock.groupMetadata(chatJid))?.subject || chatJid; } catch { chat = chatJid; }
  }
  let who = orig.pushName || null;
  try { who = (await displayName(senderJid)) || who; } catch {}
  await report({
    source: 'bot',
    who,
    phone: phoneOf(senderJid),
    chat,
    isGroup,
    sentAt: Number(orig.messageTimestamp) || null,
    text: botText(m),
    mediaKind: media?.kind,
    mediaPath,
    mimetype: media?.node.mimetype,
    fileName: media?.node.fileName,
  });
}

export function bindAntiDelete(sock) {
  if (!enabled()) return;
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages || []) {
      if (!msg?.message || !msg.key?.id) continue;
      const proto = msg.message.protocolMessage;
      if (proto) {
        // type 0 = REVOKE
        if ((proto.type === 0 || proto.type === 'REVOKE') && proto.key?.id) {
          onBotRevoke(sock, msg, proto).catch((err) => console.error('anti-delete (bot):', err.message));
        }
        continue;
      }
      if (msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') continue;
      remember(botCache, `${msg.key.remoteJid}::${msg.key.id}`, msg);
      remember(botCache, `*::${msg.key.id}`, msg);
    }
    prune(botCache);
  });
}

// ---------------------------------------------------------------------------
// Source 2: the owner's main account via the wacli mirror
// ---------------------------------------------------------------------------

const COLS = `rowid, chat_jid, chat_name, msg_id, sender_jid, sender_name, ts, text, display_text,
  media_type, media_caption, filename, mime_type, direct_path, media_key, file_sha256,
  file_enc_sha256, file_length, local_path, deleted_at`;
const MEDIA_KINDS = new Set(['image', 'video', 'gif', 'audio', 'document', 'sticker']);

export async function startWacliAntiDelete({ store = process.env.WACLI_STORE, pollMs } = {}) {
  if (!enabled() || !store) return null;
  const dbPath = path.join(store, 'wacli.db');
  try { await fs.access(dbPath); } catch { return null; }

  const { DatabaseSync } = await import('node:sqlite');
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    console.error('anti-delete: cannot open wacli db:', err.message);
    return null;
  }
  const cache = new Map();
  const reported = new Set();
  const interval = Number(pollMs || process.env.ANTI_DELETE_POLL_MS) || 2000;

  // Keyed by msg_id alone: wacli stores the revoke as a separate row, often
  // under the wrong chat_jid (the owner's own JID), so chat::id never matches.
  const snap = (r) => remember(cache, r.msg_id, r);
  const botBare = () => { try { return bare(liveSocket.user?.id); } catch { return ''; } };
  const usable = (r) => r && !isOwner(r.sender_jid) && bare(r.sender_jid) !== botBare()
    && !String(r.chat_jid).endsWith('@broadcast')
    && !String(r.chat_jid).endsWith('@newsletter');

  // Prime: last 6h of messages (still intact in the db) so deletes right
  // after a restart still have content.
  const sinceTs = Math.floor(Date.now() / 1000) - 6 * 3600;
  for (const r of db.prepare(`SELECT ${COLS} FROM messages WHERE ts >= ? AND revoked = 0 ORDER BY rowid`).all(sinceTs)) {
    if (usable(r)) snap(r);
  }
  let lastRowid = db.prepare('SELECT COALESCE(MAX(rowid),0) AS m FROM messages').get().m;
  let lastDeletedAt = Math.floor(Date.now() / 1000);

  const newRows = db.prepare(`SELECT ${COLS} FROM messages WHERE rowid > ? AND revoked = 0 ORDER BY rowid LIMIT 2000`);
  const revokes = db.prepare(`SELECT ${COLS} FROM messages WHERE revoked = 1 AND deleted_at >= ? ORDER BY deleted_at LIMIT 200`);
  const contact = db.prepare('SELECT full_name, first_name, push_name, business_name, system_name FROM contacts WHERE jid = ?');
  const chatName = db.prepare('SELECT name FROM chats WHERE jid = ?');
  const original = db.prepare(`SELECT ${COLS} FROM messages WHERE msg_id = ? AND revoked = 0 ORDER BY rowid LIMIT 1`);

  function nameFor(jid, fallback) {
    try {
      const c = contact.get(jid);
      if (c) return c.full_name || c.system_name || c.first_name || c.business_name || c.push_name || fallback;
    } catch {}
    return fallback;
  }

  async function mediaFor(r) {
    if (!MEDIA_KINDS.has(r.media_type)) return null;
    if (r.local_path) {
      try { await fs.access(r.local_path); return r.local_path; } catch {}
    }
    if (!r.media_key || !r.direct_path) return null;
    const type = r.media_type === 'gif' ? 'video' : r.media_type;
    const stream = await downloadContentFromMessage(
      { mediaKey: Buffer.from(r.media_key), directPath: r.direct_path, url: null },
      type,
    );
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return saveBuffer(r.msg_id, extFor(r.media_type, r.mime_type, r.filename), Buffer.concat(chunks));
  }

  async function handleRevoke(row) {
    const k = `${row.chat_jid}::${row.msg_id}`;
    if (reported.has(k)) return;
    reported.add(k);
    if (reported.size > 5000) reported.delete(reported.values().next().value);
    let snapRow = cache.get(row.msg_id);
    if (!snapRow) { try { snapRow = original.get(row.msg_id) || null; } catch {} }
    // Prefer the snapshot (pre-wipe); fall back to whatever is left in the row.
    const r = { ...row, ...(snapRow || {}) };
    if (!usable(r)) return;
    cache.delete(row.msg_id);

    const kind0 = MEDIA_KINDS.has(r.media_type);
    const text = r.text || r.media_caption || (kind0 ? '' : r.display_text) || '';
    const kind = MEDIA_KINDS.has(r.media_type) ? r.media_type : (r.media_type || null);
    if (!text && !kind && !snapRow) return; // nothing to recover
    let mediaPath = null;
    if (kind) {
      try { mediaPath = await mediaFor(r); } catch (err) {
        console.error('anti-delete: wacli media download failed:', err.message);
      }
    }
    const isGroup = String(r.chat_jid).endsWith('@g.us');
    let chat = null;
    if (isGroup) {
      try { chat = chatName.get(r.chat_jid)?.name || r.chat_name || r.chat_jid; } catch { chat = r.chat_name; }
    }
    await report({
      source: 'wacli',
      who: nameFor(r.sender_jid, r.sender_name),
      phone: phoneOf(r.sender_jid),
      chat,
      isGroup,
      sentAt: r.ts,
      text,
      mediaKind: kind,
      mediaPath,
      mimetype: r.mime_type,
      fileName: r.filename,
    });
  }

  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      for (const r of newRows.all(lastRowid)) {
        lastRowid = Math.max(lastRowid, r.rowid);
        if (usable(r)) snap(r);
      }
      const rows = revokes.all(lastDeletedAt);
      for (const r of rows) {
        lastDeletedAt = Math.max(lastDeletedAt, r.deleted_at);
        await handleRevoke(r).catch((err) => console.error('anti-delete (wacli):', err.message));
      }
      prune(cache);
    } catch (err) {
      console.error('anti-delete: poll failed:', err.message);
    } finally {
      busy = false;
    }
  }, interval);
  timer.unref?.();
  console.log(`anti-delete: watching ${dbPath} (${cache.size} msgs primed)`);
  return { stop: () => { clearInterval(timer); try { db.close(); } catch {} } };
}
