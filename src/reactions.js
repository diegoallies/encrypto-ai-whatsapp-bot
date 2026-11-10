// Ack reactions: ⏳ on receive, ✅ on done, ❌ on error. Disabling is one env
// var away. Each helper swallows errors — a missing emoji should never break
// the reply path. We track the "last" reaction so done/error can replace
// the in-progress one (sending an empty react-text removes the prior one).

const ENABLED = process.env.ACK_REACTIONS !== '0';

const RECEIVED = process.env.ACK_RECEIVED || '⏳';
const DONE = process.env.ACK_DONE || '✅';
const ERROR_EMOJI = process.env.ACK_ERROR || '❌';

async function react(sock, msg, emoji) {
  if (!ENABLED || !sock || typeof sock.sendMessage !== 'function') return;
  const key = msg?.key;
  if (!key) return;
  try {
    await sock.sendMessage(key.remoteJid, { react: { text: emoji, key } });
  } catch {
    // Ignore — reactions are best-effort.
  }
}

export async function ackReceived(sock, msg) { return react(sock, msg, RECEIVED); }
export async function ackDone(sock, msg) { return react(sock, msg, DONE); }
export async function ackError(sock, msg) { return react(sock, msg, ERROR_EMOJI); }
export async function clearAck(sock, msg) { return react(sock, msg, ''); }
