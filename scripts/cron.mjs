#!/usr/bin/env node
// Cron CLI for EncryptoAI. Writes to the postgres `scheduled_jobs` table —
// the running bot polls a cheap fingerprint and picks up changes within ~5s
// without a restart.

import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Cron } from 'croner';
import { parseWhen, parseDuration } from '../src/cron-time.js';
import * as db from '../src/db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// Load .env so this CLI can connect to the same DB as the bot when invoked
// outside the bot's process (e.g. by Claude over Bash).
try {
  const dotenv = await import('node:fs/promises').then((m) => m.readFile(path.join(ROOT, '.env'), 'utf-8'));
  for (const line of dotenv.split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    if (!(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

function usage() {
  process.stdout.write(`Usage: cron <command> [options]

Commands:
  add [--at <when>] [--every <duration> | --cron <expr>] [--jid <jid>] (--notify <text> | --prompt <text>)
  list [--jid <jid>]
  rm <id>

<when>:
  ISO:        2026-05-20T09:00 / 2026-05-20T09:00:00Z
  Relative:   +30m, +2h, +1d, +1w
  Time today: 18:00 (today if future, tomorrow if past)

<duration> (for --every):
  30m, 2h, 1d, 1w

<expr> (for --cron, 5-field Unix cron):
  "0 8 * * *"      every day at 08:00
  "*/15 * * * *"   every 15 minutes
  "0 9 * * 1-5"    every weekday at 09:00

Examples:
  cron add --at +1h --notify "Take out the trash"
  cron add --every 30m --prompt "Check unread emails and summarize"
  cron add --cron "0 8 * * 1-5" --notify "Morning standup"
  cron list
  cron rm a1b2c3d4
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
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function defaultJid() {
  // Try postgres first (source of truth)
  try {
    const jids = await db.listAllowedJids();
    if (jids.length > 0) return jids[0];
  } catch {}
  // Fall back to env for compat
  const raw = process.env.ALLOWED_JIDS || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean)[0] || null;
}

async function cmdAdd(args) {
  if (!args.notify && !args.prompt) {
    console.error('one of --notify or --prompt is required');
    process.exit(2);
  }
  if (!args.at && !args.every && !args.cron) {
    console.error('one of --at, --every, or --cron is required');
    process.exit(2);
  }

  let recurring = null;
  if (args.every) {
    try { parseDuration(args.every); } catch (e) { console.error(e.message); process.exit(2); }
    recurring = { every: String(args.every) };
  } else if (args.cron) {
    try { new Cron(String(args.cron), { paused: true }); }
    catch (e) { console.error(`invalid cron expression: ${e.message}`); process.exit(2); }
    recurring = { cron: String(args.cron) };
  }

  let runAtISO;
  if (args.at) {
    runAtISO = parseWhen(args.at).toISOString();
  } else if (recurring?.every) {
    runAtISO = new Date(Date.now() + parseDuration(recurring.every)).toISOString();
  } else if (recurring?.cron) {
    const next = new Cron(recurring.cron, { paused: true }).nextRun();
    if (!next) { console.error('cron expression has no future runs'); process.exit(2); }
    runAtISO = next.toISOString();
  }

  const jid = args.jid || await defaultJid();
  if (!jid) {
    console.error('no --jid given and allowlist is empty');
    process.exit(2);
  }
  const mode = args.prompt ? 'prompt' : 'notify';
  const text = args.notify || args.prompt;
  const job = {
    id: crypto.randomUUID().slice(0, 8),
    jid,
    runAt: runAtISO,
    mode,
    text,
    createdAt: new Date().toISOString(),
    ...(recurring ? { recurring } : {}),
  };
  await db.upsertScheduledJob(job);
  const repeat = recurring ? ` recurring=${recurring.every ? `every ${recurring.every}` : `cron "${recurring.cron}"`}` : '';
  console.log(`scheduled id=${job.id} at=${job.runAt} mode=${mode}${repeat} text="${text}"`);
}

async function cmdList(args) {
  const jobs = await db.listScheduledJobs();
  const filter = args.jid ? (j) => j.jid === args.jid : () => true;
  const out = jobs.filter(filter);
  if (out.length === 0) { console.log('(no jobs)'); return; }
  for (const j of out) {
    const rep = j.recurring ? `  ↻ ${j.recurring.every ? `every ${j.recurring.every}` : `cron "${j.recurring.cron}"`}` : '';
    const paused = j.paused ? '  [paused]' : '';
    console.log(`${j.id}  ${j.runAt}  [${j.mode}]${rep}${paused}  ${j.text}`);
  }
}

async function cmdRm(id) {
  if (!id) { console.error('id required'); process.exit(2); }
  const ok = await db.deleteScheduledJob(id);
  if (!ok) { console.error(`no job with id ${id}`); process.exit(1); }
  console.log(`removed ${id}`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

try {
  if (cmd === 'add') await cmdAdd(args);
  else if (cmd === 'list') await cmdList(args);
  else if (cmd === 'rm' || cmd === 'remove') await cmdRm(args._[1]);
  else if (cmd === 'help' || !cmd) { usage(); process.exit(cmd ? 0 : 1); }
  else { console.error(`unknown command: ${cmd}`); usage(); process.exit(2); }
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
} finally {
  // pg pool keeps the event loop alive; close it so the CLI exits.
  await db.pool.end().catch(() => {});
}
