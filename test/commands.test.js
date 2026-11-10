import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerCommand, dispatchCommand, clearCommands, findCommand } from '../src/commands.js';

beforeEach(() => { clearCommands(); });

function makeSock() {
  return {
    sent: [],
    async sendMessage(jid, { text }) { this.sent.push({ jid, text }); },
  };
}

test('registerCommand requires name + handler', () => {
  assert.throws(() => registerCommand({}));
  assert.throws(() => registerCommand({ name: 'x' }));
  assert.throws(() => registerCommand({ handler: () => {} }));
});

test('default match handles exact and prefix forms', () => {
  registerCommand({ name: 'ping', handler: () => {} });
  assert.ok(findCommand('/ping'));
  assert.ok(findCommand('/ping with args'));
  assert.equal(findCommand('/pingpong'), null); // no false partial match
  assert.equal(findCommand('hello'), null);
});

test('dispatchCommand passes args trimmed', async () => {
  let captured;
  registerCommand({
    name: 'echo',
    handler: async ({ args, sock, jid }) => { captured = args; await sock.sendMessage(jid, { text: 'k' }); },
  });
  const sock = makeSock();
  const r = await dispatchCommand('/echo   hello world  ', { sock, jid: 'j', isOwner: () => true });
  assert.deepEqual(r, { handled: true });
  assert.equal(captured, 'hello world');
});

test('owner-only command blocks non-owner', async () => {
  registerCommand({ name: 'restart', auth: 'owner', handler: () => { throw new Error('should not run'); } });
  const sock = makeSock();
  const r = await dispatchCommand('/restart', { sock, jid: 'stranger', isOwner: () => false });
  assert.deepEqual(r, { handled: true, reason: 'unauthorized' });
  assert.match(sock.sent[0].text, /owner-only/);
});

test('unknown command → handled: false', async () => {
  const sock = makeSock();
  const r = await dispatchCommand('/unknown', { sock, jid: 'j', isOwner: () => true });
  assert.equal(r.handled, false);
  assert.equal(r.reason, 'no-match');
});

test('custom match overrides default', async () => {
  let hit = 0;
  registerCommand({
    name: 'r',
    match: (t) => t === '/r' || t.startsWith('/rm '),
    handler: () => { hit += 1; },
  });
  assert.ok(findCommand('/rm foo'));
  assert.ok(findCommand('/r'));
  await dispatchCommand('/rm foo', { sock: makeSock(), jid: 'j', isOwner: () => true });
  assert.equal(hit, 1);
});
