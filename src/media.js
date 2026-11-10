// Downloads media from WhatsApp messages to disk and returns the local path,
// so Claude can Read/process it via its tool API.

import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadMediaMessage } from 'baileys';

const INCOMING_DIR = path.join('data', 'incoming');

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/ogg; codecs=opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
};

function extFor(mime) {
  if (!mime) return 'bin';
  const m = String(mime).toLowerCase();
  return MIME_EXT[m] || m.split('/')[1]?.split(';')[0] || 'bin';
}

function mediaNode(msg) {
  const m = msg?.message;
  if (!m) return null;
  if (m.imageMessage) return { kind: 'image', node: m.imageMessage };
  if (m.videoMessage) return { kind: 'video', node: m.videoMessage };
  if (m.audioMessage) return { kind: m.audioMessage.ptt ? 'voice' : 'audio', node: m.audioMessage };
  if (m.documentMessage) return { kind: 'document', node: m.documentMessage };
  if (m.stickerMessage) return { kind: 'sticker', node: m.stickerMessage };
  return null;
}

// Returns { kind, path, caption, mimetype } or null if no downloadable media.
// `sock` is optional but strongly recommended — without it, expired media URLs
// can't be re-requested and the download fails.
export async function downloadIncomingMedia(msg, logger, sock = null) {
  const found = mediaNode(msg);
  if (!found) return null;
  const { kind, node } = found;

  try {
    await fs.mkdir(INCOMING_DIR, { recursive: true });
    // reuploadRequest is what Baileys calls when the media URL has expired —
    // it asks WhatsApp for a fresh URL. Rejecting it (the old behavior) means
    // any media older than a few minutes silently fails to download. Pass
    // sock.updateMediaMessage so the bot can recover.
    const reuploadRequest = sock?.updateMediaMessage
      ? sock.updateMediaMessage.bind(sock)
      : () => Promise.reject(new Error('reupload not configured'));
    const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest });
    const mimetype = node.mimetype || '';
    const ext = node.fileName?.split('.').pop() || extFor(mimetype);
    const safeId = (msg.key?.id || 'unknown').replace(/[^\w.-]/g, '_');
    const filename = `${safeId}.${ext}`;
    const fullPath = path.resolve(INCOMING_DIR, filename);
    await fs.writeFile(fullPath, buf);
    return {
      kind,
      path: fullPath,
      caption: node.caption || null,
      mimetype,
      filename: node.fileName || null,
      bytes: buf.length,
    };
  } catch (err) {
    console.error(`media: download failed (${kind}):`, err.message);
    return null;
  }
}
