import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { recordUsage } from './stats.js';
import { recordTokens, mode as costMode } from './cost-guard.js';
import * as sessionsStore from './sessions-store.js';
import { buildJournalContext } from './journal.js';
import { loadPersona } from './personas.js';
import { getCriticalLessons } from './memory-md.js';
import { listOpenThreads } from './db.js';
import { assertPoweredOn } from './bot-power.js';
import * as activeRuns from './active-runs.js';

// Session IDs are persisted to disk by sessions-store. Reading them here
// goes through the store so resume survives bot restarts.
await sessionsStore.ready();

// Claude Code prunes old session transcripts, so a persisted id can point at a
// session that no longer exists. Resuming it fails hard with this message.
const STALE_SESSION_RE = /No conversation found with session ID/i;

// Optional MCP servers config. Read once at startup. Shape:
//   { "mcpServers": { "name": { "command": "...", "args": [...], "env": {} } } }
// Same schema Claude Code uses, so users can copy their existing config.
const MCP_FILE = process.env.MCP_CONFIG || 'mcp.json';
let mcpServers = null;
try {
  const text = await fs.readFile(MCP_FILE, 'utf-8');
  const parsed = JSON.parse(text);
  mcpServers = parsed?.mcpServers || parsed || null;
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    console.log(`mcp: loaded ${Object.keys(mcpServers).length} server(s) from ${MCP_FILE}`);
  } else {
    mcpServers = null;
  }
} catch (err) {
  if (err.code !== 'ENOENT') console.warn(`mcp: ${MCP_FILE} present but invalid:`, err.message);
}

const FALLBACK_APPEND =
  "You are a personal assistant chatting with the user over WhatsApp. " +
  "Keep replies concise and chat-friendly — short paragraphs, no markdown headings. " +
  "You have full filesystem and shell access on the user's PC via your tools. " +
  "When the user asks you to do something on their machine, just do it and report back briefly.";

const PROMPT_FILES = ['soul.md', 'rules.md', 'HOMELAB.md'];
const cache = new Map();

// Streaming flush thresholds. Tuned for WhatsApp: don't spam tiny bubbles,
// don't make the user wait too long for the first one. Bigger numbers ⇒
// fewer, chunkier messages.
const STREAM_MIN_CHARS = Number(process.env.STREAM_MIN_CHARS) || 280;   // min chunk before flush at boundary
const STREAM_MAX_CHARS = Number(process.env.STREAM_MAX_CHARS) || 1400;  // force flush at this size
const STREAM_MIN_GAP_MS = Number(process.env.STREAM_MIN_GAP_MS) || 900; // throttle between flushes

async function readWithMtime(file) {
  try {
    const stat = await fs.stat(file);
    const cached = cache.get(file);
    if (cached && cached.mtime === stat.mtimeMs) return cached.content;
    const content = (await fs.readFile(file, 'utf-8')).trim();
    cache.set(file, { mtime: stat.mtimeMs, content });
    return content;
  } catch {
    return null;
  }
}

const TERSE_OVERLAY = `\n# TERSE MODE\n` +
  `You're approaching your daily token budget. Until the next local-midnight reset:\n` +
  `- 1–2 short sentences per reply, no bullets, no headings.\n` +
  `- Skip tool use unless absolutely necessary to answer.\n` +
  `- Don't elaborate, don't quote source, don't re-introduce yourself.\n` +
  `- If the question is large, say "remind me tomorrow when I'm back to full" and stop.\n`;

