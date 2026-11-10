#!/usr/bin/env node
// Polls /healthz and pm2-restarts the bot on failure (or after N consecutive
// timeouts). Run via cron, e.g.:
//   * * * * * cd /path/to/whatsapp-bot && node scripts/healthcheck.mjs >> logs/healthcheck.log 2>&1

import { execSync } from 'node:child_process';

const HOST = process.env.WEB_HOST || '127.0.0.1';
const PORT = process.env.WEB_PORT || '7777';
const TIMEOUT_MS = Number(process.env.HEALTHCHECK_TIMEOUT_MS) || 5000;
const APP_NAME = process.env.PM2_APP_NAME || 'whatsapp-claude-bot';

const stamp = () => new Date().toISOString();

async function check() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`http://${HOST}:${PORT}/healthz`, { signal: ctrl.signal });
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    const body = await r.json().catch(() => ({}));
    if (body.ok !== true) return { ok: false, reason: `socket: ${body.socket || 'unknown'}` };
    return { ok: true, body };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(t);
  }
}

const r = await check();
if (r.ok) {
  // Quiet on success — just write a one-line marker, nothing else.
  console.log(`${stamp()}  ok  uptime=${Math.round((r.body.uptimeMs || 0) / 1000)}s`);
  process.exit(0);
}

console.error(`${stamp()}  unhealthy: ${r.reason}`);
try {
  execSync(`pm2 restart ${APP_NAME}`, { stdio: 'inherit' });
  console.error(`${stamp()}  restarted via pm2`);
} catch (err) {
  console.error(`${stamp()}  pm2 restart failed:`, err.message);
  process.exit(1);
}
