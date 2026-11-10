// Heartbeat scheduler. Ticks every minute and runs registered plugins
// whose own interval has elapsed. Plugins are async functions:
//
//   register({ name, intervalMs, run })
//
//   run({ sock, jid, send }) → optional string. If a string is returned,
//   it's sent to `jid` automatically. If you want to send multiple
//   messages, call `send(text)` directly.
//
// All plugins are best-effort. Throws are caught and logged.

import { setLastCheck, getLastCheck } from './memory.js';

const TICK_MS = 60_000;
const plugins = [];
let timer = null;

export function register(plugin) {
  if (!plugin?.name) throw new Error('plugin name required');
  if (!Number.isFinite(plugin.intervalMs)) throw new Error('intervalMs required');
  if (typeof plugin.run !== 'function') throw new Error('run() required');
  plugins.push(plugin);
}

export function listPlugins() {
  return plugins.map((p) => ({ name: p.name, intervalMs: p.intervalMs }));
}

async function tick({ sock, jid }) {
  const now = Date.now();
  for (const p of plugins) {
    const last = await getLastCheck(`hb:${p.name}`);
    const lastMs = last ? new Date(last).getTime() : 0;
    if (now - lastMs < p.intervalMs) continue;
    await setLastCheck(`hb:${p.name}`).catch(() => {});
    const send = async (text) => {
      if (!text || !jid) return;
      try { await sock.sendMessage(jid, { text }); } catch (err) {
        console.error(`heartbeat: send for ${p.name} failed:`, err.message);
      }
    };
    try {
      const out = await p.run({ sock, jid, send });
      if (typeof out === 'string' && out.trim()) await send(out.trim());
    } catch (err) {
      console.error(`heartbeat: plugin ${p.name} threw:`, err.message);
    }
  }
}

export function startHeartbeat({ sock, jid }) {
  if (timer) return;
  if (plugins.length === 0) return;
  // Run once on boot (after a short delay so socket settles), then on interval.
  setTimeout(() => tick({ sock, jid }).catch(() => {}), 10_000).unref();
  timer = setInterval(() => tick({ sock, jid }).catch(() => {}), TICK_MS);
  timer.unref();
}

export function stopHeartbeat() {
  if (timer) clearInterval(timer);
  timer = null;
}
