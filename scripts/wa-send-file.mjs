#!/usr/bin/env node
// Send a local file as a WhatsApp attachment. Auto-detects image/video/
// audio/document from file extension. Hits the bot's /webhook/send-file.
//
// Usage:
//   node scripts/wa-send-file.mjs --to <phone_or_jid> --path /abs/path.png
//   node scripts/wa-send-file.mjs --to <phone_or_jid> --path /abs/cat.jpg --caption "look"
//   node scripts/wa-send-file.mjs --to <phone_or_jid> --path /abs/doc.pdf --kind document

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
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {}
}
loadDotenv();

function usage() {
  process.stdout.write(`Usage: wa-send-file --to <phone_or_jid> --path <absolute_path> [--caption "<text>"] [--kind image|video|audio|document]

The bot must be running. Kind is auto-detected from extension if omitted.

Examples:
  wa-send-file --to +000000000 --path /home/me/photo.jpg --caption "Look"
  wa-send-file --to 000000000@s.whatsapp.net --path /tmp/report.pdf
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
if (!args.to || !args.path) { usage(); process.exit(2); }

const filePath = path.resolve(args.path);
if (!fs.existsSync(filePath)) { console.error(`file not found: ${filePath}`); process.exit(1); }

const jid = normalizeJid(args.to);
const port = process.env.WEB_PORT || '7777';
const url = `http://127.0.0.1:${port}/webhook/send-file`;
const headers = { 'Content-Type': 'application/json' };
if (process.env.WEBHOOK_SECRET) headers['x-webhook-secret'] = process.env.WEBHOOK_SECRET;

try {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jid, path: filePath, caption: args.caption || undefined, kind: args.kind || undefined }),
  });
  if (!res.ok) {
    console.error(`send failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const body = await res.json();
  console.log(`✓ sent ${body.kind} to ${jid}`);
} catch (err) {
  console.error(`send error: ${err.message}`);
  console.error(`(is the bot running on ${url}?)`);
  process.exit(1);
}
