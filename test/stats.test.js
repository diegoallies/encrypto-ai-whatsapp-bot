import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordMessage,
  recordError,
  recordChunks,
  snapshot,
  formatStats,
  resetStats,
} from '../src/stats.js';

test('counters accumulate correctly', () => {
  resetStats();
  recordMessage();
  recordMessage();
  recordChunks(3);
  recordError(new Error('boom'));
  const s = snapshot();
  assert.equal(s.messages, 2);
  assert.equal(s.chunksOut, 3);
  assert.equal(s.errors, 1);
  assert.equal(s.lastError, 'boom');
});

test('resetStats zeroes counters but keeps startedAt', () => {
  recordMessage();
  const before = snapshot();
  resetStats();
  const after = snapshot();
  assert.equal(after.messages, 0);
  assert.equal(after.errors, 0);
  assert.equal(after.chunksOut, 0);
  assert.equal(after.lastError, null);
  assert.equal(after.startedAt, before.startedAt);
});

test('formatStats includes the expected fields', () => {
  resetStats();
  recordMessage();
  recordChunks(2);
  const out = formatStats({ queueDepth: 1 });
  assert.match(out, /uptime/);
  assert.match(out, /messages: 1/);
  assert.match(out, /chunks sent: 2/);
  assert.match(out, /errors: 0/);
  assert.match(out, /queue depth: 1/);
});

test('formatStats omits queue depth when not provided', () => {
  resetStats();
  const out = formatStats();
  assert.doesNotMatch(out, /queue depth/);
});

test('formatStats includes last error when present', () => {
  resetStats();
  recordError(new Error('database died'));
  const out = formatStats();
  assert.match(out, /last error: database died/);
});
