// Per-key serial promise queue. Subsequent enqueue(key, fn) calls wait
// for the previous task on the same key to settle before running.
// Cross-key tasks run in parallel. Map entry is cleaned up when the
// chain for a key fully drains, so memory stays bounded.

import { EventEmitter } from 'node:events';

const tails = new Map();
const pending = new Map(); // key -> array of { id, addedAt, preview }
let idCounter = 1;
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export function enqueue(key, task, preview = '') {
  const id = idCounter++;
  const item = { id, key, addedAt: Date.now(), preview: preview.slice(0, 80) };

  // Add to pending list for this key
  if (!pending.has(key)) pending.set(key, []);
  pending.get(key).push(item);
  emitter.emit('change');

  const prev = tails.get(key) ?? Promise.resolve();
  const next = prev.then(
    async () => {
      try {
        return await task();
      } finally {
        // Remove from pending when done
        const list = pending.get(key);
        if (list) {
          const idx = list.findIndex(i => i.id === id);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) pending.delete(key);
        }
        emitter.emit('change');
      }
    },
    async () => {
      try {
        return await task();
      } finally {
        const list = pending.get(key);
        if (list) {
          const idx = list.findIndex(i => i.id === id);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) pending.delete(key);
        }
        emitter.emit('change');
      }
    }
  );
  const tail = next.catch(() => {});
  tails.set(key, tail);
  tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return next;
}

export function queueDepth() {
  return tails.size;
}

// Get all pending items across all keys
export function listPending() {
  const result = [];
  for (const [key, items] of pending) {
    for (const item of items) {
      result.push({ ...item, jid: key });
    }
  }
  return result.sort((a, b) => a.addedAt - b.addedAt);
}

// Subscribe to queue changes
export function onQueueChange(listener) {
  emitter.on('change', listener);
  return () => emitter.off('change', listener);
}
