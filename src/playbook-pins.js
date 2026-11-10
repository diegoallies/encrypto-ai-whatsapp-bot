// Pin / favorite store. Tiny JSON file. List of playbook names ordered by
// pin time (first = most recently pinned). Used to surface 3–4 playbooks at
// the top of the grid.

import fs from 'node:fs/promises';
import path from 'node:path';

const FILE = path.join('data', 'playbook-pins.json');
let cache = null;

async function load() {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    cache = Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist() {
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('playbook-pins: failed to persist:', err.message);
  }
}

export async function listPins() {
  return [...(await load())];
}

export async function isPinned(name) {
  const list = await load();
  return list.includes(name);
}

export async function togglePin(name) {
  const list = await load();
  const i = list.indexOf(name);
  if (i >= 0) list.splice(i, 1);
  else list.unshift(name);
  cache = list;
  await persist();
  return list.includes(name);
}

export function _resetForTest() {
  cache = [];
}
