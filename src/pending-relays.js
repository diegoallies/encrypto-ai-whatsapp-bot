// Pending Relays Tracker
// Tracks promises to relay information back to the owner and reminds via heartbeat
//
// Usage:
//   addRelay({ from, summary, promisedAt })  - record a promise to relay info
//   getRelays()                               - get all pending relays
//   clearRelay(id)                            - mark a relay as done
//   clearAllRelays()                          - clear all pending relays

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAYS_FILE = path.join(__dirname, '../memory/pending-relays.json');

async function load() {
  try {
    const data = await fs.readFile(RELAYS_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return { relays: [] };
  }
}

async function save(data) {
  await fs.mkdir(path.dirname(RELAYS_FILE), { recursive: true });
  await fs.writeFile(RELAYS_FILE, JSON.stringify(data, null, 2));
}

export async function addRelay({ from, summary, promisedAt = new Date().toISOString() }) {
  const data = await load();
  const id = `relay-${Date.now()}`;
  data.relays.push({ id, from, summary, promisedAt, reminded: false });
  await save(data);
  return id;
}

export async function getRelays() {
  const data = await load();
  return data.relays || [];
}

export async function clearRelay(id) {
  const data = await load();
  data.relays = data.relays.filter(r => r.id !== id);
  await save(data);
}

export async function clearAllRelays() {
  await save({ relays: [] });
}

export async function markReminded(id) {
  const data = await load();
  const relay = data.relays.find(r => r.id === id);
  if (relay) {
    relay.reminded = true;
    relay.remindedAt = new Date().toISOString();
    await save(data);
  }
}
