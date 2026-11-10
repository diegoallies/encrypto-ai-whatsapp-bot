#!/usr/bin/env node
// Send a WhatsApp message to any phone number or JID via the bot's local
// webhook. Used by Claude (and humans) to reach out beyond the current chat.
//
// The bot must be running. Webhook lives at http://127.0.0.1:WEB_PORT/webhook/alert.
//
// Usage:
//   node scripts/wa-send.mjs --to <phone_or_jid> --text "<message>"
//
// Examples:
//   node scripts/wa-send.mjs --to +000000000 --text "Hi from the bot"
//   node scripts/wa-send.mjs --to 000000000@s.whatsapp.net --text "Standup at 9"

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function loadDotenv() {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf-8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      if (!(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {}
}
loadDotenv();

function usage() {
  process.stdout.write(`Usage: wa-send --to <phone_or_jid> --text "<message>" [--title "<prefix>"] [--track "<topic>"]

Phone numbers (with or without +, dashes, spaces) are normalised to JIDs.
JIDs ending in @s.whatsapp.net or @lid are used as-is.

Options:
  --track "<topic>"   Track this message and notify the owner when recipient replies.
                      Use when the owner asks you to message someone.

Examples:
  wa-send --to +000000000 --text "Hi"
  wa-send --to 000000000@s.whatsapp.net --text "Standup time"
  wa-send --to +000000000 --text "Sync your tickets" --track "ticket sync"
`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('--')) { out[k] = v; i += 1; }
      else { out[k] = true; }
    } else out._.push(a);
  }
  return out;
}

function normalizeJid(to) {
  if (!to) throw new Error('--to required');
  const s = String(to).trim();
  if (s.includes('@')) return s;
  const digits = s.replace(/\D/g, '');
  if (!digits) throw new Error(`invalid recipient: ${to}`);
  return `${digits}@s.whatsapp.net`;
}

const args = parseArgs(process.argv.slice(2));
if (!args.to || !args.text) { usage(); process.exit(2); }

const jid = normalizeJid(args.to);
const port = process.env.WEB_PORT || '7777';
const host = '127.0.0.1';
const url = `http://${host}:${port}/webhook/alert`;
const headers = { 'Content-Type': 'application/json' };
if (process.env.WEBHOOK_SECRET) headers['x-webhook-secret'] = process.env.WEBHOOK_SECRET;

// Resolve who we're about to message via the whois helper — surfaced in the
// output so callers (Claude over Bash) get a visible cue if they got the
// number wrong. We do not block on this; failure to resolve is non-fatal.
async function whois(jidOrPhone) {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { resolveNodePath } = await import('../src/util/node-path.js');
    const exec = promisify(execFile);
    const here = path.dirname(fileURLToPath(import.meta.url));
    // resolveNodePath() avoids ENOENT when process.execPath points at a stale
    // Homebrew Cellar path after `brew upgrade node`.
    const { stdout } = await exec(resolveNodePath(), [path.join(here, 'whois.mjs'), jidOrPhone], { timeout: 8_000 });
    const lines = stdout.trim().split('\n');
    const json = lines[lines.length - 1];
    return JSON.parse(json);
  } catch { return null; }
}

const who = await whois(jid);
const display = who?.label || who?.name || who?.phoneJid || jid;
console.log(`→ ${display}${who?.allowlisted === false ? '  [STRANGER]' : ''}`);

try {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jid, text: String(args.text), title: args.title || undefined }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`send failed: ${res.status} ${body}`);
    if (res.status === 0 || res.status >= 500) {
      console.error(`(is the bot running? try: curl -s http://${host}:${port}/stats.json)`);
    }
    process.exit(1);
  }
  console.log(`✓ sent to ${display} (${jid})`);

  // Track for reply notification if --track was passed
  if (args.track) {
    try {
      const { addPending } = await import('../src/pending-replies.js');
      addPending(jid, String(args.track));
      console.log(`📋 tracking reply from ${display}`);
    } catch (err) {
      console.error(`tracking failed: ${err.message}`);
    }
  }
} catch (err) {
  console.error(`send error: ${err.message}`);
  console.error(`(is the bot running on ${url}?)`);
  process.exit(1);
}
