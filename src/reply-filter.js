// reply-filter.js — Filters out internal reasoning from Claude replies
// before they are sent to WhatsApp.
//
// Based on OpenClaw's approach: https://github.com/openclaw/openclaw/issues/25214
// - Suppress messages flagged as reasoning (isReasoning === true)
// - Suppress text starting with reasoning prefixes
// - Filter line-by-line for meta-commentary
//
// This is the LAST line of defense. The model should not produce this content
// in the first place, but when it does, this catches it.
//
// Filtered content is logged to logs/filtered-replies.jsonl for tuning.
//
// Can be disabled via REPLY_FILTER_ENABLED=0 in .env or settings page.

import fs from 'node:fs';
import path from 'node:path';

// ─── FILTER TOGGLE ─────────────────────────────────────────────────────────
// Check if filter is enabled (defaults to true for safety)
function isFilterEnabled() {
  // Re-read each time so settings changes take effect without restart
  const envVal = process.env.REPLY_FILTER_ENABLED;
  // If not set, default to enabled (1)
  if (envVal === undefined || envVal === '') return true;
  return envVal === '1' || envVal.toLowerCase() === 'true';
}

const FILTER_LOG = path.resolve('logs', 'filtered-replies.jsonl');

function logFiltered(entry) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    }) + '\n';
    fs.appendFileSync(FILTER_LOG, line);
  } catch {}
}

// ─── REASONING PREFIXES ─────────────────────────────────────────────────────
// Messages starting with these (after trim) are pure reasoning - suppress entirely
const REASONING_PREFIXES = [
  'Reasoning:',
  'Thinking:',
  'Analysis:',
  'Context:',
  'Internal:',
  '<think>',
  '<thinking>',
  '<thought>',
  '<reasoning>',
];

// ─── SILENT REPLY TOKENS ────────────────────────────────────────────────────
// Exact tokens that mean "don't send anything"
const SILENT_TOKENS = [
  'NO_REPLY',
  '*NO_REPLY*',
  '[NO_REPLY]',
  '(NO_REPLY)',
  '(no response)',  // askClaude fallback when no text generated
];

