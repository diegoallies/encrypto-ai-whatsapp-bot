#!/usr/bin/env node
// Convert an image to a WhatsApp sticker (512×512 webp, ≤100KB), then send
// it. Uses sharp (already a dep). When the owner sends an image and asks
// "make it a sticker", Claude calls this.
//
//   node scripts/sticker.mjs --to <phone_or_jid> --path <image>

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  }
  return out;
}

const { to, input } = args();
if (!to || !input) { console.error('Usage: sticker --to <phone_or_jid> --path <image>'); process.exit(2); }

const sharp = (await import('sharp')).default;
const outPath = `/tmp/wa-bot-sticker-${Date.now()}.webp`;
// 512×512, fit inside, transparent letterbox, webp quality auto-tuned to ≤100 KB.
let quality = 90;
let buf;
while (quality >= 30) {
  buf = await sharp(input)
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality, effort: 6 })
    .toBuffer();
  if (buf.length <= 100 * 1024) break;
  quality -= 10;
}
await fs.writeFile(outPath, buf);

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
  body: JSON.stringify({ jid, path: outPath, kind: 'sticker' }),
});
if (!res.ok) { console.error(`send failed: ${res.status} ${await res.text()}`); process.exit(1); }
console.log(`✓ sent sticker (${(buf.length / 1024).toFixed(1)} KB, q=${quality}) to ${jid}`);
