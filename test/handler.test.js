import { test } from 'node:test';
import assert from 'node:assert/strict';
// Disable ack reactions in the test process — they fire at react() time and
// we don't want them showing up in sock.sent. Must be set BEFORE importing
// handler.js (which imports reactions.js + stranger-notify.js).
process.env.ACK_REACTIONS = '0';
process.env.STRANGER_NOTIFY = '0';
// Tests assert one-reply-per-message semantics; coalescing batches messages.
process.env.COALESCE_DISABLE = '1';
import { createHandler } from '../src/handler.js';
import { resetStats } from '../src/stats.js';
import '../src/builtin-commands.js'; // side-effect: registers /reset, /stats, ...

function makeSock() {
  return {
    sent: [],
    reactions: [],
    polls: [],
    presences: [],
    async sendMessage(jid, payload) {
      if (payload?.react) { this.reactions.push({ jid, ...payload.react }); return { key: { remoteJid: jid, id: 'r' } }; }
      if (payload?.poll) { this.polls.push({ jid, ...payload.poll }); return { key: { remoteJid: jid, id: 'p' } }; }
      if (payload?.edit) { /* edit-in-place: replace last sent for this jid */
        const last = [...this.sent].reverse().find((m) => m.jid === jid);
        if (last) last.text = payload.text;
        return { key: payload.edit };
      }
      this.sent.push({ jid, text: payload.text });
      return { key: { remoteJid: jid, id: `m${this.sent.length}` } };
    },
    async sendPresenceUpdate(state, jid) { this.presences.push({ state, jid }); },
  };
}

function makeAgent({ reply = 'ok', throws = false } = {}) {
  return {
    calls: [],
    resets: [],
    async askClaude(jid, text) {
      this.calls.push({ jid, text });
      if (throws) throw new Error('claude exploded');
      return typeof reply === 'function' ? reply(jid, text) : reply;
    },
    resetSession(jid) { this.resets.push(jid); },
  };
}

function textMsg(jid, body, id = 'm1') {
  return {
    key: { remoteJid: jid, id, fromMe: false },
    message: { conversation: body },
  };
}

function makeScheduler() {
  return {
    jobs: [],
    async addJob(job) {
      const stored = { id: `job-${this.jobs.length + 1}`, createdAt: new Date().toISOString(), ...job };
      this.jobs.push(stored);
      return stored;
    },
    async removeJob(id) {
      const before = this.jobs.length;
      this.jobs = this.jobs.filter((j) => j.id !== id);
      return this.jobs.length !== before;
    },
    listJobs() { return [...this.jobs]; },
    listJobsFor(jid) { return this.jobs.filter((j) => j.jid === jid); },
  };
}

function build(opts = {}) {
  const sock = makeSock();
  const agent = makeAgent(opts.agent);
  const scheduler = opts.scheduler === false ? null : makeScheduler();
  const isAllowed = opts.isAllowed ?? ((j) => j === '1@s.whatsapp.net');
  // Treat the test JID as the owner unless the test overrides — keeps the
  // existing owner-only commands working without forcing every test to wire
  // ALLOWED_JIDS into process.env.
  const isOwner = opts.isOwner ?? ((j) => j === '1@s.whatsapp.net');
  const h = createHandler({ sock, agent, isAllowed, scheduler, isOwner, refreshMs: 100_000 });
  return { sock, agent, scheduler, ...h };
}

test('allowlisted text → askClaude called, reply sent', async () => {
  resetStats();
  const { sock, agent, handle } = build({ agent: { reply: 'hello back' } });
  await handle(textMsg('1@s.whatsapp.net', 'hi'));
  assert.equal(agent.calls.length, 1);
  assert.equal(agent.calls[0].jid, '1@s.whatsapp.net');
  assert.match(agent.calls[0].text, /hi/);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].text, 'hello back');
});

