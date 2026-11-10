// Persona system. Three layers, all editable from the web UI:
//
// 1. soul.md + rules.md        — global identity, applied to every reply
// 2. personas/<name>.md        — named tone modes (concise, dev, stoic…)
//                                used by the playbook runner's persona override
// 3. data/personas/<jid>.md    — per-contact overlays appended to the system
//                                prompt for a specific JID
//
// `loadPersona(jid)` continues to mean "the per-contact overlay" for backward
// compatibility — that's how claude-agent.js wires it in.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, stripLegacyHeader, extractDescription } from './persona-meta.js';

const OVERLAY_DIR = path.join('data', 'personas');
const TONE_DIR = 'personas';
const SOUL_FILE = 'soul.md';
const RULES_FILE = 'rules.md';
const AB_DIR = 'personas';
const AB_STATE_FILE = path.join('data', 'persona-ab.json');

// ─── Per-contact overlays ──────────────────────────────────────────────────

function safeJidFilename(jid) {
  return String(jid || '').replace(/[^\w@.-]/g, '_');
}

function overlayFileFor(jid) {
  return path.join(OVERLAY_DIR, `${safeJidFilename(jid)}.md`);
}

// mtime cache so we don't re-read the same file every turn.
const overlayCache = new Map(); // file → { mtime, content }

export async function loadPersona(jid) {
  if (!jid) return null;
  const file = overlayFileFor(jid);
  try {
    const stat = await fs.stat(file);
    const cached = overlayCache.get(file);
    if (cached && cached.mtime === stat.mtimeMs) return cached.content;
    const content = (await fs.readFile(file, 'utf-8')).trim();
    overlayCache.set(file, { mtime: stat.mtimeMs, content });
    return content || null;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('personas: read failed', err.message);
    return null;
  }
}

export async function savePersona(jid, body) {
  if (!jid) throw new Error('jid required');
  await fs.mkdir(OVERLAY_DIR, { recursive: true });
  const file = overlayFileFor(jid);
  await fs.writeFile(file, String(body ?? '').trim() + '\n');
  overlayCache.delete(file);
}

export async function deletePersona(jid) {
  const file = overlayFileFor(jid);
  try { await fs.unlink(file); overlayCache.delete(file); return true; }
  catch { return false; }
}

// Backwards-compat: list of every JID we have an overlay for. The on-disk
// names use _ in place of : so we restore that here.
export async function listPersonas() {
  try {
    const entries = await fs.readdir(OVERLAY_DIR);
    return entries
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, '').replace(/_/g, ':'))
      .sort();
  } catch {
    return [];
  }
}

// Richer per-overlay record for the UI: includes file size, mtime, and the
// first line of the body so the list page can show a useful preview.
export async function listOverlays() {
  let entries = [];
  try { entries = await fs.readdir(OVERLAY_DIR); } catch { return []; }
  const out = [];
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    const jid = f.replace(/\.md$/, '').replace(/_/g, ':');
    const filePath = path.join(OVERLAY_DIR, f);
    let body = ''; let updatedAt = null;
    try {
      body = await fs.readFile(filePath, 'utf-8');
      const stat = await fs.stat(filePath);
      updatedAt = stat.mtime.toISOString();
    } catch {}
    out.push({
      jid,
      preview: body.trim().slice(0, 200),
      bytes: Buffer.byteLength(body, 'utf-8'),
      updatedAt,
    });
  }
  return out.sort((a, b) => a.jid.localeCompare(b.jid));
}

