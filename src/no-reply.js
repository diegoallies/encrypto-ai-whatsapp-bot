// "Is this message worth replying to?" — cheap heuristic before the full
// Claude call. Used in groups (and optionally in chats with low-priority
// contacts) to avoid responding to noise like "lol" or thumbs-up.
//
// In DMs we always reply (no judgement). In groups, we only skip when the
// message is clearly noise AND the bot wasn't addressed.

// Common single-token / single-emoji acknowledgements WhatsApp users send.
// Lowercased; stripped of trailing punctuation before matching.
const NOISE = new Set([
  'lol', 'lmao', 'rofl', 'haha', 'hahaha', 'hehe', 'ok', 'okay', 'k', 'kk',
  'kkk', 'cool', 'nice', 'noted', 'oki', 'aight', 'word', 'fr', 'sure',
  'true', 'truee', 'yup', 'yep', 'yeah', 'yea', 'yes', 'no', 'nah',
  'thanks', 'thank you', 'thx', 'ty', 'ta', 'cheers', 'np', 'gg',
  'morning', 'evening', 'night', 'gn', 'hi', 'hii', 'hey', 'hello',
]);

// Single emoji (or a small string of emoji + punctuation) — also noise.
function isEmojiOnly(s) {
  if (!s) return false;
  // Strip whitespace and common punctuation
  const stripped = s.replace(/[\s.,!?…\-]+/g, '');
  if (!stripped) return false;
  // Match if every char is in the emoji ranges (rough but effective).
  const emojiRe = /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}‍️\u{E0020}-\u{E007F}]+$/u;
  return emojiRe.test(stripped);
}

// Return true if we should skip Claude entirely for this message.
// `addressedBot` is true when the message @-mentions us, quotes our message,
// or starts with our nickname — those always reply.
export function isNoReply(text, { addressedBot = false } = {}) {
  if (addressedBot) return false;
  const t = (text || '').trim();
  if (!t) return true;

  // Always reply to questions.
  if (t.includes('?')) return false;

  // Trim trailing punctuation for the noise lookup.
  const norm = t.toLowerCase().replace(/[.!?…\s]+$/, '');
  if (NOISE.has(norm)) return true;

  // Single-word, all-letters, ≤4 chars and not in our vocabulary → likely
  // a casual ack we can ignore.
  if (/^[a-z]{1,4}$/i.test(norm)) return true;

  // Emoji-only (👍 / ❤️ / 😂 / etc).
  if (isEmojiOnly(t)) return true;

  return false;
}
