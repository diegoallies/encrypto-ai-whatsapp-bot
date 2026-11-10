// proofreader.js - AI-based filter to catch internal reasoning before sending
//
// Uses the claude-agent-sdk (same as main bot) to check if a reply contains
// internal thoughts, meta-commentary, or reasoning that shouldn't be sent.
//
// Toggle via PROOFREADER_ENABLED=1 in .env or settings page.

// Lazy-loaded to avoid slow startup
let _query = null;
async function getQuery() {
  if (!_query) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    _query = sdk.query;
  }
  return _query;
}

const SYSTEM_PROMPT = `You clean internal AI narration out of a message before it is sent to a user. Your DEFAULT is to KEEP the message. Only strip the narration; never throw away real content.

INTERNAL NARRATION (strip these leading/trailing lines):
- "Let me check the logs.", "Looking at the file now.", "Checking the conversation."
- "Sent the PDF.", "Answered a contact.", "Replied to X.", "Fixed the bug."
- "The fix has been applied. Testing now.", "I just sent a test message to verify..."
- Standalone status with no value: "Staying quiet.", "Done, noted."

REAL CONTENT (always KEEP, verbatim):
- Answers, explanations, advice, instructions, data, reports, summaries, numbers, bullet lists
- Acknowledgments like "Got it", "Done", "On it"
- Jokes, banter, anything for the user

HOW TO DECIDE:
- If the message is a narration preamble FOLLOWED BY real content, return ONLY the real content, verbatim (drop the preamble line(s)).
  Example in: "Sent the PDF. Quick summary:\n\nEOD Report\n- Hours: 8h"
  Example out: "Quick summary:\n\nEOD Report\n- Hours: 8h"  (or keep the whole thing if unsure)
- If the message is ENTIRELY narration with NO real content, respond with exactly NO_CONTENT.
  Example: "Let me check the logs. Looking at the file now." -> NO_CONTENT
  Example: "Staying quiet." -> NO_CONTENT
- When in doubt, KEEP the full message. Losing a real reply is far worse than a little leaked narration.

OUTPUT:
- The cleaned message (preamble removed), OR the message unchanged, OR exactly NO_CONTENT if it is 100% narration.
- Preserve exact wording and newlines of whatever you keep. Do not rephrase.`;

import fs from 'node:fs';
import path from 'node:path';
import { stripInternalLines } from './reply-filter.js';

const PROOFREADER_LOG = path.resolve('logs', 'proofreader.jsonl');

function logToFile(entry) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    }) + '\n';
    fs.appendFileSync(PROOFREADER_LOG, line);
  } catch {}
}

function isEnabled() {
  const val = process.env.PROOFREADER_ENABLED;
  return val === '1' || val?.toLowerCase() === 'true';
}

// True when a message clearly carries real user-facing content (a report,
// answer, list, numbers, multi-line body) and therefore must never be fully
// suppressed — at worst its narration preamble is trimmed.
function hasSubstantialContent(text) {
  const t = (text || '').trim();
  if (t.length > 90) return true;               // lowered: real answers can be short (FP-4)
  if (/\n/.test(t)) return true;                // multi-line (reports, lists, summaries)
  if (/(^|\s)[•\-*]\s|\d+\.\s/.test(t)) return true; // bullet / numbered lists
  if (/\*\*|R\s?\d|\d{2,}|:\s*\S/.test(t)) return true; // bold, amounts, figures, fields
  // Narration PREFIX glued to a real sentence — e.g. "Answered a contact - yes keep doing
  // tummy time…". If stripping a known prefix leaves a substantial clause, it's real.
  if (/^(Answered|Replied|Responded|Told|Sent|Done|Explained|Gave)\b[^.\n]*?[-:]\s*\S{20,}/i.test(t)) return true;
  return false;
}