// ─── INTERNAL PATTERNS ──────────────────────────────────────────────────────
// Lines matching these are internal reasoning/commentary - strip them
const INTERNAL_PATTERNS = [
  // Explicit NO_REPLY markers
  /^\*?NO_REPLY\*?$/im,
  /\*NO_REPLY\*/,
  /^NO_REPLY\s*[-—]/im,

  // Reasoning tag content (XML-style)
  /^<\/?think(ing)?>/im,
  /^<\/?thought>/im,
  /^<\/?reasoning>/im,

  // Internal reasoning prefixes — Claude narrating context lookups
  /^Looking at (the journal|the context|my memory|the conversation)/im,
  /^Checking the conversation/im,
  /^Based on the conversation_label/im,
  /^The conversation_label shows/im,
  /^Based on the (banner|context|journal|history|JID)/im,
  /^Reading the/im,
  /^Analyzing/im,

  // Self-narration of intent - only catch internal meta-commentary
  /^I (should|will|need to|have to) (reply with|respond with|verify the|treat this|address this)/im,
  /^I'?ll (respond with|reply with|treat this as)/im,
  /^Let me (respond with|reply with|verify the banner|address this as)/im,
  /^I correctly (refused|did|said|told)/im,
  /^I (correctly|already|just) refused/im,

  // Talking about the user/sender in 3rd person
  /^This (person|message|user|sender|contact|JID) (is|was|seems|appears|claims|tried)/im,
  /^They('re| are| just|'re now)? (taunting|asking|trying|attempting|provoking)/im,
  /^The user (is|was|seems|wants)/im,

  // ─── POST-REPLY SUMMARIES (the main problem) ──────────────────────────────
  // These are commentary ABOUT what I just said, not the reply itself
  /^Replied (to \w+ )?(with|about|-)/im,
  /^Replying (to \w+ )?(with|about)/im,
  /^Responded (to \w+ )?(with|about|-)/im,
  /^Answered \w+ (about|with|regarding|on|to|[-–—:])/im,
  /^Explained (it )?(to \w+)?[ -]/im,
  /^Told \w+ (about|that|to|-)/im,
  /^Gave \w+ (advice|info|warning|tips|a)/im,
  /^Sent (a |the )?(reply|response|message)/im,
  /^Just (told|explained|answered|replied)/im,
  /^Acknowledged (her|his|their|the|it|this)/im,  // "Acknowledged her test."
  /^Confirmed (the|her|his|their|it|this)/im,     // "Confirmed the request."
  /^Noted (the|her|his|their|it|that|this)/im,    // "Noted that she..."
  /^Processed (the|her|his|their|it|this)/im,     // "Processed the request."
  /^Handled (the|her|his|their|it|this)/im,       // "Handled the request."
  /^Addressed (the|her|his|their|it|this)/im,     // "Addressed her question."

  // Summary continuations
  /^- (explained|told|gave|sent|replied)/im,
  /- explained/im,
  /- gave (her|him|them)/im,
  /but gave (her|him|them)/im,
  /that's how they/im,

  // ─── INTERNAL COMMENTARY ──────────────────────────────────────────────────
  // Meta-comments about what happened or how the conversation went
  // R-11: narrowed - "Done. Added X to July" is a user-facing confirmation, not
  // narration. Only catch verbs that are ALWAYS internal (Switched, Noted) or
  // require internal indicators (sent/added/removed + "for her", "to memory", etc.)
  /^Done[,.]?\s*(Switched|Changed|Noted|cloned|disabled|enabled|scheduled|set up|flagged)\b/im,
  /^Done[,.]?\s*(sent|added|removed|updated|deleted|queued|told|asked)\b[^.\n]*(to (memory|my notes|the file|self)|for (her|him|them)|in (memory|the log))\b/im,
  /Switched to \w+ for (her|him|them)/im,
  /(she|he|they) seem(s)? (impressed|happy|confused|upset|interested|surprised)/i,
  /- (she|he|they) (got|called|caught|seems?)/i,

  // Language/persona switches
  /^Switched to \w+$/im,
  /^Using \w+ (language|persona|mode)/im,
  /^Responding in \w+$/im,
  /^Changed (to|language|persona)/im,

  // Meta-commentary about conversation dynamics
  /^Touché/im,
  /got me there/i,
  /Conceded the point/i,
  /^Fair point/im,
  /she got me/i,
  /he got me/i,
  /they got me/i,
  // Anchored: only a STANDALONE "Good call." / "That's a good point" line is
  // narration. Must not fire on "Good call." sitting at the end of a real bullet
  // (that over-strip nuked a whole CV-review paragraph on 06-24).
  /^(that'?s )?(a )?(good|nice|fair) (point|catch|call)\b[.! ]*$/im,
  /^(Ha(ha)?|Lol),? (she|he|they|that)/im,

  // Internal notes — R-10: only strip clearly-internal note forms. A bare
  // /^Note:/ nuked legit notes to the user ("Note: your old schedule had R4k…").
  /^Note to self\b/im,
  /^Note: (logged|saved|recorded|tracked|noting|added to|to self|skipping|stored)/im,
  /^Noted[.:]/im,
  /^Adding to/im,
  /^Recording/im,
  /^Logging/im,
  /^Tracking/im,
  /^Saved/im,
  /^Updated/im,
  /^Stored/im,

  // Generic preambles
  /^This appears to be/im,
  /^This seems (to be|like)/im,
  /^This message is from/im,
  /^Looking at this/im,

  // JID/routing - technical internals
  /\d+@(s\.whatsapp\.net|lid)/,
  /@lid\b/,
  /conversation_label/i,
  /^The JID/im,

  // Internal directives
  /^I will use NO_REPLY/im,
  /^Using NO_REPLY/im,
  /^Responding with NO_REPLY/im,
  /^Should (respond|reply|say)/im,

  // ─── STATUS / "STAYING QUIET" NARRATION (leaked into groups) ───────────────
  // The bot announcing its own connection/availability or narrating that it's
  // choosing to stay silent — never meant for anyone to see.
  /^Connection (is )?back/im,
  /^(Back online|Reconnected|I'?m back online|I'?m online again)/im,
  /^Staying (quiet|silent|out of)/im,
  /^Staying put/im,
  /\b(he|she|they)('s| is| are)? just testing\b/i,
  /^(Not replying|No reply needed|Keeping quiet|Remaining silent)/im,
  // "Answered <name> about/with …" mid-sentence (post-reply summary)
  /\bAnswered \w+ (about|with|regarding|on|[-–—:])/i,

  // ─── F-6: third-person self-narration prefixes (observed leaking to a group) ──
  // Line-start anchored + case-insensitive so they don't eat real replies that
  // merely mention the owner mid-sentence.
  /^the owner wants\b/im,
  /^Gave the owner\b/im,
  /^I mapped\b/im,
  /^Mapped the\b/im,
  /^Diagnosis delivered\b/im,
  /^Owned it\b/im,
  /^Straight answer to the owner:?/im,
  /^Confirmed:/im,
];

// ─── SUPPRESS ENTIRE MESSAGE PATTERNS ───────────────────────────────────────
// If the ENTIRE message matches these, suppress completely
const SUPPRESS_ENTIRE_PATTERNS = [
  /^\*?NO_REPLY\*?[\s\S]*$/i,
  /^Looking at the journal[\s\S]*NO_REPLY[\s\S]*$/i,
  /^<think(ing)?>/i,  // Starts with thinking tag
  /^Reasoning:/i,
  // Pure status / staying-quiet narration — suppress the whole message.
  /^Connection (is )?back\b/i,
  /^(Back online|Reconnected|I'?m back online)\b/i,
  /^Staying (quiet|silent|out)\b/i,
  /^(Connection (is )?back|Reconnected)[\s\S]*\bAnswered \w+/i,  // "Connection is back. Answered a contact…"
  /^(Back online|Reconnected),? (ready|all good|everything)/i,
  /^(He|She|They)('s| is| are)? just testing\b/i,
];

/**
 * Check if text is a reasoning-only message (OpenClaw style).
 * These start with reasoning prefixes and should be suppressed entirely.
 */
function isReasoningMessage(text) {
  if (!text) return false;
  const trimmed = text.trim();
  for (const prefix of REASONING_PREFIXES) {
    if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return true;
  }
  return false;
}

/**
 * Check if text is exactly a silent token (OpenClaw isSilentReplyText).
 * Allows surrounding whitespace but nothing else.
 */
function isSilentToken(text) {
  if (!text) return false;
  const trimmed = text.trim().toUpperCase();
  for (const token of SILENT_TOKENS) {
    if (trimmed === token.toUpperCase()) return true;
  }
  return false;
}

/**
 * Check if a reply contains internal reasoning that shouldn't be sent.
 * @param {string} text - The reply text from Claude
 * @returns {{ leaked: boolean, patterns: string[] }} - Whether internal content was detected
 */
export function detectInternalLeak(text) {
  if (!text) return { leaked: false, patterns: [] };

  const matched = [];
  for (const pattern of INTERNAL_PATTERNS) {
    if (pattern.test(text)) {
      matched.push(pattern.source.slice(0, 40));
    }
  }

  return { leaked: matched.length > 0, patterns: matched };
}

/**
 * Check if the entire message should be suppressed (not sent at all).
 * @param {string} text - The reply text from Claude
 * @returns {boolean} - True if message should be suppressed entirely
 */
export function shouldSuppressEntirely(text) {
  if (!text) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;

  // Filter disabled - only suppress empty/whitespace
  if (!isFilterEnabled()) return false;

  // Silent token (NO_REPLY etc)
  if (isSilentToken(trimmed)) return true;

  // Reasoning message (starts with Reasoning:, <think>, etc)
  if (isReasoningMessage(trimmed)) return true;

  // Full message matches suppress pattern
  for (const pattern of SUPPRESS_ENTIRE_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  return false;
}

/**
 * Returns true if a line reads like internal reasoning rather than
 * user-facing text. Used to strip individual lines before sending.
 */
function lineIsInternal(line) {
  const t = line.trim();
  if (!t) return true; // empty lines are noise
  for (const pattern of INTERNAL_PATTERNS) {
    if (pattern.test(t)) return true;
  }
  return false;
}

/**
 * True only when a whole paragraph is internal — i.e. every non-empty line in it
 * is internal. Prevents one stray pattern match from dropping a multi-line block
 * (bullet lists, reports, summaries) that mostly contains real content.
 */
function paragraphIsInternal(p) {
  const lines = p.split(/\n/).filter((l) => l.trim());
  if (lines.length === 0) return true;
  return lines.every((l) => lineIsInternal(l));
}

/**
 * Filter a reply, removing internal reasoning content.
 * Returns the cleaned text, or null if nothing usable is left.
 *
 * Strategy (OpenClaw-inspired):
 * 1. Check if entire message is reasoning/silent - suppress entirely
 * 2. Split into paragraphs, filter each
 * 3. Within paragraphs, filter individual lines
 * 4. Return cleaned result or null
 *
 * @param {string} text - The reply text from Claude
 * @param {function} [logFn] - Optional logging function
 * @returns {string|null} - Cleaned text, or null to suppress entirely
 */
export function filterReply(text, logFn) {
  if (!text) return null;

  // ALWAYS catch silent tokens like NO_REPLY - regardless of filter setting
  if (isSilentToken(text)) {
    if (logFn) logFn({ evt: 'reply-suppressed', reason: 'silent-token', preview: text.slice(0, 80) });
    logFiltered({ action: 'suppressed-silent-token', original: text });
    return null;
  }

  // Filter disabled - pass through as-is (but silent tokens already caught above)
  if (!isFilterEnabled()) return text;

  // Hard-stop: reasoning message or silent token → drop entirely
  if (shouldSuppressEntirely(text)) {
    if (logFn) logFn({ evt: 'reply-suppressed', reason: 'full-match', preview: text.slice(0, 80) });
    logFiltered({ action: 'suppressed-full', reason: 'silent-token-or-reasoning', original: text });
    return null;
  }

  // First pass: split into paragraphs (double newline) and filter
  const paragraphs = text.split(/\n{2,}/);
  const keptParas = [];
  const droppedParas = [];

  for (const p of paragraphs) {
    // Drop a whole paragraph ONLY when EVERY non-empty line in it is internal.
    // Testing the joined paragraph with lineIsInternal() let a single unanchored
    // match (e.g. "Good call" inside one bullet) nuke an entire multi-line block.
    // Mixed paragraphs fall through to the per-line pass below.
    if (paragraphIsInternal(p)) {
      droppedParas.push(p);
      continue;
    }

    // Second pass: filter individual lines within paragraph
    const lines = p.split(/\n/);
    const keptLines = [];
    for (const line of lines) {
      if (lineIsInternal(line)) {
        droppedParas.push(line);
      } else {
        keptLines.push(line);
      }
    }

    if (keptLines.length > 0) {
      keptParas.push(keptLines.join('\n'));
    }
  }

  if (droppedParas.length > 0) {
    if (logFn) {
      logFn({
        evt: 'reply-stripped-internal',
        droppedCount: droppedParas.length,
        kept: keptParas.length,
        preview: droppedParas[0]?.slice(0, 120) || '',
      });
    }
    // Log full details for tuning
    logFiltered({
      action: 'stripped-lines',
      droppedCount: droppedParas.length,
      dropped: droppedParas,
      kept: keptParas,
      original: text,
    });
  }

  const cleaned = keptParas.join('\n\n').trim();
  if (!cleaned) {
    if (logFn) logFn({ evt: 'reply-suppressed', reason: 'all-stripped', preview: text.slice(0, 120) });
    logFiltered({ action: 'suppressed-all-stripped', original: text });
    return null;
  }
  return cleaned;
}

/**
 * Strip internal-narration lines/paragraphs from text, ALWAYS (independent of the
 * REPLY_FILTER_ENABLED toggle). Returns the cleaned text, or '' if nothing usable
 * remains. Used by the proofreader's override path (Fix P-5) so a "substantial"
 * message that mixes narration + real content gets the narration removed instead of
 * the whole raw blob being kept.
 */
export function stripInternalLines(text) {
  if (!text) return '';
  const paragraphs = text.split(/\n{2,}/);
  const keptParas = [];
  for (const p of paragraphs) {
    if (paragraphIsInternal(p)) continue;       // whole paragraph is narration
    const keptLines = p.split(/\n/).filter((line) => !lineIsInternal(line));
    if (keptLines.length > 0) keptParas.push(keptLines.join('\n'));
  }
  return keptParas.join('\n\n').trim();
}

/**
 * Filter a streaming chunk. More conservative than full reply filtering
 * since we might catch partial patterns.
 * @param {string} chunk - A streaming chunk
 * @returns {string|null} - Chunk to send, or null to skip
 */
export function filterStreamChunk(chunk) {
  if (!chunk) return null;

  // Filter disabled - pass through as-is
  if (!isFilterEnabled()) return chunk;

  // Silent token
  if (isSilentToken(chunk)) {
    logFiltered({ action: 'stream-suppressed', reason: 'silent-token', chunk });
    return null;
  }

  // Reasoning prefix
  if (isReasoningMessage(chunk)) {
    logFiltered({ action: 'stream-suppressed', reason: 'reasoning-prefix', chunk });
    return null;
  }

  // Suppress chunks that start with obvious internal patterns
  if (/^Looking at the (journal|context)/i.test(chunk)) {
    logFiltered({ action: 'stream-suppressed', reason: 'internal-pattern', pattern: 'Looking at', chunk });
    return null;
  }
  if (/^\d+@(s\.whatsapp\.net|lid)/i.test(chunk)) {
    logFiltered({ action: 'stream-suppressed', reason: 'jid-leak', chunk });
    return null;
  }

  if (/^Done[,.]?\s*(Switched)/i.test(chunk)) {
    logFiltered({ action: 'stream-suppressed', reason: 'done-commentary', chunk });
    return null;
  }
  if (/^(Replied|Answered|Explained|Responded|Told|Gave|Acknowledged|Confirmed|Noted|Processed|Handled|Addressed) /i.test(chunk)) {
    logFiltered({ action: 'stream-suppressed', reason: 'post-reply-summary', chunk });
    return null;
  }
  // Status-header summaries that open a post-action recap, e.g.
  // "Confirmed it's live and healthy:" / "All confirmed —" / "Everything's healthy:"
  if (/^(All |Everything'?s? )?(Confirmed|Verified)\b[^.\n]*(live|healthy|done|up|working)[:\-—]/i.test(chunk)) {
    logFiltered({ action: 'stream-suppressed', reason: 'status-header-summary', chunk });
    return null;
  }
  if (/(she|he|they) seem(s)? (impressed|happy|confused|upset)/i.test(chunk)) {
    logFiltered({ action: 'stream-suppressed', reason: 'meta-commentary', chunk });
    return null;
  }
  if (/^(Switched|Changed|Updated|Using) /i.test(chunk)) {
    logFiltered({ action: 'stream-suppressed', reason: 'state-change-narration', chunk });
    return null;
  }

  return chunk;
}

/**
 * Get current filter enabled state
 */
export function getFilterEnabled() {
  return isFilterEnabled();
}

/**
 * Set filter enabled state (updates process.env)
 */
export function setFilterEnabled(enabled) {
  process.env.REPLY_FILTER_ENABLED = enabled ? '1' : '0';
}