test('blocked JID → no askClaude, no reply', async () => {
  const { sock, agent, handle } = build({ isAllowed: () => false });
  await handle(textMsg('99@s.whatsapp.net', 'hey'));
  assert.equal(sock.sent.length, 0);
  assert.equal(agent.calls.length, 0);
});

test('/reset clears session and acknowledges', async () => {
  const { sock, agent, handle } = build();
  await handle(textMsg('1@s.whatsapp.net', '/reset'));
  assert.deepEqual(agent.resets, ['1@s.whatsapp.net']);
  assert.equal(agent.calls.length, 0);
  assert.equal(sock.sent[0].text, 'Conversation reset.');
});

test('/stats returns formatted snapshot', async () => {
  resetStats();
  const { sock, agent, handle } = build();
  await handle(textMsg('1@s.whatsapp.net', '/stats'));
  assert.equal(agent.calls.length, 0);
  assert.equal(sock.sent.length, 1);
  assert.match(sock.sent[0].text, /uptime/);
  assert.match(sock.sent[0].text, /messages:/);
});

test('voice note → friendly refusal, askClaude not called', async () => {
  const { sock, agent, handle } = build();
  await handle({
    key: { remoteJid: '1@s.whatsapp.net', id: 'v1', fromMe: false },
    message: { audioMessage: { ptt: true } },
  });
  assert.equal(sock.sent.length, 1);
  assert.match(sock.sent[0].text, /voice note/);
  assert.equal(agent.calls.length, 0);
});

test('reaction → silent (nothing sent, askClaude not called)', async () => {
  const { sock, agent, handle } = build();
  await handle({
    key: { remoteJid: '1@s.whatsapp.net', id: 'r1', fromMe: false },
    message: { reactionMessage: {} },
  });
  assert.equal(sock.sent.length, 0);
  assert.equal(agent.calls.length, 0);
});

test('long reply is chunked into multiple sends', async () => {
  const long = ('paragraph here. '.repeat(50) + '\n\n').repeat(20);
  const { sock, handle } = build({ agent: { reply: long } });
  await handle(textMsg('1@s.whatsapp.net', 'go'));
  assert.ok(sock.sent.length >= 2, `expected >=2 chunks, got ${sock.sent.length}`);
});

test('claude error → generic user-facing message, no throw', async () => {
  const { sock, handle } = build({ agent: { throws: true } });
  await handle(textMsg('1@s.whatsapp.net', 'go'));
  assert.equal(sock.sent.length, 1);
  assert.match(sock.sent[0].text, /Something went wrong/);
});

test('composing presence is set and cleared', async () => {
  const { sock, handle } = build();
  await handle(textMsg('1@s.whatsapp.net', 'hi'));
  const states = sock.presences.map((p) => p.state);
  assert.ok(states.includes('composing'));
  assert.ok(states.includes('paused'));
});

