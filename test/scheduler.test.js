import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  initScheduler,
  shutdownScheduler,
  addJob,
  removeJob,
  listJobs,
  listJobsFor,
  _resetForTest,
} from '../src/scheduler.js';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sched-'));
  return { dir, file: path.join(dir, 'scheduled.json') };
}

test('addJob persists to disk and is listable', async () => {
  _resetForTest();
  const { file } = await fixture();
  await initScheduler({ filePath: file });
  const job = await addJob({
    jid: '1@s.whatsapp.net',
    runAt: '2030-01-01T00:00:00.000Z',
    mode: 'notify',
    text: 'hello',
  });
  assert.ok(job.id);
  assert.equal(listJobs().length, 1);
  const onDisk = JSON.parse(await fs.readFile(file, 'utf-8'));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].id, job.id);
  shutdownScheduler();
});

test('removeJob removes from list and disk', async () => {
  _resetForTest();
  const { file } = await fixture();
  await initScheduler({ filePath: file });
  const job = await addJob({
    jid: '1@s.whatsapp.net', runAt: '2030-01-01T00:00:00.000Z', mode: 'notify', text: 'x',
  });
  const ok = await removeJob(job.id);
  assert.equal(ok, true);
  assert.equal(listJobs().length, 0);
  const onDisk = JSON.parse(await fs.readFile(file, 'utf-8'));
  assert.equal(onDisk.length, 0);
  shutdownScheduler();
});

test('listJobsFor filters by jid', async () => {
  _resetForTest();
  const { file } = await fixture();
  await initScheduler({ filePath: file });
  await addJob({ jid: 'a@s.whatsapp.net', runAt: '2030-01-01T00:00:00.000Z', mode: 'notify', text: 'A' });
  await addJob({ jid: 'b@s.whatsapp.net', runAt: '2030-01-01T00:00:00.000Z', mode: 'notify', text: 'B' });
  assert.equal(listJobsFor('a@s.whatsapp.net').length, 1);
  assert.equal(listJobsFor('a@s.whatsapp.net')[0].text, 'A');
  shutdownScheduler();
});

test('addJob validates inputs', async () => {
  _resetForTest();
  const { file } = await fixture();
  await initScheduler({ filePath: file });
  await assert.rejects(() => addJob({ runAt: '2030-01-01', mode: 'notify', text: 'x' }));
  await assert.rejects(() => addJob({ jid: 'j', mode: 'notify', text: 'x' }));
  await assert.rejects(() => addJob({ jid: 'j', runAt: '2030-01-01', mode: 'notify' }));
  await assert.rejects(() => addJob({ jid: 'j', runAt: '2030-01-01', mode: 'bogus', text: 'x' }));
  shutdownScheduler();
});

test('fire callback runs for overdue jobs on startup', async () => {
  _resetForTest();
  const { file } = await fixture();
  const past = new Date(Date.now() - 5_000).toISOString();
  await fs.writeFile(file, JSON.stringify([
    { id: 'old1', jid: '1@s', runAt: past, mode: 'notify', text: 'overdue', createdAt: past },
  ]));
  const fired = [];
  await initScheduler({ filePath: file, onFire: (job) => { fired.push(job.id); } });
  // setImmediate; give it a tick
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(fired, ['old1']);
  // and the job is removed from disk
  const onDisk = JSON.parse(await fs.readFile(file, 'utf-8'));
  assert.equal(onDisk.length, 0);
  shutdownScheduler();
});

test('stale (>24h) jobs are skipped, not fired', async () => {
  _resetForTest();
  const { file } = await fixture();
  const ancient = new Date(Date.now() - 48 * 3_600_000).toISOString();
  await fs.writeFile(file, JSON.stringify([
    { id: 'ancient', jid: '1@s', runAt: ancient, mode: 'notify', text: 'too late', createdAt: ancient },
  ]));
  const fired = [];
  await initScheduler({ filePath: file, onFire: (job) => { fired.push(job.id); } });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(fired, []);
  shutdownScheduler();
});
