import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Build a fake memory/ tree in a tmp dir and chdir for the duration of this
// file (journal.js uses dailyNotePath() which is cwd-relative). We restore
// cwd at the bottom.
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-test-'));
await fs.mkdir(path.join(TMP, 'memory'), { recursive: true });
const ORIGINAL_CWD = process.cwd();
process.chdir(TMP);

function dayFile(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return path.join('memory', `${y}-${m}-${day}.md`);
}

test('builds a Today + Yesterday block from daily notes', async () => {
  const now = new Date();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);

  await fs.writeFile(dayFile(now), '# today\n\n- 09:00  rx the owner: hi\n- 09:05  tx the owner: yo\n');
  await fs.writeFile(dayFile(yesterday), '# yest\n\n- 22:00  rx the owner: gn\n');

  const { buildJournalContext, _clearJournalCache } = await import(`../src/journal.js?v=${Date.now()}`);
  _clearJournalCache();
  const ctx = await buildJournalContext(now);

  assert.match(ctx, /Today/);
  assert.match(ctx, /rx the owner: hi/);
  assert.match(ctx, /tx the owner: yo/);
  assert.match(ctx, /Yesterday/);
  assert.match(ctx, /rx the owner: gn/);
});

test('returns empty string when there are no notes', async () => {
  // Use a future date so neither file exists.
  const future = new Date('2099-12-31T12:00:00');
  const { buildJournalContext, _clearJournalCache } = await import(`../src/journal.js?v=${Date.now()}`);
  _clearJournalCache();
  const ctx = await buildJournalContext(future);
  assert.equal(ctx, '');
});

test('respects JOURNAL_TODAY_LINES env', async () => {
  process.env.JOURNAL_TODAY_LINES = '3';
  const now = new Date();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  // Make sure yesterday's file is gone — earlier tests may have written it.
  await fs.rm(dayFile(yesterday), { force: true });
  const lines = Array.from({ length: 20 }, (_, i) => `- 10:${String(i).padStart(2, '0')}  evt ${i}`).join('\n');
  await fs.writeFile(dayFile(now), `# day\n\n${lines}\n`);
  const { buildJournalContext, _clearJournalCache } = await import(`../src/journal.js?v=${Date.now()}`);
  _clearJournalCache();
  const ctx = await buildJournalContext(now);
  // Should have only 3 event lines (today only, no yesterday).
  const eventLines = ctx.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(eventLines.length, 3);
  delete process.env.JOURNAL_TODAY_LINES;
});

test.after(() => { process.chdir(ORIGINAL_CWD); });
