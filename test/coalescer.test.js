import { test } from 'node:test';
import assert from 'node:assert/strict';

// Short windows so tests finish fast.
process.env.COALESCE_QUIET_MS = '40';
process.env.COALESCE_MAX_MS = '200';
const { coalesce, drainBuffered, bufferedCount, flushAll, _reset, _size } = await import('../src/coalescer.js');

function later(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('single message: fires after QUIET_MS', async () => {
  _reset();
  let got = null;
  coalesce('jid1', { id: 1 }, (batch) => { got = batch; });
  assert.equal(got, null);
  await later(80);
  assert.deepEqual(got, [{ id: 1 }]);
});

test('rapid messages: batched together, fires once', async () => {
  _reset();
  let got = null;
  coalesce('jid2', { id: 'a' }, (batch) => { got = batch; });
  await later(10);
  coalesce('jid2', { id: 'b' }, (batch) => { got = batch; });
  await later(10);
  coalesce('jid2', { id: 'c' }, (batch) => { got = batch; });
  await later(80);
  assert.deepEqual(got, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
});

test('different JIDs: independent buffers', async () => {
  _reset();
  const collected = {};
  coalesce('A', { x: 1 }, (b) => { collected.A = b; });
  coalesce('B', { x: 2 }, (b) => { collected.B = b; });
  await later(80);
  assert.equal(collected.A.length, 1);
  assert.equal(collected.B.length, 1);
});

test('MAX_MS: never waits longer than the cap', async () => {
  _reset();
  let got = null;
  const start = Date.now();
  coalesce('jid3', { id: 1 }, (b) => { got = b; });
  // Keep sending faster than QUIET_MS so debounce never settles on its own.
  for (let i = 0; i < 20; i++) {
    await later(20);
    if (got) break;
    coalesce('jid3', { id: i + 2 }, (b) => { got = b; });
  }
  // Should have fired by MAX_MS + a small buffer.
  const elapsed = Date.now() - start;
  assert.ok(got, 'expected batch to fire by max-wait');
  assert.ok(elapsed < 400, `expected fire within 400ms, took ${elapsed}ms`);
  assert.ok(got.length >= 2, `expected multiple msgs batched, got ${got.length}`);
});

test('drainBuffered: picks up messages added after timer fired', async () => {
  _reset();
  coalesce('jid4', { id: 'late' }, () => {});
  assert.equal(bufferedCount('jid4'), 1);
  const drained = drainBuffered('jid4');
  assert.deepEqual(drained, [{ id: 'late' }]);
  assert.equal(bufferedCount('jid4'), 0);
});

test('flushAll: forces every pending batch immediately', async () => {
  _reset();
  let counts = 0;
  coalesce('a', { x: 1 }, () => { counts++; });
  coalesce('b', { x: 2 }, () => { counts++; });
  flushAll();
  assert.equal(counts, 2);
  assert.equal(_size(), 0);
});
