import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as runs from '../src/active-runs.js';
import { createHandler, parseStop } from '../src/handler.js';

function makeSock() {
  return {
    sent: [],
    user: { id: 'bot@s.whatsapp.net' },
    async sendMessage(jid, payload) { this.sent.push({ jid, text: payload?.text }); return { key: { remoteJid: jid, id: 's' } }; },
    async sendPresenceUpdate() {},
    async readMessages() {},
  };
}
const textMsg = (jid, body, id) => ({ key: { remoteJid: jid, id, fromMe: false }, message: { conversation: body }, messageTimestamp: Math.floor(Date.now() / 1000) });

test('parseStop matches stop words, not normal prompts', () => {
  for (const t of ['stop', '/stop', 'Stop!', 'esc', '/esc', 'cancel', 'bro stop', 'Bro stop all your tasks', 'stop all', '/stop all']) {
    assert.ok(parseStop(t), t);
  }
  assert.equal(parseStop('stop all').all, true);
  assert.equal(parseStop('stop').all, false);
  for (const t of ['stop the server on port 80', 'can you stop by later', 'bus stop near me', '']) {
    assert.equal(parseStop(t), null, t);
  }
});

test('registry: inject goes to newest injectable run, stop interrupts all', async () => {
  runs._reset();
  const got = [];
  let stopped = 0;
  const off1 = runs.register('a', { injectable: false, inject: () => { got.push('sched'); return true; }, interrupt: () => { stopped++; } });
  const off2 = runs.register('a', { injectable: true, inject: (t) => { got.push(t); return true; }, interrupt: () => { stopped++; } });
  assert.equal(runs.inject('a', 'hi'), true);
  assert.deepEqual(got, ['hi']);
  assert.equal(runs.inject('b', 'x'), false);
  assert.equal(await runs.stop('a'), 2);
  assert.equal(stopped, 2);
  off1(); off2();
  assert.equal(runs.has('a'), false);
});

test('handler: stop interrupts a live run and confirms', async () => {
  runs._reset();
  const jid = 'stop-test@s.whatsapp.net';
  let interrupted = false;
  const off = runs.register(jid, { injectable: true, inject: () => true, interrupt: () => { interrupted = true; } });
  const sock = makeSock();
  const { dispatch } = createHandler({ sock, agent: { askClaude: async () => 'x', resetSession() {} }, isAllowed: () => true, isOwner: () => true, refreshMs: 100_000 });
  await dispatch({ type: 'notify', messages: [textMsg(jid, 'stop', 's1')] });
  assert.equal(interrupted, true);
  assert.match(sock.sent.at(-1).text, /Stopped/);
  off();
  await dispatch({ type: 'notify', messages: [textMsg(jid, '/esc', 's2')] });
  assert.match(sock.sent.at(-1).text, /Nothing running/);
});

test('handler: DM text during a live run is injected, not queued', async () => {
  runs._reset();
  const jid = 'inject-test@s.whatsapp.net';
  const injected = [];
  const off = runs.register(jid, { injectable: true, inject: (t) => { injected.push(t); return true; }, interrupt: () => {} });
  let asked = 0;
  const sock = makeSock();
  const { dispatch } = createHandler({ sock, agent: { askClaude: async () => { asked++; return 'x'; }, resetSession() {} }, isAllowed: () => true, isOwner: () => true, refreshMs: 100_000 });
  await dispatch({ type: 'notify', messages: [textMsg(jid, 'also check the logs', 'i1')] });
  assert.equal(injected.length, 1);
  assert.match(injected[0], /follow-up/);
  assert.match(injected[0], /also check the logs/);
  assert.match(injected[0], /\(the owner, owner\)/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(asked, 0);
  off();
});
