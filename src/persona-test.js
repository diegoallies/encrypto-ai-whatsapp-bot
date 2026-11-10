// Persona testing helper. Builds the same system prompt the bot would
// assemble for a given JID + optional tone override, so the editor can
// preview "what would the bot actually see if I sent this." Also exposes
// a one-shot Claude call that skips WhatsApp delivery.
//
// Kept separate from claude-agent.js so the editor UI doesn't depend on
// the live socket and so test runs don't perturb the resume-session map.

import fs from 'node:fs/promises';
import { loadPersona, loadToneBody } from './personas.js';
import { buildJournalContext } from './journal.js';
import { getCriticalLessons } from './memory-md.js';
import { mode as costMode } from './cost-guard.js';

const PROMPT_FILES = ['soul.md', 'rules.md', 'HOMELAB.md'];

const TERSE_OVERLAY = `\n# TERSE MODE\n` +
  `You're approaching your daily token budget. Until the next local-midnight reset:\n` +
  `- 1–2 short sentences per reply, no bullets, no headings.\n` +
  `- Skip tool use unless absolutely necessary to answer.\n` +
  `- Don't elaborate, don't quote source, don't re-introduce yourself.\n` +
  `- If the question is large, say "remind me tomorrow when I'm back to full" and stop.\n`;

async function readFile(file) {
  try { return (await fs.readFile(file, 'utf-8')).trim(); } catch { return null; }
}

// Build the same system append claude-agent.js does, but with optional
// `tone` and `includeJournal` knobs so the editor can see how each
// component contributes.
export async function buildPreviewPrompt({ jid = null, tone = null, includeJournal = true } = {}) {
  const sections = [];

  for (const f of PROMPT_FILES) {
    const c = await readFile(f);
    if (c) sections.push({ label: f, body: c });
  }

  try {
    const m = await costMode();
    if (m === 'terse') sections.push({ label: 'cost-guard:terse', body: TERSE_OVERLAY.trim() });
  } catch {}

  if (tone) {
    try {
      const body = await loadToneBody(tone);
      if (body) sections.push({ label: `tone:${tone}`, body });
    } catch (err) {
      sections.push({ label: `tone:${tone}`, body: `(failed to load: ${err.message})` });
    }
  }

  if (jid) {
    try {
      const overlay = await loadPersona(jid);
      if (overlay) sections.push({ label: `overlay:${jid}`, body: overlay });
    } catch (err) {
      console.error('persona-test: overlay load failed', err.message);
    }
  }

  try {
    const lessons = await getCriticalLessons();
    if (lessons.length) {
      const block = lessons.map((l) => `### ${l.title}\n${l.body}`).join('\n\n');
      sections.push({ label: 'critical-lessons', body: block });
    }
  } catch {}

  if (includeJournal) {
    try {
      const journal = await buildJournalContext();
      if (journal) sections.push({ label: 'journal-context', body: journal });
    } catch {}
  }

  const combined = sections.map((s) => s.body).join('\n\n');
  const estimatedTokens = Math.ceil(combined.length / 4);

  return { sections, combined, estimatedTokens };
}

// Send a one-shot prompt to Claude with the assembled persona stack but
// WITHOUT touching WhatsApp. Used by the sandbox chat in the editor.
// Lazy-imports askClaude so this module can be loaded without the SDK
// during testing.
export async function dryRun({ jid = null, tone = null, message }) {
  if (!message || typeof message !== 'string') {
    return { ok: false, error: 'message required' };
  }
  const { askClaude } = await import('./claude-agent.js');
  const sandboxJid = jid || 'persona-test:sandbox';
  try {
    const result = await askClaude(sandboxJid, message);
    return {
      ok: true,
      text: typeof result === 'string' ? result : (result?.text || ''),
      usage: result?.usage || null,
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}
