#!/usr/bin/env node
// Restart the bot. Only works when managed by pm2 (./encryptoai daemon).
// Foreground bots must be Ctrl+C'd and re-started manually — node can't
// gracefully replace its own TTY-attached process.
//
// NOTE: when this runs as a child spawned by the webui /restart endpoint it
// inherits the bot's env, and pm2 is often NOT on that PATH (it lives in the
// npm global bin, e.g. ~/.npm-global/bin). So we resolve the pm2 binary by
// absolute path instead of relying on PATH, and log the outcome to
// data/restart.log so a failed restart is never silent.

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LOG = path.join(ROOT, 'data', 'restart.log');

function log(line) {
  const stamp = new Date().toISOString();
  const entry = `${stamp}  ${line}\n`;
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); } catch {}
  try { fs.appendFileSync(LOG, entry); } catch {}
  process.stdout.write(entry);
}

// Resolve an absolute path to the pm2 binary without depending on PATH.
function findPm2() {
  const candidates = [];
  // 1. Whatever `command -v` finds, if PATH happens to include it.
  try {
    const p = execSync('command -v pm2', { encoding: 'utf-8' }).trim();
    if (p) candidates.push(p);
  } catch {}
  // 2. npm global prefix bin.
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf-8' }).trim();
    if (prefix) candidates.push(path.join(prefix, 'bin', 'pm2'));
  } catch {}
  // 3. Common absolute locations.
  const home = process.env.HOME || '';
  candidates.push(
    path.join(home, '.npm-global', 'bin', 'pm2'),
    '/usr/local/bin/pm2',
    '/usr/bin/pm2',
  );
  // 4. nvm installs.
  try {
    const nvmBase = path.join(home, '.nvm', 'versions', 'node');
    for (const v of fs.readdirSync(nvmBase)) {
      candidates.push(path.join(nvmBase, v, 'bin', 'pm2'));
    }
  } catch {}

  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

const pm2 = findPm2();
if (!pm2) {
  log('ERROR: pm2 binary not found — bot is not under pm2 (or pm2 uninstalled). Self-restart unavailable.');
  process.exit(1);
}

// Confirm the bot is actually managed by this pm2.
let managed = false;
try {
  const out = execSync(`"${pm2}" jlist`, { encoding: 'utf-8' });
  managed = out.includes('"name":"whatsapp-claude-bot"');
} catch (err) {
  log(`ERROR: pm2 jlist failed via ${pm2}: ${err.message}`);
  process.exit(1);
}

if (!managed) {
  log(`ERROR: whatsapp-claude-bot not found in pm2 process list (${pm2}). Not restarting.`);
  process.exit(1);
}

log(`restarting via ${pm2} restart whatsapp-claude-bot --update-env`);
// Detached + inherit env so the restart survives our parent dying, and
// --update-env picks up any changed environment on the way back up.
const child = spawn(pm2, ['restart', 'whatsapp-claude-bot', '--update-env'], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code) => {
  log(`pm2 restart exited with code ${code ?? 0}`);
  process.exit(code ?? 0);
});
child.on('error', (err) => {
  log(`ERROR: failed to spawn pm2: ${err.message}`);
  process.exit(1);
});
