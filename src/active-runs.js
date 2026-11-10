// Registry of in-flight AI runs, keyed by chat JID. Lets a chat:
//   - stop a run mid-flight (/stop, "stop", esc) without waiting in the queue
//   - inject follow-up messages into a live run (like typing while the
//     terminal tool is working) instead of queueing a whole new prompt
//
// A JID can have several runs at once (chat reply + a scheduled --prompt
// task). Only runs registered with `injectable: true` accept follow-ups;
// stop() interrupts every run for the JID.

const runs = new Map(); // jid -> Set<run>
let idCounter = 1;

// run: { inject(text) -> bool, interrupt() -> Promise, injectable, source }
export function register(jid, run) {
  const entry = { id: idCounter++, startedAt: Date.now(), ...run };
  if (!runs.has(jid)) runs.set(jid, new Set());
  runs.get(jid).add(entry);
  return () => {
    const set = runs.get(jid);
    if (!set) return;
    set.delete(entry);
    if (set.size === 0) runs.delete(jid);
  };
}

export function has(jid) {
  return (runs.get(jid)?.size || 0) > 0;
}

// Push text into the newest injectable run for this JID. Returns false when
// there is no live run that can take it (caller should queue normally).
export function inject(jid, text) {
  const set = runs.get(jid);
  if (!set) return false;
  const live = [...set].filter((r) => r.injectable).sort((a, b) => b.startedAt - a.startedAt);
  for (const r of live) {
    try { if (r.inject(text)) return true; } catch {}
  }
  return false;
}

// Interrupt every run for this JID. Returns how many were stopped.
export async function stop(jid) {
  const set = runs.get(jid);
  if (!set || set.size === 0) return 0;
  const list = [...set];
  await Promise.all(list.map((r) => Promise.resolve().then(() => r.interrupt()).catch(() => {})));
  return list.length;
}

export async function stopAll() {
  let n = 0;
  for (const jid of [...runs.keys()]) n += await stop(jid);
  return n;
}

export function list() {
  const out = [];
  for (const [jid, set] of runs) {
    for (const r of set) out.push({ id: r.id, jid, startedAt: r.startedAt, source: r.source || null, injectable: Boolean(r.injectable) });
  }
  return out;
}

export function _reset() {
  runs.clear();
}
