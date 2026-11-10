// Pure parsers over Baileys message envelopes. Kept dependency-free so
// they're trivial to unit-test.

export function extractText(msg) {
  return (
    msg?.message?.conversation ||
    msg?.message?.extendedTextMessage?.text ||
    msg?.message?.imageMessage?.caption ||
    msg?.message?.videoMessage?.caption ||
    null
  );
}

// Returns the contextInfo block (the place WhatsApp stuffs quotes, mentions,
// forwarding metadata). Reads from every place Baileys might park it.
export function contextInfo(msg) {
  const m = msg?.message;
  if (!m) return null;
  return (
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.audioMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    m.stickerMessage?.contextInfo ||
    null
  );
}

// Text + author of the message this one is replying to, if any.
// Returns { text, jid } where text is the best human-readable string we can
// recover from the quoted proto. `jid` is the participant who sent the quoted
// message (for groups) or the chat jid (for DMs).
export function quotedMessage(msg) {
  const ctx = contextInfo(msg);
  const q = ctx?.quotedMessage;
  if (!q) return null;
  const text =
    q.conversation ||
    q.extendedTextMessage?.text ||
    q.imageMessage?.caption ||
    q.videoMessage?.caption ||
    (q.imageMessage ? '[image]' :
     q.videoMessage ? '[video]' :
     q.audioMessage ? '[audio]' :
     q.documentMessage ? `[document: ${q.documentMessage.fileName || ''}]` :
     q.stickerMessage ? '[sticker]' :
     '[non-text]');
  return {
    text,
    jid: ctx.participant || ctx.remoteJid || null,
    stanzaId: ctx.stanzaId || null,
  };
}

export function describeNonText(msg) {
  const m = msg?.message;
  if (!m) return null;
  if (m.reactionMessage) return 'reaction';
  if (m.audioMessage?.ptt) return 'voice note';
  if (m.audioMessage) return 'audio';
  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.stickerMessage) return 'sticker';
  if (m.documentMessage) return 'document';
  if (m.locationMessage || m.liveLocationMessage) return 'location';
  if (m.contactMessage || m.contactsArrayMessage) return 'contact card';
  if (m.pollCreationMessage || m.pollUpdateMessage) return 'poll';
  return 'media';
}

export function chatType(jid) {
  if (!jid) return 'system';
  if (jid === 'status@broadcast' || jid.endsWith('@broadcast')) return 'broadcast';
  if (jid.endsWith('@g.us')) return 'group';
  if (jid.endsWith('@newsletter')) return 'channel';
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) return 'dm';
  return 'system';
}

export function isSystemJid(jid) {
  const t = chatType(jid);
  return t === 'system' || t === 'broadcast' || t === 'group' || t === 'channel';
}

export function isDM(jid) {
  return chatType(jid) === 'dm';
}

export function isGroup(jid) {
  return chatType(jid) === 'group';
}
