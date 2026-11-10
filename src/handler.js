import { extractText, describeNonText, chatType, quotedMessage } from './parse.js';
import { ownerName } from './owner.js';
import { feedOwnerOnboarding } from './owner-setup.js';
import { splitForWhatsApp } from './chunk.js';
import { enqueue, queueDepth } from './queue.js';
import * as incomingBuffer from './incoming-buffer.js';
import * as lastActivity from './last-activity.js';
import { recordMessage, recordError, recordChunks, recordResponseTime } from './stats.js';
import { appendDailyNote, appendChat, incrementCounter, getCounter } from './memory.js';
import { downloadIncomingMedia } from './media.js';
import { hasWhisper, transcribe } from './integrations/whisper.js';
import { dispatchCommand } from './commands.js';
import { ackReceived, ackDone, ackError, clearAck } from './reactions.js';
import { createStreamSender } from './streaming.js';
import { reliableSend } from './reliable-send.js';
import { buildMentions } from './mentions.js';
import { notifyStranger, consumePendingPing } from './stranger-notify.js';
import { addAllowed } from './allowlist.js';
import { handleReaction } from './reaction-commands.js';
import { shouldRespond } from './group-mode.js';
import { displayName } from './contacts.js';
import { synthesize as ttsSynth } from './integrations/piper.js';
import { check as costCheck, recordTokens, thresholds as costThresholds } from './cost-guard.js';
import { coalesce, drainBuffered } from './coalescer.js';
import { extractUrls, shouldUnfurl, buildUnfurlPrompt } from './url-unfurler.js';
import { detectTrigger as focusTrigger, enter as enterFocus, exit as exitFocus, isActive as focusActive } from './focus-mode.js';
import { isNoReply } from './no-reply.js';
import { processVideo, hasFfmpeg } from './video.js';
import { filterReply, filterStreamChunk, detectInternalLeak, shouldSuppressEntirely } from './reply-filter.js';
import { proofread, needsProofreading, getEnabled as proofreaderEnabled } from './proofreader.js';
import { startProcessing, stopProcessing, updatePreview } from './processing-state.js';
import { isPoweredOn } from './bot-power.js';
import * as activeRuns from './active-runs.js';

const DAILY_MSG_CAP = Number(process.env.DAILY_MSG_CAP_DEFAULT || 0);
// Track current buffer item being processed (for cancel support)
let currentBufferId = null;
const PER_JID_CAPS = parsePerJidCaps(process.env.DAILY_MSG_CAP_PER_JID);
const PER_JID_LIMIT_MSG = parsePerJidStrings(process.env.DAILY_MSG_LIMIT_TEXT_PER_JID);
const STREAM_REPLIES = process.env.STREAM_REPLIES !== '0';

function parsePerJidCaps(raw) {
  if (!raw) return new Map();
  const out = new Map();
  for (const part of String(raw).split(',')) {
    const [jid, n] = part.split(':').map((s) => s && s.trim());
    if (jid && Number.isFinite(Number(n))) out.set(jid, Number(n));
  }
  return out;
}

// Parse "jid:Message text|jid2:Other text" — single pipe between entries to
// allow commas/colons inside the message body.
function parsePerJidStrings(raw) {
  if (!raw) return new Map();
  const out = new Map();
  for (const part of String(raw).split('|')) {
    const m = /^([^:]+):(.+)$/.exec(part.trim());
    if (m) out.set(m[1].trim(), m[2].trim());
  }
  return out;
}

function capFor(jid) {
  return PER_JID_CAPS.get(jid) ?? DAILY_MSG_CAP;
}

function limitMsgFor(jid, cap) {
  return PER_JID_LIMIT_MSG.get(jid) || `That's my limit for today (${cap} messages). Chat tomorrow!`;
}

const PRESENCE_REFRESH_MS = 15_000;

