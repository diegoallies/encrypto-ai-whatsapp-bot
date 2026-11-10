// Tracks when the bot is processing messages - used for typing indicators.
// Emits events when processing starts/stops so the web UI can show live status.

import { EventEmitter } from 'node:events';

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

// Current processing state per JID
const processing = new Map(); // jid -> { startedAt, preview, bufferId }

export function startProcessing(jid, preview = '', bufferId = null) {
  processing.set(jid, { startedAt: Date.now(), preview: preview.slice(0, 100), bufferId });
  emitter.emit('change', getState());
}

export function stopProcessing(jid) {
  processing.delete(jid);
  emitter.emit('change', getState());
}

export function updatePreview(jid, preview) {
  const entry = processing.get(jid);
  if (entry) {
    entry.preview = preview.slice(0, 100);
    emitter.emit('change', getState());
  }
}

export function getState() {
  const active = [];
  const now = Date.now();
  for (const [jid, { startedAt, preview, bufferId }] of processing) {
    active.push({
      jid,
      elapsedMs: now - startedAt,
      preview,
      bufferId
    });
  }
  return { active, count: active.length };
}

export function isProcessing() {
  return processing.size > 0;
}

export function onStateChange(listener) {
  emitter.on('change', listener);
  return () => emitter.off('change', listener);
}

// Auto-cleanup stale entries (if processing takes > 5 minutes, assume stuck)
setInterval(() => {
  const now = Date.now();
  for (const [jid, { startedAt }] of processing) {
    if (now - startedAt > 5 * 60 * 1000) {
      processing.delete(jid);
    }
  }
  if (processing.size > 0) {
    emitter.emit('change', getState());
  }
}, 10_000);
