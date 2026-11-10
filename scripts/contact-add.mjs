#!/usr/bin/env node
// Add a contact to the bot's allowlist via the running bot's web UI API.
// Used by Claude over Bash whenever the user says "add my friend X".
//
//   node scripts/contact-add.mjs --phone "+27 67 123 4567" --label "a contact"
//
// Exit codes: 0 = added, 1 = error. Prints JSON to stdout on success.

import process from 'node:process';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--phone' || a === '-p') out.phone = argv[++i];
    else if (a === '--label' || a === '-l' || a === '--name' || a === '-n') out.label = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--port') out.port = argv[++i];
  }
  return out;
}

function usage() {
  console.error('Usage: node scripts/contact-add.mjs --phone "+27 67 ..." [--label "Name"]');
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.phone) { usage(); process.exit(args.help ? 0 : 1); }

const host = args.host || process.env.WEB_HOST || '127.0.0.1';
const port = args.port || process.env.WEB_PORT || '7777';
const url = `http://${host}:${port}/api/contacts`;

try {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: args.phone, label: args.label || '' }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.ok === false) {
    console.error(body.error || `HTTP ${r.status}`);
    process.exit(1);
  }
  // Pretty single-line summary for chat use, plus JSON for parsers.
  const { label, phone, prettyPhone, resolved } = body;
  const name = label || prettyPhone || phone;
  console.log(`✓ Added ${name}${resolved ? ' (resolved @lid)' : ' (no @lid)'}`);
  console.log(JSON.stringify(body));
} catch (err) {
  console.error(`contact-add: ${err.message}`);
  process.exit(1);
}

// Auto-restart the bot so the new allowlist entry is loaded everywhere
// (the running socket has it in memory already, but a restart guarantees
// process.env.ALLOWED_JIDS is re-parsed for any module that read it once).
// Disable with --no-restart for tests / batched adds.
if (!process.argv.includes('--no-restart')) {
  try {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const { resolveNodePath } = await import('../src/util/node-path.js');
    const here = path.dirname(fileURLToPath(import.meta.url));
    // resolveNodePath() avoids ENOENT when process.execPath points at a stale
    // Homebrew Cellar path after `brew upgrade node`.
    const child = spawn(resolveNodePath(), [path.join(here, 'restart.mjs')], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (err) => {
      console.error(`contact-add: restart spawn failed: ${err.message}`);
    });
    child.unref();
  } catch (err) {
    console.error(`contact-add: restart threw: ${err.message}`);
  }
}
