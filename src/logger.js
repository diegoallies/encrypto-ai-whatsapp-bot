// Thin wrapper around pino that drops known-noisy Baileys log lines so
// the real signal stays visible. Baileys spams the following every
// reconnect / decrypt retry, all of which are transient and harmless:
//
//   * "unexpected error in 'init queries'" — Baileys' initial chat sync
//     sometimes times out; reconnect recovers it.
//   * MessageCounterError / "Key used already or never filled"
//   * "Invalid PreKey ID" / "No session record"
//   * "failed to decrypt message"
//
// Real Baileys errors (auth, network, fatal) still propagate.

import pino from 'pino';

const NOISE = [
  /unexpected error in 'init queries'/i,
  /Key used already or never filled/i,
  /Invalid PreKey ID/i,
  /No session record/i,
  /failed to decrypt message/i,
  /MessageCounterError/i,
  /PreKeyError/i,
];

function isNoise(...args) {
  for (const a of args) {
    if (!a) continue;
    if (typeof a === 'string') {
      if (NOISE.some((r) => r.test(a))) return true;
    } else if (typeof a === 'object') {
      const m = a.msg || a.message || a.err?.message || '';
      const stack = a.err?.stack || a.stack || '';
      if (NOISE.some((r) => r.test(m) || r.test(stack))) return true;
    }
  }
  return false;
}

function wrap(base) {
  const methods = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  const out = {};
  for (const m of methods) {
    out[m] = (...args) => { if (isNoise(...args)) return; return base[m](...args); };
  }
  out.child = (bindings) => wrap(base.child(bindings));
  Object.defineProperty(out, 'level', {
    get() { return base.level; },
    set(v) { base.level = v; },
  });
  return out;
}

export function createLogger({ level = process.env.LOG_LEVEL || 'warn' } = {}) {
  return wrap(pino({ level }));
}
