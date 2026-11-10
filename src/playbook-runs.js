// Run history store for playbooks. Appends one JSON line per run to
// data/playbook-runs.jsonl. Used for the history page, the last-run badge
// on each card, and the cost/duration aggregates on the dashboard.

import fs from 'node:fs/promises';
import path from 'node:path';

const FILE = path.join('data', 'playbook-runs.jsonl');
const MAX_KEEP = 1000;

let cache = null;
let cacheLoaded = false;

async function ensureLoaded() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = await fs.readFile(FILE, 'utf-8');
    cache = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    cache = [];
  }
}

export async function recordRun(entry) {
  await ensureLoaded();
  const row = {
    id: entry.id || `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: String(entry.name || ''),
    startedAt: entry.startedAt || new Date().toISOString(),
    finishedAt: entry.finishedAt || new Date().toISOString(),
    durationMs: Number(entry.durationMs || 0),
    status: entry.status === 'error' ? 'error' : 'ok',
    error: entry.error ? String(entry.error).slice(0, 500) : null,
    tokensIn: Number(entry.tokensIn || 0),
    tokensOut: Number(entry.tokensOut || 0),
    target: entry.target || null,
    params: entry.params || null,
    outputPreview: entry.outputPreview ? String(entry.outputPreview).slice(0, 800) : null,
    persona: entry.persona || null,
    chainOf: entry.chainOf || null,
  };
  cache.push(row);
  if (cache.length > MAX_KEEP) cache = cache.slice(-MAX_KEEP);
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.appendFile(FILE, JSON.stringify(row) + '\n');
  } catch (err) {
    console.error('playbook-runs: failed to persist:', err.message);
  }
  return row;
}

export async function listRuns({ name = null, limit = 50 } = {}) {
  await ensureLoaded();
  let rows = cache;
  if (name) rows = rows.filter((r) => r.name === name);
  return rows.slice(-limit).reverse();
}

export async function lastRunByName() {
  await ensureLoaded();
  const map = new Map();
  for (const r of cache) map.set(r.name, r);
  return map;
}

export async function aggregateStats(name) {
  await ensureLoaded();
  const rows = name ? cache.filter((r) => r.name === name) : cache;
  if (rows.length === 0) return { runs: 0, ok: 0, errors: 0, avgMs: 0, totalTokensIn: 0, totalTokensOut: 0 };
  const ok = rows.filter((r) => r.status === 'ok').length;
  const totalMs = rows.reduce((s, r) => s + (r.durationMs || 0), 0);
  const totalIn = rows.reduce((s, r) => s + (r.tokensIn || 0), 0);
  const totalOut = rows.reduce((s, r) => s + (r.tokensOut || 0), 0);
  return {
    runs: rows.length,
    ok,
    errors: rows.length - ok,
    avgMs: Math.round(totalMs / rows.length),
    totalTokensIn: totalIn,
    totalTokensOut: totalOut,
  };
}

export function _resetForTest() {
  cache = [];
  cacheLoaded = true;
}
