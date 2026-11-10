#!/usr/bin/env node
// Snapshots the bot's living state to a dedicated git branch so you can
// roll back if memory/data/playbooks get corrupted or accidentally edited.
//
// What it commits: memory/, data/chats/, data/contacts.json, data/sessions.json,
// data/scheduled.json, playbooks/, .env.example, MEMORY.md
//
// What it explicitly NEVER commits: auth_info_baileys/ (creds!), .env (secrets!),
// logs/, node_modules/.
//
// Strategy: orphan branch (default `bot-state-backup`) that lives parallel to
// main. Each run adds one commit. Configurable via env:
//   GIT_BACKUP=0           disable
//   GIT_BACKUP_BRANCH=...  default "bot-state-backup"
//   GIT_BACKUP_REMOTE=...  push target, default skipped (local only)

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const BRANCH = process.env.GIT_BACKUP_BRANCH || 'bot-state-backup';
const REMOTE = process.env.GIT_BACKUP_REMOTE || null;
const ENABLED = process.env.GIT_BACKUP !== '0';

const PATHS = [
  'memory',
  'data/chats',
  'data/contacts.json',
  'data/sessions.json',
  'data/scheduled.json',
  'playbooks',
  '.env.example',
  'MEMORY.md',
];

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf-8', ...opts }).trim();
}

function tryRun(cmd) {
  try { return run(cmd); } catch (err) { return { error: err.message.slice(0, 200) }; }
}

if (!ENABLED) { console.log('git-backup: disabled (GIT_BACKUP=0)'); process.exit(0); }

// Sanity: we need git installed and a repo here.
try { run('git rev-parse --is-inside-work-tree'); }
catch { console.error('git-backup: not in a git repo, skipping'); process.exit(1); }

const currentBranch = tryRun('git symbolic-ref --short HEAD');
const stash = tryRun('git stash list');

// Build a temporary worktree-less commit via the index. We don't want to
// switch the user's working branch — that'd be disruptive.
const treeId = (() => {
  // Snapshot the current branch index, then add only our paths fresh.
  const existing = PATHS.filter((p) => existsSync(p));
  if (existing.length === 0) { console.log('git-backup: nothing to back up'); process.exit(0); }

  // Use a temporary index to avoid touching the user's staged changes.
  const tmpIndex = path.join(process.cwd(), '.git', 'BOT_BACKUP_INDEX');
  try { run(`rm -f "${tmpIndex}"`); } catch {}
  for (const p of existing) {
    run(`git --git-dir=.git add --force "${p}"`, { env: { ...process.env, GIT_INDEX_FILE: tmpIndex } });
  }
  const tree = run('git write-tree', { env: { ...process.env, GIT_INDEX_FILE: tmpIndex } });
  return tree;
})();

// Find the previous backup commit (if any) on BRANCH to use as parent.
let parent = null;
try {
  parent = run(`git rev-parse refs/heads/${BRANCH}`);
} catch {}

const msg = `bot-state-backup ${new Date().toISOString()}`;
const cmd = parent
  ? `git commit-tree ${treeId} -p ${parent} -m "${msg}"`
  : `git commit-tree ${treeId} -m "${msg}"`;
const commit = run(cmd);
run(`git update-ref refs/heads/${BRANCH} ${commit}`);

console.log(`git-backup: committed ${commit.slice(0, 10)} on ${BRANCH}`);

if (REMOTE) {
  try {
    run(`git push ${REMOTE} ${BRANCH}:${BRANCH}`);
    console.log(`git-backup: pushed to ${REMOTE}`);
  } catch (err) {
    console.error(`git-backup: push failed:`, err.message.slice(0, 200));
  }
}
