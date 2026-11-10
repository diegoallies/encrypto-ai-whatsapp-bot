import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWhen } from '../src/cron-time.js';

const FIXED = new Date('2026-05-18T12:00:00Z');

test('relative minutes', () => {
  const d = parseWhen('+30m', FIXED);
  assert.equal(d.getTime() - FIXED.getTime(), 30 * 60_000);
});

test('relative hours', () => {
  const d = parseWhen('+2h', FIXED);
  assert.equal(d.getTime() - FIXED.getTime(), 2 * 3_600_000);
});

test('relative days', () => {
  const d = parseWhen('+1d', FIXED);
  assert.equal(d.getTime() - FIXED.getTime(), 86_400_000);
});

test('HH:MM later today', () => {
  const now = new Date('2026-05-18T10:00:00');
  const d = parseWhen('18:00', now);
  assert.equal(d.getHours(), 18);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getDate(), 18);
});

test('HH:MM earlier today rolls to tomorrow', () => {
  const now = new Date('2026-05-18T20:00:00');
  const d = parseWhen('09:00', now);
  assert.equal(d.getDate(), 19);
  assert.equal(d.getHours(), 9);
});

test('invalid HH:MM throws', () => {
  assert.throws(() => parseWhen('25:00', FIXED));
  assert.throws(() => parseWhen('12:99', FIXED));
});

test('ISO 8601 timestamp', () => {
  const d = parseWhen('2026-05-20T09:00:00Z', FIXED);
  assert.equal(d.toISOString(), '2026-05-20T09:00:00.000Z');
});

test('empty / null throws', () => {
  assert.throws(() => parseWhen(''));
  assert.throws(() => parseWhen(null));
  assert.throws(() => parseWhen('   '));
});

test('garbage throws', () => {
  assert.throws(() => parseWhen('nope'));
  assert.throws(() => parseWhen('+1y'));
});
