import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeSock(overrides = {}) {
  return {
    sent: [],
    async sendMessage(jid, { text }) {
      const id = `m${this.sent.length + 1}`;
      this.sent.push({ jid, text, id });
      return { key: { remoteJid: jid, id } };
    },
    async onWhatsApp() { return []; },
    ...overrides,
  };
}

test('pings owner once per stranger', async () => {
  process.env.STRANGER_NOTIFY = '1';
  const { notifyStranger, clearStrangerCache } = await import(`../src/stranger-notify.js?v=${Date.now()}`);
  clearStrangerCache();
  const sock = makeSock();
  const r1 = await notifyStranger({ sock, ownerJid: 'me@s.whatsapp.net', fromJid: 'x@s.whatsapp.net', preview: 'hello' });
  const r2 = await notifyStranger({ sock, ownerJid: 'me@s.whatsapp.net', fromJid: 'x@s.whatsapp.net', preview: 'again' });
  assert.equal(r1, true);
  assert.equal(r2, false);
  assert.equal(sock.sent.length, 1);
  assert.match(sock.sent[0].text, /stranger/i);
  assert.match(sock.sent[0].text, /allow/i);
});

test('uses pushName when available', async () => {
  process.env.STRANGER_NOTIFY = '1';
  const { notifyStranger, clearStrangerCache } = await import(`../src/stranger-notify.js?v=${Date.now()}`);
  clearStrangerCache();
  const sock = makeSock();
  await notifyStranger({
    sock,
    ownerJid: 'me',
    fromJid: '27671234567@s.whatsapp.net',
    preview: 'hi',
    msg: { pushName: 'a contact' },
  });
  assert.match(sock.sent[0].text, /a contact/);
});

test('resolves @lid via sock.onWhatsApp for display', async () => {
  process.env.STRANGER_NOTIFY = '1';
  const { notifyStranger, clearStrangerCache } = await import(`../src/stranger-notify.js?v=${Date.now()}`);
  clearStrangerCache();
  const sock = makeSock({
    async onWhatsApp(jid) {
      if (jid === '999@lid') return [{ exists: true, jid: '27671234567@s.whatsapp.net', lid: '999@lid' }];
      return [];
    },
  });
  await notifyStranger({ sock, ownerJid: 'me', fromJid: '999@lid', preview: 'hi', msg: { pushName: 'Mary' } });
  assert.match(sock.sent[0].text, /Mary/);
  assert.match(sock.sent[0].text, /\+27/);
});

test('different strangers each get one ping', async () => {
  process.env.STRANGER_NOTIFY = '1';
  const { notifyStranger, clearStrangerCache } = await import(`../src/stranger-notify.js?v=${Date.now()}`);
  clearStrangerCache();
  const sock = makeSock();
  await notifyStranger({ sock, ownerJid: 'me', fromJid: 'a@s.whatsapp.net', preview: 'hi' });
  await notifyStranger({ sock, ownerJid: 'me', fromJid: 'b@s.whatsapp.net', preview: 'hi' });
  assert.equal(sock.sent.length, 2);
});

test('never pings the owner about themselves', async () => {
  process.env.STRANGER_NOTIFY = '1';
  const { notifyStranger, clearStrangerCache } = await import(`../src/stranger-notify.js?v=${Date.now()}`);
  clearStrangerCache();
  const sock = makeSock();
  const r = await notifyStranger({ sock, ownerJid: 'me@s.whatsapp.net', fromJid: 'me@s.whatsapp.net', preview: 'hi' });
  assert.equal(r, false);
  assert.equal(sock.sent.length, 0);
});

test('disabled via env → no-op', async () => {
  process.env.STRANGER_NOTIFY = '0';
  const { notifyStranger } = await import(`../src/stranger-notify.js?v=${Date.now()}`);
  const sock = makeSock();
  const r = await notifyStranger({ sock, ownerJid: 'me', fromJid: 'x', preview: 'hi' });
  assert.equal(r, false);
  assert.equal(sock.sent.length, 0);
});

test('lookupPendingPing finds the stranger by our outbound msg id', async () => {
  process.env.STRANGER_NOTIFY = '1';
  const { notifyStranger, clearStrangerCache, lookupPendingPing } = await import(`../src/stranger-notify.js?v=${Date.now()}`);
  clearStrangerCache();
  const sock = makeSock();
  await notifyStranger({ sock, ownerJid: 'me', fromJid: 'x@lid', preview: 'hi', msg: { pushName: 'Bob' } });
  const ourId = sock.sent[0].id;
  const entry = lookupPendingPing(ourId);
  assert.ok(entry);
  assert.equal(entry.strangerJid, 'x@lid');
  assert.equal(entry.strangerName, 'Bob');
});
