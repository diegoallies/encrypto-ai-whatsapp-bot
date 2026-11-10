// Tiny in-memory cache of outgoing messages so Baileys can satisfy a
// `getMessage` retry. WhatsApp's retry protocol asks the sender for the
// original message proto when a recipient says "I couldn't decrypt that".
// Without this, Baileys returns nothing, the retry fails, and the recipient
// is stuck on "Waiting for this message. This may take a while."
//
// Capped at MAX entries (LRU-ish via insertion order Map).

const MAX = Number(process.env.OUTBOUND_STORE_MAX) || 2000;
const store = new Map();

function key(remoteJid, id) {
  return `${remoteJid}::${id}`;
}

export function rememberOutgoing(msg) {
  if (!msg?.key?.fromMe) return;
  const k = key(msg.key.remoteJid, msg.key.id);
  if (!msg.message) return;
  // Re-insert to mark as recent.
  if (store.has(k)) store.delete(k);
  store.set(k, msg.message);
  while (store.size > MAX) {
    const first = store.keys().next().value;
    store.delete(first);
  }
}

export async function getMessage(keyObj) {
  const k = key(keyObj.remoteJid, keyObj.id);
  const msg = store.get(k);
  // Debug: log when getMessage is called
  if (!msg) {
    console.log(`getMessage: miss for ${k} (store has ${store.size} entries)`);
  }
  return msg;
}

// Manually store an outgoing message proto (use when sendMessage returns)
export function storeOutgoing(jid, msgId, messageProto) {
  if (!jid || !msgId || !messageProto) return;
  const k = key(jid, msgId);
  if (store.has(k)) store.delete(k);
  store.set(k, messageProto);
  while (store.size > MAX) {
    const first = store.keys().next().value;
    store.delete(first);
  }
}

export function bindOutboundStore(sock) {
  // (1) Wrap sendMessage so we cache the proto synchronously when WE send.
  //     This closes the race where iOS recipients fire a retry-receipt
  //     before Baileys' own messages.upsert event runs, which would have
  //     left getMessage returning undefined → "Waiting for this message…".
  const orig = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    const result = await orig(...args);
    try { rememberOutgoing(result); } catch {}
    return result;
  };

  // (2) Also catch messages.upsert with fromMe — covers messages sent from
  //     other devices on the same WhatsApp account.
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages || []) rememberOutgoing(m);
  });
}

export function outboundStoreSize() {
  return store.size;
}