async function buildSystemAppend(jid = null) {
  // Ordered for maximum prompt-cache hit rate. The SDK caches the system
  // prompt automatically; the longest stable prefix wins. So:
  //   1. Files (soul/rules/HOMELAB) — rarely change
  //   2. Critical lessons — change only when a new incident is recorded
  //   3. Per-JID persona — stable per conversation
  //   4. Conditional overlays (terse mode)
  //   5. Open threads — change when threads added/resolved
  //   6. Journal — changes within the day
  const parts = [];

  // 1. Static persona / rules files.
  for (const f of PROMPT_FILES) {
    const c = await readWithMtime(f);
    if (c) parts.push(c);
  }

  // 2. Critical lessons from MEMORY.md — small, stable, must-respect rules
  // learned from past mistakes. Injected on every turn so the bot can't "forget".
  try {
    const lessons = await getCriticalLessons();
    if (lessons.length) {
      const block = lessons.map((l) => `### ${l.title}\n${l.body}`).join('\n\n');
      parts.push(`# Critical lessons (read every turn — these are non-negotiable)\n\n${block}`);
    }
  } catch (err) {
    console.error('claude-agent: critical lessons load failed', err.message);
  }

  // 3. Per-JID persona overlay (tone/role notes specific to this contact).
  if (jid) {
    try {
      const persona = await loadPersona(jid);
      if (persona) parts.push(`# Persona for ${jid}\n${persona}`);
    } catch (err) {
      console.error('claude-agent: persona load failed', err.message);
    }
  }

  // 4. Cost-guard overlay: when we're near or past the daily soft limit, ask
  // Claude to be terse and avoid tools so we stay online without burning more.
  try {
    const m = await costMode();
    if (m === 'terse') parts.push(TERSE_OVERLAY);
  } catch {}

  // 5. Open threads — paused work the bot owes the user.
  try {
    const threads = await listOpenThreads({ status: 'open', limit: 20 });
    if (threads.length) {
      const block = threads.map((t) => {
        const meta = t.body ? `\n  ${t.body.split('\n').join('\n  ')}` : '';
        return `- **${t.title}**${meta}`;
      }).join('\n');
      parts.push(`# Open threads (work paused, resume when the user confirms)\n\n${block}`);
    }
  } catch (err) {
    console.error('claude-agent: open threads load failed', err.message);
  }

  // 6. Daily journal — bot actions today + tail of yesterday. Most volatile.
  try {
    const journal = await buildJournalContext();
    if (journal) parts.push(journal);
  } catch (err) {
    console.error('claude-agent: journal context failed', err.message);
  }

  return parts.length === 0 ? FALLBACK_APPEND : parts.join('\n\n---\n\n');
}

function findBoundary(buf) {
  // Prefer paragraph, then sentence (period+space / question/exclam + space),
  // then newline. Returns the index AFTER the boundary, or -1.
  const para = buf.lastIndexOf('\n\n');
  if (para >= STREAM_MIN_CHARS) return para + 2;
  // sentence-end heuristic: ". " / "? " / "! " followed by capital or newline
  const sentenceRe = /[.!?]["')\]]?(\s+)(?=[A-Z\n])/g;
  let m, lastIdx = -1;
  while ((m = sentenceRe.exec(buf)) !== null) lastIdx = m.index + m[0].length;
  if (lastIdx >= STREAM_MIN_CHARS) return lastIdx;
  const nl = buf.lastIndexOf('\n');
  if (nl >= STREAM_MIN_CHARS) return nl + 1;
  return -1;
}

// Async-iterable prompt for the SDK's streaming input mode. The first user
// message goes in up front; follow-ups pushed while the run is live are
// delivered into the same session (priority 'next' = picked up at the next
// step, the way typing mid-run works in the terminal tool). close() ends the
// input so the query can finish.
function createInbox() {
  const queue = [];
  let wake = null;
  let closed = false;
  return {
    get closed() { return closed; },
    push(text, priority) {
      if (closed) return false;
      const msg = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' };
      if (priority) msg.priority = priority;
      queue.push(msg);
      if (wake) { wake(); wake = null; }
      return true;
    },
    close() {
      closed = true;
      if (wake) { wake(); wake = null; }
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) { yield queue.shift(); continue; }
        if (closed) return;
        await new Promise((r) => { wake = r; });
      }
    },
  };
}

