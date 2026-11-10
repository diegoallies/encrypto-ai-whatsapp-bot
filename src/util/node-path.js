// Resilient resolver for the node binary path used when spawning child
// node processes from a long-running service (the WhatsApp bot).
//
// Why: inside a long-lived process, `process.execPath` is frozen to whatever
// resolved node when the process started. On macOS with Homebrew that is
// commonly a version-pinned Cellar path like
//   /opt/homebrew/Cellar/node@22/22.23.2_1/bin/node
// When brew later bumps node (22.23.2_1 -> 22.23.2_2) the pinned path no
// longer exists on disk. Any subsequent spawn(process.execPath, ...) then
// throws ENOENT, and if unhandled it crashes the bot with uncaughtException.
//
// Preference order:
//   1. process.execPath, if it still exists on disk
//   2. /opt/homebrew/opt/node@22/bin/node (brew-managed symlink that
//      survives version bumps)
//   3. bare "node" (let the OS resolve via PATH)

import fs from 'node:fs';
import process from 'node:process';

const BREW_NODE_22 = '/opt/homebrew/opt/node@22/bin/node';
const BREW_NODE = '/opt/homebrew/bin/node';

function isFile(p) {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

let cached = null;

export function resolveNodePath() {
  if (cached) return cached;
  if (isFile(process.execPath)) {
    cached = process.execPath;
    return cached;
  }
  if (isFile(BREW_NODE_22)) {
    cached = BREW_NODE_22;
    return cached;
  }
  if (isFile(BREW_NODE)) {
    cached = BREW_NODE;
    return cached;
  }
  cached = 'node';
  return cached;
}

// For tests only.
export function _resetNodePathCache() {
  cached = null;
}
