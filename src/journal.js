// Build a "what's going on" context block from memory/YYYY-MM-DD.md so the
// agent SDK has long-term awareness across sessions. Injected into the
// system prompt by claude-agent.js on every turn (mtime-cached so it doesn't
// re-read the file unnecessarily).
//
// Layout in the daily note (one line per event):
//   - 2026-05-19T20:45:11  rx <jid> <text>
//   - 2026-05-19T20:45:22  tx <jid> <reply preview>
//   - 2026-05-19T20:52:00  added contact a contact (+27 67 …)
//
// We keep the LAST `MAX_TODAY_LINES` from today and a short tail from
// yesterday so cross-midnight context isn't lost.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dailyNotePath } from './memory.js';

// Rx/tx no longer logged here (those live in the Postgres `messages` table).
// Daily notes are now bot actions only — much higher signal per line, so we
// can cut the default tail size dramatically.
const MAX_TODAY_LINES = Number(process.env.JOURNAL_TODAY_LINES) || 15;
const MAX_YESTERDAY_LINES = Number(process.env.JOURNAL_YESTERDAY_LINES) || 5;

const cache = new Map(); // filepath → { mtime, content }

async function readDayTail(file, maxLines) {
  try {
    const stat = await fs.stat(file);
    const cached = cache.get(file);
    if (cached && cached.mtime === stat.mtimeMs) return cached.content;
    const raw = await fs.readFile(file, 'utf-8');
    // Skip the header line ("# 2026-05-19") and blank lines; keep only events.
    const lines = raw.split('\n').filter((l) => l.startsWith('- '));
    const tail = lines.slice(-maxLines).join('\n');
    cache.set(file, { mtime: stat.mtimeMs, content: tail });
    return tail;
  } catch {
    return '';
  }
}

function dayBefore(d) {
  const out = new Date(d);
  out.setDate(out.getDate() - 1);
  return out;
}

// Returns a markdown block ready to drop into the system prompt. Empty
// string if there's nothing worth saying.
export async function buildJournalContext(now = new Date()) {
  const todayFile = dailyNotePath(now);
  const yesterdayFile = dailyNotePath(dayBefore(now));
  const [today, yesterday] = await Promise.all([
    readDayTail(todayFile, MAX_TODAY_LINES),
    readDayTail(yesterdayFile, MAX_YESTERDAY_LINES),
  ]);

  if (!today && !yesterday) return '';

  const parts = ['# Journal (your own activity log)'];
  if (today) parts.push(`\n## Today\n${today}`);
  if (yesterday) parts.push(`\n## Yesterday (tail)\n${yesterday}`);
  parts.push(
    '\n_Use this to recall what you (the bot) have been doing across restarts._\n' +
    '_For a full history, read the full file: `' + todayFile + '`._',
  );
  return parts.join('\n');
}

export function _clearJournalCache() { cache.clear(); }