export async function loadOverlayFull(jid) {
  if (!jid) return null;
  const file = overlayFileFor(jid);
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const stat = await fs.stat(file);
    return { jid, raw, body: raw, updatedAt: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

// ─── Tone modes (personas/*.md) ────────────────────────────────────────────

function safeToneName(name) {
  return String(name || '').replace(/[^\w.-]/g, '');
}

function toneFileFor(name) {
  const safe = safeToneName(name);
  if (!safe) return null;
  return path.join(TONE_DIR, `${safe}.md`);
}

export async function listTones() {
  let entries = [];
  try { entries = await fs.readdir(TONE_DIR); } catch { return []; }
  const out = [];
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    const name = f.replace(/\.md$/, '');
    const filePath = path.join(TONE_DIR, f);
    let raw = ''; let updatedAt = null;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
      const stat = await fs.stat(filePath);
      updatedAt = stat.mtime.toISOString();
    } catch {}
    const { meta, body } = parseFrontmatter(raw);
    const clean = stripLegacyHeader(body);
    out.push({
      name,
      description: extractDescription(meta, body),
      tags: Array.isArray(meta?.tags) ? meta.tags : (meta?.tags ? [meta.tags] : []),
      preview: clean.slice(0, 200),
      bytes: Buffer.byteLength(raw, 'utf-8'),
      updatedAt,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadToneFull(name) {
  const file = toneFileFor(name);
  if (!file) return null;
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const { meta, body } = parseFrontmatter(raw);
    const clean = stripLegacyHeader(body);
    return {
      name: safeToneName(name),
      raw,
      body: clean,
      meta,
      description: extractDescription(meta, body),
      tags: Array.isArray(meta?.tags) ? meta.tags : (meta?.tags ? [meta.tags] : []),
    };
  } catch {
    return null;
  }
}

// Returns just the body (frontmatter + comment header stripped). This is
// what the bot actually sees when persona override is in play.
export async function loadToneBody(name) {
  const full = await loadToneFull(name);
  return full ? full.body : null;
}

export async function saveTone(name, raw) {
  const safe = safeToneName(name);
  if (!safe) return { ok: false, error: 'invalid name' };
  if (typeof raw !== 'string') return { ok: false, error: 'body must be a string' };
  if (raw.length > 200_000) return { ok: false, error: 'too large' };
  const file = path.join(TONE_DIR, `${safe}.md`);
  try {
    await fs.mkdir(TONE_DIR, { recursive: true });
    await fs.writeFile(file, raw);
    return { ok: true, name: safe };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function deleteTone(name) {
  const file = toneFileFor(name);
  if (!file) return false;
  try { await fs.unlink(file); return true; }
  catch { return false; }
}

export async function toneExists(name) {
  const file = toneFileFor(name);
  if (!file) return false;
  try { await fs.access(file); return true; } catch { return false; }
}

// ─── Soul / Rules ──────────────────────────────────────────────────────────

export async function loadSoul() {
  try { return await fs.readFile(SOUL_FILE, 'utf-8'); } catch { return ''; }
}

export async function saveSoul(raw) {
  await fs.writeFile(SOUL_FILE, String(raw ?? ''));
}

export async function loadRules() {
  try { return await fs.readFile(RULES_FILE, 'utf-8'); } catch { return ''; }
}

export async function saveRules(raw) {
  await fs.writeFile(RULES_FILE, String(raw ?? ''));
}

// ─── A/B variant switch for soul.md ────────────────────────────────────────
//
// Lets the user keep `soul.experimental.md` (or any soul.<label>.md) side
// by side with the live one and flip with one click. Active label is
// stored in data/persona-ab.json. When "experimental" is active, soul.md
// is copied from soul.<label>.md.

export async function listSoulVariants() {
  let entries = [];
  try { entries = await fs.readdir('.'); } catch { return []; }
  return entries
    .filter((f) => /^soul(\.[\w-]+)?\.md$/.test(f))
    .map((f) => {
      const m = f.match(/^soul\.([\w-]+)\.md$/);
      return { file: f, label: m ? m[1] : 'live' };
    })
    .sort((a, b) => (a.label === 'live' ? -1 : b.label === 'live' ? 1 : a.label.localeCompare(b.label)));
}

export async function readSoulAbState() {
  try {
    const raw = await fs.readFile(AB_STATE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { active: 'live' };
  }
}

export async function setSoulAbActive(label) {
  await fs.mkdir(path.dirname(AB_STATE_FILE), { recursive: true });
  // Activating a variant copies its body into soul.md so the bot's existing
  // loader doesn't need to change.
  if (label && label !== 'live') {
    const src = path.join('.', `soul.${label}.md`);
    try {
      const body = await fs.readFile(src, 'utf-8');
      await fs.writeFile(SOUL_FILE, body);
    } catch (err) {
      throw new Error(`variant "${label}" not found: ${err.message}`);
    }
  }
  await fs.writeFile(AB_STATE_FILE, JSON.stringify({ active: label || 'live' }, null, 2));
}

// ─── Templates for new tone modes ─────────────────────────────────────────

export const TONE_TEMPLATES = {
  blank: '',
  concise: `---\ndescription: Reply in 1-2 short sentences. No fluff.\ntags: [terse]\n---\n# Concise mode\n\nReply in 1-2 short sentences. Never more. Drop greetings, niceties, restating the question. If a yes/no fits, give just that.\n`,
  analyst: `---\ndescription: Step-by-step reasoning + cited numbers.\ntags: [work]\n---\n# Analyst mode\n\nThink step by step. Show your reasoning before the conclusion. Cite numbers and assumptions. Hedge appropriately when uncertain.\n`,
  'code-reviewer': `---\ndescription: Direct, technical, no-apologies feedback.\ntags: [dev]\n---\n# Code reviewer\n\nGive direct, technical feedback. Identify bugs, security issues, edge cases. Suggest concrete fixes with diff-style snippets. No softening language.\n`,
  pirate: `---\ndescription: Arr, but still useful.\ntags: [fun]\n---\n# Pirate mode\n\nRespond in pirate dialect — but stay accurate and useful. Sprinkle "arr", "matey", nautical metaphors. Never sacrifice correctness for the bit.\n`,
  'journal-coach': `---\ndescription: Reflective, asks one open question per reply.\ntags: [personal]\n---\n# Journal coach\n\nReflect back what the user said in their own words. Ask exactly one open question that invites deeper thought. Never give advice unless explicitly asked.\n`,
};
