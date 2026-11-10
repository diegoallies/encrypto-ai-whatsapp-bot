// Heartbeat plugin: runs scripts/git-backup.mjs once a day (configurable).
// Silent — failures log to console only.

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execCb);

export function gitBackupPlugin({ intervalMs = 24 * 60 * 60_000 } = {}) {
  return {
    name: 'git-backup',
    intervalMs,
    async run() {
      const script = path.resolve('scripts/git-backup.mjs');
      try {
        const { stdout } = await exec(`node ${JSON.stringify(script)}`, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
        const line = stdout.trim().split('\n').pop();
        if (line) console.log(`git-backup: ${line}`);
      } catch (err) {
        console.error('git-backup: failed:', (err.stderr || err.message || '').toString().slice(0, 300));
      }
    },
  };
}
