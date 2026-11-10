// Daily tarball of auth_info_baileys/ to ~/wa-bot-backups/. Keeps the
// last AUTH_BACKUP_KEEP (default 7) backups. Silent — no chat notifications.

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execCb);

export function authBackupPlugin({ keep = Number(process.env.AUTH_BACKUP_KEEP) || 7 } = {}) {
  return {
    name: 'auth-backup',
    intervalMs: 24 * 60 * 60_000, // daily
    async run() {
      const dest = path.join(os.homedir(), 'wa-bot-backups');
      await fs.mkdir(dest, { recursive: true });
      try {
        await fs.access('auth_info_baileys');
      } catch {
        return null; // nothing to back up
      }
      const ts = new Date().toISOString().slice(0, 10);
      const tarPath = path.join(dest, `auth-${ts}.tar.gz`);
      await exec(`tar czf ${JSON.stringify(tarPath)} auth_info_baileys/`, { timeout: 60_000 });
      // Trim old backups beyond `keep`.
      try {
        await exec(`ls -t ${dest}/auth-*.tar.gz 2>/dev/null | tail -n +${keep + 1} | xargs -r rm -f`);
      } catch {}
      console.log(`auth-backup: wrote ${tarPath}`);
      return null;
    },
  };
}