function logKv(fields) {
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    const s = String(v);
    if (/[\s"]/.test(s)) parts.push(`${k}="${s.replace(/"/g, '\\"')}"`);
    else parts.push(`${k}=${s}`);
  }
  console.log(parts.join(' '));
}

// All JIDs that count as "owner" — i.e. you, from any device or any form
// (your phone @s.whatsapp.net, your @lid, etc.). Precedence:
//   OWNER_JIDS (explicit, comma-separated)  →  ALLOWED_JIDS[0] (default)
function ownerJids() {
  const explicit = (process.env.OWNER_JIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (explicit.length > 0) return explicit;
  const first = (process.env.ALLOWED_JIDS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
  return first ? [first] : [];
}

function ownerJid() {
  return ownerJids()[0] || null;
}

// Quick text-or-text-like preview used in blocked / system logs.
function previewOf(msg) {
  const t = extractText(msg);
  if (t) return t;
  const n = describeNonText(msg);
  return n ? `[${n}]` : '';
}

// Stop / esc phrases. Checked the moment a message arrives, before any
// queueing, so they can cut into a run that's already going. Whole-message
// match only, so "stop the server on port 80" is still a normal prompt.
const STOP_RE = /^\s*(?:(?:bro|yo|ok|okay|hey)[\s,]+)?\/?(stop|esc|escape|cancel|abort|halt)(\s+(all|everything|it|that|now|all\s+(your\s+)?tasks|all\s+tasks|what\s+you'?re\s+doing))?\s*[.!]*\s*$/i;

export function parseStop(text) {
  const m = STOP_RE.exec(text || '');
  if (!m) return null;
  return { all: /\b(all|everything)\b/i.test(m[2] || '') };
}

// Last /stop per chat (and for /stop all). A batch that was already sitting
// in the coalescer or queue when the stop landed gets dropped instead of
// running afterwards.
const stoppedJids = new Map();
let stopAllAt = 0;

function stoppedAfter(jid, msgs) {
  const stopAt = Math.max(stoppedJids.get(jid) || 0, stopAllAt);
  if (!stopAt) return false;
  const newest = Math.max(...msgs.map((m) => Number(m.messageTimestamp) || 0));
  // WhatsApp timestamps are whole seconds; only drop when the stop is
  // clearly after the newest message in the batch.
  return newest > 0 && stopAt >= (newest + 1) * 1000;
}

// Per-message materialization: download media, transcribe voice if needed,
// extract text. Returns { text, media, voiceText, fatal } — fatal=true means
// the message can't be processed (and we already messaged the user about it).
async function materialize(msg, sock, logger) {
  const jid = msg.key.remoteJid;
  const msgId = msg.key.id;
  const text = extractText(msg);
  const nonText = text ? null : describeNonText(msg);

  const isMediaCapable = nonText === 'image' || nonText === 'video' || nonText === 'document' || nonText === 'sticker';
  const captionedMedia = text && (msg?.message?.imageMessage || msg?.message?.videoMessage || msg?.message?.documentMessage);

  if (isMediaCapable || captionedMedia) {
    const media = await downloadIncomingMedia(msg, logger, sock);
    if (media) logKv({ evt: 'media', jid, msgId, kind: media.kind, path: media.path, bytes: media.bytes });

    // Videos: extract keyframes + transcribe audio so Claude can actually
    // "see" them (the Read tool is image-multimodal, not video-aware).
    if (media && media.kind === 'video') {
      if (!(await hasFfmpeg())) {
        logKv({ evt: 'video-skip', jid, msgId, reason: 'no-ffmpeg' });
      } else {
        await sock.sendPresenceUpdate('recording', jid).catch(() => {});
        try {
          const { frames, transcript, durationSec } = await processVideo(media.path);
          media.frames = frames;
          media.transcript = transcript;
          media.durationSec = durationSec;
          logKv({ evt: 'video-processed', jid, msgId, frames: frames.length, durationSec: Math.round(durationSec), transcribed: transcript.length });
        } catch (err) {
          logKv({ evt: 'video-err', jid, msgId, error: err.message });
        } finally {
          await sock.sendPresenceUpdate('paused', jid).catch(() => {});
        }
      }
    }

    return { text, media, voiceText: null };
  }

  if (nonText === 'voice note' || nonText === 'audio') {
    const audio = await downloadIncomingMedia(msg, logger, sock);
    if (!audio) {
      await sock.sendMessage(jid, { text: `Couldn't grab that voice note — try sending again.` }).catch(() => {});
      return { fatal: true };
    }
    if (!(await hasWhisper())) {
      await sock.sendMessage(jid, {
        text: `Voice transcription needs whisper. Install: pip install --user openai-whisper`,
      }).catch(() => {});
      return { fatal: true };
    }
    try {
      await sock.sendPresenceUpdate('recording', jid).catch(() => {});
      const voiceText = await transcribe(audio.path);
      logKv({ evt: 'transcribed', jid, msgId, chars: voiceText.length });
      return { text: null, media: null, voiceText };
    } catch (err) {
      logKv({ evt: 'transcribe-err', jid, msgId, error: err.message });
      await sock.sendMessage(jid, {
        text: `Couldn't transcribe that — ${err.message.slice(0, 100)}`,
      }).catch(() => {});
      return { fatal: true };
    } finally {
      await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    }
  }

  if (nonText && nonText !== 'reaction') {
    // In groups, silently ignore unsupported media to avoid spamming
    if (jid.endsWith('@g.us')) {
      return { fatal: true };
    }
    await sock.sendMessage(jid, {
      text: `I only handle text, images, and voice notes right now (got: ${nonText}).`,
    }).catch(() => {});
    return { fatal: true };
  }

  return { text, media: null, voiceText: null };
}

// Build the prompt Claude sees from a single materialized message.
function buildSinglePrompt({ text, media, voiceText }) {
  const trimmed = (text || voiceText || '').trim();
  if (!media) return trimmed;

  const lines = [];

  // Video: list keyframes + transcript so Claude can Read each frame as an
  // image. Without this it'd try to Read the .mp4 binary and fail.
  if (media.kind === 'video' && Array.isArray(media.frames) && media.frames.length > 0) {
    const dur = media.durationSec ? ` (~${Math.round(media.durationSec)}s)` : '';
    lines.push(`[user sent a video${dur}]`);
    lines.push(`source file: ${media.path}`);
    if (media.filename) lines.push(`filename: ${media.filename}`);
    if (media.caption) lines.push(`caption: ${media.caption}`);
    lines.push('');
    lines.push(`I extracted ${media.frames.length} keyframe${media.frames.length === 1 ? '' : 's'}, evenly spaced across the clip. Use the Read tool on each in order to see the video:`);
    for (let i = 0; i < media.frames.length; i++) {
      lines.push(`  frame ${i + 1}: ${media.frames[i]}`);
    }
    if (media.transcript) {
      lines.push('');
      lines.push('Audio transcript (whisper):');
      lines.push(media.transcript);
    } else {
      lines.push('');
      lines.push('Audio: (silent / no transcript)');
    }
    if (trimmed) {
      lines.push('');
      lines.push(`User wrote: ${trimmed}`);
    }
    return lines.join('\n');
  }

  // Plain media (image / sticker / document / unprocessed-video fallback).
  lines.push(`[user sent a ${media.kind}${media.mimetype ? ` (${media.mimetype})` : ''}]`);
  lines.push(`local path: ${media.path}`);
  if (media.filename) lines.push(`filename: ${media.filename}`);
  if (media.caption) lines.push(`caption: ${media.caption}`);
  lines.push('');
  lines.push('To view the file contents, use the Read tool on the local path above.');
  if (trimmed) {
    lines.push('');
    lines.push(`User wrote: ${trimmed}`);
  }
  return lines.join('\n');
}

export function createHandler({
  sock,
  agent,
  isAllowed,
  scheduler = null,
  refreshMs = PRESENCE_REFRESH_MS,
  logger = null,
  isOwner = (jid) => {
    if (!jid) return false;
    return ownerJids().includes(jid);
  },
}) {
  // ─── Single-message entry point (full pipeline) ────────────────────────
  // Used by tests and by anything that wants synchronous-feeling delivery.
  // Runs the fast-paths (reactions, commands, reply-allow) first; falls
  // through to processBatch for everything else.
  async function handle(msg) {
    // First-run onboarding: until the bot is configured, the first person to
    // DM it is walked through setup (name, phone, timezone…) and soul.md/.env
    // are filled in. Groups are ignored during setup.
    try {
      const jid0 = msg.key?.remoteJid || '';
      const isDm0 = jid0.endsWith('@s.whatsapp.net') || jid0.endsWith('@lid');
      if (!msg.key?.fromMe && isDm0) {
        const t0 = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const reply0 = await feedOwnerOnboarding(jid0, t0);
        if (reply0) { await sock.sendMessage(jid0, { text: reply0 }).catch(() => {}); return; }
      }
    } catch {}
    const handled = await quickPath(msg);
    if (handled) return;
    return processBatch([msg]);
  }

  // ─── Multi-message processor ───────────────────────────────────────────
  // Materializes each message (media / voice), folds in any late arrivals
  // from the coalescer buffer, then sends a single AI reply that addresses
  // the whole batch.
  async function processBatch(initial) {
    if (!initial || initial.length === 0) return;
    const jid = initial[0].key.remoteJid;
    const kind = chatType(jid);

    // Fold in any messages that snuck into the buffer between fireBatch and
    // the queue dequeuing us. Tight race; this closes it.
    const extras = drainBuffered(jid);
    let msgs = extras.length ? [...initial, ...extras] : initial;

    // Allowlist gate (per-JID). Use the LAST message for the stranger ping
    // preview so the owner sees the most recent thing they said.
    if (!isAllowed(jid)) {
      // Late-LID backfill: contact-add resolves the @lid up-front, but
      // Baileys v7 doesn't always know the mapping until the contact has
      // messaged us once. Reverse-resolve their LID → phone, and if the
      // phone belongs to a known allowlisted contact, hot-allow the LID
      // so their first reply isn't dropped.
      if (kind === 'dm' && jid.endsWith('@lid')) {
        try {
          const { backfillLidFromMessage } = await import('./contact-onboard.js');
          const phoneJid = await backfillLidFromMessage(sock, jid);
          if (phoneJid) logKv({ evt: 'allowlist-lid-backfill', jid, phoneJid });
        } catch {}
      }
      if (!isAllowed(jid)) {
        const last = msgs[msgs.length - 1];
        const previewText = previewOf(last);
        logKv({ evt: 'blocked', jid, kind, batch: msgs.length, text: previewText.slice(0, 60) });
        if (kind === 'dm') {
          const owner = ownerJid();
          if (owner) {
            notifyStranger({ sock, ownerJid: owner, fromJid: jid, preview: previewText, kind, msg: last }).catch(() => {});
          }
        }
        return;
      }
    }

    // Materialize each message (download/transcribe). Drop fatals.
    const materialized = [];
    for (const msg of msgs) {
      const m = await materialize(msg, sock, logger);
      if (!m.fatal) materialized.push({ msg, ...m });
    }
    if (materialized.length === 0) return;

    // Group silence: only reply if at least one msg addresses the bot.
    // Check after materialization so transcribed voice notes can count.
    // Use the bot's own JID (sock.user.id), not the owner's JID.
    const botJid = sock.user?.id || '';
    const ownNum = botJid.split('@')[0].split(':')[0]; // strip @s.whatsapp.net and any :device suffix
    const ownLid = sock.user?.lid?.split('@')[0]?.split(':')[0] || null; // LID for group mentions
    if (kind === 'group') {
      let respond = false;
      for (const { msg } of materialized) {
        if (await shouldRespond(msg, ownNum, ownLid)) { respond = true; break; }
      }
      if (!respond) {
        const ids = materialized.map((m) => m.msg.key.id).join(',');
        logKv({ evt: 'silent', jid, msgIds: ids, reason: 'group-not-addressed' });
        return;
      }
    }

    // ─── Owner focus-mode triggers ─────────────────────────────────────────
    // If the owner says "stop / drop everything / focus on me", flip focus
    // mode on and silence everyone else for FOCUS_TTL_MS. "resume" flips off.
    const isOwnerJidEarly = isOwner(jid);
    if (isOwnerJidEarly) {
      for (const { text: t, voiceText: vt } of materialized) {
        const tr = focusTrigger(t || vt || '');
        if (tr === 'enter') {
          await enterFocus({ ownerJid: jid, reason: (t || vt || '').slice(0, 120) });
          await sock.sendMessage(jid, { text: '🔒 Focus mode on — silencing other chats. Say "resume" when done.' }).catch(() => {});
          logKv({ evt: 'focus-enter', jid });
          return;
        }
        if (tr === 'exit') {
          await exitFocus();
          await sock.sendMessage(jid, { text: '🔓 Focus mode off — back to everyone.' }).catch(() => {});
          logKv({ evt: 'focus-exit', jid });
          return;
        }
      }
    }
    // Non-owner messages get silently dropped while focus mode is active.
    if (!isOwnerJidEarly && (await focusActive())) {
      logKv({ evt: 'focus-suppressed', jid, kind });
      return;
    }

    // ─── No-reply judgement (groups only by default) ───────────────────────
    // Skip Claude entirely for noise-y group messages that aren't addressed
    // to the bot. DMs always reply.
    if (kind === 'group') {
      const lastMat = materialized[materialized.length - 1];
      const lastText = lastMat.text || lastMat.voiceText || '';
      // shouldRespond above already confirmed the bot was addressed by *some*
      // message in the batch — but if the LAST one is pure noise we still skip
      // any reply that'd be addressing noise. This is conservative: only skip
      // when the batch is a single noise message.
      if (materialized.length === 1 && isNoReply(lastText, { addressedBot: false })) {
        logKv({ evt: 'silent', jid, msgId: lastMat.msg.key.id, reason: 'low-value' });
        return;
      }
    }

    // Build the combined prompt.
    const lastMsg = materialized[materialized.length - 1].msg;
    const lastMsgId = lastMsg.key.id;

    // Resolve each message's sender for groups up front. A coalesced turn in a
    // group can mix several different people (and other bots), so we attribute
    // every line to its own sender instead of labelling the whole batch by one
    // sender — that mislabelling is what caused replies aimed at the wrong
    // person.
    const senderJidOf = (m) => m.msg.key?.participant || m.msg.participant || null;
    let groupSenders = null;
    if (kind === 'group') {
      groupSenders = await Promise.all(materialized.map(async (m) => {
        const p = senderJidOf(m);
        const isOwn = p ? isOwner(p) : false;
        const nm = p ? await displayName(p).catch(() => null) : null;
        const phone = p?.endsWith('@s.whatsapp.net') ? `+${p.split('@')[0]}` : null;
        const base = nm || phone || p?.split('@')[0] || 'someone';
        return { jid: p, isOwn, label: isOwn ? `${base} (${ownerName()}, owner)` : base };
      }));
    }

    let prompt;
    if (materialized.length === 1) {
      prompt = buildSinglePrompt(materialized[0]);
      // Quoted-reply context for single messages.
      const quoted = quotedMessage(materialized[0].msg);
      if (quoted?.text) {
        const who = quoted.jid === jid ? 'you' : (quoted.jid || 'someone');
        prompt = `[reply to message from ${who}]\n> ${quoted.text.slice(0, 500).replace(/\n/g, '\n> ')}\n\n${prompt}`;
      }
    } else {
      const segments = materialized.map((m, i) => {
        // In groups, tag each line with WHO sent it so a multi-person burst
        // never collapses into a single assumed author.
        const who = groupSenders ? `[${groupSenders[i].label}] ` : '';
        return `${i + 1}. ${who}${buildSinglePrompt(m) || '(empty)'}`;
      });
      prompt = `[${materialized.length} messages in quick succession — treat as one turn]\n\n${segments.join('\n\n')}`;
    }

    // ─── URL unfurl ────────────────────────────────────────────────────────
    // When the user sends just a link (or link + a couple words), replace
    // the prompt with a "summarise these URLs" instruction. URL_UNFURL=1.
    if (materialized.length === 1) {
      const t = materialized[0].text || materialized[0].voiceText || '';
      if (shouldUnfurl(t)) {
        const urls = extractUrls(t);
        prompt = buildUnfurlPrompt(urls);
        logKv({ evt: 'unfurl', jid, urls: urls.length });
      }
    }

    // ─── Speaker identity (CRITICAL) ────────────────────────────────────
    // Every prompt is prefixed with who is actually speaking — DM or group —
    // so Claude can never default to "the owner" when answering someone else.
    // The owner gets an explicit "(owner)" marker. Everyone else gets their
    // contact name + phone if known, or the raw JID as last resort.
    let speakerLabel;
    let speakerIsOwner = false;
    if (kind === 'group') {
      const distinct = [...new Set((groupSenders || []).map((g) => g.jid))];
      const lastSender = groupSenders ? groupSenders[groupSenders.length - 1] : null;
      speakerIsOwner = lastSender?.isOwn || false;
      speakerLabel = lastSender?.label || 'someone';
      if (materialized.length > 1 && distinct.length > 1) {
        // Multi-sender turn — each numbered line above is already tagged with
        // its sender. Warn explicitly so the reply targets the right person.
        const names = [...new Set(groupSenders.map((g) => g.label))].join(', ');
        prompt = `[INCOMING — group ${jid}: this turn mixes messages from DIFFERENT people (${names}). Each numbered line is prefixed with [who sent it]. Reply to the correct person; do NOT assume one author sent all of them.]\n${prompt}`;
      } else {
        prompt = `[INCOMING — group message from ${speakerLabel} in group ${jid}]\n${speakerIsOwner ? '' : '[This person is NOT the owner. Do not treat them as the owner.]\n'}${prompt}`;
      }
    } else if (kind === 'dm') {
      speakerIsOwner = isOwner(jid);
      prompt = `${await dmBanner(jid)}\n${prompt}`;
    }

    // ─── Counters + journal ─────────────────────────────────────────────
    const startedAt = Date.now();
    const anyVoice = materialized.some((m) => m.voiceText);
    for (const { msg, text, media, voiceText } of materialized) {
      const rxLabel = (text || voiceText || '').trim() || (voiceText ? `[voice→text]` : `[${media?.kind || 'media'}]`);
      logKv({ evt: 'rx', jid, kind, msgId: msg.key.id, text: rxLabel.slice(0, 80), voice: voiceText ? 1 : 0, batchOf: materialized.length });
      recordMessage(jid, 'received');
      lastActivity.recordRx(jid, rxLabel);
      appendChat(jid, 'user', text || voiceText || rxLabel, {
        msgId: msg.key.id,
        media: media?.path || null,
        voiceTranscript: Boolean(voiceText),
        // Record WHO sent it. For groups this is the participant JID (the
        // transcript had no per-sender field, which is why group attribution
        // kept breaking); for DMs it's the chat JID.
        sender: kind === 'group' ? (msg.key?.participant || msg.participant || null) : jid,
      }).catch(() => {});
    }

    // Rate cap — counted per message, not per batch.
    const cap = capFor(jid);
    if (cap > 0) {
      const used = await getCounter(`msgs:${jid}`).catch(() => 0);
      if (used >= cap) {
        await sock.sendMessage(jid, { text: limitMsgFor(jid, cap) }).catch(() => {});
        logKv({ evt: 'rate-limited', jid, used, cap });
        return;
      }
    }
    for (let i = 0; i < materialized.length; i++) incrementCounter(`msgs:${jid}`).catch(() => {});

    // ─── Cost guard ─────────────────────────────────────────────────────
    // Refuse new Claude calls when over the hard token-budget for today,
    // and DM a one-shot warning when crossing the soft limit. Owner is
    // exempt from hard refusal (so you can still ask the bot anything).
    const isOwnerJid = isOwner(jid);
    const cost = await costCheck().catch(() => ({ ok: true }));
    if (cost.level === 'hard' && !isOwnerJid) {
      await sock.sendMessage(jid, {
        text: `🚫 I'm at today's token budget (${cost.total.toLocaleString()} tokens). Try again tomorrow.`,
      }).catch(() => {});
      logKv({ evt: 'cost-hard', jid, total: cost.total });
      return;
    }
    if (cost.level === 'soft') {
      const t = costThresholds();
      const owner = ownerJid();
      if (owner) {
        await sock.sendMessage(owner, {
          text: `💸 Heads up — bot has used ${cost.total.toLocaleString()} tokens today (soft limit ${t.soft.toLocaleString()}, hard ${t.hard.toLocaleString() || 'none'}).`,
        }).catch(() => {});
      }
      logKv({ evt: 'cost-soft', total: cost.total });
    }

    // ─── Reply ──────────────────────────────────────────────────────────
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    const ticker = setInterval(() => {
      sock.sendPresenceUpdate('composing', jid).catch(() => {});
    }, refreshMs);

    // Track processing state for the web UI typing indicator
    const promptPreview = prompt.slice(0, 80).replace(/\s+/g, ' ');
    startProcessing(jid, promptPreview, currentBufferId);

    try {
      const stream = createStreamSender({ sock, jid });

      // Don't stream group replies. Streaming sends chunks live, before the
      // proofreader/filter can vet the full message — that's how internal
      // commentary ("Connection is back…", "Staying quiet.") leaked into
      // groups. For groups we buffer the whole reply, vet it, then send once.
      //
      // Same reasoning for DMs when the AI proofreader is ON: streamed chunks
      // are delivered live (streaming.js) before proofread() ever runs, so its
      // cleaning/suppression would be a silent no-op (raw text already sent).
      // Buffer + vet + send once whenever proofreading can act on the reply.
      // Owner DMs always stream (the owner wants live replies); the proofreader
      // still vets everyone else's DMs.
      const useStreaming =
        STREAM_REPLIES && kind !== 'group' && (isOwner(jid) || !proofreaderEnabled());

      const onChunk = useStreaming
        ? async (part) => {
            if (!part) return;
            // Filter out internal reasoning that leaked into streaming chunks
            const filtered = filterStreamChunk(part);
            if (!filtered) {
              logKv({ evt: 'stream-filtered', jid, preview: part.slice(0, 60) });
              return;
            }
            await stream.append(filtered);
            // Update processing state with partial response
            updatePreview(jid, filtered.slice(0, 60) + '...');
          }
        : undefined;

      // Check if cancelled before starting Claude call
      if (stoppedAfter(jid, materialized.map((m) => m.msg))) {
        logKv({ evt: 'cancelled-before-claude', jid, msgId: lastMsgId, reason: 'stop' });
        return;
      }
      if (currentBufferId && incomingBuffer.isCancelRequested(currentBufferId)) {
        logKv({ evt: 'cancelled-before-claude', jid, msgId: lastMsgId });
        return;
      }

      let result;
      let attempt = 0;
      while (true) {
        try {
          result = await agent.askClaude(jid, prompt, { onChunk, injectable: kind === 'dm', source: 'chat' });
          break;
        } catch (err) {
          attempt += 1;
          const m = err?.message || String(err);
          const transientApi = /Overloaded|Rate limited|temporarily limiting|\b529\b|\b503\b|\b502\b/i.test(m);
          const networkErr = /process exited with code|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/i.test(m);
          const retryable = transientApi || networkErr;
          const maxAttempts = transientApi ? 5 : 2;
          if (!retryable || attempt >= maxAttempts || stream.chunkCount() > 0) throw err;
          const backoffMs = transientApi ? Math.min(2000 * 2 ** (attempt - 1), 16000) : 2000;
          logKv({ evt: 'retry', jid, msgId: lastMsgId, attempt, backoffMs, error: m.slice(0, 120) });
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }

      // Check if cancelled after Claude call (don't send response)
      if (currentBufferId && incomingBuffer.isCancelRequested(currentBufferId)) {
        logKv({ evt: 'cancelled-after-claude', jid, msgId: lastMsgId });
        return;
      }
      const rawText = typeof result === 'string' ? result : result?.text || '';
      const streamed = typeof result === 'object' && result?.streamed;

      // Stopped mid-run (/stop). Whatever already streamed stays; nothing
      // else goes out. The stop command already confirmed to the user.
      if (result?.interrupted) {
        if (streamed) await stream.finalize().catch(() => {});
        if (rawText) appendChat(jid, 'assistant', `${rawText}\n[stopped]`, { msgId: lastMsgId, streamed, interrupted: true }).catch(() => {});
        logKv({ evt: 'interrupted', jid, msgId: lastMsgId, durMs: Date.now() - startedAt });
        return;
      }

      // Filter internal reasoning from full reply before sending
      const fullText = filterReply(rawText, logKv);
      if (!fullText) {
        // Entire reply was internal reasoning - suppress it
        logKv({ evt: 'reply-suppressed-full', jid, msgId: lastMsgId, preview: rawText.slice(0, 80) });
        // Still log to chat history for debugging
        appendChat(jid, 'assistant', `[SUPPRESSED: ${rawText.slice(0, 200)}]`, { msgId: lastMsgId, suppressed: true }).catch(() => {});
        return;
      }

      // Detect residual internal content the line filter couldn't strip
      // (inline leaks). A detected leak forces the AI proofreader below.
      const leak = detectInternalLeak(fullText);
      if (leak.leaked) {
        logKv({ evt: 'reply-internal-detected', jid, msgId: lastMsgId, patterns: leak.patterns.join(';') });
      }

      // ─── PROOFREADER GATE ─────────────────────────────────────────────────
      // AI-based filter for internal reasoning/commentary before sending.
      // Uses a fast haiku call to catch stuff the regex filter might miss.
      // Runs when needsProofreading() flags it OR a leak was detected above.
      let finalText = fullText;
      if (needsProofreading(fullText) || leak.leaked) {
        finalText = await proofread(fullText, { logFn: logKv });
        if (!finalText) {
          // Suppression only means anything if nothing has been sent yet. When a
          // reply was streamed, the chunks are already delivered — we can't
          // un-send them, so don't log a fake "suppressed" (and keep the stream
          // bookkeeping intact below). This shouldn't happen now that streaming
          // is disabled whenever the proofreader is on, but guard it anyway.
          if (!streamed) {
            logKv({ evt: 'proofreader-suppressed', jid, msgId: lastMsgId, preview: fullText.slice(0, 80) });
            appendChat(jid, 'assistant', `[PROOFREAD-SUPPRESSED] ${fullText.slice(0, 200)}`, { msgId: lastMsgId, suppressed: true }).catch(() => {});
            return;
          }
          logKv({ evt: 'proofreader-suppress-too-late', jid, msgId: lastMsgId, preview: fullText.slice(0, 80) });
          finalText = fullText; // already streamed; fall through to finalize
        }
      }

      if (!streamed) {
        const chunks = splitForWhatsApp(finalText);
        for (const part of chunks) {
          // mentions must live in the CONTENT object (next to text), not the
          // 3rd options arg — Baileys reads content.mentions. Passing it as
          // options silently drops it (renders as grey text).
          const { mentions } = await buildMentions(sock, jid, part);
          const content = mentions ? { text: part, mentions } : { text: part };
          await reliableSend(sock, jid, content);
        }
        recordChunks(chunks.length);
      } else {
        await stream.finalize();
        recordChunks(stream.chunkCount());
      }

      appendChat(jid, 'assistant', finalText, { msgId: lastMsgId, streamed, batchOf: materialized.length }).catch(() => {});

      // Voice reply: if the user spoke and VOICE_REPLY is on, also send the
      // reply as an opus voice note. Best-effort — no-op when Piper / model
      // isn't configured.
      if (anyVoice && process.env.VOICE_REPLY === '1' && finalText.length < 2000) {
        try {
          const oggPath = await ttsSynth(finalText, { id: lastMsgId || `tts-${Date.now()}` });
          if (oggPath) {
            const buf = await (await import('node:fs')).promises.readFile(oggPath);
            await reliableSend(sock, jid, { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true });
            logKv({ evt: 'tts', jid, msgId: lastMsgId, bytes: buf.length });
          }
        } catch (err) {
          logKv({ evt: 'tts-err', jid, msgId: lastMsgId, error: err.message?.slice(0, 120) });
        }
      }
      const responseTimeMs = Date.now() - startedAt;
      logKv({
        evt: 'tx',
        jid,
        msgId: lastMsgId,
        durMs: responseTimeMs,
        chunks: streamed ? stream.chunkCount() : splitForWhatsApp(fullText).length,
        streamed: streamed ? 1 : 0,
        batchOf: materialized.length,
        reply: fullText.slice(0, 80),
      });
      // Record analytics
      recordMessage(jid, 'sent');
      recordResponseTime(responseTimeMs);
      lastActivity.recordTx(jid, fullText);
    } catch (err) {
      recordError(err);
      const emsg = err?.message || String(err);
      logKv({ evt: 'err', jid, msgId: lastMsgId, durMs: Date.now() - startedAt, error: emsg });
      // Anthropic AUP / usage-policy refusals come back as a returned error, not a
      // transient one — retrying never helps and the generic "something went wrong"
      // leaves the person guessing. Give them an honest message and ping the owner
      // so a human can step in and reply manually.
      // Two flavours of hard refusal come back as a returned error (retry never helps):
      //  1. Anthropic AUP / usage-policy blocks
      //  2. model safeguards flagging a topic (e.g. "safeguards flagged this message
      //     for a cybersecurity topic … apply for an exemption")
      const policyBlock = /Usage Policy|unable to respond to this request|\baup\b|safeguards? flagged|flagged this (message|topic|request)|cyber\s?security topic|apply for an exemption|flagged .* for a .* topic/i.test(emsg);
      const senderIsOwner = jid === ownerJid();
      await reliableSend(sock, jid, {
        text: policyBlock
          ? (senderIsOwner
              ? "Bro that one got flagged by my provider's safeguards (cybersecurity topic) so I can't answer it automatically. Try rephrasing it, or ask me a different way and I'll get it."
              : "Sorry, my provider's safeguards flagged that topic so I can't answer it automatically. I've flagged it to the owner so he can step in.")
          : '⚠ Something went wrong on my end. Try again in a moment, or /reset if it keeps failing.',
      }).catch(() => {});
      await ackError(sock, lastMsg);
      if (policyBlock) {
        const owner = ownerJid();
        if (owner && owner !== jid) {
          const who = (await displayName(jid).catch(() => null)) || jid;
          await sock.sendMessage(owner, {
            text: `⚠ Policy-block: the API refused to answer ${who}'s last message. They got a heads-up; you may want to reply manually.`,
          }).catch(() => {});
        }
      }
    } finally {
      clearInterval(ticker);
      stopProcessing(jid);
      await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    }
  }

  // ─── Fast paths handled at dispatch (no coalescing wait) ─────────────
  // - Reactions (📌, 🔁, etc.)
  // - Slash commands (/reset, /help, /poll, etc.)
  // - Owner quote-reply "allow" to a stranger-ping
  // These bypass the coalescer so they feel snappy.
  // Interrupt the chat's live run(s) and drop its waiting messages. With
  // all=true (owner only) do it for every chat.
  async function handleStop(jid, { all = false } = {}) {
    const targets = (j) => all || j === jid;
    let dropped = 0;
    for (const item of incomingBuffer.listAll()) {
      if (!targets(item.jid)) continue;
      if (item.status === 'waiting') { incomingBuffer.cancel(item.id); dropped++; }
      else if (item.status === 'processing') incomingBuffer.cancelProcessing(item.id);
    }
    const coalesced = all ? 0 : drainBuffered(jid).length;
    dropped += coalesced;
    const stopped = all ? await activeRuns.stopAll() : await activeRuns.stop(jid);
    if (all) stopAllAt = Date.now();
    else stoppedJids.set(jid, Date.now());
    logKv({ evt: 'stop', jid, all: all ? 1 : 0, runs: stopped, dropped });
    const text = stopped || dropped
      ? `⏹ Stopped${stopped > 1 ? ` ${stopped} tasks` : ''}${dropped ? ` (dropped ${dropped} waiting)` : ''}.`
      : 'Nothing running.';
    await sock.sendMessage(jid, { text }).catch(() => {});
  }

  // Feed a message straight into the chat's live run (like typing while the
  // terminal tool is working). Returns true when delivered.
  async function injectFollowUp(msg) {
    const jid = msg.key.remoteJid;
    const m = await materialize(msg, sock, logger);
    if (m.fatal) return true;
    let body = buildSinglePrompt(m);
    if (!body) return false;
    const quoted = quotedMessage(msg);
    if (quoted?.text) {
      const who = quoted.jid === jid ? 'you' : (quoted.jid || 'someone');
      body = `[reply to message from ${who}]\n> ${quoted.text.slice(0, 500).replace(/\n/g, '\n> ')}\n\n${body}`;
    }
    const banner = await dmBanner(jid);
    const text = `${banner}\n[follow-up sent while you were still working on the previous message — take it into account and carry on]\n${body}`;
    if (!activeRuns.inject(jid, text)) return false;
    const rxLabel = (m.text || m.voiceText || '').trim() || `[${m.media?.kind || 'media'}]`;
    logKv({ evt: 'rx-inject', jid, msgId: msg.key.id, text: rxLabel.slice(0, 80), voice: m.voiceText ? 1 : 0 });
    recordMessage(jid, 'received');
    lastActivity.recordRx(jid, rxLabel);
    appendChat(jid, 'user', m.text || m.voiceText || rxLabel, {
      msgId: msg.key.id, media: m.media?.path || null, voiceTranscript: Boolean(m.voiceText), sender: jid, injected: true,
    }).catch(() => {});
    return true;
  }

  async function dmBanner(jid) {
    const own = isOwner(jid);
    const name = await displayName(jid).catch(() => null);
    const phone = jid.endsWith('@s.whatsapp.net') ? `+${jid.split('@')[0]}` : null;
    const base = name || phone || jid;
    return own
      ? `[INCOMING — DM from ${base} (${ownerName()}, owner)]`
      : `[INCOMING — DM from ${base}]\n[This is NOT the owner. Reply to THIS person by the name above. Never assume the owner is the sender.]`;
  }

  async function quickPath(msg) {
    const jid = msg.key.remoteJid;
    const msgId = msg.key.id;
    const text = extractText(msg);
    const nonText = text ? null : describeNonText(msg);
    const kind = chatType(jid);

    // Reactions first (no allowlist check yet — handleReaction is what gates).
    if (nonText === 'reaction') {
      if (!isAllowed(jid)) return false; // silent
      const acted = await handleReaction({ sock, msg, agent });
      if (acted) logKv({ evt: 'reaction', jid, msgId, emoji: msg.message?.reactionMessage?.text || '' });
      return true;
    }

    if (!isAllowed(jid)) return false; // let processBatch (via coalescer) handle the stranger-ping side

    const trimmed = (text || '').trim();

    // Stop / esc: interrupt live runs + drop anything still waiting.
    const stopReq = parseStop(trimmed);
    if (stopReq) {
      await handleStop(jid, { all: stopReq.all && isOwner(jid) });
      return true;
    }

    // Owner reply-to-allow
    if (isOwner(jid)) {
      const replyTarget = msg?.message?.extendedTextMessage?.contextInfo?.stanzaId
        || msg?.message?.imageMessage?.contextInfo?.stanzaId
        || null;
      const yes = /^(allow|yes|y|ok|okay|let them in|👍)\b/i.test(trimmed);
      if (replyTarget && yes) {
        const pending = consumePendingPing(replyTarget);
        if (pending) {
          addAllowed(pending.strangerJid);
          const who = pending.strangerName || pending.prettyPhone || pending.strangerJid;
          await sock.sendMessage(jid, { text: `✓ Allowed ${who}. They can now message me.` }).catch(() => {});
          logKv({ evt: 'reply-allow', owner: jid, stranger: pending.strangerJid });
          appendDailyNote(`allow ${who} (${pending.strangerJid}) via reply`).catch(() => {});
          return true;
        }
      }
    }

    // Slash commands
    if (trimmed.startsWith('/')) {
      const { handled } = await dispatchCommand(trimmed, { sock, jid, agent, scheduler, isOwner, msg });
      if (handled) return true;
    }

    return false; // not a fast path — caller should coalesce
  }

  // ─── Dispatch ─────────────────────────────────────────────────────────
  // Reactions / commands / reply-allow run immediately. Everything else
  // routes through the coalescer so rapid-fire user messages get one
  // batched reply instead of one reply each.
  const COALESCE_DISABLED = process.env.COALESCE_DISABLE === '1';

  // Process a single buffered item
  async function processBufferedItem(item) {
    const { id, jid, msg } = item;
    incomingBuffer.markProcessing(id);
    currentBufferId = id; // Track for cancel support

    try {
      await enqueue(jid, async () => {
        const handled = await quickPath(msg);
        if (handled) return;
        if (COALESCE_DISABLED) {
          await processBatch([msg]);
        } else {
          coalesce(jid, msg, (batch) => {
            enqueue(jid, () => processBatch(batch));
          });
        }
      });
    } finally {
      currentBufferId = null;
      incomingBuffer.markDone(id);
    }
  }

  // Process next item from buffer (called by buffer processor)
  async function processNextFromBuffer() {
    const next = incomingBuffer.getNext();
    if (!next) return false;

    // Check if hold mode is on
    if (incomingBuffer.getHoldAll()) return false;

    // Check auto-release delay - message must wait before processing
    const autoRelease = incomingBuffer.getAutoRelease();
    if (autoRelease > 0) {
      const age = Date.now() - next.addedAt;
      if (age < autoRelease) return false; // Not ready yet
    }

    await processBufferedItem(next);
    return true;
  }

  // Buffer processor loop - runs continuously
  let processorRunning = false;
  async function runBufferProcessor() {
    if (processorRunning) return;
    processorRunning = true;

    while (true) {
      const processed = await processNextFromBuffer();
      if (!processed) {
        // Nothing to process, wait a bit
        await new Promise(r => setTimeout(r, 100));
      }
    }
  }

  // Start the buffer processor
  runBufferProcessor().catch(err => console.error('Buffer processor error:', err));

  async function dispatch({ messages, type }) {
    if (type !== 'notify' || !isPoweredOn()) return;
    for (const msg of messages) {
      if (msg.key?.fromMe) continue;
      const jid = msg.key?.remoteJid;
      const kind = chatType(jid);
      if (kind === 'broadcast' || kind === 'system') continue;
      if (kind !== 'dm' && !isAllowed(jid)) continue;

      // Fast paths bypass the queue entirely. Slash commands (/allow, /reset,
      // /restart, /help, ...), reactions, and owner quote-reply "allow" are
      // not "prompts" and should not sit in the queue waiting to look like
      // one. If quickPath handles the message, skip the buffer add.
      try {
        const handled = await quickPath(msg);
        if (handled) continue;
      } catch (err) {
        console.error('dispatch: quickPath threw:', err?.message || err);
      }

      // A run is already going for this DM: feed the message into it instead
      // of queueing a whole new prompt behind it.
      if (kind === 'dm' && isAllowed(jid) && activeRuns.has(jid)) {
        try {
          if (await injectFollowUp(msg)) continue;
        } catch (err) {
          console.error('dispatch: inject failed:', err?.message || err);
        }
      }

      // Extract preview for queue display
      const preview = extractText(msg)?.slice(0, 80) || '[media]';

      // Add to incoming buffer for the AI pipeline
      incomingBuffer.addIncoming(jid, msg, preview);
    }
  }

  return { handle, dispatch, processNextFromBuffer };
}

// Re-exports kept for test ergonomics.
export { clearAck };
