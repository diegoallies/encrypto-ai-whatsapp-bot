// Captures console output into a ring buffer and emits new entries to
// listeners so the web UI can SSE-stream a live log tail. The original
// console methods are preserved — stdout/stderr still get everything.

import { EventEmitter } from 'node:events';

const CAPACITY = 500;
const buf = [];
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

let installed = false;

function push(level, args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
    .join(' ');
  const entry = { t: new Date().toISOString(), level, text };
  buf.push(entry);
  if (buf.length > CAPACITY) buf.shift();
  emitter.emit('line', entry);
}

export function installLogCapture() {
  if (installed) return;
  installed = true;
  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  console.log = (...args) => { push('log', args); orig.log(...args); };
  console.warn = (...args) => { push('warn', args); orig.warn(...args); };
  console.error = (...args) => { push('error', args); orig.error(...args); };
}

export function recentLogs(limit = 200) {
  return buf.slice(-limit);
}

export function onLog(listener) {
  emitter.on('line', listener);
  return () => emitter.off('line', listener);
}
