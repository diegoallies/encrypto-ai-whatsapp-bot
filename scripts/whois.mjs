#!/usr/bin/env node
// Resolve a phone or JID to a contact name/label. Use this BEFORE wa-send so
// you know who you're actually messaging. Prints JSON.
//
//   node scripts/whois.mjs +000000000
//   node scripts/whois.mjs 000000000@s.whatsapp.net
//   node scripts/whois.mjs 24666651549925@lid

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import * as db from '../src/db.js';

const exec = promisify(execCb);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// Load .env for DB connection
try {
  const dotenv = await fs.readFile(path.join(ROOT, '.env'), 'utf-8');
  for (const line of dotenv.split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    if (!(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/whois.mjs <phone|jid>');
  process.exit(2);
}

function normalize(s) {
  if (s.includes('@')) return { jid: s, digits: s.split('@')[0].replace(/\D/g, '') };
  const digits = s.replace(/\D/g, '');
  return { jid: digits ? `${digits}@s.whatsapp.net` : null, digits };
}

const { jid, digits } = normalize(input);
const result = { input, jid, digits, label: null, name: null, lid: null, phoneJid: null, allowlisted: false };

// 1. Local data/contacts.json (the label you set when adding via contact-add).
try {
  const raw = await fs.readFile(path.join(ROOT, 'data', 'contacts.json'), 'utf-8');
  const all = JSON.parse(raw);
  if (digits && all[digits]) {
    result.label = all[digits].label || null;
    result.phoneJid = all[digits].phoneJid || null;
    result.lid = all[digits].lid || null;
  }
} catch {}

// 2. Postgres allowlist membership (source of truth)
try {
  const allowed = await db.listAllowedJids();
  result.allowlisted = allowed.includes(jid) || (result.lid && allowed.includes(result.lid));
} catch {
  // Fall back to .env for compat
  try {
    const envText = await fs.readFile(path.join(ROOT, '.env'), 'utf-8');
    const m = envText.match(/^ALLOWED_JIDS=(.*)$/m);
    if (m) {
      const envAllowed = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      result.allowlisted = envAllowed.includes(jid) || (result.lid && envAllowed.includes(result.lid));
    }
  } catch {}
}

// 3. wacli show — works for both @s.whatsapp.net and @lid.
async function wacliShow(store, j) {
  try {
    const { stdout } = await exec(
      `wacli --store ${JSON.stringify(store)} contacts show --jid ${JSON.stringify(j)} --json`,
      { timeout: 5_000 },
    );
    const body = JSON.parse(stdout);
    if (body?.success && body.data) return body.data;
  } catch {}
  return null;
}
for (const store of ['$HOME/.wacli-main', '$HOME/.wacli-alt']) {
  if (result.name) break;
  const d = await wacliShow(store, jid);
  if (d) {
    result.name = d.Alias || d.Name || result.name;
    if (!result.lid && jid.endsWith('@s.whatsapp.net')) result.lid = d.JID;
  }
}

const display = result.label || result.name || result.phoneJid || result.jid || input;
console.log(`who: ${display}${result.allowlisted ? '  [allowlisted]' : '  [STRANGER]'}`);
console.log(JSON.stringify(result));
