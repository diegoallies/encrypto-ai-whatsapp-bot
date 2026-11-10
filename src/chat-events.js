// Pub/sub for new chat messages — drives the /chats/:jid SSE live feed.
// Pure in-memory; subscribers automatically clean up on disconnect.

const subscribers = new Map(); // jid -> Set<{ send(payload) }>

export function subscribe(jid, handler) {
  let set = subscribers.get(jid);
  if (!set) { set = new Set(); subscribers.set(jid, set); }
  const entry = { send: handler };
  set.add(entry);
  return () => {
    set.delete(entry);
    if (set.size === 0) subscribers.delete(jid);
  };
}

export function publish(jid, payload) {
  const set = subscribers.get(jid);
  if (!set) return;
  for (const entry of set) {
    try { entry.send(payload); } catch { /* dead subscriber */ }
  }
}

export function subscriberCount(jid) {
  return subscribers.get(jid)?.size || 0;
}
