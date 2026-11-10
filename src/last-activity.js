// In-memory record of the most recent incoming and outgoing message,
// both globally and per-JID. Drives the dashboard "Now" panel.

let lastRx = null; // { jid, text, at }
let lastTx = null; // { jid, text, at }
const byJid = new Map(); // jid -> { rxAt, rxText, txAt, txText }

function setEntry(jid, patch) {
  const cur = byJid.get(jid) || {};
  byJid.set(jid, { ...cur, ...patch });
}

export function recordRx(jid, text, at = Date.now()) {
  const trimmed = (text || '').slice(0, 200);
  lastRx = { jid, text: trimmed, at };
  setEntry(jid, { rxAt: at, rxText: trimmed });
}

export function recordTx(jid, text, at = Date.now()) {
  const trimmed = (text || '').slice(0, 200);
  lastTx = { jid, text: trimmed, at };
  setEntry(jid, { txAt: at, txText: trimmed });
}

export function getLast() {
  return { rx: lastRx, tx: lastTx };
}

export function getByJid(jid) {
  return byJid.get(jid) || null;
}
