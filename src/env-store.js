// Read/write key/value pairs in the project .env. Preserves comments,
// blank lines, and original ordering; appends previously-unset keys at
// the end. Values containing whitespace, =, # or quotes are written
// double-quoted with backslash-escaping.

import fs from 'node:fs';
import path from 'node:path';

const ENV_FILE = path.resolve(process.cwd(), '.env');

const KEY_LINE = /^\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/;

function needsQuoting(v) {
  return /[\s"'\\#=]/.test(v);
}

function quote(v) {
  return `"${String(v).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function format(value) {
  if (value === '' || value == null) return '';
  return needsQuoting(value) ? quote(value) : String(value);
}

export function readEnvFile() {
  let text = '';
  try { text = fs.readFileSync(ENV_FILE, 'utf-8'); } catch { /* empty file is fine */ }
  const result = {};
  for (const raw of text.split('\n')) {
    const m = KEY_LINE.exec(raw);
    if (!m) continue;
    let val = m[2].trim();
    // Strip surrounding quotes if any.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", '\\');
    }
    result[m[1]] = val;
  }
  return result;
}

// Patch a set of key/value pairs into .env. Setting a value to '' or null
// blanks the line (`KEY=`) but keeps the entry.
export function patchEnv(updates) {
  let text = '';
  try { text = fs.readFileSync(ENV_FILE, 'utf-8'); } catch {}
  const lines = text.split('\n');
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const m = KEY_LINE.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    if (key in updates) {
      lines[i] = `${key}=${format(updates[key])}`;
      seen.add(key);
    }
  }

  // Append any new keys at the end (trimming a trailing empty line if needed).
  const tail = [];
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) tail.push(`${k}=${format(v)}`);
  }
  if (tail.length > 0) {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push('', ...tail);
  }

  fs.writeFileSync(ENV_FILE, lines.join('\n'));
  // Mirror into process.env so changes are visible until restart for things
  // that re-read at runtime.
  for (const [k, v] of Object.entries(updates)) process.env[k] = v == null ? '' : String(v);
}
