#!/usr/bin/env node
// Download audio or a short video clip from a URL via yt-dlp, then post it
// to the bot as a WhatsApp attachment. Use this when the owner pastes a YouTube
// (or Twitter/Insta/TikTok) URL and asks for the audio or a clip.
//
//   node scripts/yt-grab.mjs --to <phone_or_jid> --url <url> [--audio | --video]
//                            [--start 0:30 --end 1:45]  (optional trim)
//
// Audio output: mp3 (192k)  ·  Video output: mp4 (≤720p, capped at ~25 MB).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// Load .env (WEB_PORT + WEBHOOK_SECRET only).
try {
  const t = await fs.readFile(path.join(ROOT, '.env'), 'utf-8');
  for (const line of t.split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

function args() {
  const a = process.argv.slice(2);
  const out = { mode: 'audio' };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--to' || a[i] === '-t') out.to = a[++i];
    else if (a[i] === '--url' || a[i] === '-u') out.url = a[++i];
    else if (a[i] === '--audio') out.mode = 'audio';
    else if (a[i] === '--video') out.mode = 'video';
    else if (a[i] === '--start') out.start = a[++i];
    else if (a[i] === '--end') out.end = a[++i];
    else if (a[i] === '--caption') out.caption = a[++i];
  }
  return out;
}

const { to, url, mode, start, end, caption } = args();
if (!to || !url) {
  console.error('Usage: yt-grab --to <phone_or_jid> --url <url> [--audio|--video] [--start <ts> --end <ts>]');
  process.exit(2);
}

function normalizeJid(t) {
  if (t.includes('@')) return t;
  const digits = String(t).replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

const tmpdir = '/tmp/wa-bot-yt';
await fs.mkdir(tmpdir, { recursive: true });
const stem = `yt-${Date.now()}`;

function run(cmd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { err += b.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} exit ${code}: ${err.slice(0, 200)}`)));
  });
}

const ext = mode === 'audio' ? 'mp3' : 'mp4';
const outPath = path.join(tmpdir, `${stem}.${ext}`);

// First fetch to a generic name via yt-dlp; trim with ffmpeg if needed.
const dlPath = path.join(tmpdir, `${stem}.dl`);
const ytArgs = mode === 'audio'
  ? ['-x', '--audio-format', 'mp3', '--audio-quality', '192K', '-o', `${dlPath}.%(ext)s`, url]
  : ['-f', 'bv*[height<=720]+ba/b[height<=720]', '--merge-output-format', 'mp4', '-o', `${dlPath}.%(ext)s`, url];

try {
  await run('yt-dlp', ytArgs);
} catch (e) {
  console.error('yt-dlp failed:', e.message);
  process.exit(1);
}

// Find the actual file (yt-dlp picks the extension).
const found = (await fs.readdir(tmpdir)).find((f) => f.startsWith(`${stem}.dl.`));
if (!found) { console.error('yt-dlp produced no file'); process.exit(1); }
const downloaded = path.join(tmpdir, found);

// Trim if requested.
let final = downloaded;
if (start || end) {
  const ffArgs = ['-y'];
  if (start) ffArgs.push('-ss', start);
  if (end) ffArgs.push('-to', end);
  ffArgs.push('-i', downloaded, '-c', 'copy', outPath);
  await run('ffmpeg', ffArgs);
  final = outPath;
} else {
  await fs.rename(downloaded, outPath);
  final = outPath;
}

const stat = await fs.stat(final);
if (stat.size > 64 * 1024 * 1024) {
  console.error(`file too large for WhatsApp (${(stat.size / 1e6).toFixed(1)} MB > 64 MB cap)`);
  process.exit(1);
}

const jid = normalizeJid(to);
const port = process.env.WEB_PORT || '7777';
const headers = { 'Content-Type': 'application/json' };
if (process.env.WEBHOOK_SECRET) headers['x-webhook-secret'] = process.env.WEBHOOK_SECRET;
const res = await fetch(`http://127.0.0.1:${port}/webhook/send-file`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ jid, path: final, caption: caption || undefined, kind: mode === 'audio' ? 'audio' : 'video' }),
});
if (!res.ok) {
  console.error(`send failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log(`✓ sent ${mode} (${(stat.size / 1e6).toFixed(1)} MB) to ${jid}`);