const INJECT_IDLE_MS = Number(process.env.INJECT_IDLE_MS) || 2500;
const INTERRUPT_GRACE_MS = Number(process.env.INTERRUPT_GRACE_MS) || 4000;

async function askClaudeWithClaude(jid, userMessage, opts = {}) {
  const { onChunk, injectable = false, source = null } = opts;
  const resumeId = sessionsStore.get(jid);
  const workDir = process.env.WORK_DIR || process.cwd();
  const append = await buildSystemAppend(jid);

  const textChunks = [];
  let latestSessionId = resumeId;

  // Streaming state.
  let buffer = '';
  let streamedChars = 0;
  let lastFlushAt = 0;

  async function flush(final = false) {
    if (!onChunk || !buffer) return;
    const now = Date.now();
    if (!final && now - lastFlushAt < STREAM_MIN_GAP_MS) return;

    let cut;
    if (final) {
      cut = buffer.length;
    } else if (buffer.length >= STREAM_MAX_CHARS) {
      // Hard cut at a boundary close to STREAM_MAX_CHARS, or just cut.
      cut = findBoundary(buffer.slice(0, STREAM_MAX_CHARS));
      if (cut < 0) cut = STREAM_MAX_CHARS;
    } else {
      cut = findBoundary(buffer);
      if (cut < 0) return;
    }

    const chunk = buffer.slice(0, cut).trimStart();  // Only trim leading whitespace, preserve trailing newlines
    buffer = buffer.slice(cut);
    if (!chunk.trim()) return;  // Skip if entirely whitespace
    streamedChars += chunk.length;
    lastFlushAt = Date.now();
    try { await onChunk(chunk); } catch (err) { console.error('claude-agent: onChunk failed:', err.message); }
  }

  const options = {
    cwd: workDir,
    permissionMode: 'bypassPermissions',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append,
    },
  };
  if (onChunk) options.includePartialMessages = true;
  if (resumeId) options.resume = resumeId;
  if (mcpServers) options.mcpServers = mcpServers;

  let processError = null;
  let interrupted = false;
  let current = null; // { q, inbox, abort } for the live attempt

  async function runQuery() {
    if (interrupted) return;
    const inbox = createInbox();
    const abort = new AbortController();
    inbox.push(userMessage);
    let sent = 1;
    let results = 0;
    const q = query({ prompt: inbox, options: { ...options, abortController: abort } });
    current = {
      q,
      abort,
      inject(text) {
        if (interrupted || !inbox.push(text, 'next')) return false;
        sent += 1;
        return true;
      },
    };
    // The CLI can fold a follow-up into the turn it's already on, so we may
    // get fewer results than messages sent. After a result with messages
    // possibly outstanding, close input once the stream goes quiet.
    let idle = null;
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => inbox.close(), INJECT_IDLE_MS);
      idle.unref?.();
    };
    for await (const event of q) {
      if (idle) armIdle();
      if (process.env.DEBUG_RUNS) console.log('[run]', jid, event.type, event.subtype || '', event.type === 'user' ? JSON.stringify(event.message?.content).slice(0, 80) : '', `sent=${sent} results=${results}`);
      if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
        latestSessionId = event.session_id;
      }

      // Streaming deltas (only when includePartialMessages: true).
      if (event.type === 'stream_event' && event.event) {
        const inner = event.event;
        if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
          if (interrupted) continue;
          buffer += inner.delta.text;
          await flush(false);
        }
      }

      if (event.type === 'assistant' && event.message?.content) {
        if (interrupted) continue;
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text) textChunks.push(block.text);
        }
      }

      if (event.type === 'result') {
        if (event.session_id) latestSessionId = event.session_id;
        // SDK reports cumulative usage on result events. Record any usage we
        // see so the dashboard / stats can show token spend over the session,
        // and feed the cost guard so daily budgets can fire.
        if (event.usage) {
          recordUsage(event.usage);
          recordTokens(event.usage).catch(() => {});
        }
        // One result per user turn. Once every message we pushed (the first
        // prompt plus any injected follow-ups) has been answered, end input.
        results += 1;
        if (interrupted || results >= sent) inbox.close();
        else armIdle();
      }
    }
    clearTimeout(idle);
    inbox.close();
  }

  const unregister = activeRuns.register(jid, {
    injectable,
    source,
    inject: (text) => Boolean(current?.inject(text)),
    async interrupt() {
      if (interrupted) return;
      interrupted = true;
      const c = current;
      if (!c) return;
      // Polite interrupt first (keeps the session resumable), hard abort if
      // the CLI hasn't wound down within the grace window.
      const hard = setTimeout(() => { try { c.abort.abort(); } catch {} }, INTERRUPT_GRACE_MS);
      hard.unref?.();
      try { await c.q.interrupt(); } catch { try { c.abort.abort(); } catch {} }
    },
  });

  try {
    await runQuery();
  } catch (err) {
    // A stored session id outlives its transcript once Claude Code prunes old
    // sessions, and resuming a pruned id is a hard error. Drop the dead id and
    // retry once on a fresh session so the chat self-heals instead of replying
    // with the raw error. Only safe before anything has been streamed out.
    if (interrupted) {
      // Abort after /stop surfaces as an error; that's the expected outcome.
    } else if (STALE_SESSION_RE.test(err?.message || '') && streamedChars === 0) {
      console.warn(`claude-agent: stale session for ${jid} (${resumeId}) — starting fresh`);
      sessionsStore.del(jid);
      delete options.resume;
      latestSessionId = null;
      buffer = '';
      textChunks.length = 0;
      try { await runQuery(); } catch (retryErr) { if (!interrupted) processError = retryErr; }
    } else {
      processError = err;
    }
  } finally {
    unregister();
  }

  if (interrupted) {
    if (latestSessionId) sessionsStore.set(jid, latestSessionId);
    buffer = '';
    return { text: textChunks.join('\n').trim(), streamed: Boolean(onChunk) && streamedChars > 0, interrupted: true };
  }

  if (latestSessionId) sessionsStore.set(jid, latestSessionId);

  // Final flush of any tail content we buffered during streaming.
  if (onChunk) await flush(true);

  const fullReply = textChunks.join('\n').trim();

  if (processError) {
    // If we streamed some text already, surface a graceful tail. Otherwise rethrow.
    if (streamedChars > 0) {
      try { await onChunk?.(`⚠ (cut off — process exited: ${processError.message})`); } catch {}
      return { text: fullReply, streamed: true, error: processError };
    }
    throw processError;
  }

  return { text: fullReply || '(no response)', streamed: Boolean(onChunk) && streamedChars > 0 };
}

