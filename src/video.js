// Make videos "visible" to Claude. The Claude Agent SDK's Read tool is
// multimodal for IMAGES but can't parse video binary, so we:
//
//   1. ffprobe the duration
//   2. ffmpeg extract N keyframes evenly distributed across the clip
//   3. whisper the audio (whisper internally invokes ffmpeg to demux)
//
// The handler then hands Claude the list of frame paths + transcript and
// tells it to Read each frame. Effectively turns "see this video" into
// "see these screenshots + read this transcript".
//
// Tunables:
//   VIDEO_MAX_FRAMES=6        upper bound on keyframes (also implicit lower
//                             bound on memory + tokens). Short clips get
//                             fewer; long clips get exactly MAX.
//   VIDEO_TRANSCRIBE=1        set 0 to skip whisper (silent videos / save time)
//   VIDEO_FRAME_QUALITY=4     ffmpeg -q:v, 2..31 (lower=better, 4 is fine)

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { hasWhisper, transcribe } from './integrations/whisper.js';

const exec = promisify(execCb);

const MAX_FRAMES = Math.max(1, Math.min(12, Number(process.env.VIDEO_MAX_FRAMES) || 6));
const TRANSCRIBE = process.env.VIDEO_TRANSCRIBE !== '0';
const QUALITY = Math.max(2, Math.min(31, Number(process.env.VIDEO_FRAME_QUALITY) || 4));

let cached = null;
export async function hasFfmpeg() {
  if (cached !== null) return cached;
  try { await exec('command -v ffmpeg && command -v ffprobe'); cached = true; }
  catch { cached = false; }
  return cached;
}

async function probeDuration(videoPath) {
  try {
    const { stdout } = await exec(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${JSON.stringify(videoPath)}`,
      { timeout: 5_000 },
    );
    const d = parseFloat(stdout.trim());
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch {
    return 0;
  }
}

// Extract up to MAX_FRAMES jpegs, evenly distributed across the video.
// Returns an array of absolute paths. Empty on failure.
export async function extractFrames(videoPath) {
  if (!(await hasFfmpeg())) return [];
  if (!videoPath) return [];

  const duration = await probeDuration(videoPath);
  if (duration <= 0) return [];

  // For very short clips, take fewer frames. For longer ones, cap at MAX.
  const frameCount = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(duration / 1.5)));

  const dir = path.join(
    path.dirname(videoPath),
    `frames-${path.basename(videoPath, path.extname(videoPath))}`,
  );
  await fs.mkdir(dir, { recursive: true });

  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    // Sample at the middle of each equal slice so we don't grab the title
    // card (t=0) or the credit roll (t=duration).
    const t = ((i + 0.5) * duration) / frameCount;
    const out = path.join(dir, `frame-${String(i + 1).padStart(2, '0')}.jpg`);
    try {
      // -ss before -i = fast seek (less accurate but ~100x faster)
      await exec(
        `ffmpeg -y -hide_banner -loglevel error -ss ${t.toFixed(2)} -i ${JSON.stringify(videoPath)} -frames:v 1 -q:v ${QUALITY} ${JSON.stringify(out)}`,
        { timeout: 15_000 },
      );
      // Confirm the file actually wrote something.
      const stat = await fs.stat(out);
      if (stat.size > 0) frames.push(out);
    } catch (err) {
      console.error(`video: frame ${i + 1} extract failed:`, err.message);
    }
  }
  return frames;
}

// Transcribe audio track via whisper (which internally calls ffmpeg, so video
// files work directly). Returns trimmed text, or empty string.
export async function transcribeVideo(videoPath) {
  if (!TRANSCRIBE) return '';
  try {
    if (!(await hasWhisper())) return '';
    return (await transcribe(videoPath)) || '';
  } catch (err) {
    console.error('video: transcribe failed:', err.message);
    return '';
  }
}

// One-shot: process a video into the form the handler needs.
export async function processVideo(videoPath) {
  const [frames, transcript] = await Promise.all([
    extractFrames(videoPath),
    transcribeVideo(videoPath),
  ]);
  return {
    frames,                                     // string[] of absolute paths
    transcript,                                 // string (possibly empty)
    durationSec: await probeDuration(videoPath),
  };
}
