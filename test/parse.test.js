import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, describeNonText, isSystemJid, chatType, isDM, isGroup } from '../src/parse.js';

test('extractText: conversation', () => {
  assert.equal(extractText({ message: { conversation: 'hi' } }), 'hi');
});

test('extractText: extendedTextMessage', () => {
  assert.equal(extractText({ message: { extendedTextMessage: { text: 'hey' } } }), 'hey');
});

test('extractText: image caption', () => {
  assert.equal(extractText({ message: { imageMessage: { caption: 'pic' } } }), 'pic');
});

test('extractText: video caption', () => {
  assert.equal(extractText({ message: { videoMessage: { caption: 'vid' } } }), 'vid');
});

test('extractText: empty / missing message → null', () => {
  assert.equal(extractText({}), null);
  assert.equal(extractText(null), null);
  assert.equal(extractText({ message: {} }), null);
});

test('describeNonText covers known payload shapes', () => {
  assert.equal(describeNonText({ message: { reactionMessage: {} } }), 'reaction');
  assert.equal(describeNonText({ message: { audioMessage: { ptt: true } } }), 'voice note');
  assert.equal(describeNonText({ message: { audioMessage: {} } }), 'audio');
  assert.equal(describeNonText({ message: { imageMessage: {} } }), 'image');
  assert.equal(describeNonText({ message: { videoMessage: {} } }), 'video');
  assert.equal(describeNonText({ message: { stickerMessage: {} } }), 'sticker');
  assert.equal(describeNonText({ message: { documentMessage: {} } }), 'document');
  assert.equal(describeNonText({ message: { locationMessage: {} } }), 'location');
  assert.equal(describeNonText({ message: { liveLocationMessage: {} } }), 'location');
  assert.equal(describeNonText({ message: { contactMessage: {} } }), 'contact card');
  assert.equal(describeNonText({ message: { contactsArrayMessage: {} } }), 'contact card');
});

test('describeNonText: unknown payload → "media"', () => {
  assert.equal(describeNonText({ message: { somethingElse: {} } }), 'media');
});

test('describeNonText: empty / missing → null', () => {
  assert.equal(describeNonText({}), null);
  assert.equal(describeNonText({ message: null }), null);
});

test('isSystemJid: broadcasts, groups, newsletters', () => {
  assert.equal(isSystemJid('status@broadcast'), true);
  assert.equal(isSystemJid('1234-5678@g.us'), true);
  assert.equal(isSystemJid('abc@newsletter'), true);
  assert.equal(isSystemJid('anything@broadcast'), true);
});

test('isSystemJid: personal JID → false', () => {
  assert.equal(isSystemJid('14155551234@s.whatsapp.net'), false);
});

test('isSystemJid: null / empty → true (treated as system / skip)', () => {
  assert.equal(isSystemJid(undefined), true);
  assert.equal(isSystemJid(null), true);
  assert.equal(isSystemJid(''), true);
});

test('chatType classifies all known shapes', () => {
  assert.equal(chatType('1@s.whatsapp.net'), 'dm');
  assert.equal(chatType('abc@lid'), 'dm');
  assert.equal(chatType('1234-5678@g.us'), 'group');
  assert.equal(chatType('xyz@newsletter'), 'channel');
  assert.equal(chatType('status@broadcast'), 'broadcast');
  assert.equal(chatType('anything@broadcast'), 'broadcast');
  assert.equal(chatType(null), 'system');
  assert.equal(chatType(''), 'system');
  assert.equal(chatType('weirdshape'), 'system');
});

test('isDM / isGroup helpers', () => {
  assert.equal(isDM('1@s.whatsapp.net'), true);
  assert.equal(isDM('1234@g.us'), false);
  assert.equal(isGroup('1234@g.us'), true);
  assert.equal(isGroup('1@s.whatsapp.net'), false);
});