/**
 * Proofread a reply before sending. Returns cleaned text or null if should suppress.
 * @param {string} text - The raw reply from Claude
 * @param {object} [opts] - Options
 * @param {function} [opts.logFn] - Optional logging function
 * @returns {Promise<string|null>} - Cleaned text or null
 */
export async function proofread(text, opts = {}) {
  const { logFn } = opts;

  // Skip if disabled
  if (!isEnabled()) {
    return text;
  }

  // Skip empty
  if (!text?.trim()) {
    return null;
  }

  // Skip very short messages (likely already clean). Kept in sync with the
  // needsProofreading() gate (>=25) so a flagged 25-29 char message isn't
  // silently passed through here unchecked.
  if (text.length < 25) {
    return text;
  }

  try {
    const start = Date.now();

    // Use claude-agent-sdk query with preset + append for the sanitizer instructions
    const query = await getQuery();
    const textChunks = [];
    for await (const event of query({
      prompt: `SANITIZE THIS MESSAGE (output ONLY the cleaned text, no explanation):\n\n${text}`,
      options: {
        maxTurns: 1,
        allowedTools: [],
        // Fast, cheap, deterministic: a plain sanitizer prompt on Haiku. The
        // old `claude_code` preset framed this simple strip task as a coding
        // agent, which is what made it "argue with itself" (see the NO_CONTENT
        // self-talk handling below) and added needless latency/cost.
        model: process.env.PROOFREADER_MODEL || 'claude-haiku-4-5-20251001',
        systemPrompt: SYSTEM_PROMPT,
      },
    })) {
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text) textChunks.push(block.text);
        }
      }
    }

    let cleaned = textChunks.join('\n').trim();
    // Fix P-4: the sanitizer model sometimes emits "NO_CONTENT" then argues with
    // itself ("NO_CONTENT\n\nWait, that's wrong, let me reconsider…"). That self-
    // talk is neither a clean suppression signal nor real content. If it appears
    // on a message that actually carries content, keep the original (model flip-
    // flopped on a real reply); otherwise collapse it to the bare suppression
    // signal so the deterministic guards below decide. Fail-open by design.
    if (/^NO_CONTENT\b/i.test(cleaned) && cleaned.length > 'NO_CONTENT'.length) {
      if (hasSubstantialContent(text)) {
        if (logFn) logFn({ evt: 'proofreader-selftalk-kept', preview: text.slice(0, 80) });
        logToFile({ action: 'selftalk-kept', original: text, sanitized: cleaned });
        return text;
      }
      cleaned = 'NO_CONTENT';
    }
    const durMs = Date.now() - start;
    const changed = cleaned !== text;

    if (logFn) {
      logFn({ evt: 'proofreader', durMs, inputLen: text.length, outputLen: cleaned.length, changed });
    }

    // Log full before/after to file for tracking
    logToFile({
      action: 'proofread',
      durMs,
      changed,
      original: text,
      sanitized: cleaned,
      inputLen: text.length,
      outputLen: cleaned.length,
    });

    // Check for suppression signal
    if (cleaned === 'NO_CONTENT' || cleaned === '') {
      // Safety guard: the model sometimes flags a whole message as commentary
      // when it actually carries a real report/answer/data after a narration
      // preamble. Never drop substantial content — keep the message whole. A
      // little leaked narration is far better than losing a real reply.
      if (hasSubstantialContent(text)) {
        // Fix P-5: don't keep the RAW original (that re-leaks the narration the model
        // flagged). Strip the narration lines first; keep the stripped result if it
        // still carries real content. Only fall back to raw if stripping empties it.
        const stripped = stripInternalLines(text);
        if (stripped && hasSubstantialContent(stripped)) {
          if (logFn) logFn({ evt: 'proofreader-suppress-overridden-stripped', preview: stripped.slice(0, 80) });
          logToFile({ action: 'suppress-overridden-stripped', original: text, sanitized: stripped });
          return stripped;
        }
        if (logFn) logFn({ evt: 'proofreader-suppress-overridden', preview: text.slice(0, 80) });
        logToFile({ action: 'suppress-overridden-kept', original: text });
        return text;
      }
      // Fix P-2: last-chance recovery — a narration prefix glued to a real answer
      // ("Answered a contact - yes keep doing tummy time…"). Strip the leading clause
      // and keep the rest if it still carries real content, instead of dropping all.
      const recovered = text
        .replace(/^(Answered|Replied|Responded|Told|Sent|Done|Explained|Gave)\b[^.\n-]*[-–—:]\s*/i, '')
        .trim();
      if (recovered && recovered !== text && recovered.length >= 20) {
        if (logFn) logFn({ evt: 'proofreader-prefix-recovered', preview: recovered.slice(0, 80) });
        logToFile({ action: 'prefix-recovered', original: text, sanitized: recovered });
        return recovered;
      }
      if (logFn) logFn({ evt: 'proofreader-suppressed', preview: text.slice(0, 80) });
      logToFile({ action: 'suppressed', original: text,
                 _diag: { len: text.length, multiline: /\n/.test(text), substantial: hasSubstantialContent(text) } });
      return null;
    }

    // Guard the stripped result too: if the model returned something far shorter
    // than the original (it dropped real content, not just a preamble), keep the
    // original instead.
    if (hasSubstantialContent(text) && cleaned.length < text.length * 0.4) {
      if (logFn) logFn({ evt: 'proofreader-overtrim-kept', preview: text.slice(0, 80) });
      logToFile({ action: 'overtrim-kept', original: text, sanitized: cleaned });
      return text;
    }

    return cleaned;
  } catch (err) {
    // On error, pass through original (fail open)
    if (logFn) logFn({ evt: 'proofreader-error', error: err.message });
    console.error('proofreader error:', err.message);
    return text;
  }
}

