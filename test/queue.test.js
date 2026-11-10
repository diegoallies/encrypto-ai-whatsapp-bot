import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueue, queueDepth } from '../src/queue.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('same-key tasks run serially even when later tasks are faster', async () => {
  const order = [];
  await Promise.all([
    enqueue('a', async () => { await delay(30); order.push(1); }),
    enqueue('a', async () => { await delay(10); order.push(2); }),
    enqueue('a', async () => { await delay(5);  order.push(3); }),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
});

test('different-key tasks run in parallel', async () => {
  const events = [];
  await Promise.all([
    enqueue('x', async () => { events.push('x-start'); await delay(40); events.push('x-end'); }),
    enqueue('y', async () => { events.push('y-start'); await delay(40); events.push('y-end'); }),
  ]);
  // Both starts must precede either end if they truly ran in parallel.
  const xStart = events.indexOf('x-start');
  const yStart = events.indexOf('y-start');
  const xEnd = events.indexOf('x-end');
  const yEnd = events.indexOf('y-end');
  assert.ok(Math.max(xStart, yStart) < Math.min(xEnd, yEnd));
});

test('error in one task does not break later tasks on the same key', async () => {
  const order = [];
  const p1 = enqueue('c', async () => { order.push(1); });
  const p2 = enqueue('c', async () => { throw new Error('boom'); }).catch(() => order.push('err'));
  const p3 = enqueue('c', async () => { order.push(3); });
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, [1, 'err', 3]);
});

test('queueDepth drains to 0 after tasks settle', async () => {
  await enqueue('d', async () => {});
  await delay(10);
  assert.equal(queueDepth(), 0);
});
