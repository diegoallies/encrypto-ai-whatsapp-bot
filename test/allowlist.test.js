import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAllowlist } from '../src/allowlist.js';

test('empty raw → reject all (fail-closed)', () => {
  const a = createAllowlist('');
  assert.equal(a.isAllowed('14155551234@s.whatsapp.net'), false);
  assert.equal(a.size(), 0);
});

test('null / undefined raw → reject all', () => {
  assert.equal(createAllowlist(undefined).isAllowed('x@s.whatsapp.net'), false);
  assert.equal(createAllowlist(null).isAllowed('x@s.whatsapp.net'), false);
});

test('single JID', () => {
  const a = createAllowlist('1@s.whatsapp.net');
  assert.equal(a.isAllowed('1@s.whatsapp.net'), true);
  assert.equal(a.isAllowed('2@s.whatsapp.net'), false);
  assert.equal(a.size(), 1);
});

test('comma-separated with whitespace', () => {
  const a = createAllowlist(' 1@s.whatsapp.net ,  2@s.whatsapp.net ');
  assert.equal(a.isAllowed('1@s.whatsapp.net'), true);
  assert.equal(a.isAllowed('2@s.whatsapp.net'), true);
  assert.equal(a.size(), 2);
});

test('null/empty JIDs always rejected, even with non-empty allowlist', () => {
  const a = createAllowlist('1@s.whatsapp.net');
  assert.equal(a.isAllowed(null), false);
  assert.equal(a.isAllowed(undefined), false);
  assert.equal(a.isAllowed(''), false);
});

test('empty entries in comma list are ignored', () => {
  const a = createAllowlist(',1@s.whatsapp.net,,,');
  assert.equal(a.size(), 1);
  assert.equal(a.isAllowed('1@s.whatsapp.net'), true);
});

test('glob: *@s.whatsapp.net matches any DM', () => {
  const a = createAllowlist('*@s.whatsapp.net');
  assert.equal(a.isAllowed('1@s.whatsapp.net'), true);
  assert.equal(a.isAllowed('9999@s.whatsapp.net'), true);
  assert.equal(a.isAllowed('group-1@g.us'), false);
});

test('glob: *@g.us matches any group', () => {
  const a = createAllowlist('*@g.us');
  assert.equal(a.isAllowed('1234-5678@g.us'), true);
  assert.equal(a.isAllowed('1@s.whatsapp.net'), false);
});

test('mixed exact + glob entries', () => {
  const a = createAllowlist('1@s.whatsapp.net,*@g.us');
  assert.equal(a.isAllowed('1@s.whatsapp.net'), true);
  assert.equal(a.isAllowed('2@s.whatsapp.net'), false);
  assert.equal(a.isAllowed('abc@g.us'), true);
});

test('glob: regex specials in raw pattern are escaped', () => {
  const a = createAllowlist('foo.bar@s.whatsapp.net');
  assert.equal(a.isAllowed('foo.bar@s.whatsapp.net'), true);
  assert.equal(a.isAllowed('fooxbar@s.whatsapp.net'), false);
});
