// Snapshot every persona/rules/tone/overlay save to data/persona-history.jsonl
// so we can roll back. Each entry:
//
//   { id, kind, target, savedAt, bytes, snippet, body }
//
// kind ∈ 'soul' | 'rules' | 'tone' | 'overlay'
// target is the filename or jid the snapshot is for ('soul', 'rules',
// 'concise', '27671234567@s.whatsapp.net', etc.)

import fs from 'node:fs/promises';
import path from 'node:path';

const FILE = path.join('data', 'persona-history.jsonl');
const MAX_KEEP = 500;

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

export async function snapshot({ kind, target, body }) {
  await ensureLoaded();
  if (typeof body !== 'string') return null;
  const row = {
    id: `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    kind: String(kind || ''),
    target: String(target || ''),
    savedAt: new Date().toISOString(),
    bytes: Buffer.byteLength(body, 'utf-8'),
    snippet: body.slice(0, 200),
    body,
  };
  cache.push(row);
  if (cache.length > MAX_KEEP) cache = cache.slice(-MAX_KEEP);
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.appendFile(FILE, JSON.stringify(row) + '\n');
  } catch (err) {
    console.error('persona-history: failed to persist:', err.message);
  }
  return row;
}

export async function list({ kind = null, target = null, limit = 50 } = {}) {
  await ensureLoaded();
  let rows = cache;
  if (kind) rows = rows.filter((r) => r.kind === kind);
  if (target) rows = rows.filter((r) => r.target === target);
  return rows.slice(-limit).reverse();
}

export async function getById(id) {
  await ensureLoaded();
  return cache.find((r) => r.id === id) || null;
}

export function _resetForTest() {
  cache = [];
  cacheLoaded = true;
}