test('dispatch: system JID is silently ignored', async () => {
  const { sock, agent, dispatch } = build({ isAllowed: () => true });
  dispatch({ type: 'notify', messages: [textMsg('status@broadcast', 'sometext')] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sock.sent.length, 0);
  assert.equal(agent.calls.length, 0);
});

test('dispatch: fromMe is ignored', async () => {
  const { sock, agent, dispatch } = build({ isAllowed: () => true });
  dispatch({
    type: 'notify',
    messages: [{
      key: { remoteJid: '1@s.whatsapp.net', id: 'me1', fromMe: true },
      message: { conversation: 'hi' },
    }],
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(agent.calls.length, 0);
  assert.equal(sock.sent.length, 0);
});

test('dispatch: type != notify is ignored', async () => {
  const { sock, agent, dispatch } = build();
  dispatch({ type: 'append', messages: [textMsg('1@s.whatsapp.net', 'hi')] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sock.sent.length, 0);
  assert.equal(agent.calls.length, 0);
});

test('/remind schedules a job and confirms', async () => {
  const { sock, scheduler, handle } = build();
  await handle(textMsg('1@s.whatsapp.net', '/remind +1h Take out the trash'));
  assert.equal(scheduler.jobs.length, 1);
  assert.equal(scheduler.jobs[0].mode, 'notify');
  assert.equal(scheduler.jobs[0].text, 'Take out the trash');
  assert.equal(scheduler.jobs[0].jid, '1@s.whatsapp.net');
  assert.match(sock.sent[0].text, /Scheduled/);
});

test('/remind with no args returns usage', async () => {
  const { sock, scheduler, handle } = build();
  await handle(textMsg('1@s.whatsapp.net', '/remind'));
  assert.equal(scheduler.jobs.length, 0);
  assert.match(sock.sent[0].text, /Usage: \/remind/);
});

test('/remind with unparseable time returns helpful error', async () => {
  const { sock, scheduler, handle } = build();
  await handle(textMsg('1@s.whatsapp.net', '/remind notatime Do thing'));
  assert.equal(scheduler.jobs.length, 0);
  assert.match(sock.sent[0].text, /Couldn't parse/);
});

test('/cron list with no jobs', async () => {
  const { sock, handle } = build();
  await handle(textMsg('1@s.whatsapp.net', '/cron list'));
  assert.match(sock.sent[0].text, /no scheduled jobs/);
});

test('/cron list shows jobs for this jid only', async () => {
  const { sock, scheduler, handle } = build();
  await scheduler.addJob({ jid: '1@s.whatsapp.net', runAt: '2026-06-01T12:00:00.000Z', mode: 'notify', text: 'mine' });
  await scheduler.addJob({ jid: '99@s.whatsapp.net', runAt: '2026-06-01T12:00:00.000Z', mode: 'notify', text: 'not mine' });
  await handle(textMsg('1@s.whatsapp.net', '/cron list'));
  assert.match(sock.sent[0].text, /mine/);
  assert.doesNotMatch(sock.sent[0].text, /not mine/);
});

test('/cron rm removes the right job', async () => {
  const { sock, scheduler, handle } = build();
  const job = await scheduler.addJob({ jid: '1@s.whatsapp.net', runAt: '2026-06-01T12:00:00.000Z', mode: 'notify', text: 'kill me' });
  await handle(textMsg('1@s.whatsapp.net', `/cron rm ${job.id}`));
  assert.equal(scheduler.jobs.length, 0);
  assert.match(sock.sent[0].text, /removed/);
});

test('/cron rm unknown id reports not found', async () => {
  const { sock, handle } = build();
  await handle(textMsg('1@s.whatsapp.net', '/cron rm bogus'));
  assert.match(sock.sent[0].text, /no job with id/);
});

test('/remind without scheduler configured returns error', async () => {
  const { sock, handle } = build({ scheduler: false });
  await handle(textMsg('1@s.whatsapp.net', '/remind +1h hi'));
  assert.match(sock.sent[0].text, /not configured/);
});

test('dispatch: same-JID messages serialize via queue', async () => {
  const order = [];
  const agent = {
    calls: [],
    resets: [],
    async askClaude(jid, text) {
      // Extract just the user's actual letter — the prompt is now wrapped
      // in an `[INCOMING — DM from ...]` banner.
      const m = text.match(/(?:^|\n)([A-Z])\s*$/);
      const letter = m ? m[1] : text;
      order.push(`start:${letter}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end:${letter}`);
      return letter;
    },
    resetSession() {},
  };
  const sock = makeSock();
  const { dispatch } = createHandler({
    sock, agent, isAllowed: () => true, refreshMs: 100_000,
  });
  // Use a fresh JID so prior tests' queue tails can't bleed in.
  const jid = 'queue-serial-test@s.whatsapp.net';
  dispatch({
    type: 'notify',
    messages: [
      textMsg(jid, 'A', 'a'),
      textMsg(jid, 'B', 'b'),
      textMsg(jid, 'C', 'c'),
    ],
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(order, [
    'start:A', 'end:A',
    'start:B', 'end:B',
    'start:C', 'end:C',
  ]);
});
