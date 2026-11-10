// Lightweight in-memory counters surfaced via the /stats command and the
// periodic heartbeat. No persistence — these reset on process restart.
// Also forwards to analytics.js for persistent storage.

import * as analytics from './analytics.js';

const startedAt = Date.now();
let messages = 0;
let errors = 0;
let chunksOut = 0;
let lastError = null;
let tokensIn = 0;
let tokensOut = 0;
let cacheReadTokens = 0;
let cacheWriteTokens = 0;

export function recordMessage(jid = null, direction = 'received') {
  messages += 1;
  if (jid) {
    analytics.recordMessage(jid, direction);
  }
}

export function recordError(err) {
  errors += 1;
  lastError = err?.message ? String(err.message) : String(err);
}

export function recordChunks(n) {
  chunksOut += n;
}

export function recordResponseTime(ms) {
  analytics.recordResponseTime(ms);
}

export function recordUsage(usage) {
  if (!usage) return;
  const input = Number(usage.input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  const cacheRead = Number(usage.cache_read_input_tokens || 0);

  tokensIn += input;
  tokensOut += output;
  cacheReadTokens += cacheRead;
  cacheWriteTokens += Number(usage.cache_creation_input_tokens || 0);

  // Also record to persistent analytics
  analytics.recordTokens(input, output, cacheRead);
}

export function resetStats() {
  messages = 0;
  errors = 0;
  chunksOut = 0;
  lastError = null;
}

export function snapshot() {
  return {
    startedAt,
    uptimeMs: Date.now() - startedAt,
    messages,
    errors,
    chunksOut,
    lastError,
    tokensIn,
    tokensOut,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

function fmtDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatStats({ queueDepth } = {}) {
  const s = snapshot();
  const lines = [
    '📊 stats',
    ` uptime: ${fmtDuration(s.uptimeMs)}`,
    ` messages: ${s.messages}`,
    ` chunks sent: ${s.chunksOut}`,
    ` errors: ${s.errors}`,
  ];
  if (s.lastError) lines.push(` last error: ${s.lastError.slice(0, 120)}`);
  if (typeof queueDepth === 'number') lines.push(` queue depth: ${queueDepth}`);
  return lines.join('\n');
}
