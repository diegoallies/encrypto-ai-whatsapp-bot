// Atomic file writes: write to a temp file in the same directory, then rename
// over the target. rename() is atomic on POSIX, so a crash mid-write can never
// leave a half-written or truncated file — readers see either the old complete
// file or the new complete file, never garbage.

import fs from 'node:fs/promises';
import path from 'node:path';

// Serialize writes per target path so two concurrent writers can't interleave
// temp files and clobber each other.
const chains = new Map();

export async function atomicWrite(filePath, data) {
  const prev = chains.get(filePath) ?? Promise.resolve();
  const next = prev.then(() => doWrite(filePath, data)).catch((err) => {
    console.error(`atomicWrite: ${filePath} failed`, err?.message || err);
    throw err;
  });
  // Keep the chain going even if this write rejected.
  chains.set(filePath, next.catch(() => {}));
  return next;
}

async function doWrite(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  // Unique-ish temp name without Date.now()/random (kept deterministic-friendly).
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`);
  await fs.writeFile(tmp, data, 'utf-8');
  await fs.rename(tmp, filePath);
}

// Append a line atomically-ish. fs.appendFile with a single write of a short
// line is atomic on POSIX for sizes under PIPE_BUF; we also serialize per path
// so concurrent appends don't interleave.
export async function atomicAppend(filePath, line) {
  const prev = chains.get(filePath) ?? Promise.resolve();
  const next = prev.then(async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {});
    await fs.appendFile(filePath, line, 'utf-8');
  }).catch((err) => {
    console.error(`atomicAppend: ${filePath} failed`, err?.message || err);
    throw err;
  });
  chains.set(filePath, next.catch(() => {}));
  return next;
}
