// Playbook runner. A playbook is a markdown file under playbooks/<name>.md.
//
// Files may begin with a YAML-ish frontmatter block delimited by `---`:
//
//   ---
//   description: Today's schedule
//   tags: [daily, work]
//   persona: terse
//   chain: [health, morning]
//   owner_only: true
//   triggers: [end my day, /endday]
//   ---
//   # Title
//   > description
//
//   Body goes here. {{variables}} get filled in from the params form.
//
// Legacy convention is still supported: if there's no frontmatter we look
// for a leading `> description` line (the rest of the file is the prompt).

import fs from 'node:fs/promises';
import path from 'node:path';

const DIR = path.join('playbooks');

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

// Very small YAML subset — enough for `key: value`, lists in `[a, b, c]`
// shorthand or one-per-line. We don't pull in a YAML dep for one feature.
function parseFrontmatter(raw) {
  if (!raw) return { meta: {}, body: '' };
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { meta: {}, body: raw };
  const block = m[1];
  const body = raw.slice(m[0].length);
  const meta = {};
  let currentKey = null;
  const lines = block.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) { currentKey = null; continue; }
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && currentKey) {
      if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
      meta[currentKey].push(coerceValue(listItem[1].trim()));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    currentKey = key;
    if (val === '') { meta[key] = null; continue; }
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map((s) => coerceValue(s.trim())).filter((s) => s !== '');
      currentKey = null;
      continue;
    }
    meta[key] = coerceValue(val);
    currentKey = null;
  }
  return { meta, body };
}

function coerceValue(s) {
  if (s == null) return s;
  const t = String(s).trim().replace(/^["']|["']$/g, '');
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  return t;
}

function stripLegacyHeader(body) {
  const lines = body.split('\n');
  while (lines.length > 0 && /^(\s*#\s|\s*>\s|\s*$)/.test(lines[0])) lines.shift();
  return lines.join('\n').trim();
}

function extractLegacyDescription(body) {
  const line = body.split('\n').find((l) => l.trim().startsWith('>'));
  if (!line) return '';
  return line.replace(/^\s*>\s*/, '').trim();
}

// Find all {{var}} placeholders in the body. Returns ordered unique names.
export function extractVariables(body) {
  const seen = new Set();
  const re = /\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g;
  let m;
  while ((m = re.exec(body)) !== null) seen.add(m[1]);
  return [...seen];
}

// Replace {{var}} with provided values. Missing values become "".
export function applyVariables(body, params = {}) {
  return body.replace(/\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g, (_, k) => {
    const v = params[k];
    return v == null ? '' : String(v);
  });
}

// Parse a "Triggers: foo, bar, /baz" line out of the body, if present.
// Helps the UI surface what WhatsApp commands fire this playbook.
export function extractTriggers(body) {
  const m = body.match(/^\s*Triggers?:\s*(.+)$/im);
  if (!m) return [];
  return m[1]
    .split(/[,;]/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
    .slice(0, 12);
}

export function safeName(name) {
  return String(name || '').replace(/[^\w.-]/g, '');
}

function pathFor(name) {
  const safe = safeName(name);
  if (!safe) return null;
  return path.join(DIR, `${safe}.md`);
}

async function readRaw(name) {
  const p = pathFor(name);
  if (!p) return null;
  try { return await fs.readFile(p, 'utf-8'); } catch { return null; }
}

// listPlaybooks() — returns one record per .md file, enriched with metadata.
// Shape: { name, description, tags, persona, ownerOnly, chain, triggers,
//          variables, updatedAt }
export async function listPlaybooks() {
  let entries = [];
  try { entries = await fs.readdir(DIR); } catch { return []; }
  const out = [];
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    const name = f.replace(/\.md$/, '');
    let info = { name, description: '', tags: [], persona: null, ownerOnly: false, chain: [], triggers: [], variables: [], updatedAt: null };
    try {
      const filePath = path.join(DIR, f);
      const raw = await fs.readFile(filePath, 'utf-8');
      const { meta, body } = parseFrontmatter(raw);
      info.description = meta.description || extractLegacyDescription(body) || '';
      info.tags = Array.isArray(meta.tags) ? meta.tags : (meta.tags ? [meta.tags] : []);
      info.persona = meta.persona || null;
      info.ownerOnly = !!meta.owner_only;
      info.chain = Array.isArray(meta.chain) ? meta.chain : (meta.chain ? [meta.chain] : []);
      const cleanBody = stripLegacyHeader(body);
      info.triggers = Array.isArray(meta.triggers) ? meta.triggers : extractTriggers(cleanBody);
      info.variables = extractVariables(cleanBody);
      try {
        const stat = await fs.stat(filePath);
        info.updatedAt = stat.mtime.toISOString();
      } catch {}
    } catch {}
    out.push(info);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// loadPlaybook(name) — returns the prompt body, with {{vars}} replaced by
// any params passed in. Returns null if missing.
export async function loadPlaybook(name, params = null) {
  const raw = await readRaw(name);
  if (raw == null) return null;
  const { body } = parseFrontmatter(raw);
  const clean = stripLegacyHeader(body);
  if (params && Object.keys(params).length > 0) return applyVariables(clean, params);
  return clean;
}

// loadPlaybookFull(name) — returns the full record (meta + raw + clean body)
// for the editor and the params form.
export async function loadPlaybookFull(name) {
  const raw = await readRaw(name);
  if (raw == null) return null;
  const { meta, body } = parseFrontmatter(raw);
  const clean = stripLegacyHeader(body);
  return {
    name: safeName(name),
    raw,
    body: clean,
    meta,
    description: meta.description || extractLegacyDescription(body) || '',
    tags: Array.isArray(meta.tags) ? meta.tags : (meta.tags ? [meta.tags] : []),
    persona: meta.persona || null,
    ownerOnly: !!meta.owner_only,
    chain: Array.isArray(meta.chain) ? meta.chain : (meta.chain ? [meta.chain] : []),
    triggers: Array.isArray(meta.triggers) ? meta.triggers : extractTriggers(clean),
    variables: extractVariables(clean),
  };
}

// savePlaybook(name, raw) — writes raw markdown to playbooks/<name>.md.
// Caller is responsible for sanitizing `name` (we do safeName here too).
// Returns { ok, error?, name }.
export async function savePlaybook(name, raw) {
  const safe = safeName(name);
  if (!safe) return { ok: false, error: 'invalid name' };
  if (typeof raw !== 'string') return { ok: false, error: 'body must be a string' };
  if (raw.length > 200_000) return { ok: false, error: 'too large' };
  const target = path.join(DIR, `${safe}.md`);
  try {
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(target, raw);
    return { ok: true, name: safe };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function deletePlaybook(name) {
  const safe = safeName(name);
  if (!safe) return false;
  try {
    await fs.unlink(path.join(DIR, `${safe}.md`));
    return true;
  } catch {
    return false;
  }
}

export async function playbookExists(name) {
  const safe = safeName(name);
  if (!safe) return false;
  try { await fs.access(path.join(DIR, `${safe}.md`)); return true; } catch { return false; }
}

// Aggregate all tags across all playbooks (for the filter chip row).
export async function allTags() {
  const list = await listPlaybooks();
  const set = new Set();
  for (const p of list) for (const t of p.tags) set.add(t);
  return [...set].sort();
}
