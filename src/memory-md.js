// Parser for MEMORY.md. Splits the file by `## ` headings and exposes
// section-aware helpers used by the system-prompt builder and /memory UI.
// mtime-cached so we don't re-parse on every turn.

import { promises as fs } from 'node:fs';
import { atomicWrite } from './atomic-write.js';

const FILE = 'MEMORY.md';
let cache = null; // { mtime, sections: Map<title, body>, order: string[] }

async function load() {
  try {
    const stat = await fs.stat(FILE);
    if (cache && cache.mtime === stat.mtimeMs) return cache;
    const raw = await fs.readFile(FILE, 'utf-8');
    cache = { mtime: stat.mtimeMs, ...parse(raw), raw };
    return cache;
  } catch {
    cache = { mtime: 0, sections: new Map(), order: [], raw: '' };
    return cache;
  }
}

function parse(raw) {
  const sections = new Map();
  const order = [];
  const lines = raw.split('\n');
  let currentTitle = null;
  let currentBody = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (currentTitle !== null) {
        sections.set(currentTitle, currentBody.join('\n').trim());
        order.push(currentTitle);
      }
      currentTitle = line.slice(3).trim();
      currentBody = [];
    } else if (currentTitle !== null) {
      currentBody.push(line);
    }
  }
  if (currentTitle !== null) {
    sections.set(currentTitle, currentBody.join('\n').trim());
    order.push(currentTitle);
  }
  return { sections, order };
}

export async function getSections() {
  const { sections, order, raw } = await load();
  return { sections, order, raw };
}

// All sections whose title starts with "Critical lesson". Each section is a
// single rule the bot must respect — small enough to inject into every prompt.
export async function getCriticalLessons() {
  const { sections, order } = await load();
  const out = [];
  for (const title of order) {
    if (/^critical lesson/i.test(title)) {
      const body = sections.get(title) || '';
      if (body) out.push({ title, body });
    }
  }
  return out;
}

export async function getSectionBody(title) {
  const { sections } = await load();
  return sections.get(title) || '';
}

// Replace a single `## Title` section, preserve everything else, write back.
export async function setSectionBody(title, body) {
  const { raw } = await load();
  const lines = raw.split('\n');
  const headingLine = `## ${title}`;
  const startIdx = lines.findIndex((l) => l.trim() === headingLine);
  if (startIdx === -1) {
    // Append as new section at end
    const next = raw.replace(/\n+$/, '') + `\n\n## ${title}\n${body.trim()}\n`;
    await atomicWrite(FILE, next);
    cache = null;
    return;
  }
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { endIdx = i; break; }
  }
  const before = lines.slice(0, startIdx + 1);
  const after = lines.slice(endIdx);
  const next = [...before, '', body.trim(), '', ...after].join('\n').replace(/\n{3,}/g, '\n\n');
  await atomicWrite(FILE, next);
  cache = null;
}

export function _invalidate() { cache = null; }
