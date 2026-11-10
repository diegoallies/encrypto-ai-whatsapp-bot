// Incoming message buffer - holds messages BEFORE they reach the AI.
// Allows viewing, cancelling, prioritizing messages in a queue.
// Messages can be auto-released after a delay or manually approved.

import { EventEmitter } from 'node:events';

const buffer = []; // { id, jid, msg, preview, addedAt, status, priority }
let idCounter = 1;
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

// Settings
let autoReleaseMs = 100; // Default 100ms - fast processing
let holdAll = false;      // If true, hold all messages until manually released

// Add message to buffer
export function addIncoming(jid, msg, preview = '') {
  const item = {
    id: idCounter++,
    jid,
    msg,
    preview: preview.slice(0, 100),
    addedAt: Date.now(),
    status: 'waiting', // waiting | processing | done | cancelled
    priority: 0,
  };
  buffer.push(item);
  buffer.sort((a, b) => b.priority - a.priority || a.addedAt - b.addedAt);
  emitter.emit('change');
  return item;
}

// Get all waiting messages
export function listWaiting() {
  return buffer.filter(i => i.status === 'waiting');
}

// Get all messages (including history)
export function listAll() {
  return [...buffer];
}

// Get next message to process (highest priority, oldest)
export function getNext() {
  return buffer.find(i => i.status === 'waiting');
}

// Mark as processing
export function markProcessing(id) {
  const item = buffer.find(i => i.id === id);
  if (item && item.status === 'waiting') {
    item.status = 'processing';
    item.startedAt = Date.now();
    emitter.emit('change');
    return true;
  }
  return false;
}

// Mark as done
export function markDone(id) {
  const item = buffer.find(i => i.id === id);
  if (item) {
    item.status = 'done';
    item.doneAt = Date.now();
    emitter.emit('change');
    return true;
  }
  return false;
}

// Cancel a waiting message
export function cancel(id) {
  const item = buffer.find(i => i.id === id);
  if (item && item.status === 'waiting') {
    item.status = 'cancelled';
    item.cancelledAt = Date.now();
    emitter.emit('change');
    return true;
  }
  return false;
}

// Cancel a processing message (sets flag, handler must check it)
export function cancelProcessing(id) {
  const item = buffer.find(i => i.id === id);
  if (item && item.status === 'processing') {
    item.cancelRequested = true;
    emitter.emit('change');
    return true;
  }
  return false;
}

// Check if cancel was requested for a processing item
export function isCancelRequested(id) {
  const item = buffer.find(i => i.id === id);
  return item?.cancelRequested === true;
}

// Change priority (higher = processed first)
export function setPriority(id, priority) {
  const item = buffer.find(i => i.id === id);
  if (item && item.status === 'waiting') {
    item.priority = priority;
    buffer.sort((a, b) => b.priority - a.priority || a.addedAt - b.addedAt);
    emitter.emit('change');
    return true;
  }
  return false;
}

// Move to front of queue
export function moveToFront(id) {
  const item = buffer.find(i => i.id === id);
  if (item && item.status === 'waiting') {
    const maxPriority = Math.max(...buffer.filter(i => i.status === 'waiting').map(i => i.priority), 0);
    item.priority = maxPriority + 1;
    buffer.sort((a, b) => b.priority - a.priority || a.addedAt - b.addedAt);
    emitter.emit('change');
    return true;
  }
  return false;
}

// Subscribe to changes
export function onChange(listener) {
  emitter.on('change', listener);
  return () => emitter.off('change', listener);
}

// Settings getters/setters
export function setAutoRelease(ms) {
  autoReleaseMs = Math.max(0, ms);
}

export function getAutoRelease() {
  return autoReleaseMs;
}

export function setHoldAll(hold) {
  holdAll = Boolean(hold);
  emitter.emit('change');
}

export function getHoldAll() {
  return holdAll;
}

// Cleanup old done/cancelled items (keep last hour)
export function cleanup(maxAgeMs = 3600000) {
  const cutoff = Date.now() - maxAgeMs;
  for (let i = buffer.length - 1; i >= 0; i--) {
    const item = buffer[i];
    if ((item.status === 'done' || item.status === 'cancelled') && item.addedAt < cutoff) {
      buffer.splice(i, 1);
    }
  }
}

// Get counts
export function counts() {
  let waiting = 0, processing = 0, done = 0, cancelled = 0;
  for (const item of buffer) {
    if (item.status === 'waiting') waiting++;
    else if (item.status === 'processing') processing++;
    else if (item.status === 'done') done++;
    else if (item.status === 'cancelled') cancelled++;
  }
  return { waiting, processing, done, cancelled, total: buffer.length };
}

// Run cleanup every 10 minutes
setInterval(() => cleanup(), 600000);
