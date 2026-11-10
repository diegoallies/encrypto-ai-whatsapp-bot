// Wrapper around sock.sendMessage that handles Connection Closed errors
// with automatic retry. Fixes the 428 "Connection Closed" transaction
// failures that cause messages to silently fail.
//
// Critically, every attempt re-reads the LIVE socket from socket-holder, so a
// send that started on a socket which then died will retry on the freshly
// reconnected socket instead of hammering the dead one forever.

import { getSocket, isOpen, waitForOpen } from './socket-holder.js';

const MAX_RETRIES = 5;
const RECONNECT_WAIT_MS = 20000; // Wait up to 20s for reconnect
const CONNECTION_CLOSED_CODE = 428;

function isConnectionClosed(err) {
  // Check for Baileys Boom error with Connection Closed
  if (err?.output?.statusCode === CONNECTION_CLOSED_CODE) return true;
  if (err?.statusCode === CONNECTION_CLOSED_CODE) return true;
  // Check message pattern
  const msg = err?.message || String(err);
  if (/connection closed/i.test(msg)) return true;
  if (/precondition required/i.test(msg)) return true;
  return false;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Send a WhatsApp message with retry on Connection Closed errors.
 * @param {object} sockArg - Baileys socket (fallback; live socket preferred)
 * @param {string} jid - recipient JID
 * @param {object} content - message content (e.g. { text: '...' })
 * @param {object} options - optional sendMessage options
 * @returns {Promise<object>} - sendMessage result
 */
export async function reliableSend(sockArg, jid, content, options = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Always prefer the live socket from the holder. The passed-in socket may
    // already be dead after a reconnect; the holder tracks the current one.
    const sock = getSocket() || sockArg;
    if (!sock) {
      await waitForOpen(RECONNECT_WAIT_MS);
      continue;
    }
    try {
      const result = await sock.sendMessage(jid, content, options);
      return result;
    } catch (err) {
      lastErr = err;
      if (!isConnectionClosed(err)) {
        // Not a connection error - throw immediately
        throw err;
      }
      // Connection closed - wait for the holder to report a live socket again.
      if (attempt < MAX_RETRIES - 1) {
        console.log(`reliableSend: Connection Closed, retry ${attempt + 1}/${MAX_RETRIES}`);
        const reconnected = await waitForOpen(RECONNECT_WAIT_MS);
        if (!reconnected) {
          console.log(`reliableSend: Still disconnected after wait, will retry anyway`);
          await sleep(1500);
        }
      }
    }
  }
  // All retries exhausted
  console.error(`reliableSend: Failed after ${MAX_RETRIES} retries`, lastErr?.message || lastErr);
  throw lastErr;
}

/**
 * Check if the live socket connection is open.
 */
export function isConnected() {
  return isOpen();
}

/**
 * Wait for the live socket to report open.
 */
export async function waitForConnection(timeoutMs = RECONNECT_WAIT_MS) {
  return waitForOpen(timeoutMs);
}
