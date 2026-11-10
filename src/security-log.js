// Security Incident Logger
// Tracks attempts to trick, impersonate, or extract info about the owner
//
// Usage:
//   logIncident({ who, what, action })  - record a security incident
//   getIncidents()                       - get all incidents
//   getRecentIncidents(hours)            - get incidents from last N hours

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INCIDENTS_FILE = path.join(__dirname, '../memory/security-incidents.json');

async function load() {
  try {
    const data = await fs.readFile(INCIDENTS_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return { incidents: [] };
  }
}

async function save(data) {
  await fs.mkdir(path.dirname(INCIDENTS_FILE), { recursive: true });
  await fs.writeFile(INCIDENTS_FILE, JSON.stringify(data, null, 2));
}

export async function logIncident({ who, what, action = 'Refused/blocked', reported = false }) {
  const data = await load();
  const id = `incident-${Date.now()}`;
  const incident = {
    id,
    timestamp: new Date().toISOString(),
    who,
    what,
    action,
    reported
  };
  data.incidents.push(incident);
  await save(data);
  return incident;
}

export async function markReported(id) {
  const data = await load();
  const incident = data.incidents.find(i => i.id === id);
  if (incident) {
    incident.reported = true;
    incident.reportedAt = new Date().toISOString();
    await save(data);
  }
}

export async function getIncidents() {
  const data = await load();
  return data.incidents || [];
}

export async function getRecentIncidents(hours = 24) {
  const data = await load();
  const cutoff = Date.now() - (hours * 60 * 60 * 1000);
  return (data.incidents || []).filter(i => new Date(i.timestamp).getTime() > cutoff);
}

export async function getUnreportedIncidents() {
  const data = await load();
  return (data.incidents || []).filter(i => !i.reported);
}
