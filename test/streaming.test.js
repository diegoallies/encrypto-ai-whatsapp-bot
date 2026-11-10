import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeSock() {
  return {
    sent: [],
    async sendMessage(jid, payload) {
      if (payload.edit) {
        const last = [...this.sent].reverse().find((m) => m.jid === jid);
        if (last) last.text = payload.text;
        return { key: payload.edit };
      }
      const key = { remoteJid: jid, id: `m${this.sent.length + 1}` };
      this.sent.push({ jid, text: payload.text, key });
      return { key };
    },
  };
}

test('default mode: each append sends a fresh message', async () => {
  process.env.STREAM_AS_EDITS = '0';
  const { createStreamSender } = await import(`../src/streaming.js?v=${Date.now()}`);
  const sock = makeSock();
  const s = createStreamSender({ sock, jid: 'j' });
  await s.append('alpha');
  await s.append('beta');
  await s.finalize();
  assert.deepEqual(sock.sent.map((m) => m.text), ['alpha', 'beta']);
  assert.equal(s.chunkCount(), 2);
});

test('edit mode: subsequent appends edit one message', async () => {
  process.env.STREAM_AS_EDITS = '1';
  const { createStreamSender } = await import(`../src/streaming.js?v=${Date.now()}`);
  const sock = makeSock();
  const s = createStreamSender({ sock, jid: 'j' });
  await s.append('hello');
  await s.append(' world');
  await s.append('!');
  await s.finalize();
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].text, 'hello world!');
  assert.equal(s.chunkCount(), 1);
});

test('edit mode: overflowing 3500 chars starts a new message', async () => {
  process.env.STREAM_AS_EDITS = '1';
  const { createStreamSender } = await import(`../src/streaming.js?v=${Date.now()}`);
  const sock = makeSock();
  const s = createStreamSender({ sock, jid: 'j' });
  const para = 'word '.repeat(800); // ~4000 chars
  await s.append(para);
  await s.finalize();
  assert.ok(sock.sent.length >= 2, `expected split, got ${sock.sent.length}`);
});
