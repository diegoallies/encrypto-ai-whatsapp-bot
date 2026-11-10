// Voice-note transcription via the openai-whisper Python CLI.
// Falls back to a no-op when whisper isn't on PATH.
//
// Configure model via WHISPER_MODEL (default "tiny" — 39MB, fast).
// Other valid values: tiny, base, small, medium, large.

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execCb);

const MODEL = process.env.WHISPER_MODEL || 'tiny';
const LANGUAGE = process.env.WHISPER_LANGUAGE || 'en';
const TMPDIR = '/tmp/wa-bot-whisper';
const TIMEOUT_MS = Number(process.env.WHISPER_TIMEOUT_MS) || 120_000;

let _hasWhisper = null;
export async function hasWhisper() {
  if (_hasWhisper !== null) return _hasWhisper;
  try { await exec('command -v whisper'); _hasWhisper = true; }
  catch { _hasWhisper = false; }
  return _hasWhisper;
}

export async function transcribe(audioPath) {
  if (!(await hasWhisper())) throw new Error('whisper CLI not installed (pip install openai-whisper)');
  await fs.mkdir(TMPDIR, { recursive: true });
  const base = path.basename(audioPath).replace(/\.[^.]+$/, '');
  const cmd = `whisper ${JSON.stringify(audioPath)} --model ${MODEL} --output_format txt --output_dir ${JSON.stringify(TMPDIR)} --language ${LANGUAGE} --verbose False --fp16 False`;
  await exec(cmd, { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  const txt = await fs.readFile(path.join(TMPDIR, `${base}.txt`), 'utf-8');
  return txt.trim();
}
