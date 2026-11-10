// Single source of truth for the live WhatsApp socket.
//
// The socket is destroyed and recreated on every reconnect. Anything that
// captured a socket reference (handler, scheduler, heartbeat, webui) ends up
// holding a DEAD socket after a reconnect — that's the "bot goes silent after
// reconnecting" bug. Everything that sends must read the CURRENT socket through
// here, or go through the proxy below, so it always hits the live connection.

let current = null;
let open = false;
let openWaiters = [];

export function setSocket(sock) {
  current = sock;
  open = false; // a fresh socket starts closed until 'open' fires
}

export function markOpen() {
  open = true;
  const waiters = openWaiters;
  openWaiters = [];
  for (const resolve of waiters) {
    try { resolve(true); } catch {}
  }
}

export function markClosed() {
  open = false;
}

export function getSocket() {
  return current;
}

export function isOpen() {
  if (open) return true;
  // Fallback to the underlying websocket state in case markOpen() was missed.
  try {
    if (current?.ws?.readyState === 1) return true;
  } catch {}
  return false;
}

// Resolves true as soon as a socket reports open, or false on timeout.
export function waitForOpen(timeoutMs = 15000) {
  if (isOpen()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    openWaiters.push(() => finish(true));
    setTimeout(() => finish(isOpen()), timeoutMs);
  });
}

// A stable stand-in for the socket. Every property/method access is forwarded
// to whatever socket is live RIGHT NOW. Pass this anywhere that used to capture
// `sock` and the code transparently keeps using the current connection across
// reconnects, with no further changes at the call sites.
export const liveSocket = new Proxy({}, {
  get(_target, prop) {
    const s = current;
    if (!s) return undefined;
    const value = s[prop];
    return typeof value === 'function' ? value.bind(s) : value;
  },
  set(_target, prop, value) {
    if (current) current[prop] = value;
    return true;
  },
  has(_target, prop) {
    return current ? prop in current : false;
  },
});
