// Note: reactions.js reads ACK_REACTIONS at import-time, so we set it before
// the dynamic import below.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeSock() {
  return {
    reactions: [],
    async sendMessage(jid, payload) {
      if (payload.react) this.reactions.push({ jid, ...payload.react });
      return { key: {} };
    },
  };
}

test('ackReceived / ackDone / ackError fire react payloads', async () => {
  process.env.ACK_REACTIONS = '1';
  const { ackReceived, ackDone, ackError } = await import(`../src/reactions.js?v=${Date.now()}`);
  const sock = makeSock();
  const msg = { key: { remoteJid: 'j', id: 'm1' } };
  await ackReceived(sock, msg);
  await ackDone(sock, msg);
  await ackError(sock, msg);
  assert.equal(sock.reactions.length, 3);
  assert.equal(sock.reactions[0].text, '⏳');
  assert.equal(sock.reactions[1].text, '✅');
  assert.equal(sock.reactions[2].text, '❌');
});

test('disabled via env → no-op', async () => {
  process.env.ACK_REACTIONS = '0';
  const { ackReceived } = await import(`../src/reactions.js?v=${Date.now()}`);
  const sock = makeSock();
  await ackReceived(sock, { key: { remoteJid: 'j', id: 'm' } });
  assert.equal(sock.reactions.length, 0);
});

test('missing msg.key → silent no-op', async () => {
  process.env.ACK_REACTIONS = '1';
  const { ackReceived } = await import(`../src/reactions.js?v=${Date.now()}`);
  const sock = makeSock();
  await ackReceived(sock, {});
  await ackReceived(sock, null);
  assert.equal(sock.reactions.length, 0);
});

test('sock.sendMessage throwing is swallowed', async () => {
  process.env.ACK_REACTIONS = '1';
  const { ackReceived } = await import(`../src/reactions.js?v=${Date.now()}`);
  const sock = { sendMessage: async () => { throw new Error('boom'); } };
  await assert.doesNotReject(() =>
    ackReceived(sock, { key: { remoteJid: 'j', id: 'm' } }),
  );
});
