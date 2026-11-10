// Scheduled playbook runs. Each entry: { id, name, cron, target, params,
// persona, createdAt }. Cron expressions follow croner's syntax (5-field
// classic cron). On boot init() reads the JSON file and arms timers; we
// re-arm whenever an entry is added/removed.
//
// onFire is provided by the host (webui.js) so this module stays UI-free
// and easy to test.

import fs from 'node:fs/promises';
import path from 'node:path';
import { Cron } from 'croner';

const FILE = path.join('data', 'playbook-schedules.json');

let entries = [];
let timers = new Map();
let onFire = null;
let loaded = false;

async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [];
  } catch {
    entries = [];
  }
}

async function persist() {
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(entries, null, 2));
  } catch (err) {
    console.error('playbook-schedules: failed to persist:', err.message);
  }
}

function clearTimers() {
  for (const t of timers.values()) { try { t.stop(); } catch {} }
  timers.clear();
}

function armOne(entry) {
  try {
    const t = new Cron(entry.cron, { protect: true }, () => {
      if (!onFire) return;
      Promise.resolve(onFire(entry)).catch((err) => {
        console.error(`playbook-schedule ${entry.id} fire failed:`, err.message);
      });
    });
    timers.set(entry.id, t);
  } catch (err) {
    console.error(`playbook-schedule ${entry.id} invalid cron "${entry.cron}":`, err.message);
  }
}

function armAll() {
  clearTimers();
  for (const e of entries) armOne(e);
}

export async function initPlaybookSchedules({ onFire: cb } = {}) {
  onFire = cb || null;
  await load();
  armAll();
}

export async function listSchedules({ name } = {}) {
  await load();
  const out = name ? entries.filter((e) => e.name === name) : entries.slice();
  return out.map((e) => ({ ...e, nextRun: nextRunFor(e) }));
}

function nextRunFor(entry) {
  try {
    const t = timers.get(entry.id);
    if (t) {
      const d = t.nextRun();
      return d ? d.toISOString() : null;
    }
    const probe = new Cron(entry.cron);
    const d = probe.nextRun();
    try { probe.stop(); } catch {}
    return d ? d.toISOString() : null;
  } catch {
    return null;
  }
}

export async function addSchedule({ name, cron, target = null, params = null, persona = null }) {
  if (!name) throw new Error('name required');
  if (!cron) throw new Error('cron required');
  try { new Cron(cron).stop(); } catch (err) { throw new Error(`invalid cron: ${err.message}`); }
  await load();
  const entry = {
    id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    name: String(name),
    cron: String(cron).trim(),
    target,
    params,
    persona,
    createdAt: new Date().toISOString(),
  };
  entries.push(entry);
  await persist();
  armOne(entry);
  return { ...entry, nextRun: nextRunFor(entry) };
}

export async function removeSchedule(id) {
  await load();
  const before = entries.length;
  entries = entries.filter((e) => e.id !== id);
  if (entries.length === before) return false;
  const t = timers.get(id);
  if (t) { try { t.stop(); } catch {} timers.delete(id); }
  await persist();
  return true;
}

export function shutdownPlaybookSchedules() {
  clearTimers();
}

export function _resetForTest() {
  clearTimers();
  entries = [];
  loaded = true;
}