/**
 * Quick check if text looks like it might be full-message commentary.
 * Only triggers proofreading for messages that look like pure narration.
 *
 * Focus: catch messages that are ENTIRELY about what the AI did,
 * not messages that have some internal bits mixed with real content.
 */
export function needsProofreading(text) {
  if (!text) return false;

  // Very short acks ("ok", "done") are fine and common — skip them.
  if (text.length < 25) return false;

  // Patterns that indicate FULL-MESSAGE commentary (not just bits)
  const fullMsgCommentary = [
    // Describing own actions at start
    /^I (just |have )?(sent|made|applied|fixed|updated|changed|created|added)/i,
    /^(Just |Now )?(sent|sending|applied|applying|fixed|fixing|updated|checking)/i,
    /^The (fix|change|update) (is|has been|was) /i,
    /^Let me (check|look|read|verify|test)/i,
    /^(Looking|Checking|Reading|Analyzing|Examining) (at |the |this )/i,

    // Short narration slips that the 100-char gate used to let through
    /^(Done|Got it|Noted|Acknowledged|Confirmed|Replied|Responded|Sent)[,.]/i,
    /^(Done|Replied|Responded|Sent|Told|Explained|Switched|Updated|Noted) (to |it |that |her |him |them )/i,

    // Status / staying-quiet narration that leaked into groups
    /^Connection (is )?back/i,
    /^(Back online|Reconnected|I'?m back online)/i,
    /^Staying (quiet|silent|out)/i,
    /\b(he|she|they)('s| is| are)? just testing\b/i,
    /\bAnswered \w+ (about|with|regarding|on)\b/i,

    // Waiting/testing narration
    /waiting for (you|confirmation|the owner|the owner) to (confirm|verify|test|check)/i,
    /testing (now|this)/i,

    // Pure status updates with no content
    /^(Done|Fixed|Updated|Applied)\. (The |This )?(fix|change|update)/i,
  ];

  return fullMsgCommentary.some(p => p.test(text));
}

export function getEnabled() {
  return isEnabled();
}

export function setEnabled(enabled) {
  process.env.PROOFREADER_ENABLED = enabled ? '1' : '0';
}
