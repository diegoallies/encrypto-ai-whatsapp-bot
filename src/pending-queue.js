// Visible pending message queue for the web UI. Tracks messages waiting
// to be sent, allowing edit/cancel/priority operations before send.
// The actual sending still goes through the normal flow.

import { EventEmitter } from 'node:events';

const queue = [];
let idCounter = 1;
const emitter = new EventEmitter();
emitter.setMaxListeners(20);

// Add a message to the pending queue
export function addPending(jid, text, priority = 0) {
  const item = {
    id: idCounter++,
    jid,
    text,
    priority,
    createdAt: new Date().toISOString(),
    status: 'pending', // pending | sending | sent | cancelled
  };
  queue.push(item);
  queue.sort((a, b) => b.priority - a.priority);
  emitter.emit('change');
  return item;
}

// Get all pending items
export function listPending() {
  return queue.filter(q => q.status === 'pending' || q.status === 'sending');
}

// Get all items including history
export function listAll() {
  return [...queue];
}

// Edit a pending message
export function editPending(id, newText) {
  const item = queue.find(q => q.id === id);
  if (item && item.status === 'pending') {
    item.text = newText;
    item.editedAt = new Date().toISOString();
    emitter.emit('change');
    return true;
  }
  return false;
}

// Cancel a pending message
export function cancelPending(id) {
  const item = queue.find(q => q.id === id);
  if (item && item.status === 'pending') {
    item.status = 'cancelled';
    item.cancelledAt = new Date().toISOString();
    emitter.emit('change');
    return true;
  }
  return false;
}

// Change priority
export function setPriority(id, priority) {
  const item = queue.find(q => q.id === id);
  if (item && item.status === 'pending') {
    item.priority = priority;
    queue.sort((a, b) => b.priority - a.priority);
    emitter.emit('change');
    return true;
  }
  return false;
}

// Move item up (increase priority)
export function moveUp(id) {
  const idx = queue.findIndex(q => q.id === id);
  if (idx > 0 && queue[idx].status === 'pending') {
    queue[idx].priority = (queue[idx - 1]?.priority || 0) + 1;
    queue.sort((a, b) => b.priority - a.priority);
    emitter.emit('change');
    return true;
  }
  return false;
}

// Move item down (decrease priority)
export function moveDown(id) {
  const idx = queue.findIndex(q => q.id === id);
  if (idx < queue.length - 1 && idx >= 0 && queue[idx].status === 'pending') {
    queue[idx].priority = Math.max(0, (queue[idx + 1]?.priority || 0) - 1);
    queue.sort((a, b) => b.priority - a.priority);
    emitter.emit('change');
    return true;
  }
  return false;
}

// Mark as sending
export function markSending(id) {
  const item = queue.find(q => q.id === id);
  if (item) {
    item.status = 'sending';
    item.sendingAt = new Date().toISOString();
    emitter.emit('change');
    return true;
  }
  return false;
}

// Mark as sent
export function markSent(id) {
  const item = queue.find(q => q.id === id);
  if (item) {
    item.status = 'sent';
    item.sentAt = new Date().toISOString();
    emitter.emit('change');
    return true;
  }
  return false;
}

// Get next pending item to send
export function getNext() {
  return queue.find(q => q.status === 'pending');
}

// Clear sent/cancelled items older than given ms
export function cleanup(maxAgeMs = 3600000) {
  const cutoff = Date.now() - maxAgeMs;
  const before = queue.length;
  for (let i = queue.length - 1; i >= 0; i--) {
    const item = queue[i];
    if ((item.status === 'sent' || item.status === 'cancelled') &&
        new Date(item.createdAt).getTime() < cutoff) {
      queue.splice(i, 1);
    }
  }
  if (queue.length !== before) emitter.emit('change');
}

// Subscribe to changes
export function onChange(listener) {
  emitter.on('change', listener);
  return () => emitter.off('change', listener);
}

// Get queue size
export function pendingCount() {
  return queue.filter(q => q.status === 'pending').length;
}
