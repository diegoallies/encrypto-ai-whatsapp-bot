import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'sessions-test-'));
const FILE = path.join(TMP, 'sessions.json');

import * as store from '../src/sessions-store.js';

test('round-trips a session id through disk', async () => {
  store._setFileForTest(FILE);
  await store.ready();
  store.set('a@s.whatsapp.net', 'sess-1');
  store.set('b@lid', 'sess-2');
  await new Promise((r) => setTimeout(r, 150));
  const parsed = JSON.parse(await fs.readFile(FILE, 'utf-8'));
  assert.equal(parsed['a@s.whatsapp.net'], 'sess-1');
  assert.equal(parsed['b@lid'], 'sess-2');
});

test('reads existing file on next ready()', async () => {
  const FILE2 = path.join(TMP, 'sessions2.json');
  await fs.writeFile(FILE2, JSON.stringify({ 'c@s.whatsapp.net': 'sess-3' }));
  store._setFileForTest(FILE2);
  await store.ready();
  assert.equal(store.get('c@s.whatsapp.net'), 'sess-3');
});

test('del removes the entry from disk', async () => {
  const FILE3 = path.join(TMP, 'sessions3.json');
  store._setFileForTest(FILE3);
  await store.ready();
  store.set('x@lid', 'sess-x');
  await new Promise((r) => setTimeout(r, 150));
  store.del('x@lid');
  await new Promise((r) => setTimeout(r, 150));
  const parsed = JSON.parse(await fs.readFile(FILE3, 'utf-8'));
  assert.equal(parsed['x@lid'], undefined);
});
