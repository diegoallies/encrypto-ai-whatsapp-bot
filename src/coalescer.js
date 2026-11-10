// Per-JID message coalescer. When a user fires off a burst of WhatsApp
// messages, we hold them in a small per-JID buffer and only "settle" the
// batch once the user has paused. Avoids the bot replying line-by-line
// when someone is mid-thought.
//
// Two timers govern when a batch fires:
//
//   QUIET_MS    debounce reset on each new arrival (default 1500ms)
//   MAX_MS      hard cap from the first message in the burst (default 8000ms)
//
// So a fast typist still gets answered within MAX_MS even if they never
// pause for QUIET_MS. Slow typists are coalesced as long as gaps stay
// under QUIET_MS.
//
// drainBuffered(jid) lets the handler grab any messages that arrived
// between the timer firing and the handler actually running (e.g. while
// it was waiting in the per-JID serial queue) — closes the race window.

const QUIET_MS = Number(process.env.COALESCE_QUIET_MS) || 1500;
const MAX_MS = Number(process.env.COALESCE_MAX_MS) || 8000;

const buffers = new Map(); // jid → { msgs, firstAt, timer, onSettle }

export function coalesce(jid, msg, onSettle) {
  let entry = buffers.get(jid);
  const now = Date.now();
  if (!entry) {
    entry = { msgs: [], firstAt: now, timer: null, onSettle };
    buffers.set(jid, entry);
  } else {
    // Keep the most recently provided callback (handler closure may have
    // captured a different sock/agent — unlikely, but safe).
    entry.onSettle = onSettle;
  }
  entry.msgs.push(msg);
  if (entry.timer) clearTimeout(entry.timer);

  const elapsed = now - entry.firstAt;
  const untilMax = Math.max(0, MAX_MS - elapsed);
  const delay = Math.min(QUIET_MS, untilMax);
  entry.timer = setTimeout(() => fireBatch(jid), delay);
  entry.timer.unref?.();
}

function fireBatch(jid) {
  const entry = buffers.get(jid);
  if (!entry) return;
  buffers.delete(jid);
  if (entry.timer) clearTimeout(entry.timer);
  try {
    entry.onSettle(entry.msgs);
  } catch (err) {
    console.error('coalescer: onSettle threw', err);
  }
}

// Used by the handler at the start of processBatch to fold in any messages
// that snuck in between fireBatch and the queue dequeuing us. Returns []
// when there's nothing buffered.
export function drainBuffered(jid) {
  const entry = buffers.get(jid);
  if (!entry) return [];
  buffers.delete(jid);
  if (entry.timer) clearTimeout(entry.timer);
  return entry.msgs;
}

export function bufferedCount(jid) {
  return buffers.get(jid)?.msgs.length || 0;
}

// Force-fire every pending batch (used at shutdown / for tests).
export function flushAll() {
  for (const jid of [...buffers.keys()]) fireBatch(jid);
}

// Test helpers.
export function _reset() {
  for (const e of buffers.values()) if (e.timer) clearTimeout(e.timer);
  buffers.clear();
}
export function _size() { return buffers.size; }
