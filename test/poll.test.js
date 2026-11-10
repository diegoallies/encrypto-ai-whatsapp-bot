import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendPoll, sendConfirmPoll } from '../src/poll.js';

function makeSock() {
  return {
    polls: [],
    async sendMessage(jid, payload) { this.polls.push({ jid, ...payload.poll }); },
  };
}

test('sendPoll forwards name + values', async () => {
  const sock = makeSock();
  await sendPoll(sock, 'j', 'Dinner?', ['Pizza', 'Tacos', 'Sushi']);
  assert.equal(sock.polls.length, 1);
  assert.equal(sock.polls[0].name, 'Dinner?');
  assert.deepEqual(sock.polls[0].values, ['Pizza', 'Tacos', 'Sushi']);
  assert.equal(sock.polls[0].selectableCount, 1);
});

test('sendPoll rejects fewer than 2 options', async () => {
  const sock = makeSock();
  await assert.rejects(() => sendPoll(sock, 'j', 'Q?', ['only']));
  await assert.rejects(() => sendPoll(sock, 'j', 'Q?', []));
});

test('sendPoll rejects missing name', async () => {
  await assert.rejects(() => sendPoll(makeSock(), 'j', '', ['a', 'b']));
});

test('sendPoll clamps to 12 options', async () => {
  const sock = makeSock();
  const big = Array.from({ length: 20 }, (_, i) => `o${i}`);
  await sendPoll(sock, 'j', 'Pick one', big);
  assert.equal(sock.polls[0].values.length, 12);
});

test('sendConfirmPoll posts Yes/No', async () => {
  const sock = makeSock();
  await sendConfirmPoll(sock, 'j', 'Proceed?');
  assert.deepEqual(sock.polls[0].values, ['Yes', 'No']);
});
