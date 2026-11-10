// Heartbeat "wake-up" plugin. On each tick, Claude re-reads its own
// memory files (MEMORY.md, today's daily note, the journal) and decides
// whether to surface anything to the owner — overdue todos, stale Saved items,
// unfollowed-up commitments. If nothing's worth saying, returns NONE and
// stays silent.
//
// Enable with WAKE_UP=1. Default interval 4 hours.

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { askClaude } from '../claude-agent.js';

const exec = promisify(execCb);

const WAKEUP_PROMPT = `[heartbeat wake-up]

You are tick-ing on your own heartbeat. Don't expect a question — the owner is not asking anything right now.

Briefly re-orient yourself:
1. Read MEMORY.md ("## Saved" section especially) — any items older than 24h that should be acted on or cleared?
2. Read today's daily note in memory/ — anything you said you'd follow up on?
3. Skim the last 20 lines of journal entries — any open commitments?

If you find ONE thing genuinely worth pinging the owner about right now, reply with a single short WhatsApp-friendly message starting with "🔔 " (the bell emoji). It must be specific (mention the thing, the date, what to do).

If nothing is worth interrupting him for, reply exactly: NONE

Do not chat. Do not explain. Either one bell-message or NONE.`;

export function wakeUpPlugin({
  intervalMs = Number(process.env.WAKEUP_INTERVAL_MS) || 4 * 60 * 60_000, // 4h
} = {}) {
  return {
    name: 'wake-up',
    intervalMs,
    async run({ jid }) {
      if (!jid) return null;
      try {
        // Use a synthetic JID so we don't pollute the owner's normal session.
        const reply = await askClaude(`wake-up::${jid}`, WAKEUP_PROMPT);
        const text = typeof reply === 'string' ? reply : reply?.text || '';
        const trimmed = text.trim();
        if (!trimmed || /^none\b/i.test(trimmed)) return null;
        // Only return when it's actually a bell-message — otherwise quiet.
        if (!trimmed.startsWith('🔔')) return null;
        return trimmed;
      } catch (err) {
        console.error('wake-up: failed', err.message);
        return null;
      }
    },
  };
}
