#!/usr/bin/env node
// TTS via Piper → send as a WhatsApp voice note. Use this whenever the user
// asks for a voice reply (in writing) and you have the text to speak.
//
// Usage:
//   node scripts/wa-say.mjs --to <phone_or_jid> --text "<what to say>"
//
// Reads PIPER_VOICE from .env. Falls back to a clear error if Piper isn't
// installed or the voice model isn't configured.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec as execCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execCb);

// Run a command with stdin text input. `exec` silently ignores its `input`
// option (it's only valid on execSync), which is why bare exec() left piper
// hanging on an empty stdin.
function runWithStdin(cmd, argv, stdin, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error(`timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 300)}`));
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// Load .env for PIPER_VOICE / PIPER_BIN / WEB_PORT.
try {
  const text = await fs.readFile(path.join(ROOT, '.env'), 'utf-8');
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to' || a === '-t') out.to = argv[++i];
    else if (a === '--text' || a === '-T') out.text = argv[++i];
    else if (a === '--voice') out.voice = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.to || !args.text) {
  console.error('Usage: node scripts/wa-say.mjs --to <phone_or_jid> --text "<message>"');
  process.exit(args.help ? 0 : 2);
}

function normalizeJid(to) {
  const s = String(to).trim();
  if (s.includes('@')) return s;
  const digits = s.replace(/\D/g, '');
  if (!digits) throw new Error(`invalid recipient: ${to}`);
  return `${digits}@s.whatsapp.net`;
}

const jid = normalizeJid(args.to);
const voice = args.voice || process.env.PIPER_VOICE;
if (!voice) {
  console.error('PIPER_VOICE not set in .env. Configure it first.');
  process.exit(1);
}
try { await fs.access(voice); }
catch { console.error(`voice model not found: ${voice}`); process.exit(1); }

const piperBin = process.env.PIPER_BIN || 'piper';
const tmpdir = '/tmp/wa-bot-tts';
await fs.mkdir(tmpdir, { recursive: true });
const stem = `say-${Date.now()}`;
const wav = path.join(tmpdir, `${stem}.wav`);
const ogg = path.join(tmpdir, `${stem}.ogg`);

const max = Number(process.env.TTS_MAX_CHARS) || 1500;
const speech = String(args.text).slice(0, max);

try {
  await runWithStdin(piperBin, ['--model', voice, '--output_file', wav], speech, { timeoutMs: 60_000 });
} catch (err) {
  console.error('piper failed:', err.message);
  process.exit(1);
}

try {
  await exec(
    `ffmpeg -y -i ${JSON.stringify(wav)} -c:a libopus -b:a 24k -application voip ${JSON.stringify(ogg)}`,
    { timeout: 30_000 },
  );
} catch (err) {
  console.error('ffmpeg failed:', err.message);
  process.exit(1);
}

const port = process.env.WEB_PORT || '7777';
const url = `http://127.0.0.1:${port}/webhook/send-file`;
const headers = { 'Content-Type': 'application/json' };
if (process.env.WEBHOOK_SECRET) headers['x-webhook-secret'] = process.env.WEBHOOK_SECRET;

try {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jid, path: ogg, kind: 'voice' }),
  });
  if (!res.ok) {
    console.error(`send failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log(`✓ spoke ${speech.length} chars to ${jid}`);
} catch (err) {
  console.error(`send error: ${err.message}`);
  process.exit(1);
}
