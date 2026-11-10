// Text → voice-note via the Piper TTS CLI. No-op when piper isn't installed
// or no voice model is configured.
//
// Install (one-time, local, free):
//   pip install --user piper-tts
//   mkdir -p ~/piper-voices && cd ~/piper-voices
//   curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx
//   curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json
//
// Then in .env:
//   PIPER_VOICE=$HOME/piper-voices/en_US-lessac-medium.onnx
//   VOICE_REPLY=1
//
// Output: an .ogg/opus file ready to send via wa-send-file's audio path.

import { exec as execCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execCb);

// Run a command with stdin text. `exec`'s `input` option silently no-ops for
// async exec (it only works on execSync), which leaves piper hanging on an
// empty stdin.
function runWithStdin(cmd, argv, stdin, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error(`timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 300)}`));
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

const TMPDIR = '/tmp/wa-bot-tts';

let _hasPiper = null;
export async function hasPiper() {
  if (_hasPiper !== null) return _hasPiper;
  try { await exec('command -v piper'); _hasPiper = true; }
  catch { _hasPiper = false; }
  return _hasPiper;
}

function voiceModel() {
  return process.env.PIPER_VOICE || '';
}

// Generates an opus .ogg suitable for WhatsApp PTT. Piper writes WAV; we
// transcode via ffmpeg. Returns the absolute file path, or null on any error.
export async function synthesize(text, { id = 'reply', voice = voiceModel() } = {}) {
  if (!text || !voice) return null;
  if (!(await hasPiper())) return null;
  try { await exec('command -v ffmpeg'); } catch { return null; }

  await fs.mkdir(TMPDIR, { recursive: true });
  const safe = id.replace(/[^\w.-]/g, '_');
  const wav = path.join(TMPDIR, `${safe}.wav`);
  const ogg = path.join(TMPDIR, `${safe}.ogg`);

  // Cap input length so we don't synthesise a 10-minute monologue.
  const max = Number(process.env.TTS_MAX_CHARS) || 1500;
  const input = text.slice(0, max);

  const piperBin = process.env.PIPER_BIN || 'piper';
  // piper reads text on stdin, writes WAV to --output_file.
  try {
    await runWithStdin(piperBin, ['--model', voice, '--output_file', wav], input, { timeoutMs: 60_000 });
    await exec(
      `ffmpeg -y -i ${JSON.stringify(wav)} -c:a libopus -b:a 24k -application voip ${JSON.stringify(ogg)}`,
      { timeout: 30_000 },
    );
    return ogg;
  } catch (err) {
    console.error('piper: synth failed', err.message);
    return null;
  }
}
