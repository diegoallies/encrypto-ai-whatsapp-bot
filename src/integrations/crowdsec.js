// CrowdSec → WhatsApp heartbeat plugin. Polls `cscli decisions list -o json`
// on the running container and forwards new bans/captchas to the primary JID.
// Deduped via the last-seen decision ID (kept in heartbeat-state.json).
//
// Enable with: CROWDSEC=1  (container name override: CROWDSEC_CONTAINER=crowdsec)

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { getState, updateState } from '../memory.js';

const exec = promisify(execCb);

async function have(cmd) {
  try { await exec(`command -v ${cmd}`); return true; } catch { return false; }
}

async function containerRunning(name) {
  try {
    const { stdout } = await exec(`docker inspect -f '{{.State.Running}}' ${JSON.stringify(name)} 2>/dev/null`);
    return stdout.trim() === 'true';
  } catch { return false; }
}

export function crowdsecPlugin({
  intervalMs = Number(process.env.CROWDSEC_INTERVAL_MS) || 15 * 60_000,
  container = process.env.CROWDSEC_CONTAINER || 'crowdsec',
} = {}) {
  return {
    name: 'crowdsec',
    intervalMs,
    async run() {
      if (!(await have('docker'))) return null;
      if (!(await containerRunning(container))) return null;
      let decisions;
      try {
        const { stdout } = await exec(
          `docker exec ${JSON.stringify(container)} cscli decisions list -o json`,
          { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
        );
        decisions = JSON.parse(stdout);
      } catch (err) {
        // Permission denied / cscli missing — quiet fail.
        return null;
      }
      if (!Array.isArray(decisions)) return null;

      const state = await getState();
      const seen = new Set(state.lastChecks?.['crowdsec-ids'] || []);
      const fresh = [];
      const ids = [];
      for (const d of decisions) {
        const id = String(d.id ?? d.value ?? '');
        if (!id) continue;
        ids.push(id);
        if (!seen.has(id)) fresh.push(d);
      }
      // Persist the current ID set so we only alert on truly new decisions.
      await updateState((s) => {
        s.lastChecks['crowdsec-ids'] = ids.slice(-500);
        return s;
      }).catch(() => {});

      if (fresh.length === 0) return null;
      const lines = fresh.slice(0, 5).map((d) => {
        const ip = d.value || d.source?.ip || '?';
        const reason = d.scenario || d.type || 'decision';
        const dur = d.duration || '';
        return `• ${ip} — ${reason}${dur ? ` (${dur})` : ''}`;
      });
      const more = fresh.length > 5 ? `\n…+${fresh.length - 5} more` : '';
      return `🛡️ CrowdSec — ${fresh.length} new decision${fresh.length === 1 ? '' : 's'}:\n${lines.join('\n')}${more}`;
    },
  };
}
