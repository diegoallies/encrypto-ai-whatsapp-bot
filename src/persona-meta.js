// Tiny YAML-ish frontmatter parser shared by personas/*.md and the
// per-contact overlays. Same shape as playbooks frontmatter — keep them in
// sync so the editor UI is consistent across pages.

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(raw) {
  if (!raw) return { meta: {}, body: '' };
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { meta: {}, body: raw };
  const block = m[1];
  const body = raw.slice(m[0].length);
  const meta = {};
  let currentKey = null;
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim()) { currentKey = null; continue; }
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && currentKey) {
      if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
      meta[currentKey].push(coerce(listItem[1].trim()));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    currentKey = key;
    if (val === '') { meta[key] = null; continue; }
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map((s) => coerce(s.trim())).filter((s) => s !== '');
      currentKey = null;
      continue;
    }
    meta[key] = coerce(val);
    currentKey = null;
  }
  return { meta, body };
}

function coerce(s) {
  if (s == null) return s;
  const t = String(s).trim().replace(/^["']|["']$/g, '');
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  return t;
}

// Rough token estimate (~4 chars/token). Good enough for the "is this
// system prompt about to blow my budget" warning.
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

// Parse `## Heading` sections out of a markdown body so the editor sidebar
// can render anchor links / a TOC.
export function extractSections(body) {
  if (!body) return [];
  const sections = [];
  const re = /^##\s+(.+)$/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    const title = m[1].trim();
    const anchor = title.toLowerCase().replace(/[^\w]+/g, '-').replace(/(^-|-$)/g, '');
    sections.push({ title, anchor, offset: m.index });
  }
  return sections;
}

// Strip a leading `# Title` + `> description` so the body the bot actually
// sees doesn't include the comment scaffolding.
export function stripLegacyHeader(body) {
  const lines = body.split('\n');
  while (lines.length > 0 && /^(\s*#\s|\s*>\s|\s*$)/.test(lines[0])) lines.shift();
  return lines.join('\n').trim();
}

export function extractDescription(meta, body) {
  if (meta?.description) return String(meta.description);
  const line = (body || '').split('\n').find((l) => l.trim().startsWith('>'));
  return line ? line.replace(/^\s*>\s*/, '').trim() : '';
}

// Quick safety scan over a soul/rules/tone body so the editor can show
// inline warnings. Pure string heuristics — no real semantic check.
export function lint(body) {
  const warnings = [];
  const text = String(body || '');
  if (!text.trim()) {
    warnings.push({ level: 'error', msg: 'Body is empty.' });
    return warnings;
  }
  const tokens = estimateTokens(text);
  if (tokens > 2000) warnings.push({ level: 'warn', msg: `Large prompt (~${tokens} tokens) — every reply pays this cost.` });
  if (text.length > 30_000) warnings.push({ level: 'warn', msg: 'Body over 30k chars — consider splitting into multiple personas.' });
  const headings = (text.match(/^##\s+/gm) || []).length;
  if (headings === 0 && text.length > 800) warnings.push({ level: 'info', msg: 'No `## section` headings — consider structuring.' });
  if (/\bALWAYS\b.*\bNEVER\b/.test(text)) warnings.push({ level: 'info', msg: 'Conflicting ALWAYS/NEVER directives on one line — pick one.' });
  return warnings;
}
