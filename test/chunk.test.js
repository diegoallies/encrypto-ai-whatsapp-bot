import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitForWhatsApp } from '../src/chunk.js';

test('empty / null input → []', () => {
  assert.deepEqual(splitForWhatsApp(''), []);
  assert.deepEqual(splitForWhatsApp(null), []);
  assert.deepEqual(splitForWhatsApp(undefined), []);
});

test('short input → single chunk', () => {
  assert.deepEqual(splitForWhatsApp('hello'), ['hello']);
});

test('long input splits below cap', () => {
  const long = 'word '.repeat(2000);
  const parts = splitForWhatsApp(long);
  assert.ok(parts.length >= 2, 'expected multiple chunks');
  for (const p of parts) {
    assert.ok(p.length <= 3700, `chunk too long: ${p.length}`);
  }
});

test('paragraph boundary preferred (no trailing whitespace)', () => {
  const para = 'para1 '.repeat(400);
  const text = para + '\n\n' + para + '\n\n' + para;
  const parts = splitForWhatsApp(text);
  for (const p of parts) assert.equal(p, p.trimEnd(), 'trailing whitespace in chunk');
});

test('code fence is rebalanced across cuts', () => {
  const code = 'before\n\n```js\n' + 'console.log(1);\n'.repeat(300) + '```\nafter';
  const parts = splitForWhatsApp(code);
  assert.ok(parts.length >= 2);
  for (const p of parts) {
    const fences = (p.match(/```/g) || []).length;
    assert.equal(fences % 2, 0, `unbalanced fences in chunk (${fences})`);
  }
});

test('reassembled chunks preserve boundaries', () => {
  const text = 'aaa\n\n' + 'b'.repeat(5000) + '\n\nccc';
  const parts = splitForWhatsApp(text);
  assert.ok(parts[0].startsWith('aaa'));
  assert.ok(parts[parts.length - 1].endsWith('ccc'));
});

test('text exactly at cap → single chunk', () => {
  const text = 'x'.repeat(3500);
  assert.deepEqual(splitForWhatsApp(text), [text]);
});
