// Email check plugin backed by the `himalaya` CLI. No-op when himalaya
// isn't installed or HEARTBEAT_EMAIL_CHECK is unset.

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { getState, updateState } from '../memory.js';

const exec = promisify(execCb);

async function have(cmd) {
  try { await exec(`command -v ${cmd}`); return true; } catch { return false; }
}

async function unreadCount(account) {
  const a = account ? ` -a ${account}` : '';
  try {
    const { stdout } = await exec(
      `himalaya${a} envelopes list --filter 'flag NEW' -o json 2>/dev/null`,
      { timeout: 15_000 },
    );
    const arr = JSON.parse(stdout);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function sendEmail({ to, subject, body, account = process.env.HIMALAYA_ACCOUNT || '' }) {
  if (!to || !subject) throw new Error('to and subject required');
  if (!(await have('himalaya'))) throw new Error('himalaya CLI not installed');
  const a = account ? ` -a ${account}` : '';
  const message = `Subject: ${subject}\nTo: ${to}\n\n${body || ''}`;
  await exec(
    `printf %s ${JSON.stringify(message)} | himalaya${a} message send`,
    { timeout: 30_000 },
  );
  return { ok: true };
}

export function emailCheckPlugin({
  intervalMs = 30 * 60_000,
  account = process.env.HIMALAYA_ACCOUNT || '',
} = {}) {
  return {
    name: 'email-check',
    intervalMs,
    async run() {
      if (!(await have('himalaya'))) return null;
      const unread = await unreadCount(account);
      if (unread.length === 0) return null;

      // Suppress duplicates: only notify when the unread set grew or rotated.
      const state = await getState();
      const lastIds = state.lastChecks?.['email-ids'] || [];
      const ids = unread.map((e) => e.id || e.uid || e.subject).filter(Boolean);
      const isSame = ids.length === lastIds.length && ids.every((id, i) => id === lastIds[i]);
      if (isSame) return null;
      await updateState((s) => {
        s.lastChecks['email-ids'] = ids;
        return s;
      }).catch(() => {});

      const head = unread.slice(0, 5).map((e) => {
        const from = e.from?.name || e.from?.addr || e.from || '?';
        const subj = e.subject || '(no subject)';
        return `• ${from}: ${subj}`;
      });
      const more = unread.length > 5 ? `\n…and ${unread.length - 5} more` : '';
      return `📧 ${unread.length} unread email${unread.length === 1 ? '' : 's'}:\n${head.join('\n')}${more}`;
    },
  };
}