function aiProvider() {
  return String(process.env.AI_PROVIDER || process.env.LLM_PROVIDER || 'claude').trim().toLowerCase();
}

function isOpenAIProvider(provider = aiProvider()) {
  return ['openai', 'chatgpt', 'codex'].includes(provider);
}

function getOpenAIKey(provider = aiProvider()) {
  if (provider === 'codex') return process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || '';
  return process.env.OPENAI_API_KEY || process.env.CHATGPT_API_KEY || process.env.CODEX_API_KEY || '';
}

function normalizeOpenAIBaseUrl(url) {
  const raw = String(url || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  return raw.endsWith('/v1') ? raw : raw + '/v1';
}

function sessionForProvider(provider, stored) {
  if (!stored || typeof stored !== 'string') return null;
  if (stored.startsWith(provider + ':')) return stored.slice(provider.length + 1);
  if (!stored.includes(':') && provider === 'claude') return stored;
  return null;
}

function extractOpenAIText(response) {
  if (typeof response?.output_text === 'string') return response.output_text;
  const chunks = [];
  for (const item of response?.output || []) {
    for (const part of item?.content || []) {
      if (typeof part?.text === 'string') chunks.push(part.text);
      if (typeof part?.content === 'string') chunks.push(part.content);
    }
  }
  return chunks.join('\n').trim();
}

function normalizeOpenAIUsage(usage) {
  if (!usage) return null;
  return {
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cache_read_input_tokens: usage.input_tokens_details?.cached_tokens || 0,
    cache_creation_input_tokens: 0,
  };
}

function isCodexCliProvider(provider = aiProvider()) {
  return ['codex-cli', 'codex_exec', 'codex-exec'].includes(provider);
}

function isOpenCodeProvider(provider = aiProvider()) {
  return ['opencode', 'open-code', 'opencode-cli'].includes(provider);
}

function splitCliArgs(raw) {
  if (!raw) return [];
  const args = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|\S+/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    args.push((m[1] ?? m[2] ?? m[0]).replace(/\\(["'\\])/g, '$1'));
  }
  return args;
}

function codexApiKey() {
  return process.env.CODEX_API_KEY || '';
}

// Register a spawned CLI provider run so /stop can kill it. Resolves the
// run's promise as interrupted instead of erroring.
function stoppableChild(jid, child, source, onStop) {
  let stopped = false;
  const unregister = activeRuns.register(jid, {
    injectable: false,
    source,
    inject: () => false,
    interrupt() {
      if (stopped) return;
      stopped = true;
      try { child.kill('SIGTERM'); } catch {}
      onStop();
    },
  });
  child.on('close', unregister);
  child.on('error', unregister);
  return () => stopped;
}

async function runCodexCli(jid, userMessage, opts = {}) {
  const apiKey = codexApiKey();

  const append = await buildSystemAppend(jid);
  const workDir = process.env.WORK_DIR || process.cwd();
  const model = process.env.CODEX_MODEL || '';
  const timeoutMs = Number(process.env.CODEX_CLI_TIMEOUT_MS || 300000) || 300000;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-codex-'));
  const outFile = path.join(tmpDir, 'last-message.txt');
  const prompt = [
    append,
    '\n---\n',
    'You are replying to a WhatsApp message. Keep the final answer concise and chat-friendly unless the user asks for detail.',
    'Conversation JID: ' + jid,
    '\nUser message:\n',
    userMessage,
  ].join('\n');

  const extraArgs = splitCliArgs(process.env.CODEX_CLI_ARGS || '');
  const modelArgs = model ? ['--model', model] : [];
  const args = [
    'exec',
    '--cd', workDir,
    '--sandbox', process.env.CODEX_CLI_SANDBOX || 'workspace-write',
    ...modelArgs,
    '--output-last-message', outFile,
    ...extraArgs,
    '-',
  ];

  const env = {
    ...process.env,
    NO_COLOR: '1',
  };
  if (apiKey) env.CODEX_API_KEY = apiKey;

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.env.CODEX_CLI_BIN || 'codex', args, {
      cwd: workDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    stoppableChild(jid, child, opts.source || null, () => { clearTimeout(timer); resolve({ stdout, stderr, interrupted: true }); });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('codex-cli: timed out after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error('codex-cli: exited with code ' + code + ': ' + (stderr || stdout).slice(-1200)));
    });
    child.stdin.end(prompt);
  });

  let text = '';
  try { text = (await fs.readFile(outFile, 'utf8')).trim(); } catch {}
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  if (!text) text = result.stdout.trim();
  if (result.interrupted) return { text, streamed: false, interrupted: true, provider: 'codex-cli', model };
  return { text: text || '(no response)', streamed: false, provider: 'codex-cli', model };
}

async function runOpenCode(jid, userMessage, opts = {}) {
  const append = await buildSystemAppend(jid);
  const workDir = process.env.WORK_DIR || process.cwd();
  const model = process.env.OPENCODE_MODEL || 'opencode/nemotron-3.5-lightning-free';
  const timeoutMs = Number(process.env.OPENCODE_TIMEOUT_MS || 300000) || 300000;
  const bin = process.env.OPENCODE_BIN || path.join(os.homedir(), '.opencode/bin/opencode');
  const prompt = [
    append,
    '\n---\n',
    'You are replying to a WhatsApp message. Keep the final answer concise and chat-friendly unless the user asks for detail.',
    'Conversation JID: ' + jid,
    '\nUser message:\n',
    userMessage,
  ].join('\n');

  const args = ['run', '-m', model, prompt];
  const env = { ...process.env, NO_COLOR: '1' };

  const result = await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: workDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    stoppableChild(jid, child, opts.source || null, () => { clearTimeout(timer); resolve({ stdout, stderr, interrupted: true }); });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('opencode: timed out after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error('opencode: exited with code ' + code + ': ' + (stderr || stdout).slice(-1200)));
    });
  });

  // strip opencode's "> build · <model>" header lines, keep the reply
  const text = (result.stdout || '')
    .replace(/^\s*>\s*build\b.*$/gim, '')
    .trim();
  if (result.interrupted) return { text, streamed: false, interrupted: true, provider: 'opencode', model };
  return { text: text || '(no response)', streamed: false, provider: 'opencode', model };
}

