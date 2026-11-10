// Two streaming strategies, picked by env:
//   STREAM_AS_EDITS=0 (default) — every chunk = a new WhatsApp message.
//                                 Simpler, what the bot has shipped with.
//   STREAM_AS_EDITS=1            — one message is edited in place as text
//                                 arrives; when it would exceed MAX, the
//                                 message is finalized and a new one starts.
//
// Caller pattern:
//   const s = createStreamSender({ sock, jid });
//   await s.append('first piece ');
//   await s.append('more text');
//   await s.finalize();           // flushes any pending content
//   s.chunkCount();               // # of distinct WhatsApp messages sent

import { splitForWhatsApp } from './chunk.js';
import { reliableSend } from './reliable-send.js';

const AS_EDITS = process.env.STREAM_AS_EDITS === '1';
const MAX = 3500;

export function createStreamSender({ sock, jid }) {
  let chunks = 0;

  if (!AS_EDITS) {
    // Per-chunk mode: split each incoming part on WhatsApp limits and send.
    return {
      async append(part) {
        for (const piece of splitForWhatsApp(part)) {
          await reliableSend(sock, jid, { text: piece }).catch(() => {});
          chunks += 1;
        }
      },
      async finalize() {},
      chunkCount: () => chunks,
    };
  }

  // Edit-in-place mode.
  let currentKey = null;
  let currentText = '';

  async function send(text) {
    const res = await reliableSend(sock, jid, { text });
    chunks += 1;
    currentKey = res?.key || null;
    currentText = text;
  }

  async function edit(text) {
    if (!currentKey) return send(text);
    try {
      await reliableSend(sock, jid, { text, edit: currentKey });
      currentText = text;
    } catch {
      // Edit failed (rate-limit, expired, …) — fall back to a new send.
      currentKey = null;
      currentText = '';
      await send(text);
    }
  }

  return {
    async append(part) {
      if (!part) return;
      const next = currentText + part;
      if (next.length <= MAX) {
        if (!currentKey) await send(next);
        else await edit(next);
        return;
      }
      // Overflow — finalize current message at a clean cut, start a new one.
      const all = splitForWhatsApp(next);
      // First piece replaces the current message (edit if we have a key).
      if (currentKey) await edit(all[0]);
      else await send(all[0]);
      // Force-flush by clearing currentKey so the next chunk lands in a new msg.
      currentKey = null;
      currentText = '';
      for (let i = 1; i < all.length; i++) {
        await send(all[i]);
        currentKey = null;
        currentText = '';
      }
    },
    async finalize() {
      // Nothing extra to flush — content is already in WhatsApp.
    },
    chunkCount: () => chunks,
  };
}
