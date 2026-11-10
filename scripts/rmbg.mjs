#!/usr/bin/env node
// Remove background from an image via `rembg`, then send the PNG result to
// a chat. Used when the owner says "rmbg" / "remove background" on an image.
//
//   node scripts/rmbg.mjs --to <phone_or_jid> --path <input.jpg> [--caption "<text>"]

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
try {
  const t = await fs.readFile(path.join(ROOT, '.env'), 'utf-8');
  for (const l of t.split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(l);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

function args() {
  const a = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--to') out.to = a[++i];
    else if (a[i] === '--path' || a[i] === '-p') out.input = a[++i];
    else if (a[i] === '--caption') out.caption = a[++i];
  }
  return out;
}

const { to, input, caption } = args();
if (!to || !input) { console.error('Usage: rmbg --to <phone_or_jid> --path <image>'); process.exit(2); }
try { await fs.access(input); } catch { console.error(`file not found: ${input}`); process.exit(1); }

const outdir = '/tmp/wa-bot-rmbg';
await fs.mkdir(outdir, { recursive: true });
const outPath = path.join(outdir, `rmbg-${Date.now()}.png`);

await new Promise((resolve, reject) => {
  const child = spawn('rembg', ['i', input, outPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (b) => { err += b.toString(); });
  child.on('error', reject);
  child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`rembg exit ${code}: ${err.slice(0, 200)}`)));
});

function normalizeJid(t) {
  if (t.includes('@')) return t;
  return `${String(t).replace(/\D/g, '')}@s.whatsapp.net`;
}

const jid = normalizeJid(to);
const port = process.env.WEB_PORT || '7777';
const headers = { 'Content-Type': 'application/json' };
if (process.env.WEBHOOK_SECRET) headers['x-webhook-secret'] = process.env.WEBHOOK_SECRET;
const res = await fetch(`http://127.0.0.1:${port}/webhook/send-file`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ jid, path: outPath, kind: 'image', caption }),
});
if (!res.ok) { console.error(`send failed: ${res.status}`); process.exit(1); }
console.log(`✓ sent transparent PNG to ${jid}`);