async function askOpenAI(jid, userMessage, opts = {}) {
  const provider = aiProvider();
  const apiKey = getOpenAIKey(provider);
  if (!apiKey) {
    const suffix = provider === 'codex' ? ' or CODEX_API_KEY' : '';
    throw new Error(provider + ': missing OPENAI_API_KEY' + suffix);
  }

  const append = await buildSystemAppend(jid);
  const storedSessionId = sessionsStore.get(jid);
  const previousResponseId = sessionForProvider(provider, storedSessionId);
  const model = process.env.OPENAI_MODEL || process.env.CHATGPT_MODEL || 'gpt-5';
  const maxOutputTokens = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 0) || undefined;

  const body = {
    model,
    instructions: append,
    input: userMessage,
  };
  if (previousResponseId) body.previous_response_id = previousResponseId;
  if (maxOutputTokens) body.max_output_tokens = maxOutputTokens;

  const headers = {
    'Authorization': 'Bearer ' + apiKey,
    'Content-Type': 'application/json',
  };
  if (process.env.OPENAI_ORG_ID) headers['OpenAI-Organization'] = process.env.OPENAI_ORG_ID;
  if (process.env.OPENAI_PROJECT_ID) headers['OpenAI-Project'] = process.env.OPENAI_PROJECT_ID;

  const url = normalizeOpenAIBaseUrl(process.env.OPENAI_BASE_URL) + '/responses';
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }

  if (!res.ok) {
    const msg = data?.error?.message || data?.message || raw || res.statusText;
    throw new Error(provider + ': ' + res.status + ' ' + msg);
  }

  if (data?.id) sessionsStore.set(jid, provider + ':' + data.id);
  const usage = normalizeOpenAIUsage(data?.usage);
  if (usage) {
    recordUsage(usage);
    recordTokens(usage).catch(() => {});
  }

  const text = extractOpenAIText(data).trim();
  if (opts.onChunk && text) {
    // OpenAI token mode currently returns full responses; WhatsApp splitting
    // and filtering still happen in the caller before delivery.
  }
  return { text: text || '(no response)', streamed: false, provider, model };
}

export async function askClaude(jid, userMessage, opts = {}) {
  // Final safety gate: no provider can consume tokens while the bot is off,
  // even if a scheduled task or an already-queued action reaches this point.
  assertPoweredOn();
  const provider = aiProvider();
  if (isCodexCliProvider(provider)) return runCodexCli(jid, userMessage, opts);
  if (isOpenCodeProvider(provider)) return runOpenCode(jid, userMessage, opts);
  if (isOpenAIProvider(provider)) return askOpenAI(jid, userMessage, opts);
  return askClaudeWithClaude(jid, userMessage, opts);
}

export function resetSession(jid) {
  sessionsStore.del(jid);
}
