// Local dashboard for the WhatsApp Claude bot. Binds to 127.0.0.1 by default
// (override via WEB_HOST). Mobile-first layout — works equally well on phone
// and desktop. All bot settings are editable from here.

import express from 'express';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import multer from 'multer';

const WEBUI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { snapshot } from './stats.js';
import { queueDepth, listPending as listIncomingQueue, onQueueChange } from './queue.js';
import { listAllowed, addAllowed, removeAllowed } from './allowlist.js';
import { addContact, removeContact, listContacts, normalizePhone } from './contact-onboard.js';
import { listPlugins } from './heartbeat.js';
import { recentLogs, onLog } from './log-buffer.js';
import { parseWhen, parseDuration } from './cron-time.js';
import { readEnvFile, patchEnv } from './env-store.js';
import { storeOutgoing } from './outbound-store.js';
import * as sessionsStore from './sessions-store.js';
import { _size as coalescerSize } from './coalescer.js';
import { dailyTokens, thresholds as costThresholds } from './cost-guard.js';
import {
  listPlaybooks,
  loadPlaybook,
  loadPlaybookFull,
  savePlaybook,
  deletePlaybook,
  playbookExists,
  allTags,
  applyVariables,
  safeName as safePlaybookName,
} from './playbooks.js';
import * as playbookRuns from './playbook-runs.js';
import * as playbookPins from './playbook-pins.js';
import * as playbookSchedules from './playbook-schedules.js';
import { askClaude } from './claude-agent.js';
import { getChatList, getMessages, addOpenThread, listOpenThreads, resolveOpenThread, reopenThread, deleteOpenThread } from './db.js';
import * as memoryMd from './memory-md.js';
import { splitForWhatsApp } from './chunk.js';
import { searchChats, snippetOf } from './chat-search.js';
import { resolveNodePath } from './util/node-path.js';
import {
  loadPersona,
  savePersona,
  deletePersona,
  listPersonas,
  listOverlays,
  loadOverlayFull,
  listTones,
  loadToneFull,
  loadToneBody,
  saveTone,
  deleteTone,
  toneExists,
  loadSoul,
  saveSoul,
  loadRules,
  saveRules,
  listSoulVariants,
  readSoulAbState,
  setSoulAbActive,
  TONE_TEMPLATES,
} from './personas.js';
import * as personaHistory from './persona-history.js';
import * as personaMeta from './persona-meta.js';
import { buildPreviewPrompt, dryRun as personaDryRun } from './persona-test.js';
import * as pendingQueue from './pending-queue.js';
import * as processingState from './processing-state.js';
import { isOpen as isSocketOpen } from './socket-holder.js';
import * as incomingBuffer from './incoming-buffer.js';
import * as activeRuns from './active-runs.js';
import { displayName } from './contacts.js';
import * as analytics from './analytics.js';
import * as connectionState from './connection-state.js';
import * as lastActivity from './last-activity.js';
import { getOpenThreads, appendChat } from './memory.js';
import { subscribe as subscribeChat } from './chat-events.js';
import { esc, formatPhoneForDisplay, NAV, MOBILE_NAV, LAYOUT } from './webui/layout.js';

function fmtDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ────────────────────────────────────────────────────────────────────────────
// Settings schema — what's editable on /settings, grouped for the UI.
// Each entry: { key, label, type, options?, placeholder? }

// OpenCode's free model list, fetched live once at startup so the dropdown
// always reflects what's actually available (falls back to a known set).
const OPENCODE_MODELS = (() => {
  try {
    const bin = process.env.OPENCODE_BIN || path.join(os.homedir(), '.opencode/bin/opencode');
    const out = execSync(`"${bin}" models`, { encoding: 'utf8', timeout: 15000 });
    const list = out.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('opencode/'));
    if (list.length) return list;
  } catch {}
  return [
    'opencode/union-alpha',
    'opencode/nemotron-3.5-lightning-free',
    'opencode/nemotron-3-ultra-free',
    'opencode/big-pickle',
    'opencode/hy3-free',
    'opencode/mimo-v2.5-free',
    'opencode/x-preview-f-free',
  ];
})();

const SETTINGS = [
  { group: 'General', icon: 'sliders-horizontal', items: [
    { key: 'PUBLIC_URL', label: 'Public URL', type: 'text', placeholder: 'https://ai.home', help: 'Shown on the dashboard header. Cosmetic only.' },
    { key: 'AI_PROVIDER', label: 'AI provider', type: 'select', options: ['claude', 'openai', 'chatgpt', 'codex', 'codex-cli', 'opencode'], help: 'claude uses the Claude Code agent. codex-cli shells out to codex exec. opencode shells out to the OpenCode CLI (free models). openai/chatgpt/codex use API token mode.', needsRestart: true },
    { key: 'ANTHROPIC_MODEL', label: 'Claude model', type: 'select', providers: ['claude'], options: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5-20251101', 'claude-opus-4-1-20250805', 'claude-opus-4-20250514', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-20250514', 'claude-3-haiku-20240307'], help: 'Which Claude model to use for replies. Current gen: Opus 5.5 = latest/most capable, Fable 5.1 = creative, Sonnet 5 = balanced, Haiku 4.5 = fastest/cheapest. Older Opus/Sonnet 4.x kept below.', needsRestart: true },
    { key: 'OPENAI_MODEL', label: 'OpenAI model', type: 'text', providers: ['openai', 'chatgpt', 'codex'], placeholder: 'gpt-5', help: 'Model for openai/chatgpt/codex token mode. Use any model ID enabled for your API key.', needsRestart: true },
    { key: 'OPENAI_API_KEY', label: 'OpenAI API key', type: 'password', providers: ['openai', 'chatgpt', 'codex'], help: 'Server-side API key for openai/chatgpt provider mode.', needsRestart: true },
    { key: 'CODEX_API_KEY', label: 'Codex API key', type: 'password', providers: ['codex', 'codex-cli'], help: 'Used by codex-cli, or codex API mode. Falls back to OPENAI_API_KEY.', needsRestart: true },
    { key: 'CODEX_MODEL', label: 'Codex CLI model', type: 'text', providers: ['codex-cli'], placeholder: 'gpt-5', help: 'Model for codex-cli provider mode.', needsRestart: true },
    { key: 'CODEX_CLI_TIMEOUT_MS', label: 'Codex CLI timeout', type: 'number', providers: ['codex-cli'], placeholder: '300000', unit: 'ms', help: 'Max time for a codex exec reply before failing.', needsRestart: true },
    { key: 'OPENCODE_MODEL', label: 'OpenCode model', type: 'select', providers: ['opencode'], options: OPENCODE_MODELS, help: 'Model for opencode provider mode. Free OpenCode Zen models (no API key).', needsRestart: true },
    { key: 'OPENAI_BASE_URL', label: 'OpenAI base URL', type: 'text', providers: ['openai', 'chatgpt', 'codex'], placeholder: 'https://api.openai.com/v1', help: 'Override only for OpenAI-compatible gateways.', needsRestart: true },
    { key: 'WEB_HOST', label: 'Web host', type: 'text', placeholder: '127.0.0.1', help: 'Bind address for this dashboard. Leave on loopback unless reverse-proxied.', needsRestart: true },
    { key: 'WEB_PORT', label: 'Web port', type: 'number', placeholder: '7777', help: 'TCP port for the dashboard.', needsRestart: true },
    { key: 'LOG_LEVEL', label: 'Log level', type: 'select', options: ['silent', 'error', 'warn', 'info', 'debug', 'trace'], help: 'Verbosity of bot output.' },
    { key: 'WORK_DIR', label: 'Work directory (sandbox)', type: 'text', placeholder: '/home/you/sandbox', help: 'Directory the Bash/Write/Edit tools operate in. Leave empty to allow the whole filesystem.' },
  ]},
  { group: 'Streaming replies', icon: 'zap', items: [
    { key: 'STREAM_REPLIES', label: 'Stream replies', type: 'select', options: ['1', '0'], help: '1 = send the reply in chunks as Claude generates it. 0 = wait for the full reply.' },
    { key: 'STREAM_AS_EDITS', label: 'Stream as message edits', type: 'select', options: ['0', '1'], help: '1 = edit a single WhatsApp message in place. 0 = send separate chunks.' },
    { key: 'STREAM_MIN_CHARS', label: 'Min chars per chunk', type: 'number', placeholder: '280', help: 'Don\'t flush a chunk smaller than this at sentence boundaries.', needsRestart: true },
    { key: 'STREAM_MAX_CHARS', label: 'Max chars per chunk', type: 'number', placeholder: '1400', help: 'Force flush once a chunk hits this size.', needsRestart: true },
    { key: 'STREAM_MIN_GAP_MS', label: 'Min gap between chunks', type: 'number', placeholder: '900', unit: 'ms', help: 'Throttle between flushes so chunks don\'t arrive faster than WhatsApp can render.', needsRestart: true },
  ]},
  { group: 'Reply filter', icon: 'filter', items: [
    { key: 'REPLY_FILTER_ENABLED', label: 'Enable regex filter', type: 'select', options: ['0', '1'], help: '1 = filter internal reasoning via regex patterns. 0 = skip regex filtering. Disable if replies get cut off incorrectly.' },
    { key: 'PROOFREADER_ENABLED', label: 'Enable AI proofreader', type: 'select', options: ['1', '0'], help: '1 = use a fast haiku call to catch internal reasoning the regex misses. Adds ~200ms latency but more reliable.' },
  ]},
  { group: 'Coalescing (batch rapid-fire messages)', icon: 'layers', items: [
    { key: 'COALESCE_DISABLE', label: 'Disable coalescing', type: 'select', options: ['0', '1'], help: '0 = batch rapid-fire user messages into one reply. 1 = reply per message.' },
    { key: 'COALESCE_QUIET_MS', label: 'Quiet window', type: 'number', placeholder: '1500', unit: 'ms', help: 'Wait this long after the last message in a burst before generating a reply.', needsRestart: true },
    { key: 'COALESCE_MAX_MS', label: 'Max wait', type: 'number', placeholder: '8000', unit: 'ms', help: 'Never wait longer than this, even if more messages keep arriving.', needsRestart: true },
  ]},
  { group: 'Owner & access', icon: 'shield', items: [
    { key: 'OWNER_JIDS', label: 'Owner JIDs (comma-separated, both forms)', type: 'text', placeholder: '27...@s.whatsapp.net,...@lid', help: 'JIDs treated as "you". Include both your @s.whatsapp.net number and any @lid alias.' },
    { key: 'ACK_REACTIONS', label: 'Ack reactions (⏳/✅/❌)', type: 'select', options: ['1', '0'], help: 'React to received messages so you know the bot saw them.' },
    { key: 'STRANGER_NOTIFY', label: 'Ping me on stranger DMs', type: 'select', options: ['1', '0'], help: 'Forward unknown-sender DMs to the owner with an Allow prompt.' },
  ]},
  { group: 'Cost guard (daily token budget)', icon: 'coins', items: [
    { key: 'DAILY_TOKEN_SOFT_LIMIT', label: 'Soft limit (warn me)', type: 'number', placeholder: '500000', unit: 'tokens', help: 'Crossing this triggers an amber warning on the dashboard.', needsRestart: true },
    { key: 'DAILY_TOKEN_HARD_LIMIT', label: 'Hard limit (refuse new calls)', type: 'number', placeholder: '1000000', unit: 'tokens', help: 'Once today\'s tokens exceed this, the bot refuses new Claude calls.', needsRestart: true },
  ]},
  { group: 'Rate limits', icon: 'gauge', items: [
    { key: 'DAILY_MSG_CAP_DEFAULT', label: 'Global daily message cap', type: 'number', placeholder: '0', help: '0 = unlimited. Cap applies per JID per day.', needsRestart: true },
    { key: 'DAILY_MSG_CAP_PER_JID', label: 'Per-JID caps', type: 'text', placeholder: '000000000@s.whatsapp.net:15', help: 'Comma-separated jid:n entries. Overrides the global cap for those JIDs.', needsRestart: true },
  ]},
  { group: 'Voice transcription', icon: 'mic', items: [
    { key: 'WHISPER_MODEL', label: 'Whisper model', type: 'select', options: ['tiny', 'base', 'small', 'medium', 'large'], help: 'Larger = more accurate but slower. tiny/base run fine on CPU.' },
    { key: 'WHISPER_LANGUAGE', label: 'Language code', type: 'text', placeholder: 'en', help: 'ISO 639-1 code. Leave empty for auto-detect.' },
    { key: 'WHISPER_TIMEOUT_MS', label: 'Timeout', type: 'number', placeholder: '120000', unit: 'ms', help: 'Abort transcription if it takes longer than this.' },
  ]},
  { group: 'Heartbeat', icon: 'activity', items: [
    { key: 'HEARTBEAT_EMAIL_CHECK', label: 'Email check (himalaya)', type: 'select', options: ['1', '0'], help: 'Poll your Himalaya account for new mail and ping you on the dashboard.', needsRestart: true },
    { key: 'HEARTBEAT_EMAIL_INTERVAL', label: 'Email check interval', type: 'text', placeholder: '30m', help: 'Duration string: 30s, 15m, 1h, etc.', needsRestart: true },
    { key: 'HIMALAYA_ACCOUNT', label: 'Himalaya account', type: 'text', placeholder: 'gmail', help: 'Account name as configured in ~/.config/himalaya/config.toml.' },
  ]},
  { group: 'ntfy bridge', icon: 'bell', items: [
    { key: 'NTFY_TOPIC', label: 'Topic', type: 'text', placeholder: 'my-alerts', help: 'Topic name for push notifications.' },
    { key: 'NTFY_SERVER', label: 'Server', type: 'text', placeholder: 'https://ntfy.sh', help: 'Server URL. Use your self-hosted ntfy instance if you have one.' },
    { key: 'NTFY_TOKEN', label: 'Token (optional)', type: 'password', help: 'Bearer token for protected topics. Leave empty for public topics.' },
  ], actions: [{ id: 'ntfy', label: 'Send test notification', icon: 'send' }] },
  { group: 'Auth backup', icon: 'archive', items: [
    { key: 'AUTH_BACKUP', label: 'Daily auth backup', type: 'select', options: ['1', '0'], help: 'Tarball auth_info_baileys/ to wa-bot-backups/ each night.' },
    { key: 'AUTH_BACKUP_KEEP', label: 'Backups to keep', type: 'number', placeholder: '7', help: 'Older backups are deleted.' },
  ]},
  { group: 'Webhook', icon: 'webhook', items: [
    { key: 'WEBHOOK_SECRET', label: 'Webhook shared secret', type: 'password', help: 'x-webhook-secret header required on /webhook/alert and /webhook/send-file POSTs.' },
  ], actions: [{ id: 'webhook', label: 'Send test payload', icon: 'send' }] },
];

const EDITABLE_KEYS = new Set(SETTINGS.flatMap((g) => g.items.map((i) => i.key)));

function renderSettingsField(item, current) {
  const id = `f_${item.key}`;
  const val = current[item.key] ?? '';
  const ph = item.placeholder ? ` placeholder="${esc(item.placeholder)}"` : '';
  const dataInitial = ` data-initial="${esc(val)}"`;
  const common = `id="${id}" name="${esc(item.key)}" class="setting-input input"${dataInitial}`;
  if (item.type === 'select') {
    return `<select ${common}>${item.options.map((o) => `<option value="${esc(o)}" ${val === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }
  if (item.type === 'password') {
    return `<div class="relative">
      <input ${common}${ph} type="password" autocomplete="off" value="${esc(val)}" style="padding-right: 2.5rem;">
      <button type="button" class="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200 p-1" data-toggle-eye="${esc(id)}" aria-label="Show or hide value">
        <i data-lucide="eye" class="size-4"></i>
      </button>
    </div>`;
  }
  if (item.type === 'number') {
    return `<input ${common}${ph} type="number" inputmode="numeric" value="${esc(val)}">`;
  }
  return `<input ${common}${ph} type="text" value="${esc(val)}">`;
}

// ────────────────────────────────────────────────────────────────────────────

export function createWebUI({ scheduler, memoryModule, sock, power }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false, limit: '5mb' }));
  app.use(express.json({ limit: '5mb' }));

  // ─── PWA (manifest + service worker + icon) ───────────────────────────────
  // Lets you install the dashboard as a standalone app from Chrome/Safari.
  const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#34d399"/>
      <stop offset="100%" stop-color="#059669"/>
    </linearGradient>
  </defs>
  <rect width="192" height="192" rx="36" fill="url(#g)"/>
  <text x="96" y="132" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="120" font-weight="800" fill="#09090b" text-anchor="middle">E</text>
</svg>`;
  app.get('/icon.svg', (_req, res) => {
    res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    res.send(ICON_SVG);
  });

  // Maskable variant — same icon but with safe-zone padding so Android home
  // screens can crop it into circles/squares without clipping the "E".
  const ICON_MASKABLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#34d399"/>
      <stop offset="100%" stop-color="#059669"/>
    </linearGradient>
  </defs>
  <rect width="192" height="192" fill="url(#g)"/>
  <text x="96" y="120" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="80" font-weight="800" fill="#09090b" text-anchor="middle">E</text>
</svg>`;
  app.get('/icon-maskable.svg', (_req, res) => {
    res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    res.send(ICON_MASKABLE_SVG);
  });

  app.get('/manifest.webmanifest', (_req, res) => {
    res.set({ 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600' });
    res.json({
      name: 'Encrypto AI',
      short_name: 'Encrypto',
      description: 'Encrypto AI control dashboard',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait-primary',
      theme_color: '#09090b',
      background_color: '#09090b',
      icons: [
        { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        { src: '/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
      ],
      shortcuts: [
        { name: 'Chats', url: '/chats', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] },
        { name: 'Jobs', url: '/jobs', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] },
        { name: 'Queue', url: '/queue', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] },
      ],
    });
  });

  // Service worker. Minimal app-shell strategy:
  //   - GET / and other navigations: network-first, fall back to cached shell
  //   - icon + manifest: cache-first
  //   - everything else (API, SSE, POST): straight pass-through
  // The version string is bumped automatically by including pkg metadata, so
  // a deploy invalidates the cache without manual intervention.
  app.get('/sw.js', (_req, res) => {
    res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
    res.send(`
const VERSION = 'encrypto-ai-${process.env.SW_VERSION || Date.now()}';
const SHELL_URL = '/';
const STATIC = ['/icon.svg', '/icon-maskable.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(STATIC)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== VERSION).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Don't touch SSE/streaming or JSON APIs — let them go straight through.
  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/event-stream') || url.pathname.startsWith('/api/') || url.pathname.endsWith('/stream')) return;

  // Static assets: cache-first.
  if (STATIC.includes(url.pathname)) {
    e.respondWith(caches.match(req).then((c) => c || fetch(req)));
    return;
  }

  // Navigations: network-first, fall back to cached shell if offline.
  if (req.mode === 'navigate' || accept.includes('text/html')) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(VERSION);
        cache.put(SHELL_URL, fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        const cache = await caches.open(VERSION);
        const cached = await cache.match(SHELL_URL);
        return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
  }
});
`);
  });

  // ─── Webhook (alerts → WhatsApp) ───────────────────────────────────────────
  const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
  app.post('/webhook/alert', async (req, res) => {
    if (WEBHOOK_SECRET && req.get('x-webhook-secret') !== WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'bad secret' });
    }
    const { title, text, jid: rawJid } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });
    const jid = (rawJid && String(rawJid).trim()) || listAllowed()[0];
    if (!jid) return res.status(400).json({ error: 'no jid and allowlist empty' });
    const msg = title ? `📣 ${title}\n${text}` : text;
    try {
      const result = await sock.sendMessage(jid, { text: msg });
      // Store for getMessage retry callback
      if (result?.key?.id && result?.message) {
        storeOutgoing(jid, result.key.id, result.message);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Restart ───────────────────────────────────────────────────────────────
  app.post('/restart', (_req, res) => {
    // Return JSON immediately, then restart after response is sent
    res.json({ ok: true, message: 'Restarting...' });
    res.on('finish', () => {
      setTimeout(() => {
        // Absolute path — process.cwd() isn't guaranteed to be the project
        // root. Log stdout/stderr to data/restart.log so a failed restart
        // (e.g. pm2 not resolvable) is visible instead of vanishing.
        const script = path.join(WEBUI_ROOT, 'scripts', 'restart.mjs');
        const logPath = path.join(WEBUI_ROOT, 'data', 'restart.log');
        let out = 'ignore';
        try {
          fsSync.mkdirSync(path.dirname(logPath), { recursive: true });
          out = fsSync.openSync(logPath, 'a');
        } catch {}
        const stdio = out === 'ignore' ? 'ignore' : ['ignore', out, out];
        // resolveNodePath() rather than process.execPath so a stale Homebrew
        // Cellar path (after `brew upgrade node`) doesn't ENOENT. Wrap in
        // try/catch to avoid crashing the webui with uncaughtException.
        try {
          const child = spawn(resolveNodePath(), [script], { detached: true, stdio });
          child.on('error', (err) => {
            console.error(`webui restart: spawn failed: ${err.message}`);
          });
          child.unref();
        } catch (err) {
          console.error(`webui restart: spawn threw: ${err.message}`);
        }
      }, 300);
    });
  });

  // Logical power control: the dashboard process stays alive while WhatsApp,
  // queued processing and every AI provider are disabled.
  app.get('/api/power', (_req, res) => {
    res.json({ ok: true, poweredOn: power?.isOn?.() !== false });
  });

  app.post('/api/power', async (req, res) => {
    const turnOn = req.body?.poweredOn === true;
    try {
      if (turnOn) await power?.on?.();
      else await power?.off?.();
      res.json({ ok: true, poweredOn: power?.isOn?.() !== false });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Pause/resume incoming-message processing. Pausing flips
  // incomingBuffer.holdAll — queued messages remain visible but the
  // processor loop won't pull them until it's flipped back.
  app.post('/api/dashboard/toggle-pause', (_req, res) => {
    incomingBuffer.setHoldAll(!incomingBuffer.getHoldAll());
    res.redirect('/');
  });

  app.post('/settings/toggle-streaming', (_req, res) => {
    const next = process.env.STREAM_REPLIES === '0' ? '1' : '0';
    patchEnv({ STREAM_REPLIES: next });
    res.redirect('back');
  });

  // ─── Send file webhook ─────────────────────────────────────────────────────
  // POST /webhook/send-file  body: { path, jid?, caption?, kind? } where kind
  // is "image" | "video" | "audio" | "document" (auto-detected if omitted).
  app.post('/webhook/send-file', async (req, res) => {
    if (WEBHOOK_SECRET && req.get('x-webhook-secret') !== WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'bad secret' });
    }
    const { path: filePath, jid: rawJid, caption, kind } = req.body || {};
    if (!filePath) return res.status(400).json({ error: 'path required' });
    const jid = (rawJid && String(rawJid).trim()) || listAllowed()[0];
    if (!jid) return res.status(400).json({ error: 'no jid and allowlist empty' });

    const absPath = path.resolve(filePath);
    let stat;
    try { stat = await fs.stat(absPath); } catch { return res.status(404).json({ error: `file not found: ${absPath}` }); }
    if (!stat.isFile()) return res.status(400).json({ error: 'not a regular file' });

    const ext = absPath.toLowerCase().split('.').pop();
    const MIME = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
      mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
      ogg: 'audio/ogg', opus: 'audio/ogg; codecs=opus', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac',
      pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      zip: 'application/zip', tar: 'application/x-tar', gz: 'application/gzip',
      json: 'application/json', csv: 'text/csv', html: 'text/html', xml: 'application/xml',
    };
    const mimetype = MIME[ext] || 'application/octet-stream';

    let detected = kind;
    if (!detected) {
      if (mimetype.startsWith('image/')) detected = 'image';
      else if (mimetype.startsWith('video/')) detected = 'video';
      else if (mimetype.startsWith('audio/')) detected = 'audio';
      else detected = 'document';
    }

    try {
      // Pass a buffer + explicit mimetype + filename. Baileys handles the
      // encrypted upload to WhatsApp's media server. The "Waiting for this
      // message" symptom comes from missing mimetype or the upload not
      // finishing — both are addressed here.
      const buf = await fs.readFile(absPath);
      const filename = path.basename(absPath);
      const message =
        detected === 'sticker'  ? { sticker: buf, mimetype: 'image/webp' } :
        detected === 'image'    ? { image: buf, caption, mimetype } :
        detected === 'video'    ? { video: buf, caption, mimetype } :
        detected === 'voice'    ? { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true } :
        detected === 'audio'    ? { audio: buf, mimetype, ptt: false } :
                                  { document: buf, fileName: filename, mimetype, caption };
      const result = await sock.sendMessage(jid, message);
      res.json({ ok: true, kind: detected, mimetype, bytes: stat.size, messageId: result?.key?.id });
    } catch (err) {
      console.error(`send-file failed (${absPath} → ${jid}):`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Dashboard ─────────────────────────────────────────────────────────────
  app.get('/', async (_req, res) => {
    const s = snapshot();
    const plugins = listPlugins();
    const jobs = scheduler.listJobs();
    const sessionCount = sessionsStore._size();
    const bufferedJids = coalescerSize();
    const tokensToday = await dailyTokens().catch(() => 0);
    const cost = costThresholds();
    const totalTokens = (s.tokensIn || 0) + (s.tokensOut || 0);
    const conn = connectionState.getState();
    const poweredOn = power?.isOn?.() !== false;
    const last = lastActivity.getLast();
    const openThreads = await getOpenThreads().catch(() => []);
    // Filter out owner JIDs from top contacts (privacy)
    const owners = new Set(ownerJids());
    const topToday = analytics.getTopContactsToday(10).filter((c) => !owners.has(c.jid)).slice(0, 5);
    const hourly = analytics.getHourlyMessages(24);
    const maxHourly = Math.max(1, ...hourly.map((h) => h.count));
    const isPaused = incomingBuffer.getHoldAll();
    // Resolve names for the widgets that show contacts
    const [lastRxName, lastTxName, ...topNames] = await Promise.all([
      last.rx ? displayName(last.rx.jid).catch(() => last.rx.jid) : Promise.resolve(null),
      last.tx ? displayName(last.tx.jid).catch(() => last.tx.jid) : Promise.resolve(null),
      ...topToday.map((c) => displayName(c.jid).catch(() => c.jid)),
    ]);
    const fmtAgo = (ts) => {
      if (!ts) return '—';
      const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
      if (sec < 60) return `${sec}s ago`;
      if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
      if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
      return `${Math.floor(sec / 86400)}d ago`;
    };
    const stat = (icon, tile, label, value, sub = '') => `
<div class="stat">
  <div class="flex items-start gap-3">
    <div class="icon-tile icon-tile-${tile}"><i data-lucide="${icon}" class="size-4"></i></div>
    <div class="flex-1 min-w-0">
      <div class="label">${esc(label)}</div>
      <div class="text-2xl font-semibold mt-1 truncate">${value}</div>
      ${sub ? `<div class="text-[11px] text-zinc-500 mt-0.5">${sub}</div>` : ''}
    </div>
  </div>
</div>`;
    const costBar = () => {
      if (!cost.hard) return '';
      const pct = Math.min(100, Math.round((tokensToday / cost.hard) * 100));
      const tone = pct >= 90 ? 'rose' : pct >= 70 ? 'amber' : 'emerald';
      return `
<section class="card p-5 mb-6">
  <div class="flex items-baseline justify-between mb-2">
    <div class="flex items-center gap-2">
      <i data-lucide="coins" class="size-4 text-emerald-400"></i>
      <h2 class="font-semibold">Daily token budget</h2>
    </div>
    <div class="text-sm text-zinc-400 mono">${tokensToday.toLocaleString()} / ${cost.hard.toLocaleString()}</div>
  </div>
  <div class="h-2 bg-zinc-900 rounded-full overflow-hidden">
    <div class="h-full bg-gradient-to-r from-${tone}-500 to-${tone}-400 transition-all" style="width:${pct}%"></div>
  </div>
  <div class="flex justify-between text-[11px] text-zinc-500 mt-1.5">
    <span>0</span>
    ${cost.soft ? `<span class="text-amber-400">⚠ soft ${cost.soft.toLocaleString()}</span>` : ''}
    <span>${cost.hard.toLocaleString()}</span>
  </div>
</section>`;
    };
    const connTone = !poweredOn ? 'zinc' : conn.status === 'open' ? 'emerald' : conn.status === 'close' ? 'rose' : 'amber';
    const connLabel = !poweredOn ? 'Offline' : conn.status === 'open' ? 'Connected' : conn.status === 'close' ? `Disconnected${conn.closeCode ? ` (${conn.closeCode})` : ''}` : 'Connecting';
    const connSince = !poweredOn ? null : conn.status === 'open' ? conn.lastOpenAt : conn.status === 'close' ? conn.lastCloseAt : null;
    const botUptime = poweredOn && conn.status === 'open' && conn.lastOpenAt
      ? fmtDuration(Date.now() - conn.lastOpenAt)
      : 'Offline';
    const body = `
<div class="flex flex-wrap items-start justify-between mb-6 gap-3">
  <div>
    <div class="flex items-center gap-3 flex-wrap">
      <h1 class="text-2xl md:text-3xl font-semibold tracking-tight">Dashboard</h1>
      <span class="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs bg-${connTone}-500/15 text-${connTone}-300 border border-${connTone}-500/30">
        <span class="h-1.5 w-1.5 rounded-full bg-${connTone}-400 ${poweredOn && conn.status === 'open' ? 'animate-pulse' : ''}"></span>
        ${esc(connLabel)}${connSince ? ` · ${esc(fmtAgo(connSince))}` : ''}
      </span>
      <span class="text-[11px] text-zinc-500 mono">restarts ${conn.restartCount}</span>
    </div>
    <p class="text-sm text-zinc-500 mt-1">${esc(process.env.PUBLIC_URL || `localhost:${process.env.WEB_PORT || 7777}`)}</p>
  </div>
  <div class="flex items-center gap-2 flex-wrap">
    <form method="post" action="/api/dashboard/toggle-pause" class="contents">
      <button type="submit" ${poweredOn ? '' : 'disabled'} class="btn ${poweredOn ? (isPaused ? 'btn-warning' : 'btn-ghost') : 'btn-ghost opacity-50 cursor-not-allowed'}" title="${poweredOn ? (isPaused ? 'Resume processing' : 'Hold all incoming messages') : 'Power on the bot before resuming'}">
        <i data-lucide="${poweredOn && !isPaused ? 'pause' : 'play'}" class="size-4"></i>${poweredOn ? (isPaused ? 'Resume' : 'Pause') : 'Offline'}
      </button>
    </form>
    <a href="/people" class="btn btn-ghost"><i data-lucide="user-plus" class="size-4"></i>Allow contact</a>
    <a href="/playbooks" class="btn btn-ghost"><i data-lucide="play" class="size-4"></i>Run playbook</a>
    <a href="/chats" class="btn btn-primary"><i data-lucide="messages-square" class="size-4"></i>Open chats</a>
  </div>
</div>

<section class="card p-4 mb-6">
  <div class="flex items-center justify-between mb-3">
    <div class="flex items-center gap-2">
      <i data-lucide="activity" class="size-4 text-emerald-400"></i>
      <h2 class="font-semibold text-sm">Last 24h messages</h2>
      <span class="text-[11px] text-zinc-500">${hourly.reduce((a, h) => a + h.count, 0)} total</span>
    </div>
    <a href="/analytics" class="text-emerald-400 text-xs hover:text-emerald-300 inline-flex items-center gap-1">More <i data-lucide="arrow-right" class="size-3"></i></a>
  </div>
  <div class="flex items-end gap-[3px] h-14">
    ${hourly.map((h) => `<div class="flex-1 min-w-[3px] bg-gradient-to-t from-emerald-600 to-emerald-400 rounded-sm" style="height:${Math.max(2, Math.round((h.count / maxHourly) * 100))}%" title="${esc(h.label)}: ${h.count}"></div>`).join('')}
  </div>
  <div class="flex justify-between text-[10px] text-zinc-500 mt-1.5">
    <span>${esc(hourly[0]?.label || '')}</span>
    <span>${esc(hourly[Math.floor(hourly.length / 2)]?.label || '')}</span>
    <span>${esc(hourly[hourly.length - 1]?.label || '')}</span>
  </div>
</section>

<div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
  ${stat('clock', poweredOn && conn.status === 'open' ? 'emerald' : 'zinc', 'Bot uptime', botUptime)}
  ${stat('message-circle', 'sky', 'Messages', s.messages.toLocaleString())}
  ${stat('circle-alert', s.errors > 0 ? 'rose' : 'zinc', 'Errors', s.errors)}
  ${stat('layers', 'violet', 'Queue', queueDepth())}
</div>

<div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
  ${stat('brain', 'emerald', 'Sessions', sessionCount, 'Remembered chats')}
  ${stat('hourglass', 'amber', 'Coalescing', bufferedJids, 'JIDs being buffered')}
  ${stat('coins', 'sky', 'Tokens today', tokensToday.toLocaleString())}
  ${stat('database', 'violet', 'Cache reads', (s.cacheReadTokens || 0).toLocaleString(), totalTokens > 0 ? `${Math.round((s.cacheReadTokens || 0) / Math.max(totalTokens, 1) * 100)}% of total` : '')}
</div>

${costBar()}

<div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
  <section class="card p-5">
    <div class="flex items-center gap-2 mb-3">
      <i data-lucide="inbox" class="size-4 text-sky-400"></i>
      <h2 class="font-semibold">Last incoming</h2>
    </div>
    ${
      last.rx && !owners.has(last.rx.jid)
        ? `<div class="text-xs text-zinc-500 flex items-center gap-2 mb-1.5"><span class="mono">${esc(lastRxName || last.rx.jid)}</span><span>·</span><span>${esc(fmtAgo(last.rx.at))}</span></div>
           <div class="text-sm text-zinc-200 leading-relaxed">${esc((last.rx.text || '').slice(0, 240)) || '<span class="text-zinc-500 italic">[no text]</span>'}</div>`
        : '<p class="text-zinc-500 text-sm">No messages yet this session.</p>'
    }
  </section>
  <section class="card p-5">
    <div class="flex items-center gap-2 mb-3">
      <i data-lucide="send" class="size-4 text-emerald-400"></i>
      <h2 class="font-semibold">Last reply</h2>
    </div>
    ${
      last.tx && !owners.has(last.tx.jid)
        ? `<div class="text-xs text-zinc-500 flex items-center gap-2 mb-1.5"><span class="mono">${esc(lastTxName || last.tx.jid)}</span><span>·</span><span>${esc(fmtAgo(last.tx.at))}</span></div>
           <div class="text-sm text-zinc-200 leading-relaxed">${esc((last.tx.text || '').slice(0, 240))}</div>`
        : '<p class="text-zinc-500 text-sm">No replies sent yet this session.</p>'
    }
  </section>
</div>

<div id="processing-card" class="hidden card p-5 mb-6 border-emerald-500/30 bg-emerald-500/5">
  <div class="flex items-center gap-3">
    <div class="animate-spin h-5 w-5 border-2 border-emerald-400 border-t-transparent rounded-full shrink-0"></div>
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2">
        <span class="font-semibold text-emerald-300">Processing message</span>
        <span id="processing-time" class="text-xs text-emerald-400">0s</span>
      </div>
      <div id="processing-preview" class="text-sm text-zinc-400 truncate max-w-full mt-0.5"></div>
    </div>
    <a href="/queue" class="btn btn-ghost text-xs shrink-0">View queue</a>
  </div>
</div>

<div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
  <section class="card p-5">
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-2">
        <i data-lucide="bookmark" class="size-4 text-amber-400"></i>
        <h2 class="font-semibold">Open threads</h2>
        <span class="text-[11px] text-zinc-500">${openThreads.length}</span>
      </div>
      <a class="text-amber-400 text-xs hover:text-amber-300 inline-flex items-center gap-1" href="/memory">Edit <i data-lucide="arrow-right" class="size-3"></i></a>
    </div>
    ${
      openThreads.length === 0
        ? '<p class="text-zinc-500 text-sm">No paused tasks. MEMORY.md → <span class="mono">## Open threads</span></p>'
        : `<ul class="text-sm space-y-2">${openThreads.slice(0, 5).map((t) => `<li class="flex items-start gap-2"><i data-lucide="dot" class="size-3.5 mt-1 text-amber-400 shrink-0"></i><span class="text-zinc-300">${esc(t.slice(0, 220))}</span></li>`).join('')}</ul>`
    }
  </section>
  <section class="card p-5">
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-2">
        <i data-lucide="users" class="size-4 text-emerald-400"></i>
        <h2 class="font-semibold">Top contacts today</h2>
      </div>
      <a class="text-emerald-400 text-xs hover:text-emerald-300 inline-flex items-center gap-1" href="/chats">All <i data-lucide="arrow-right" class="size-3"></i></a>
    </div>
    ${
      topToday.length === 0
        ? '<p class="text-zinc-500 text-sm">No chats today yet.</p>'
        : `<ul class="text-sm space-y-2">${topToday.map((c, i) => `<li class="flex items-center gap-3"><span class="h-6 w-6 rounded-full bg-emerald-500/15 text-emerald-300 text-xs flex items-center justify-center font-semibold">${esc((topNames[i] || c.jid).toString().charAt(0).toUpperCase())}</span><div class="flex-1 min-w-0"><div class="text-zinc-200 truncate">${esc(topNames[i] || c.jid)}</div><div class="text-[10px] text-zinc-500">${c.received} in · ${c.sent} out</div></div><span class="text-sm font-semibold text-emerald-400">${c.total}</span></li>`).join('')}</ul>`
    }
  </section>
</div>

<div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
  <section class="card p-5">
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-2">
        <i data-lucide="calendar-clock" class="size-4 text-emerald-400"></i>
        <h2 class="font-semibold">Scheduled jobs <span class="text-zinc-500 font-normal">(${jobs.length})</span></h2>
      </div>
      <a class="text-emerald-400 text-sm hover:text-emerald-300 inline-flex items-center gap-1" href="/jobs">Manage <i data-lucide="arrow-right" class="size-3.5"></i></a>
    </div>
    ${
      jobs.length === 0
        ? '<p class="text-zinc-500 text-sm">No jobs scheduled.</p>'
        : `<ul class="text-sm space-y-1.5">${jobs.slice(0, 6).map((j) => `<li class="flex items-start gap-2"><i data-lucide="${j.recurring ? 'repeat' : 'circle-dot'}" class="size-3.5 mt-1 text-zinc-500 shrink-0"></i><div class="flex-1 min-w-0"><span class="text-zinc-300 truncate block">${esc(j.text.slice(0, 60))}</span><span class="text-[11px] text-zinc-500 mono">${esc(new Date(j.runAt).toLocaleString())}${j.recurring ? ` · ${esc(j.recurring.every || j.recurring.cron)}` : ''}</span></div></li>`).join('')}</ul>`
    }
  </section>

  <section class="card p-5">
    <div class="flex items-center gap-2 mb-3">
      <i data-lucide="activity" class="size-4 text-emerald-400"></i>
      <h2 class="font-semibold">Heartbeat plugins</h2>
    </div>
    ${
      plugins.length === 0
        ? '<p class="text-zinc-500 text-sm">None registered.</p>'
        : `<ul class="text-sm space-y-2">${plugins.map((p) => `<li class="flex items-center gap-2"><span class="pulse-dot"></span><span class="text-zinc-200">${esc(p.name)}</span><span class="text-zinc-500 text-xs ml-auto">every ${Math.round(p.intervalMs / 60000)}m</span></li>`).join('')}</ul>`
    }
  </section>
</div>

<section class="card overflow-hidden">
  <div class="flex items-center justify-between p-4 pb-3 border-b border-zinc-800/60">
    <div class="flex items-center gap-2">
      <i data-lucide="terminal" class="size-4 text-emerald-400"></i>
      <h2 class="font-semibold">Live log</h2>
    </div>
    <div class="flex items-center gap-2">
      <div class="flex gap-1 text-xs">
        <button onclick="setLogFilter('all')" id="filter-all" class="log-filter-btn px-2 py-1 rounded bg-zinc-800 text-zinc-300">All</button>
        <button onclick="setLogFilter('error')" id="filter-error" class="log-filter-btn px-2 py-1 rounded text-zinc-500 hover:text-rose-400">Errors</button>
        <button onclick="setLogFilter('warn')" id="filter-warn" class="log-filter-btn px-2 py-1 rounded text-zinc-500 hover:text-amber-400">Warnings</button>
      </div>
      <span class="text-xs text-zinc-500 inline-flex items-center gap-1.5 ml-2"><span class="pulse-dot"></span>streaming</span>
    </div>
  </div>
  <pre id="log" class="text-xs text-zinc-300 h-80 md:h-96 overflow-y-scroll bg-zinc-950/60 p-4 mono">${recentLogs(200).map((e) => `<div class="log-line log-${esc(e.level)}" data-level="${esc(e.level)}">[${esc(e.t.slice(11, 19))}] ${esc(e.text)}</div>`).join('')}</pre>
</section>
<script>
  const el = document.getElementById('log');
  el.scrollTop = el.scrollHeight;
  let currentFilter = 'all';

  function setLogFilter(filter) {
    currentFilter = filter;
    document.querySelectorAll('.log-filter-btn').forEach(btn => {
      btn.classList.remove('bg-zinc-800', 'text-zinc-300', 'text-rose-400', 'text-amber-400');
      btn.classList.add('text-zinc-500');
    });
    const activeBtn = document.getElementById('filter-' + filter);
    if (filter === 'all') {
      activeBtn.classList.remove('text-zinc-500');
      activeBtn.classList.add('bg-zinc-800', 'text-zinc-300');
    } else if (filter === 'error') {
      activeBtn.classList.remove('text-zinc-500');
      activeBtn.classList.add('bg-rose-500/20', 'text-rose-400');
    } else if (filter === 'warn') {
      activeBtn.classList.remove('text-zinc-500');
      activeBtn.classList.add('bg-amber-500/20', 'text-amber-400');
    }
    document.querySelectorAll('#log .log-line').forEach(line => {
      const level = line.getAttribute('data-level');
      if (filter === 'all') {
        line.style.display = '';
      } else if (filter === 'error') {
        line.style.display = level === 'error' ? '' : 'none';
      } else if (filter === 'warn') {
        line.style.display = (level === 'warn' || level === 'error') ? '' : 'none';
      }
    });
    el.scrollTop = el.scrollHeight;
  }

  const ev = new EventSource('/logs/stream');
  ev.onmessage = (m) => {
    try {
      const d = JSON.parse(m.data);
      const div = document.createElement('div');
      div.className = 'log-line log-' + d.level;
      div.setAttribute('data-level', d.level);
      div.textContent = '[' + d.t.slice(11,19) + '] ' + d.text;
      if (currentFilter !== 'all') {
        if (currentFilter === 'error' && d.level !== 'error') div.style.display = 'none';
        if (currentFilter === 'warn' && d.level !== 'warn' && d.level !== 'error') div.style.display = 'none';
      }
      el.appendChild(div);
      while (el.children.length > 500) el.removeChild(el.firstChild);
      el.scrollTop = el.scrollHeight;
    } catch {}
  };

  // Processing indicator for dashboard
  (function() {
    const card = document.getElementById('processing-card');
    const timeEl = document.getElementById('processing-time');
    const previewEl = document.getElementById('processing-preview');
    if (!card) return;
    const ps = new EventSource('/processing/stream');
    ps.onmessage = (e) => {
      try {
        const state = JSON.parse(e.data);
        if (state.count > 0) {
          card.classList.remove('hidden');
          const first = state.active[0];
          const secs = Math.floor(first.elapsedMs / 1000);
          timeEl.textContent = secs + 's';
          previewEl.textContent = first.preview || '';
        } else {
          card.classList.add('hidden');
        }
      } catch {}
    };
  })();
</script>
`;
    res.send(LAYOUT('Dashboard', body, '/'));
  });

  // ─── Jobs ──────────────────────────────────────────────────────────────────
  app.get('/jobs', (_req, res) => {
    const jobs = scheduler.listJobs();
    const now = Date.now();
    const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
    const today = startOfDay(new Date());
    const tomorrow = today + 86_400_000;
    const dayAfterTomorrow = tomorrow + 86_400_000;
    const endOfWeek = today + 7 * 86_400_000;
    const fmtSince = (ms) => {
      const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
      if (sec < 60) return `${sec}s ago`;
      if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
      if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
      return `${Math.floor(sec / 86400)}d ago`;
    };
    const groupOf = (runAtMs) => {
      if (runAtMs < now) return 'overdue';
      if (runAtMs < tomorrow) return 'today';
      if (runAtMs < dayAfterTomorrow) return 'tomorrow';
      if (runAtMs < endOfWeek) return 'week';
      return 'later';
    };
    const groups = { overdue: [], today: [], tomorrow: [], week: [], later: [] };
    for (const j of jobs) {
      groups[groupOf(new Date(j.runAt).getTime())].push(j);
    }
    const groupMeta = {
      overdue:  { label: 'Overdue',   icon: 'alert-triangle', tone: 'rose' },
      today:    { label: 'Today',     icon: 'sun',            tone: 'emerald' },
      tomorrow: { label: 'Tomorrow',  icon: 'sunrise',        tone: 'sky' },
      week:     { label: 'This week', icon: 'calendar',       tone: 'violet' },
      later:    { label: 'Later',     icon: 'calendar-days',  tone: 'zinc' },
    };
    const renderJob = (j) => {
      const isRecurring = Boolean(j.recurring);
      const runDate = new Date(j.runAt);
      const timeStr = runDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
      const dateStr = runDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const paused = Boolean(j.paused);
      const lastFiredAt = j.lastFiredAt ? new Date(j.lastFiredAt).getTime() : null;
      const lastOk = j.lastFireOk !== false;
      const formData = {
        text: j.text,
        at: j.runAt,
        mode: j.mode,
        every: j.recurring?.every || '',
        cron: j.recurring?.cron || '',
        jid: j.jid,
      };
      const formDataAttr = esc(JSON.stringify(formData));
      return `<div class="card p-4 flex items-start gap-3 hover:border-zinc-700 transition-colors ${paused ? 'opacity-60' : ''}">
        <label class="flex items-center pt-0.5 shrink-0">
          <input type="checkbox" name="job-check" value="${esc(j.id)}" form="bulkForm" class="size-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-0">
        </label>
        <div class="icon-tile ${paused ? 'icon-tile-zinc' : isRecurring ? 'icon-tile-violet' : 'icon-tile-sky'} shrink-0 mt-0.5">
          <i data-lucide="${paused ? 'pause' : isRecurring ? 'repeat' : 'clock'}" class="size-4"></i>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-baseline justify-between gap-2">
            <a href="/jobs/${esc(j.id)}" class="font-medium text-sm truncate hover:text-emerald-300 transition-colors" title="View details">${esc(j.text.slice(0, 80))}${j.text.length > 80 ? '...' : ''}</a>
            <a href="/jobs/${esc(j.id)}" class="text-[10px] text-zinc-500 mono shrink-0 hover:text-zinc-300">${esc(j.id.slice(0, 8))}</a>
          </div>
          <div class="flex items-center gap-3 mt-1.5 text-xs text-zinc-400 flex-wrap">
            <span class="inline-flex items-center gap-1"><i data-lucide="calendar" class="size-3"></i>${esc(dateStr)} ${esc(timeStr)}</span>
            <span class="countdown text-zinc-500" data-runat="${esc(j.runAt)}" data-paused="${paused ? '1' : '0'}"></span>
            ${isRecurring ? `<span class="inline-flex items-center gap-1"><i data-lucide="repeat" class="size-3"></i>${esc(j.recurring.every || j.recurring.cron)}</span>` : ''}
            <span class="px-1.5 py-0.5 rounded text-[10px] ${j.mode === 'prompt' ? 'bg-violet-500/20 text-violet-300' : 'bg-sky-500/20 text-sky-300'}">${esc(j.mode)}</span>
            ${paused ? '<span class="px-1.5 py-0.5 rounded text-[10px] bg-zinc-700 text-zinc-300">paused</span>' : ''}
            ${lastFiredAt ? `<span class="inline-flex items-center gap-1 ${lastOk ? 'text-emerald-400' : 'text-rose-400'}"><i data-lucide="${lastOk ? 'check' : 'x'}" class="size-3"></i>last ${esc(fmtSince(lastFiredAt))}${!lastOk && j.lastFireError ? ` · ${esc(j.lastFireError.slice(0, 40))}` : ''}</span>` : ''}
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <form method="POST" action="/jobs/${esc(j.id)}/fire" class="contents">
            <button class="btn btn-icon btn-ghost" title="Run now"><i data-lucide="play" class="size-4 text-emerald-400"></i></button>
          </form>
          <form method="POST" action="/jobs/${esc(j.id)}/pause" class="contents">
            <button class="btn btn-icon btn-ghost" title="${paused ? 'Resume' : 'Pause'}"><i data-lucide="${paused ? 'play-circle' : 'pause-circle'}" class="size-4"></i></button>
          </form>
          <button type="button" class="btn btn-icon btn-ghost" title="Edit" data-edit-job="${formDataAttr}" data-job-id="${esc(j.id)}"><i data-lucide="pencil" class="size-4"></i></button>
          <form method="POST" action="/jobs/${esc(j.id)}/del" onsubmit="return confirm('Delete this job?');" class="contents">
            <button class="btn btn-icon btn-danger" title="Delete"><i data-lucide="trash-2" class="size-4"></i></button>
          </form>
        </div>
      </div>`;
    };
    const renderGroup = (key) => {
      const items = groups[key];
      if (items.length === 0) return '';
      const m = groupMeta[key];
      return `<section class="mb-5">
        <div class="flex items-center gap-2 mb-2 text-${m.tone}-300">
          <i data-lucide="${m.icon}" class="size-4"></i>
          <h2 class="font-semibold text-sm">${esc(m.label)}</h2>
          <span class="text-xs text-zinc-500">${items.length}</span>
        </div>
        <div class="grid gap-2">${items.map(renderJob).join('')}</div>
      </section>`;
    };
    const body = `
<div class="flex flex-wrap items-center justify-between mb-6 gap-3">
  <div>
    <h1 class="text-2xl md:text-3xl font-semibold tracking-tight">Jobs</h1>
    <p class="text-sm text-zinc-500 mt-1">${jobs.length} scheduled ${jobs.length === 1 ? 'job' : 'jobs'}</p>
  </div>
  <button onclick="document.getElementById('addJobModal').classList.remove('hidden')" class="btn btn-primary">
    <i data-lucide="plus" class="size-4"></i>Add job
  </button>
</div>

${jobs.length === 0 ? `
<section class="card p-8 text-center">
  <i data-lucide="calendar-clock" class="size-10 text-zinc-600 mx-auto mb-3"></i>
  <p class="text-zinc-400">No scheduled jobs</p>
  <p class="text-sm text-zinc-500 mt-1">Click "Add job" to schedule a reminder or task.</p>
</section>` : `
<form id="bulkForm" method="POST" action="/jobs/delete-many" onsubmit="return confirm('Delete selected jobs?');" class="hidden"></form>
<div id="bulkBar" class="hidden sticky top-2 z-10 mb-3 card p-3 flex items-center justify-between bg-zinc-900/95 backdrop-blur">
  <div class="text-sm"><span id="bulkCount">0</span> selected</div>
  <div class="flex gap-2">
    <button type="button" onclick="clearJobChecks()" class="btn btn-ghost btn-sm">Clear</button>
    <button type="submit" form="bulkForm" class="btn btn-danger btn-sm"><i data-lucide="trash-2" class="size-4"></i>Delete selected</button>
  </div>
</div>
${renderGroup('overdue')}
${renderGroup('today')}
${renderGroup('tomorrow')}
${renderGroup('week')}
${renderGroup('later')}`}

<!-- Add Job Modal -->
<div id="addJobModal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onclick="if(event.target===this)this.classList.add('hidden')">
  <div class="card p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onclick="event.stopPropagation()">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-lg font-semibold">Add scheduled job</h2>
      <button onclick="document.getElementById('addJobModal').classList.add('hidden')" class="btn btn-icon btn-ghost"><i data-lucide="x" class="size-4"></i></button>
    </div>
    <form method="POST" action="/jobs" class="space-y-4" id="addJobForm">
      <div>
        <label class="label block mb-1.5">What to do</label>
        <input name="text" required placeholder="Remind me to check emails" class="input">
      </div>
      <div class="flex flex-wrap gap-1.5">
        <button type="button" class="preset-chip" data-set='{"at":"+30m"}'>in 30m</button>
        <button type="button" class="preset-chip" data-set='{"at":"+1h"}'>in 1h</button>
        <button type="button" class="preset-chip" data-set='{"at":"+1d"}'>in 1 day</button>
        <button type="button" class="preset-chip" data-set='{"at":"09:00"}'>9am next</button>
        <button type="button" class="preset-chip" data-set='{"cron":"0 9 * * 1-5","at":""}'>daily 9am Mon-Fri</button>
        <button type="button" class="preset-chip" data-set='{"every":"1h","at":""}'>every 1h</button>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="label block mb-1.5">When</label>
          <input name="at" placeholder="+1h, 18:00, or ISO date" class="input">
          <p class="text-[10px] text-zinc-500 mt-1">+30m, +2h, 18:00, 2026-06-15T09:00</p>
        </div>
        <div>
          <label class="label block mb-1.5">Mode</label>
          <select name="mode" class="input">
            <option value="notify">Notify (send text)</option>
            <option value="prompt">Prompt (run Claude)</option>
          </select>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="label block mb-1.5">Repeat every</label>
          <input name="every" placeholder="30m, 2h, 1d, 1w" class="input">
        </div>
        <div>
          <label class="label block mb-1.5">Or cron</label>
          <input name="cron" placeholder="0 8 * * 1-5" class="input mono">
        </div>
      </div>
      <div>
        <label class="label block mb-1.5">Target JID (optional)</label>
        <input name="jid" placeholder="${esc(listAllowed()[0] || 'defaults to owner')}" class="input">
      </div>
      <div class="flex gap-2 pt-2">
        <button type="button" onclick="document.getElementById('addJobModal').classList.add('hidden')" class="btn btn-ghost flex-1">Cancel</button>
        <button type="submit" class="btn btn-primary flex-1"><i data-lucide="calendar-plus" class="size-4"></i>Schedule</button>
      </div>
    </form>
  </div>
</div>

<!-- Edit Job Modal -->
<div id="editJobModal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onclick="if(event.target===this)this.classList.add('hidden')">
  <div class="card p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onclick="event.stopPropagation()">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-lg font-semibold">Edit job</h2>
      <button onclick="document.getElementById('editJobModal').classList.add('hidden')" class="btn btn-icon btn-ghost"><i data-lucide="x" class="size-4"></i></button>
    </div>
    <form method="POST" id="editJobForm" class="space-y-4">
      <div>
        <label class="label block mb-1.5">What to do</label>
        <input name="text" required class="input">
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="label block mb-1.5">When</label>
          <input name="at" placeholder="ISO or +1h" class="input">
        </div>
        <div>
          <label class="label block mb-1.5">Mode</label>
          <select name="mode" class="input">
            <option value="notify">Notify (send text)</option>
            <option value="prompt">Prompt (run Claude)</option>
          </select>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="label block mb-1.5">Repeat every</label>
          <input name="every" placeholder="30m, 2h, 1d, 1w" class="input">
        </div>
        <div>
          <label class="label block mb-1.5">Or cron</label>
          <input name="cron" placeholder="0 8 * * 1-5" class="input mono">
        </div>
      </div>
      <div>
        <label class="label block mb-1.5">Target JID</label>
        <input name="jid" class="input">
      </div>
      <div class="flex gap-2 pt-2">
        <button type="button" onclick="document.getElementById('editJobModal').classList.add('hidden')" class="btn btn-ghost flex-1">Cancel</button>
        <button type="submit" class="btn btn-primary flex-1"><i data-lucide="save" class="size-4"></i>Save</button>
      </div>
    </form>
  </div>
</div>

<style>
  .preset-chip { display: inline-flex; align-items: center; padding: 0.25rem 0.625rem; border-radius: 999px; background: rgb(39 39 42); color: rgb(228 228 231); font-size: 0.7rem; border: 1px solid rgb(63 63 70); cursor: pointer; }
  .preset-chip:hover { background: rgb(63 63 70); border-color: rgb(82 82 91); }
  .btn-sm { padding-left: 0.625rem; padding-right: 0.625rem; padding-top: 0.25rem; padding-bottom: 0.25rem; font-size: 0.75rem; }
</style>
<script>
  function fmtUntil(ms) {
    if (ms < 0) return 'overdue ' + fmtAgoMs(-ms);
    if (ms < 60_000) return 'in ' + Math.round(ms / 1000) + 's';
    if (ms < 3_600_000) return 'in ' + Math.round(ms / 60_000) + 'm';
    if (ms < 86_400_000) {
      const h = Math.floor(ms / 3_600_000);
      const m = Math.round((ms - h * 3_600_000) / 60_000);
      return 'in ' + h + 'h' + (m ? ' ' + m + 'm' : '');
    }
    return 'in ' + Math.floor(ms / 86_400_000) + 'd';
  }
  function fmtAgoMs(ms) {
    if (ms < 60_000) return Math.round(ms / 1000) + 's';
    if (ms < 3_600_000) return Math.round(ms / 60_000) + 'm';
    if (ms < 86_400_000) return Math.round(ms / 3_600_000) + 'h';
    return Math.round(ms / 86_400_000) + 'd';
  }
  function tickCountdowns() {
    const now = Date.now();
    document.querySelectorAll('.countdown').forEach((el) => {
      if (el.dataset.paused === '1') { el.textContent = '· paused'; el.classList.add('text-zinc-600'); return; }
      const ts = new Date(el.dataset.runat).getTime();
      const diff = ts - now;
      el.textContent = '· ' + fmtUntil(diff);
      el.classList.remove('text-rose-400','text-amber-400','text-zinc-500','text-zinc-600');
      if (diff < 0 || diff < 600_000) el.classList.add('text-rose-400');
      else if (diff < 3_600_000) el.classList.add('text-amber-400');
      else el.classList.add('text-zinc-500');
    });
  }
  tickCountdowns();
  setInterval(tickCountdowns, 15_000);

  function updateBulkBar() {
    const checks = document.querySelectorAll('input[name="job-check"]:checked');
    const bar = document.getElementById('bulkBar');
    const count = document.getElementById('bulkCount');
    if (!bar || !count) return;
    if (checks.length > 0) { bar.classList.remove('hidden'); count.textContent = String(checks.length); }
    else bar.classList.add('hidden');
  }
  function clearJobChecks() {
    document.querySelectorAll('input[name="job-check"]').forEach((c) => { c.checked = false; });
    updateBulkBar();
  }
  document.addEventListener('change', (e) => {
    if (e.target && e.target.name === 'job-check') updateBulkBar();
  });

  document.querySelectorAll('.preset-chip').forEach((b) => {
    b.addEventListener('click', () => {
      const set = JSON.parse(b.dataset.set);
      const form = document.getElementById('addJobForm');
      for (const k of Object.keys(set)) {
        const inp = form.querySelector('[name="' + k + '"]');
        if (inp) inp.value = set[k];
      }
    });
  });

  document.querySelectorAll('[data-edit-job]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const data = JSON.parse(btn.dataset.editJob);
      const form = document.getElementById('editJobForm');
      form.action = '/jobs/' + btn.dataset.jobId + '/edit';
      for (const k of Object.keys(data)) {
        const inp = form.querySelector('[name="' + k + '"]');
        if (inp) inp.value = data[k] == null ? '' : data[k];
      }
      document.getElementById('editJobModal').classList.remove('hidden');
    });
  });
</script>
`;
    res.send(LAYOUT('Jobs', body, '/jobs'));
  });

  app.post('/jobs', async (req, res) => {
    try {
      const { jid: rawJid, mode = 'notify', text, at, every, cron } = req.body || {};
      if (!text) return res.status(400).send('text required');
      const jid = (rawJid && rawJid.trim()) || listAllowed()[0];
      if (!jid) return res.status(400).send('no JID and allowlist is empty');

      let recurring = null;
      if (every && every.trim()) { parseDuration(every.trim()); recurring = { every: every.trim() }; }
      else if (cron && cron.trim()) { recurring = { cron: cron.trim() }; }

      let runAt;
      if (at && at.trim()) runAt = parseWhen(at.trim()).toISOString();

      await scheduler.addJob({ jid, runAt, mode, text, recurring });
      res.redirect('/jobs');
    } catch (err) {
      res.status(400).send(`error: ${esc(err.message)}`);
    }
  });

  app.get('/jobs/:id', async (req, res) => {
    const job = scheduler.listJobs().find((j) => j.id === req.params.id);
    if (!job) return res.status(404).send(LAYOUT('Job not found', `
<div class="card p-8 text-center">
  <i data-lucide="search-x" class="size-10 text-zinc-600 mx-auto mb-3"></i>
  <p class="text-zinc-400">Job <code>${esc(req.params.id)}</code> not found.</p>
  <a href="/jobs" class="btn btn-ghost mt-4 inline-flex"><i data-lucide="arrow-left" class="size-4"></i>Back to jobs</a>
</div>`, '/jobs'));

    const runDate = new Date(job.runAt);
    const createdDate = job.createdAt ? new Date(job.createdAt) : null;
    const lastFiredDate = job.lastFiredAt ? new Date(job.lastFiredAt) : null;
    const paused = Boolean(job.paused);
    const isRecurring = Boolean(job.recurring);
    const lastOk = job.lastFireOk !== false;
    const jidName = await displayName(job.jid).catch(() => job.jid);
    const fmtFull = (d) => d ? `${d.toLocaleString()} (${d.toISOString()})` : '—';
    const formData = {
      text: job.text,
      at: job.runAt,
      mode: job.mode,
      every: job.recurring?.every || '',
      cron: job.recurring?.cron || '',
      jid: job.jid,
    };
    const formDataAttr = esc(JSON.stringify(formData));

    const subtitle = `${job.mode === 'prompt' ? 'Prompt to Claude' : 'Notification'}${isRecurring ? ` · ${job.recurring.every ? `every ${job.recurring.every}` : `cron ${job.recurring.cron}`}` : ''}${paused ? ' · paused' : ''}`;
    const body = `
<div class="flex items-center gap-2 mb-4 text-sm text-zinc-400">
  <a href="/jobs" class="hover:text-zinc-200 inline-flex items-center gap-1"><i data-lucide="arrow-left" class="size-3.5"></i>Jobs</a>
  <span class="text-zinc-600">/</span>
  <code class="mono text-zinc-300">${esc(job.id)}</code>
</div>

<div class="flex flex-wrap items-center justify-between mb-6 gap-3">
  <div>
    <h1 class="text-2xl md:text-3xl font-semibold tracking-tight">Job ${esc(job.id)}</h1>
    <p class="text-sm text-zinc-500 mt-1">${esc(subtitle)}</p>
  </div>
  <div class="flex items-center gap-2 flex-wrap">
    <form method="POST" action="/jobs/${esc(job.id)}/fire" class="contents">
      <button class="btn btn-ghost" title="Run now"><i data-lucide="play" class="size-4"></i>Run now</button>
    </form>
    <form method="POST" action="/jobs/${esc(job.id)}/pause" class="contents">
      <button class="btn btn-ghost"><i data-lucide="${paused ? 'play-circle' : 'pause-circle'}" class="size-4"></i>${paused ? 'Resume' : 'Pause'}</button>
    </form>
    <button type="button" class="btn btn-ghost" data-edit-job="${formDataAttr}" data-job-id="${esc(job.id)}"><i data-lucide="pencil" class="size-4"></i>Edit</button>
    <form method="POST" action="/jobs/${esc(job.id)}/del" onsubmit="return confirm('Delete this job?');" class="contents">
      <button class="btn btn-danger"><i data-lucide="trash-2" class="size-4"></i>Delete</button>
    </form>
  </div>
</div>

<div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
  <div class="stat">
    <div class="flex items-start gap-3">
      <div class="icon-tile ${paused ? 'icon-tile-zinc' : isRecurring ? 'icon-tile-violet' : 'icon-tile-sky'}"><i data-lucide="${paused ? 'pause' : isRecurring ? 'repeat' : 'clock'}" class="size-4"></i></div>
      <div class="flex-1 min-w-0">
        <div class="label">Mode</div>
        <div class="text-2xl font-semibold mt-1 truncate">${esc(job.mode)}</div>
      </div>
    </div>
  </div>
  <div class="stat">
    <div class="flex items-start gap-3">
      <div class="icon-tile icon-tile-emerald"><i data-lucide="timer" class="size-4"></i></div>
      <div class="flex-1 min-w-0">
        <div class="label">Next run</div>
        <div class="text-2xl font-semibold mt-1 truncate countdown" data-runat="${esc(job.runAt)}" data-paused="${paused ? '1' : '0'}">—</div>
        <div class="text-[11px] text-zinc-500 mt-0.5">${esc(runDate.toLocaleString())}</div>
      </div>
    </div>
  </div>
  <div class="stat">
    <div class="flex items-start gap-3">
      <div class="icon-tile ${lastFiredDate ? (lastOk ? 'icon-tile-emerald' : 'icon-tile-rose') : 'icon-tile-zinc'}"><i data-lucide="${lastFiredDate ? (lastOk ? 'check' : 'x') : 'minus'}" class="size-4"></i></div>
      <div class="flex-1 min-w-0">
        <div class="label">Last fire</div>
        <div class="text-2xl font-semibold mt-1 truncate">${lastFiredDate ? (lastOk ? 'OK' : 'Failed') : '—'}</div>
        <div class="text-[11px] text-zinc-500 mt-0.5">${lastFiredDate ? esc(lastFiredDate.toLocaleString()) : 'Never fired'}</div>
      </div>
    </div>
  </div>
  <div class="stat">
    <div class="flex items-start gap-3">
      <div class="icon-tile icon-tile-violet"><i data-lucide="calendar-plus" class="size-4"></i></div>
      <div class="flex-1 min-w-0">
        <div class="label">Created</div>
        <div class="text-2xl font-semibold mt-1 truncate">${createdDate ? esc(createdDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) : '—'}</div>
        <div class="text-[11px] text-zinc-500 mt-0.5">${createdDate ? esc(createdDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })) : ''}</div>
      </div>
    </div>
  </div>
</div>

<div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
  <section class="card p-5 lg:col-span-2">
    <div class="flex items-center gap-2 mb-3">
      <i data-lucide="file-text" class="size-4 text-emerald-400"></i>
      <h2 class="font-semibold">${esc(job.mode === 'prompt' ? 'Prompt to Claude' : 'Notification text')}</h2>
    </div>
    <pre class="whitespace-pre-wrap text-sm text-zinc-200 leading-relaxed mono bg-zinc-950/60 rounded p-3 border border-zinc-800/60">${esc(job.text)}</pre>
  </section>

  <section class="card p-5">
    <div class="flex items-center gap-2 mb-3">
      <i data-lucide="info" class="size-4 text-emerald-400"></i>
      <h2 class="font-semibold">Details</h2>
    </div>
    <dl class="text-sm space-y-3">
      <div>
        <dt class="label">Recipient</dt>
        <dd class="text-zinc-200 mt-0.5">${esc(jidName)}</dd>
        <dd class="text-xs text-zinc-500 mono break-all mt-0.5">${esc(job.jid)}</dd>
      </div>
      <div>
        <dt class="label">Next run</dt>
        <dd class="text-zinc-200 mt-0.5">${esc(runDate.toLocaleString())}</dd>
        <dd class="text-xs text-zinc-500 mono mt-0.5">${esc(runDate.toISOString())}</dd>
      </div>
      ${isRecurring ? `<div>
        <dt class="label">Recurrence</dt>
        <dd class="text-zinc-200 mt-0.5">${job.recurring.every ? `every ${esc(job.recurring.every)}` : `cron <code class="mono text-xs">${esc(job.recurring.cron)}</code>`}</dd>
      </div>` : ''}
      <div>
        <dt class="label">Created</dt>
        <dd class="text-zinc-200 mt-0.5">${createdDate ? esc(createdDate.toLocaleString()) : '—'}</dd>
      </div>
    </dl>
  </section>
</div>

${lastFiredDate || isRecurring ? `<section class="card p-5 mb-6">
  <div class="flex items-center gap-2 mb-3">
    <i data-lucide="history" class="size-4 text-emerald-400"></i>
    <h2 class="font-semibold">Last fire</h2>
  </div>
  ${
    lastFiredDate
      ? `<div class="flex items-start gap-3">
          <div class="icon-tile ${lastOk ? 'icon-tile-emerald' : 'icon-tile-rose'} shrink-0 mt-0.5">
            <i data-lucide="${lastOk ? 'check' : 'x'}" class="size-4"></i>
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm text-zinc-200">${lastOk ? 'Succeeded' : 'Failed'}</div>
            <div class="text-xs text-zinc-500 mt-0.5">${esc(lastFiredDate.toLocaleString())}</div>
            ${!lastOk && job.lastFireError ? `<pre class="mt-2 text-xs text-rose-300 bg-rose-500/5 border border-rose-500/20 rounded p-2 whitespace-pre-wrap">${esc(job.lastFireError)}</pre>` : ''}
          </div>
        </div>`
      : '<p class="text-zinc-500 text-sm">Never fired yet.</p>'
  }
</section>` : ''}

<!-- Edit Job Modal (same shape as on /jobs) -->
<div id="editJobModal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onclick="if(event.target===this)this.classList.add('hidden')">
  <div class="card p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onclick="event.stopPropagation()">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-lg font-semibold">Edit job</h2>
      <button onclick="document.getElementById('editJobModal').classList.add('hidden')" class="btn btn-icon btn-ghost"><i data-lucide="x" class="size-4"></i></button>
    </div>
    <form method="POST" id="editJobForm" class="space-y-4">
      <div>
        <label class="label block mb-1.5">What to do</label>
        <textarea name="text" required rows="4" class="input"></textarea>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="label block mb-1.5">When</label>
          <input name="at" placeholder="ISO or +1h" class="input">
        </div>
        <div>
          <label class="label block mb-1.5">Mode</label>
          <select name="mode" class="input">
            <option value="notify">Notify (send text)</option>
            <option value="prompt">Prompt (run Claude)</option>
          </select>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="label block mb-1.5">Repeat every</label>
          <input name="every" placeholder="30m, 2h, 1d, 1w" class="input">
        </div>
        <div>
          <label class="label block mb-1.5">Or cron</label>
          <input name="cron" placeholder="0 8 * * 1-5" class="input mono">
        </div>
      </div>
      <div>
        <label class="label block mb-1.5">Target JID</label>
        <input name="jid" class="input">
      </div>
      <div class="flex gap-2 pt-2">
        <button type="button" onclick="document.getElementById('editJobModal').classList.add('hidden')" class="btn btn-ghost flex-1">Cancel</button>
        <button type="submit" class="btn btn-primary flex-1"><i data-lucide="save" class="size-4"></i>Save</button>
      </div>
    </form>
  </div>
</div>

<script>
  function fmtUntil(ms) {
    if (ms < 0) {
      const abs = -ms;
      if (abs < 60_000) return 'overdue ' + Math.round(abs / 1000) + 's';
      if (abs < 3_600_000) return 'overdue ' + Math.round(abs / 60_000) + 'm';
      if (abs < 86_400_000) return 'overdue ' + Math.round(abs / 3_600_000) + 'h';
      return 'overdue ' + Math.round(abs / 86_400_000) + 'd';
    }
    if (ms < 60_000) return 'in ' + Math.round(ms / 1000) + 's';
    if (ms < 3_600_000) return 'in ' + Math.round(ms / 60_000) + 'm';
    if (ms < 86_400_000) {
      const h = Math.floor(ms / 3_600_000);
      const m = Math.round((ms - h * 3_600_000) / 60_000);
      return 'in ' + h + 'h' + (m ? ' ' + m + 'm' : '');
    }
    return 'in ' + Math.floor(ms / 86_400_000) + 'd';
  }
  function tickCountdowns() {
    const now = Date.now();
    document.querySelectorAll('.countdown').forEach((el) => {
      if (el.dataset.paused === '1') { el.textContent = 'paused'; return; }
      const ts = new Date(el.dataset.runat).getTime();
      const diff = ts - now;
      el.textContent = fmtUntil(diff);
      el.classList.remove('text-rose-400','text-amber-400','text-zinc-500');
      if (diff < 0 || diff < 600_000) el.classList.add('text-rose-400');
      else if (diff < 3_600_000) el.classList.add('text-amber-400');
    });
  }
  tickCountdowns();
  setInterval(tickCountdowns, 15_000);

  document.querySelectorAll('[data-edit-job]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const data = JSON.parse(btn.dataset.editJob);
      const form = document.getElementById('editJobForm');
      form.action = '/jobs/' + btn.dataset.jobId + '/edit';
      for (const k of Object.keys(data)) {
        const inp = form.querySelector('[name="' + k + '"]');
        if (inp) inp.value = data[k] == null ? '' : data[k];
      }
      document.getElementById('editJobModal').classList.remove('hidden');
    });
  });
</script>
`;
    res.send(LAYOUT(`Job · ${job.id}`, body, '/jobs'));
  });

  app.post('/jobs/:id/del', async (req, res) => {
    await scheduler.removeJob(req.params.id);
    res.redirect('/jobs');
  });

  app.post('/jobs/:id/fire', async (req, res) => {
    const ok = await scheduler.fireNow(req.params.id);
    if (!ok) return res.status(404).send('not found');
    res.redirect('/jobs');
  });

  app.post('/jobs/:id/pause', async (req, res) => {
    const cur = scheduler.listJobs().find((j) => j.id === req.params.id);
    if (!cur) return res.status(404).send('not found');
    await scheduler.setPaused(req.params.id, !cur.paused);
    res.redirect('/jobs');
  });

  app.post('/jobs/:id/edit', async (req, res) => {
    try {
      const { jid: rawJid, mode, text, at, every, cron } = req.body || {};
      const patch = {};
      if (text != null && text.trim()) patch.text = text;
      if (mode) patch.mode = mode;
      if (rawJid != null && rawJid.trim()) patch.jid = rawJid.trim();
      // Recurrence: every / cron / neither (one-shot). Empty string means clear.
      if (every && every.trim()) {
        parseDuration(every.trim());
        patch.recurring = { every: every.trim() };
      } else if (cron && cron.trim()) {
        patch.recurring = { cron: cron.trim() };
      } else if (every === '' && cron === '') {
        patch.recurring = null;
      }
      if (at && at.trim()) {
        patch.runAt = parseWhen(at.trim()).toISOString();
      }
      const updated = await scheduler.updateJob(req.params.id, patch);
      if (!updated) return res.status(404).send('not found');
      res.redirect('/jobs');
    } catch (err) {
      res.status(400).send(`error: ${esc(err.message)}`);
    }
  });

  app.post('/jobs/delete-many', async (req, res) => {
    const raw = req.body?.['job-check'];
    const ids = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (ids.length === 0) return res.redirect('/jobs');
    await scheduler.removeJobs(ids);
    res.redirect('/jobs');
  });

  // ─── Memory ────────────────────────────────────────────────────────────────
  app.get('/memory', async (req, res) => {
    const tab = req.query.tab || 'curated';
    const q = String(req.query.q || '').trim();

    const { sections, order } = await memoryMd.getSections();

    let dailyList = [];
    try {
      dailyList = (await fs.readdir('memory'))
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort()
        .reverse();
    } catch {}
    const which = req.query.day && dailyList.includes(req.query.day) ? req.query.day : dailyList[0];
    let daily = '';
    if (tab === 'daily' && which && !q) {
      daily = await fs.readFile(path.join('memory', which), 'utf-8').catch(() => '');
    }

    let searchResults = [];
    if (tab === 'daily' && q) {
      const needle = q.toLowerCase();
      for (const f of dailyList) {
        const text = await fs.readFile(path.join('memory', f), 'utf-8').catch(() => '');
        text.split('\n').forEach((line, idx) => {
          if (line.toLowerCase().includes(needle)) {
            searchResults.push({ file: f, lineNo: idx + 1, line: line.trim() });
          }
        });
        if (searchResults.length >= 200) break;
      }
    }

    const threadsOpen = await listOpenThreads({ status: 'open' }).catch(() => []);
    const threadsDone = await listOpenThreads({ status: 'done', limit: 20 }).catch(() => []);
    const state = await memoryModule.getState();

    const tabClass = (t) => t === tab
      ? 'px-4 py-2 text-sm font-medium rounded-lg bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
      : 'px-4 py-2 text-sm font-medium rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50';

    const sectionEditor = (title) => `
<section class="card p-4 mb-4">
  <form method="POST" action="/memory/section">
    <input type="hidden" name="title" value="${esc(title)}">
    <div class="flex items-center justify-between mb-2">
      <h2 class="text-sm label">${esc(title)}</h2>
      <button class="btn btn-primary text-xs"><i data-lucide="save" class="size-3.5"></i>Save</button>
    </div>
    <textarea name="content" class="mono input text-sm" style="min-height: 8rem;" spellcheck="false">${esc(sections.get(title) || '')}</textarea>
  </form>
</section>`;

    const threadCard = (t) => `
<section class="card p-4 ${t.status === 'done' ? 'opacity-60' : ''}">
  <div class="flex items-start gap-3">
    <div class="icon-tile ${t.status === 'done' ? 'icon-tile-zinc' : 'icon-tile-amber'} shrink-0">
      <i data-lucide="${t.status === 'done' ? 'check' : 'circle-dot'}" class="size-4"></i>
    </div>
    <div class="flex-1 min-w-0">
      <h3 class="font-medium text-sm">${esc(t.title)}</h3>
      ${t.body ? `<p class="text-xs text-zinc-500 mt-1 whitespace-pre-wrap">${esc(t.body)}</p>` : ''}
      <p class="text-[10px] text-zinc-600 mt-2">created ${esc(new Date(t.created_at).toLocaleString())}${t.resolved_at ? ` · resolved ${esc(new Date(t.resolved_at).toLocaleString())}` : ''}</p>
    </div>
    <div class="flex flex-col gap-1 shrink-0">
      ${t.status === 'open'
        ? `<form method="POST" action="/memory/threads/${t.id}/resolve"><button class="btn btn-ghost btn-icon" title="Mark done"><i data-lucide="check" class="size-3.5"></i></button></form>`
        : `<form method="POST" action="/memory/threads/${t.id}/reopen"><button class="btn btn-ghost btn-icon" title="Reopen"><i data-lucide="rotate-ccw" class="size-3.5"></i></button></form>`}
      <form method="POST" action="/memory/threads/${t.id}/delete" onsubmit="return confirm('Delete this thread?');"><button class="btn btn-danger btn-icon" title="Delete"><i data-lucide="trash-2" class="size-3.5"></i></button></form>
    </div>
  </div>
</section>`;

    const body = `
<div class="flex items-baseline justify-between mb-4 gap-3">
  <div>
    <h1 class="text-2xl md:text-3xl font-semibold tracking-tight">Memory</h1>
    <p class="text-sm text-zinc-500 mt-1">${threadsOpen.length} open thread${threadsOpen.length === 1 ? '' : 's'} · ${order.length} curated section${order.length === 1 ? '' : 's'} · ${dailyList.length} daily note${dailyList.length === 1 ? '' : 's'}</p>
  </div>
</div>

<div class="tab-row">
  <a href="/memory?tab=curated" class="${tabClass('curated')}"><i data-lucide="book-marked" class="size-4 inline mr-1.5"></i>Curated</a>
  <a href="/memory?tab=threads" class="${tabClass('threads')}"><i data-lucide="list-todo" class="size-4 inline mr-1.5"></i>Open threads${threadsOpen.length ? ` <span class="ml-1 text-xs bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded">${threadsOpen.length}</span>` : ''}</a>
  <a href="/memory?tab=daily" class="${tabClass('daily')}"><i data-lucide="calendar-days" class="size-4 inline mr-1.5"></i>Daily</a>
  <a href="/memory?tab=state" class="${tabClass('state')}"><i data-lucide="activity" class="size-4 inline mr-1.5"></i>State</a>
</div>

${tab === 'curated' ? (order.length === 0
  ? '<section class="card p-8 text-center"><p class="text-zinc-400">MEMORY.md is empty.</p></section>'
  : order.map(sectionEditor).join('')) : ''}

${tab === 'threads' ? `
<section class="card p-4 mb-4">
  <h2 class="text-sm label mb-3">Add new</h2>
  <form method="POST" action="/memory/threads" class="flex flex-col gap-2">
    <input name="title" required placeholder="What needs to resume?" class="input">
    <textarea name="body" placeholder="(optional) why paused, what's next" class="input" style="min-height: 4rem;"></textarea>
    <button class="btn btn-primary md:self-start"><i data-lucide="plus" class="size-4"></i>Add open thread</button>
  </form>
</section>
${threadsOpen.length === 0
  ? '<section class="card p-8 text-center"><i data-lucide="check-circle-2" class="size-10 text-emerald-700 mx-auto mb-3"></i><p class="text-zinc-400">No open threads. Inbox zero.</p></section>'
  : `<div class="space-y-2">${threadsOpen.map(threadCard).join('')}</div>`}
${threadsDone.length > 0 ? `
<details class="mt-6">
  <summary class="text-sm text-zinc-500 cursor-pointer hover:text-zinc-300">Recently resolved (${threadsDone.length})</summary>
  <div class="space-y-2 mt-2">${threadsDone.map(threadCard).join('')}</div>
</details>` : ''}
` : ''}

${tab === 'daily' ? `
<section class="card p-4 mb-4">
  <form method="GET" action="/memory" class="flex items-center gap-2 bg-zinc-900/60 rounded-lg px-3 border border-zinc-800">
    <input type="hidden" name="tab" value="daily">
    <i data-lucide="search" class="size-4 text-zinc-500"></i>
    <input type="text" name="q" value="${esc(q)}" placeholder="Search across all daily notes..." class="bg-transparent flex-1 py-2.5 outline-none text-zinc-100 text-sm">
    ${q ? '<a href="/memory?tab=daily" class="text-xs text-zinc-500 hover:text-zinc-300">clear</a>' : ''}
  </form>
</section>
${q ? `
<section class="card p-4">
  <h2 class="text-sm label mb-3">${searchResults.length} match${searchResults.length === 1 ? '' : 'es'} for "${esc(q)}"</h2>
  ${searchResults.length === 0
    ? '<p class="text-sm text-zinc-500">No results.</p>'
    : `<div class="space-y-1 mono text-xs">${searchResults.map((r) => `<div class="flex gap-3 py-1 border-b border-zinc-800/50 last:border-0"><a href="/memory?tab=daily&day=${esc(r.file)}" class="text-emerald-400 shrink-0">${esc(r.file.replace('.md', ''))}:${r.lineNo}</a><span class="text-zinc-300 break-all">${esc(r.line)}</span></div>`).join('')}</div>`}
</section>
` : (dailyList.length === 0
  ? '<section class="card p-8 text-center"><p class="text-zinc-400">No daily notes yet.</p></section>'
  : `<section class="card p-4">
  <form class="mb-3">
    <input type="hidden" name="tab" value="daily">
    <select name="day" onchange="this.form.submit()" class="input md:w-64">
      ${dailyList.map((d) => `<option value="${esc(d)}" ${d === which ? 'selected' : ''}>${esc(d.replace('.md', ''))}</option>`).join('')}
    </select>
  </form>
  <pre class="mono bg-zinc-900/60 rounded-md p-3 border border-zinc-800 text-xs h-96 overflow-y-auto whitespace-pre-wrap">${esc(daily) || '<span class="text-zinc-500">(empty)</span>'}</pre>
</section>`)}
` : ''}

${tab === 'state' ? `
<section class="card p-4 mb-4">
  <h2 class="text-sm label mb-3">Counters</h2>
  ${Object.keys(state.counters || {}).length === 0
    ? '<p class="text-sm text-zinc-500">No counters yet.</p>'
    : `<div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">${Object.entries(state.counters).map(([k, v]) => `<div class="flex items-center justify-between p-2.5 rounded-lg bg-zinc-900/60 border border-zinc-800"><span class="text-sm text-zinc-300 mono truncate">${esc(k)}</span><span class="font-medium text-emerald-300 ml-2 shrink-0">${esc(String(v))}</span></div>`).join('')}</div>`}
</section>
<section class="card p-4">
  <h2 class="text-sm label mb-3">Last checks</h2>
  ${Object.keys(state.lastChecks || {}).length === 0
    ? '<p class="text-sm text-zinc-500">No checks recorded.</p>'
    : `<div class="space-y-1">${Object.entries(state.lastChecks).map(([k, v]) => `<div class="flex items-center justify-between p-2 rounded-lg bg-zinc-900/60 border border-zinc-800 text-xs"><span class="mono text-zinc-300 truncate">${esc(k)}</span><span class="text-zinc-500 ml-2 shrink-0">${esc(String(v))}</span></div>`).join('')}</div>`}
</section>
` : ''}
`;
    res.send(LAYOUT('Memory', body, '/memory'));
  });

  app.post('/memory/section', async (req, res) => {
    const title = String(req.body?.title || '').trim();
    const content = String(req.body?.content || '');
    if (!title) { res.redirect('/memory?tab=curated'); return; }
    await memoryMd.setSectionBody(title, content);
    res.redirect('/memory?tab=curated');
  });

  app.post('/memory/threads', async (req, res) => {
    const title = String(req.body?.title || '').trim();
    const body = String(req.body?.body || '').trim();
    if (title) await addOpenThread(title, { body: body || null });
    res.redirect('/memory?tab=threads');
  });

  app.post('/memory/threads/:id/resolve', async (req, res) => {
    await resolveOpenThread(Number(req.params.id));
    res.redirect('/memory?tab=threads');
  });

  app.post('/memory/threads/:id/reopen', async (req, res) => {
    await reopenThread(Number(req.params.id));
    res.redirect('/memory?tab=threads');
  });

  app.post('/memory/threads/:id/delete', async (req, res) => {
    await deleteOpenThread(Number(req.params.id));
    res.redirect('/memory?tab=threads');
  });

  // Legacy: full MEMORY.md save. Kept for any external scripts that hit it.
  app.post('/memory/save', async (req, res) => {
    await fs.writeFile('MEMORY.md', req.body?.content ?? '');
    res.redirect('/memory');
  });

  // ─── Persona ───────────────────────────────────────────────────────────────
  //
  // Tabbed surface for the three persona layers + a sandbox/history:
  //   Soul / Rules / Tones / Overlays / Test / History
  //
  // See src/personas.js (storage), src/persona-meta.js (frontmatter + lint),
  // src/persona-history.js (snapshots), src/persona-test.js (preview + dry-run).

  function safeTonePathName(name) { return String(name || '').replace(/[^\w.-]/g, ''); }
  function decodeJidParam(raw) {
    const s = String(raw || '');
    return s.includes('@') ? s : s.replace(/_/g, ':');
  }

  const PERSONA_TABS = [
    ['soul',     'Soul',     'flame'],
    ['rules',    'Rules',    'shield'],
    ['tones',    'Tones',    'sparkles'],
    ['overlays', 'Overlays', 'users'],
    ['test',     'Test',     'flask-conical'],
    ['history',  'History',  'history'],
  ];

  function personaTabNav(active) {
    return `<div class="flex flex-wrap gap-1 mb-5 border-b border-zinc-800/60 -mx-1 px-1 overflow-x-auto">
      ${PERSONA_TABS.map(([key, label, icon]) => {
        const isActive = key === active;
        return `<a href="/persona?tab=${encodeURIComponent(key)}" class="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${isActive ? 'border-emerald-400 text-emerald-300' : 'border-transparent text-zinc-500 hover:text-zinc-200'}">
          <i data-lucide="${icon}" class="size-4"></i>${esc(label)}
        </a>`;
      }).join('')}
    </div>`;
  }

  function personaHeader({ saved = false, error = null, info = null } = {}) {
    return `
<div class="flex flex-wrap items-center justify-between mb-4 gap-3">
  <div>
    <h1 class="text-2xl md:text-3xl font-semibold tracking-tight">Persona</h1>
    <p class="text-sm text-zinc-500 mt-1">Edits hot-reload on the next message. Send <code class="mono text-emerald-400">/reset</code> to clear cached sessions if you change something major.</p>
  </div>
</div>
${saved ? '<div class="card p-3 mb-4 border-emerald-500/30 bg-emerald-500/5 text-sm text-emerald-300 flex items-center gap-2"><i data-lucide="check-circle-2" class="size-4"></i>Saved</div>' : ''}
${info ? `<div class="card p-3 mb-4 border-sky-500/30 bg-sky-500/5 text-sm text-sky-300 flex items-center gap-2"><i data-lucide="info" class="size-4"></i>${esc(info)}</div>` : ''}
${error ? `<div class="card p-3 mb-4 border-rose-500/30 bg-rose-500/5 text-sm text-rose-300 flex items-center gap-2"><i data-lucide="circle-alert" class="size-4"></i>${esc(error)}</div>` : ''}
`;
  }

  function lintBadges(warnings) {
    if (!warnings || warnings.length === 0) return '';
    return `<div class="card p-3 mb-3 border-amber-500/20 bg-amber-500/5">
      <div class="flex items-center gap-2 mb-1"><i data-lucide="lightbulb" class="size-4 text-amber-400"></i><span class="text-xs font-semibold text-amber-300">Lint</span></div>
      <ul class="text-xs space-y-1 text-zinc-300">
        ${warnings.map((w) => `<li class="flex gap-1.5"><span class="${w.level === 'error' ? 'text-rose-400' : w.level === 'warn' ? 'text-amber-400' : 'text-zinc-500'}">●</span> ${esc(w.msg)}</li>`).join('')}
      </ul>
    </div>`;
  }

  function relTimePersona(iso) {
    if (!iso) return '';
    const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function personaEditorPanel({ title, subtitle = '', raw, saveAction, hasName = false, name = '', deleteAction = null, rows = 22, sections = [], warnings = [], extraFields = '' }) {
    const tokens = personaMeta.estimateTokens(raw);
    return `
<section class="card p-5 mb-4">
  <form method="POST" action="${saveAction}" id="persona-edit-form" class="space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <div class="flex items-center gap-2 flex-1 min-w-0">
        <i data-lucide="file-edit" class="size-4 text-zinc-500"></i>
        <h2 class="font-semibold truncate">${esc(title)}</h2>
        ${subtitle ? `<span class="text-xs text-zinc-500 truncate">${esc(subtitle)}</span>` : ''}
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs text-zinc-500"><span id="persona-tok">${tokens.toLocaleString()}</span> tok · <span id="persona-chr">${raw.length.toLocaleString()}</span> chars</span>
        <button type="submit" class="btn btn-primary"><i data-lucide="save" class="size-4"></i>Save</button>
        ${deleteAction ? `<button type="button" class="btn btn-danger" onclick="if(confirm('Delete?')){document.getElementById('persona-delete-form').submit()}"><i data-lucide="trash-2" class="size-4"></i>Delete</button>` : ''}
      </div>
    </div>
    ${hasName ? `<div class="flex items-center gap-2">
      <label class="label">Name</label>
      <input class="input mono max-w-xs" name="rename" value="${esc(name)}" pattern="[\\w.\\-]+" required>
    </div>` : ''}
    ${extraFields}
    <textarea id="persona-editor" name="content" class="input mono" rows="${rows}" spellcheck="false">${esc(raw)}</textarea>
  </form>
  ${deleteAction ? `<form id="persona-delete-form" method="POST" action="${deleteAction}" class="hidden"></form>` : ''}
</section>

${lintBadges(warnings)}

${sections.length > 0 ? `<section class="card p-4 mb-4">
  <div class="label mb-2">Sections (## headings)</div>
  <div class="flex flex-wrap gap-1.5">
    ${sections.map((s) => `<span class="text-xs px-2 py-1 rounded-full bg-zinc-800/60 text-zinc-400 border border-zinc-700/60">${esc(s.title)}</span>`).join('')}
  </div>
</section>` : ''}

<script>
  (function() {
    const ta = document.getElementById('persona-editor');
    const tok = document.getElementById('persona-tok');
    const chr = document.getElementById('persona-chr');
    if (ta) {
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const s = ta.selectionStart, en = ta.selectionEnd;
          ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(en);
          ta.selectionStart = ta.selectionEnd = s + 2;
        }
      });
      ta.addEventListener('input', () => {
        if (chr) chr.textContent = ta.value.length.toLocaleString();
        if (tok) tok.textContent = Math.ceil(ta.value.length / 4).toLocaleString();
      });
    }
    document.addEventListener('keydown', (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); document.getElementById('persona-edit-form')?.requestSubmit(); }
      else if (e.key === 'Escape' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        window.location.href = '/persona';
      }
    });
  })();
</script>
`;
  }

  // ───────────────────────────────────────────── GET /persona (tabs)
  app.get('/persona', async (req, res) => {
    const tab = (req.query.tab || 'soul').toString();
    const saved = !!req.query.saved;
    const error = req.query.error ? String(req.query.error) : null;
    const info = req.query.info ? String(req.query.info) : null;
    const validTab = PERSONA_TABS.some(([k]) => k === tab) ? tab : 'soul';
    let panel = '';

    if (validTab === 'soul') {
      const raw = await loadSoul();
      const variants = await listSoulVariants();
      const ab = await readSoulAbState();
      const sections = personaMeta.extractSections(raw);
      const warnings = personaMeta.lint(raw);
      const variantSwitcher = variants.length > 1 ? `
<section class="card p-4 mb-4">
  <div class="flex items-center gap-2 mb-3"><i data-lucide="shuffle" class="size-4 text-violet-400"></i><h3 class="font-semibold text-sm">A/B variant</h3></div>
  <form method="POST" action="/persona/soul/variant" class="flex flex-wrap items-center gap-2">
    <select name="label" class="input max-w-xs">
      ${variants.map((v) => `<option value="${esc(v.label)}" ${ab.active === v.label ? 'selected' : ''}>${esc(v.label)} ${ab.active === v.label ? '(active)' : ''}</option>`).join('')}
    </select>
    <button class="btn btn-ghost"><i data-lucide="check" class="size-4"></i>Activate</button>
    <span class="text-xs text-zinc-500">drop a <code class="mono">soul.&lt;label&gt;.md</code> next to <code class="mono">soul.md</code> to add variants</span>
  </form>
</section>` : '';
      panel = variantSwitcher + personaEditorPanel({
        title: 'soul.md',
        subtitle: 'who Encrypto AI is',
        raw,
        saveAction: '/persona/soul',
        rows: 24,
        sections,
        warnings,
      });
    } else if (validTab === 'rules') {
      const raw = await loadRules();
      const sections = personaMeta.extractSections(raw);
      const warnings = personaMeta.lint(raw);
      panel = personaEditorPanel({
        title: 'rules.md',
        subtitle: 'hard rules + scheduling protocol',
        raw,
        saveAction: '/persona/rules',
        rows: 24,
        sections,
        warnings,
      });
    } else if (validTab === 'tones') {
      const tones = await listTones();
      const templates = Object.keys(TONE_TEMPLATES);
      panel = `
<div class="flex flex-wrap items-center justify-between mb-4 gap-2">
  <p class="text-sm text-zinc-500">${tones.length} tone mode${tones.length === 1 ? '' : 's'} in <code class="mono">personas/</code>. Playbooks pick these as overrides.</p>
  <form method="GET" action="/persona/tones/new" class="flex items-center gap-2">
    <select name="template" class="input">${templates.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select>
    <button class="btn btn-primary"><i data-lucide="plus" class="size-4"></i>New tone</button>
  </form>
</div>
${tones.length === 0
  ? `<section class="card p-10 text-center"><i data-lucide="sparkles" class="size-10 text-zinc-600 mx-auto mb-3"></i><p class="text-zinc-300 font-medium">No tone modes yet.</p><p class="text-sm text-zinc-500 mt-1">Pick a template above and click "New tone" to start.</p></section>`
  : `<section class="grid gap-3 md:grid-cols-2">${tones.map((t) => `
      <div class="card p-5 flex flex-col gap-3">
        <div class="flex items-start gap-3">
          <div class="icon-tile icon-tile-violet"><i data-lucide="sparkles" class="size-4"></i></div>
          <div class="flex-1 min-w-0">
            <div class="font-medium truncate">${esc(t.name)}</div>
            <div class="text-xs text-zinc-400 mt-0.5 line-clamp-2">${esc(t.description || t.preview || '(no description)')}</div>
            <div class="flex items-center gap-2 mt-1 text-[10px] text-zinc-500"><span>${(t.bytes / 1024).toFixed(1)}kb</span>${t.updatedAt ? `<span>· edited ${esc(relTimePersona(t.updatedAt))}</span>` : ''}</div>
            ${t.tags.length > 0 ? `<div class="flex flex-wrap gap-1 mt-1.5">${t.tags.slice(0, 4).map((tg) => `<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-800/60 text-zinc-400 border border-zinc-700/60">#${esc(tg)}</span>`).join('')}</div>` : ''}
          </div>
        </div>
        <div class="flex items-center gap-2 mt-auto pt-1">
          <a href="/persona/tones/${esc(t.name)}" class="btn btn-ghost flex-1"><i data-lucide="file-edit" class="size-4"></i>Edit</a>
        </div>
      </div>
    `).join('')}</section>`}
`;
    } else if (validTab === 'overlays') {
      const [overlays, contactList] = await Promise.all([listOverlays(), listContacts().catch(() => [])]);
      const named = await Promise.all(overlays.map(async (o) => ({ ...o, label: await displayName(o.jid).catch(() => null) || o.jid })));
      const contactOpts = contactList.map((c) => {
        const jid = c.phoneJid || (c.phone ? c.phone + '@s.whatsapp.net' : '');
        if (!jid) return '';
        const label = c.label || formatPhoneForDisplay(c.phone);
        return `<option value="${esc(jid)}">${esc(label)}</option>`;
      }).filter(Boolean).join('');
      panel = `
<div class="flex flex-wrap items-center justify-between mb-4 gap-2">
  <p class="text-sm text-zinc-500">${named.length} overlay${named.length === 1 ? '' : 's'} appended only when that contact messages.</p>
  <form id="overlay-pick" class="flex items-center gap-2" onsubmit="event.preventDefault();const v=this.jid.value;if(v)window.location.href='/persona/overlays/'+encodeURIComponent(v);">
    <select name="jid" class="input"><option value="">Pick contact…</option>${contactOpts}</select>
    <button class="btn btn-primary"><i data-lucide="plus" class="size-4"></i>New overlay</button>
  </form>
</div>
${named.length === 0
  ? `<section class="card p-10 text-center"><i data-lucide="users" class="size-10 text-zinc-600 mx-auto mb-3"></i><p class="text-zinc-300 font-medium">No per-contact overlays yet.</p><p class="text-sm text-zinc-500 mt-1">Pick a contact above to add a tone overlay just for them.</p></section>`
  : `<section class="grid gap-3 md:grid-cols-2">${named.map((o) => `
      <div class="card p-5 flex flex-col gap-3">
        <div class="flex items-start gap-3">
          <div class="icon-tile icon-tile-sky"><i data-lucide="user" class="size-4"></i></div>
          <div class="flex-1 min-w-0">
            <div class="font-medium truncate">${esc(o.label)}</div>
            <div class="text-[11px] text-zinc-500 mono truncate">${esc(o.jid)}</div>
            <div class="text-xs text-zinc-400 mt-1 line-clamp-2">${esc(o.preview || '(empty)')}</div>
            <div class="flex items-center gap-2 mt-1 text-[10px] text-zinc-500"><span>${(o.bytes / 1024).toFixed(1)}kb</span>${o.updatedAt ? `<span>· edited ${esc(relTimePersona(o.updatedAt))}</span>` : ''}</div>
          </div>
        </div>
        <div class="flex items-center gap-2 mt-auto pt-1">
          <a href="/persona/overlays/${esc(o.jid)}" class="btn btn-ghost flex-1"><i data-lucide="file-edit" class="size-4"></i>Edit</a>
        </div>
      </div>`).join('')}</section>`}
`;
    } else if (validTab === 'test') {
      const tones = await listTones();
      const overlays = await listOverlays();
      const overlayOpts = await Promise.all(overlays.map(async (o) => {
        const label = await displayName(o.jid).catch(() => null) || o.jid;
        return `<option value="${esc(o.jid)}">${esc(label)}</option>`;
      }));
      const toneOpts = tones.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('');
      panel = `
<section class="card p-5 mb-4">
  <div class="flex items-center gap-2 mb-3"><i data-lucide="flask-conical" class="size-4 text-emerald-400"></i><h2 class="font-semibold">Sandbox</h2></div>
  <p class="text-sm text-zinc-500 mb-4">Preview the assembled system prompt and (optionally) send a sample message to Claude without touching WhatsApp.</p>
  <div class="grid md:grid-cols-2 gap-3 mb-4">
    <div>
      <label class="label mb-1 block">Tone</label>
      <select id="test-tone" class="input"><option value="">— none —</option>${toneOpts}</select>
    </div>
    <div>
      <label class="label mb-1 block">Per-contact overlay</label>
      <select id="test-overlay" class="input"><option value="">— none —</option>${overlayOpts.join('')}</select>
    </div>
  </div>
  <div class="mb-3">
    <label class="label mb-1 block">Sample incoming message</label>
    <textarea id="test-message" class="input mono" rows="4" placeholder="hey, what's up?"></textarea>
  </div>
  <div class="flex flex-wrap items-center gap-2">
    <button type="button" id="test-preview-btn" class="btn btn-ghost"><i data-lucide="eye" class="size-4"></i>Preview prompt</button>
    <button type="button" id="test-run-btn" class="btn btn-primary"><i data-lucide="play" class="size-4"></i>Dry-run (calls Claude)</button>
    <span id="test-status" class="text-xs text-zinc-500"></span>
  </div>
</section>

<section class="card p-5 mb-4" id="test-preview-panel" style="display:none">
  <div class="flex items-center justify-between mb-2">
    <h3 class="font-semibold text-sm">System prompt preview</h3>
    <span class="text-xs text-zinc-500" id="test-preview-meta"></span>
  </div>
  <div id="test-preview-sections" class="space-y-2"></div>
  <details class="mt-3">
    <summary class="text-xs text-zinc-500 cursor-pointer">Show full combined prompt</summary>
    <pre id="test-preview-full" class="text-xs text-zinc-300 whitespace-pre-wrap mono bg-zinc-950/60 rounded-md p-3 border border-zinc-800/60 mt-2 max-h-96 overflow-y-auto"></pre>
  </details>
</section>

<section class="card p-5" id="test-reply-panel" style="display:none">
  <div class="flex items-center justify-between mb-2">
    <h3 class="font-semibold text-sm">Bot reply</h3>
    <span class="text-xs text-zinc-500" id="test-reply-meta"></span>
  </div>
  <pre id="test-reply-output" class="text-sm text-zinc-200 whitespace-pre-wrap bg-zinc-950/60 rounded-md p-3 border border-zinc-800/60 max-h-96 overflow-y-auto"></pre>
</section>

<script>
  (function() {
    const previewBtn = document.getElementById('test-preview-btn');
    const runBtn = document.getElementById('test-run-btn');
    const status = document.getElementById('test-status');
    const tone = document.getElementById('test-tone');
    const overlay = document.getElementById('test-overlay');
    const msg = document.getElementById('test-message');
    const pPanel = document.getElementById('test-preview-panel');
    const pMeta = document.getElementById('test-preview-meta');
    const pSections = document.getElementById('test-preview-sections');
    const pFull = document.getElementById('test-preview-full');
    const rPanel = document.getElementById('test-reply-panel');
    const rMeta = document.getElementById('test-reply-meta');
    const rOut = document.getElementById('test-reply-output');

    previewBtn?.addEventListener('click', async () => {
      status.textContent = 'building…';
      try {
        const q = new URLSearchParams();
        if (tone.value) q.set('tone', tone.value);
        if (overlay.value) q.set('jid', overlay.value);
        const r = await fetch('/persona/preview?' + q.toString());
        const j = await r.json();
        pMeta.textContent = '~' + j.estimatedTokens.toLocaleString() + ' tokens · ' + j.sections.length + ' sections';
        pSections.innerHTML = j.sections.map((s) => '<div class="flex items-center justify-between text-xs px-2 py-1 rounded bg-zinc-900/40 border border-zinc-800/60"><span class="mono text-zinc-400">' + s.label + '</span><span class="text-zinc-500">' + s.body.length.toLocaleString() + ' chars</span></div>').join('');
        pFull.textContent = j.combined;
        pPanel.style.display = '';
        if (window.lucide) window.lucide.createIcons();
        status.textContent = '';
      } catch (err) { status.textContent = 'preview failed: ' + err.message; }
    });

    runBtn?.addEventListener('click', async () => {
      if (!msg.value.trim()) { status.textContent = 'enter a message first'; return; }
      status.textContent = 'asking Claude…';
      runBtn.disabled = true;
      try {
        const r = await fetch('/persona/test', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ tone: tone.value || null, jid: overlay.value || null, message: msg.value }) });
        const j = await r.json();
        if (!j.ok) { rPanel.style.display = ''; rOut.textContent = '⚠ ' + (j.error || 'failed'); rMeta.textContent = ''; }
        else { rPanel.style.display = ''; rOut.textContent = j.text || '(no reply)'; rMeta.textContent = j.usage ? ((j.usage.input_tokens||0) + ' in / ' + (j.usage.output_tokens||0) + ' out') : ''; }
        status.textContent = '';
      } catch (err) { status.textContent = 'dry-run failed: ' + err.message; }
      finally { runBtn.disabled = false; }
    });
  })();
</script>
`;
    } else if (validTab === 'history') {
      const items = await personaHistory.list({ limit: 100 });
      panel = items.length === 0
        ? `<section class="card p-10 text-center"><i data-lucide="history" class="size-10 text-zinc-600 mx-auto mb-3"></i><p class="text-zinc-300 font-medium">No saves yet.</p><p class="text-sm text-zinc-500 mt-1">Every save (soul, rules, tones, overlays) gets snapshotted here for rollback.</p></section>`
        : `<section class="card overflow-hidden"><table class="w-full text-sm">
            <thead class="text-xs text-zinc-500 border-b border-zinc-800/60">
              <tr><th class="text-left p-3">When</th><th class="text-left p-3">Kind</th><th class="text-left p-3">Target</th><th class="text-right p-3">Bytes</th><th class="text-left p-3">Preview</th><th class="text-right p-3"></th></tr>
            </thead>
            <tbody>
              ${items.map((h) => `<tr class="border-b border-zinc-900/60 align-top">
                <td class="p-3 text-xs text-zinc-400 whitespace-nowrap">${esc(relTimePersona(h.savedAt))}</td>
                <td class="p-3 text-xs"><span class="px-1.5 py-0.5 rounded bg-zinc-800/60 text-zinc-300">${esc(h.kind)}</span></td>
                <td class="p-3 text-xs mono text-zinc-300 truncate max-w-xs">${esc(h.target)}</td>
                <td class="p-3 text-right text-xs text-zinc-400 mono">${h.bytes.toLocaleString()}</td>
                <td class="p-3 text-xs text-zinc-400 max-w-md"><pre class="whitespace-pre-wrap mono text-[11px] line-clamp-2">${esc(h.snippet)}</pre></td>
                <td class="p-3 text-right"><form method="POST" action="/persona/history/${esc(h.id)}/restore" onsubmit="return confirm('Restore this snapshot? It will overwrite the current ' + ${JSON.stringify(h.kind)} + '.');"><button class="btn btn-ghost btn-icon" title="Restore"><i data-lucide="rotate-ccw" class="size-4"></i></button></form></td>
              </tr>`).join('')}
            </tbody>
          </table></section>`;
    }

    const body = personaHeader({ saved, error, info }) + personaTabNav(validTab) + panel;
    res.send(LAYOUT('Persona', body, '/persona'));
  });

  // ───────────────────────────────────────────── soul / rules
  app.post('/persona/soul', async (req, res) => {
    const body = req.body?.content ?? '';
    await personaHistory.snapshot({ kind: 'soul', target: 'soul.md', body }).catch(() => {});
    await saveSoul(body);
    res.redirect('/persona?tab=soul&saved=1');
  });

  app.post('/persona/rules', async (req, res) => {
    const body = req.body?.content ?? '';
    await personaHistory.snapshot({ kind: 'rules', target: 'rules.md', body }).catch(() => {});
    await saveRules(body);
    res.redirect('/persona?tab=rules&saved=1');
  });

  app.post('/persona/soul/variant', async (req, res) => {
    const label = (req.body?.label || '').toString().trim() || 'live';
    try {
      await setSoulAbActive(label);
      res.redirect('/persona?tab=soul&info=' + encodeURIComponent(`Activated "${label}" variant`));
    } catch (err) {
      res.redirect('/persona?tab=soul&error=' + encodeURIComponent(err.message));
    }
  });

  // ───────────────────────────────────────────── tones
  app.get('/persona/tones/new', async (req, res) => {
    const template = (req.query.template || 'blank').toString();
    const raw = TONE_TEMPLATES[template] != null ? TONE_TEMPLATES[template] : '';
    const sections = personaMeta.extractSections(raw);
    const warnings = personaMeta.lint(raw);
    const body = personaHeader() + personaTabNav('tones') + `
<div class="flex items-center gap-2 mb-4">
  <a href="/persona?tab=tones" class="btn btn-ghost"><i data-lucide="arrow-left" class="size-4"></i>Back</a>
  <h2 class="text-xl font-semibold tracking-tight">New tone <span class="text-zinc-500 font-normal">(from <code class="mono">${esc(template)}</code>)</span></h2>
</div>
` + personaEditorPanel({
      title: 'new tone',
      subtitle: 'personas/<name>.md',
      raw,
      saveAction: '/persona/tones/__new__/save',
      hasName: true,
      name: '',
      sections,
      warnings,
      rows: 18,
    });
    res.send(LAYOUT('New tone', body, '/persona'));
  });

  app.get('/persona/tones/:name', async (req, res) => {
    const name = safeTonePathName(req.params.name);
    const full = await loadToneFull(name);
    if (!full) return res.redirect('/persona?tab=tones&error=' + encodeURIComponent(`tone "${name}" not found`));
    const sections = personaMeta.extractSections(full.raw);
    const warnings = personaMeta.lint(full.raw);
    const body = personaHeader({ saved: !!req.query.saved, error: req.query.error ? String(req.query.error) : null }) + personaTabNav('tones') + `
<div class="flex items-center gap-2 mb-4">
  <a href="/persona?tab=tones" class="btn btn-ghost"><i data-lucide="arrow-left" class="size-4"></i>Back</a>
  <h2 class="text-xl font-semibold tracking-tight">${esc(name)}</h2>
</div>
` + personaEditorPanel({
      title: `personas/${name}.md`,
      subtitle: full.description || 'tone mode',
      raw: full.raw,
      saveAction: `/persona/tones/${encodeURIComponent(name)}/save`,
      hasName: true,
      name,
      deleteAction: `/persona/tones/${encodeURIComponent(name)}/delete`,
      sections,
      warnings,
      rows: 18,
    });
    res.send(LAYOUT(`tone · ${name}`, body, '/persona'));
  });

  app.post('/persona/tones/:name/save', async (req, res) => {
    const requested = req.body?.rename ? safeTonePathName(req.body.rename) : safeTonePathName(req.params.name);
    const original = safeTonePathName(req.params.name);
    const raw = (req.body?.content || '').toString();
    if (!requested) return res.redirect('/persona?tab=tones&error=' + encodeURIComponent('invalid name'));
    await personaHistory.snapshot({ kind: 'tone', target: requested, body: raw }).catch(() => {});
    const result = await saveTone(requested, raw);
    if (!result.ok) return res.redirect(`/persona/tones/${encodeURIComponent(original || requested)}?error=` + encodeURIComponent(result.error));
    if (original && original !== requested && original !== '__new__') {
      await deleteTone(original).catch(() => {});
    }
    res.redirect(`/persona/tones/${encodeURIComponent(requested)}?saved=1`);
  });

  app.post('/persona/tones/:name/delete', async (req, res) => {
    const name = safeTonePathName(req.params.name);
    if (name) await deleteTone(name);
    res.redirect('/persona?tab=tones&info=' + encodeURIComponent(`deleted "${name}"`));
  });

  // ───────────────────────────────────────────── overlays
  app.get('/persona/overlays/:jid', async (req, res) => {
    const jid = decodeJidParam(req.params.jid);
    const full = await loadOverlayFull(jid);
    const raw = full?.raw || '';
    const sections = personaMeta.extractSections(raw);
    const warnings = personaMeta.lint(raw);
    const label = (await displayName(jid).catch(() => null)) || jid;
    const body = personaHeader({ saved: !!req.query.saved, error: req.query.error ? String(req.query.error) : null }) + personaTabNav('overlays') + `
<div class="flex items-center gap-2 mb-4">
  <a href="/persona?tab=overlays" class="btn btn-ghost"><i data-lucide="arrow-left" class="size-4"></i>Back</a>
  <h2 class="text-xl font-semibold tracking-tight">${esc(label)}</h2>
  <span class="text-xs text-zinc-500 mono">${esc(jid)}</span>
</div>
` + personaEditorPanel({
      title: `overlay for ${label}`,
      subtitle: `data/personas/${jid.replace(/[^\w@.-]/g, '_')}.md`,
      raw,
      saveAction: `/persona/overlays/${encodeURIComponent(jid)}/save`,
      deleteAction: full ? `/persona/overlays/${encodeURIComponent(jid)}/delete` : null,
      sections,
      warnings,
      rows: 16,
    });
    res.send(LAYOUT(`overlay · ${label}`, body, '/persona'));
  });

  app.post('/persona/overlays/:jid/save', async (req, res) => {
    const jid = decodeJidParam(req.params.jid);
    const raw = (req.body?.content || '').toString();
    if (!jid) return res.redirect('/persona?tab=overlays&error=' + encodeURIComponent('invalid jid'));
    await personaHistory.snapshot({ kind: 'overlay', target: jid, body: raw }).catch(() => {});
    try { await savePersona(jid, raw); }
    catch (err) { return res.redirect(`/persona/overlays/${encodeURIComponent(jid)}?error=` + encodeURIComponent(err.message)); }
    res.redirect(`/persona/overlays/${encodeURIComponent(jid)}?saved=1`);
  });

  app.post('/persona/overlays/:jid/delete', async (req, res) => {
    const jid = decodeJidParam(req.params.jid);
    if (jid) await deletePersona(jid);
    res.redirect('/persona?tab=overlays&info=' + encodeURIComponent(`removed overlay for ${jid}`));
  });

  // ───────────────────────────────────────────── test / preview
  app.get('/persona/preview', async (req, res) => {
    const tone = (req.query.tone || '').toString() || null;
    const jid = (req.query.jid || '').toString() || null;
    try {
      const preview = await buildPreviewPrompt({ jid, tone, includeJournal: false });
      res.json(preview);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/persona/test', async (req, res) => {
    const { tone = null, jid = null, message = '' } = req.body || {};
    if (!message) return res.status(400).json({ ok: false, error: 'message required' });
    try {
      const r = await personaDryRun({ tone, jid, message: String(message) });
      res.json(r);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ───────────────────────────────────────────── history rollback
  app.post('/persona/history/:id/restore', async (req, res) => {
    const id = String(req.params.id || '').replace(/[^\w-]/g, '');
    const row = await personaHistory.getById(id);
    if (!row) return res.redirect('/persona?tab=history&error=' + encodeURIComponent('snapshot not found'));
    try {
      if (row.kind === 'soul') await saveSoul(row.body);
      else if (row.kind === 'rules') await saveRules(row.body);
      else if (row.kind === 'tone') {
        const r = await saveTone(row.target, row.body);
        if (!r.ok) throw new Error(r.error);
      } else if (row.kind === 'overlay') {
        await savePersona(row.target, row.body);
      } else {
        throw new Error(`unknown kind: ${row.kind}`);
      }
    } catch (err) {
      return res.redirect('/persona?tab=history&error=' + encodeURIComponent(err.message));
    }
    res.redirect('/persona?tab=history&info=' + encodeURIComponent(`restored ${row.kind}:${row.target}`));
  });

  // ─── People (combined Chats + Contacts) ─────────────────────────────────────
  app.get('/people', async (req, res) => {
    const tab = req.query.tab || 'chats';
    const contacts = await listContacts();
    const allowed = listAllowed();
    const trackedJids = new Set(contacts.flatMap((c) => [c.phoneJid, c.lid].filter(Boolean)));
    const orphans = allowed.filter((j) => !trackedJids.has(j));

    // Get chat list from DB (was: scan data/chats/*.jsonl)
    // Filter out owner JIDs from the chat list (privacy)
    const owners = new Set(ownerJids());
    let chatRows = [];
    try { chatRows = await getChatList(); } catch (err) { console.error('[webui] /people getChatList failed:', err.message); }
    const filteredChatRows = chatRows.filter((r) => !owners.has(r.jid));
    const chatList = await Promise.all(filteredChatRows.map(async (r) => {
      const jid = r.jid;
      const name = await displayName(jid).catch(() => null);
      const lastTime = r.last_time instanceof Date ? r.last_time.toISOString() : r.last_time || null;
      return {
        jid,
        name,
        lastMsg: (r.last_msg || '').slice(0, 60),
        lastTime,
        msgCount: r.msg_count,
        file: jid.replace(/[^\w@.-]/g, '_'),
      };
    }));

    const chatCard = (c) => {
      const initial = (c.name || c.jid).charAt(0).toUpperCase();
      const timeAgo = c.lastTime ? c.lastTime.slice(11, 16) : '';
      const searchText = (c.name || '') + ' ' + c.jid + ' ' + (c.lastMsg || '');
      return `<a href="/chats/${esc(c.file)}" class="people-item flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-zinc-900/60 transition-colors border-b border-zinc-800/50 last:border-0" data-search="${esc(searchText.toLowerCase())}">
        <div class="h-10 w-10 rounded-full bg-gradient-to-br from-emerald-500/20 to-emerald-700/20 flex items-center justify-center font-medium text-emerald-300 text-sm shrink-0">
          ${esc(initial)}
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-baseline justify-between gap-2">
            <span class="font-medium text-sm truncate">${esc(c.name || c.jid)}</span>
            ${timeAgo ? `<span class="text-[10px] text-zinc-500 shrink-0">${esc(timeAgo)}</span>` : ''}
          </div>
          ${c.lastMsg ? `<div class="text-xs text-zinc-500 truncate mt-0.5">${esc(c.lastMsg)}</div>` : ''}
        </div>
      </a>`;
    };

    const contactCard = (c) => {
      const name = c.label || c.phoneJid?.split('@')[0] || c.phone;
      const pretty = formatPhoneForDisplay(c.phone);
      const lidHint = c.lid ? '<span class="text-emerald-400 text-[10px]">@lid</span>' : '<span class="text-amber-400 text-[10px]">pending</span>';
      const jid = c.lid || c.phoneJid || '';
      const searchText = name + ' ' + c.phone + ' ' + (c.phoneJid || '');
      return `<div class="people-item flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-zinc-900/60 transition-colors border-b border-zinc-800/50 last:border-0" data-search="${esc(searchText.toLowerCase())}">
        <div class="h-10 w-10 rounded-full bg-gradient-to-br from-sky-500/20 to-sky-700/20 flex items-center justify-center font-medium text-sky-300 text-sm shrink-0">
          ${esc((name || '?').charAt(0).toUpperCase())}
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="font-medium text-sm truncate">${esc(name)}</span>
            ${lidHint}
          </div>
          <div class="text-xs text-zinc-500">${esc(pretty)}</div>
        </div>
        <div class="flex items-center gap-1">
          <button type="button" onclick="openSendModal('${esc(jid)}', '${esc(name)}')" class="btn btn-ghost btn-icon" title="Send">
            <i data-lucide="send" class="size-4"></i>
          </button>
          <a href="/chats/${esc((c.phoneJid || '').replace(/:/g, '_'))}" class="btn btn-ghost btn-icon" title="Chat">
            <i data-lucide="messages-square" class="size-4"></i>
          </a>
          <form method="POST" action="/people/del" onsubmit="return confirm('Remove ${esc(name)}?');" class="inline">
            <input type="hidden" name="phone" value="${esc(c.phone)}">
            <button class="btn btn-danger btn-icon" title="Remove"><i data-lucide="trash-2" class="size-4"></i></button>
          </form>
        </div>
      </div>`;
    };

    const tabClass = (t) => t === tab
      ? 'px-4 py-2 text-sm font-medium rounded-lg bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
      : 'px-4 py-2 text-sm font-medium rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50';

    const body = `
<div class="flex flex-wrap items-center justify-between mb-4 gap-3">
  <div>
    <h1 class="text-2xl md:text-3xl font-semibold tracking-tight">People</h1>
    <p class="text-sm text-zinc-500 mt-1">${chatList.length} chats, ${contacts.length} contacts</p>
  </div>
  <button onclick="document.getElementById('addModal').classList.remove('hidden')" class="btn btn-primary">
    <i data-lucide="user-plus" class="size-4"></i>Add
  </button>
</div>

<div class="mb-4">
  <div class="flex items-center gap-2 bg-zinc-900/60 rounded-lg px-3 border border-zinc-800">
    <i data-lucide="search" class="size-4 text-zinc-500"></i>
    <input type="text" id="peopleSearch" placeholder="Search chats and contacts..." class="bg-transparent flex-1 py-2.5 outline-none text-zinc-100 text-sm" oninput="filterPeople(this.value)">
  </div>
</div>

<div class="tab-row">
  <a href="/people?tab=chats" class="${tabClass('chats')}"><i data-lucide="messages-square" class="size-4 inline mr-1.5"></i>Chats</a>
  <a href="/people?tab=contacts" class="${tabClass('contacts')}"><i data-lucide="users" class="size-4 inline mr-1.5"></i>Contacts</a>
</div>

${tab === 'chats' ? `
${chatList.length === 0
  ? '<section class="card p-8 text-center"><i data-lucide="messages-square" class="size-10 text-zinc-600 mx-auto mb-3"></i><p class="text-zinc-400">No chats yet.</p></section>'
  : `<div class="space-y-0" id="peopleList">${chatList.map(chatCard).join('')}</div>`}
` : `
${contacts.length === 0
  ? '<section class="card p-8 text-center"><i data-lucide="users" class="size-10 text-zinc-600 mx-auto mb-3"></i><p class="text-zinc-400">No contacts yet.</p><p class="text-sm text-zinc-500 mt-1">Click "Add" to get started.</p></section>'
  : `<div class="space-y-0" id="peopleList">${contacts.map(contactCard).join('')}</div>`}

${orphans.length > 0 ? `
<section class="card p-5 mt-6">
  <h2 class="text-sm label mb-3">Legacy JIDs</h2>
  <div class="space-y-2">${orphans.map((j) => `<div class="flex items-center gap-2 p-3 rounded-lg bg-zinc-900/60 border border-zinc-800"><code class="text-emerald-400 flex-1 break-all text-xs mono">${esc(j)}</code><form method="POST" action="/people/del-jid"><input type="hidden" name="jid" value="${esc(j)}"><button class="btn btn-danger btn-icon"><i data-lucide="trash-2" class="size-4"></i></button></form></div>`).join('')}</div>
</section>` : ''}
`}

<!-- Add Contact Modal -->
<div id="addModal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onclick="if(event.target===this)this.classList.add('hidden')">
  <div class="card p-6 w-full max-w-md" onclick="event.stopPropagation()">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-lg font-semibold">Add contact</h2>
      <button onclick="document.getElementById('addModal').classList.add('hidden')" class="btn btn-icon btn-ghost"><i data-lucide="x" class="size-4"></i></button>
    </div>
    <form method="POST" action="/people" class="space-y-4">
      <div>
        <label class="label block mb-1.5">Name</label>
        <input name="label" placeholder="e.g. Wife, Mom, Boss" class="input" autocomplete="off">
      </div>
      <div>
        <label class="label block mb-1.5">Phone number</label>
        <input name="phone" placeholder="+27 67 123 4567" class="input" inputmode="tel" required>
        <p class="text-[11px] text-zinc-500 mt-1.5">Include country code. WhatsApp ID resolved automatically.</p>
      </div>
      <div class="flex gap-2 pt-2">
        <button type="button" onclick="document.getElementById('addModal').classList.add('hidden')" class="btn btn-ghost flex-1">Cancel</button>
        <button type="submit" class="btn btn-primary flex-1"><i data-lucide="user-plus" class="size-4"></i>Add</button>
      </div>
    </form>
  </div>
</div>

<!-- Send Message Modal -->
<div id="sendModal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onclick="if(event.target===this)this.classList.add('hidden')">
  <div class="card p-6 w-full max-w-md" onclick="event.stopPropagation()">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-lg font-semibold">Send message to <span id="sendModalName"></span></h2>
      <button onclick="document.getElementById('sendModal').classList.add('hidden')" class="btn btn-icon btn-ghost"><i data-lucide="x" class="size-4"></i></button>
    </div>
    <form method="POST" action="/api/send" class="space-y-4" id="sendForm">
      <input type="hidden" name="jid" id="sendModalJid">
      <div>
        <label class="label block mb-1.5">Message</label>
        <textarea name="text" rows="4" class="input" placeholder="Type your message..." required id="sendModalText"></textarea>
      </div>
      <div class="flex gap-2 pt-2">
        <button type="button" onclick="document.getElementById('sendModal').classList.add('hidden')" class="btn btn-ghost flex-1">Cancel</button>
        <button type="submit" class="btn btn-primary flex-1"><i data-lucide="send" class="size-4"></i>Send</button>
      </div>
    </form>
  </div>
</div>

<script>
function openSendModal(jid, name) {
  document.getElementById('sendModalJid').value = jid;
  document.getElementById('sendModalName').textContent = name;
  document.getElementById('sendModalText').value = '';
  document.getElementById('sendModal').classList.remove('hidden');
  document.getElementById('sendModalText').focus();
}
document.getElementById('sendForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const jid = form.jid.value;
  const text = form.text.value;
  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid, text })
    });
    if (res.ok) {
      document.getElementById('sendModal').classList.add('hidden');
      alert('Message sent!');
    } else {
      const data = await res.json();
      alert('Failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
});
function filterPeople(q) {
  const query = q.toLowerCase().trim();
  const items = document.querySelectorAll('.people-item');
  items.forEach(el => {
    const searchText = el.getAttribute('data-search') || '';
    el.style.display = searchText.includes(query) ? '' : 'none';
  });
}
</script>
`;
    res.send(LAYOUT('People', body, '/people'));
  });

  // Redirect old /allowlist and /chats to /people
  app.get('/allowlist', (_req, res) => res.redirect('/people?tab=contacts'));

  // Friendly form post — name + phone → resolve @lid via sock, add both forms.
  app.post('/people', async (req, res) => {
    const phone = (req.body?.phone || '').trim();
    const label = (req.body?.label || '').trim();
    if (req.body?.jid && !phone) {
      const jid = String(req.body.jid).trim();
      if (jid) addAllowed(jid);
      return res.redirect('/people?tab=contacts');
    }
    if (!phone) return res.redirect('/people?tab=contacts');
    const result = await addContact({ phone, label, sock });
    if (!result.ok && req.headers.accept?.includes('application/json')) {
      return res.status(400).json(result);
    }
    res.redirect('/people?tab=contacts');
  });

  // Friendly remove (by phone).
  app.post('/people/del', async (req, res) => {
    const phone = (req.body?.phone || '').trim();
    if (phone) await removeContact(phone);
    res.redirect('/people?tab=contacts');
  });

  // Legacy remove (by raw JID).
  app.post('/people/del-jid', (req, res) => {
    const jid = (req.body?.jid || '').trim();
    if (jid) removeAllowed(jid);
    res.redirect('/people?tab=contacts');
  });

  // Keep old routes working
  app.post('/allowlist', async (req, res) => {
    const phone = (req.body?.phone || '').trim();
    const label = (req.body?.label || '').trim();
    if (!phone) return res.redirect('/people?tab=contacts');
    await addContact({ phone, label, sock });
    res.redirect('/people?tab=contacts');
  });
  app.post('/allowlist/del', async (req, res) => {
    const phone = (req.body?.phone || '').trim();
    if (phone) await removeContact(phone);
    res.redirect('/people?tab=contacts');
  });
  app.post('/allowlist/del-jid', (req, res) => {
    const jid = (req.body?.jid || '').trim();
    if (jid) removeAllowed(jid);
    res.redirect('/people?tab=contacts');
  });

  // ─── JSON API: same code path, for Claude (curl) and headless clients ───
  app.get('/api/contacts', async (_req, res) => {
    res.json({ contacts: await listContacts() });
  });
  app.post('/api/contacts', async (req, res) => {
    const phone = (req.body?.phone || '').trim();
    const label = (req.body?.label || '').trim();
    const result = await addContact({ phone, label, sock });
    res.status(result.ok ? 200 : 400).json(result);
  });
  app.delete('/api/contacts/:phone', async (req, res) => {
    const result = await removeContact(req.params.phone);
    res.status(result.ok ? 200 : 404).json(result);
  });

  // ─── Send message API ─────────────────────────────────────────────────────
  app.post('/api/send', async (req, res) => {
    const { jid, text } = req.body || {};
    if (!jid || !text) {
      return res.status(400).json({ error: 'jid and text required' });
    }
    try {
      const result = await sock.sendMessage(jid, { text });
      if (result?.key?.id && result?.message) {
        storeOutgoing(jid, result.key.id, result.message);
      }
      // Log the manual send into the chat history so it shows up everywhere.
      appendChat(jid, 'assistant', text, {
        msgId: result?.key?.id || null,
        source: 'webui',
      }).catch((err) => console.error('[api/send] appendChat failed:', err.message));
      res.json({ ok: true, messageId: result?.key?.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Playbooks ─────────────────────────────────────────────────────────────
  //
  // Full ops surface: list / search / pin / edit / run with params /
  // live SSE output / history / scheduling / cost guard. See playbooks.js,
  // playbook-runs.js, playbook-pins.js, playbook-schedules.js for storage.

  // Live-run registry — each /run creates one; SSE subscribes by id.
  const liveRuns = new Map();
  function makeLiveRun(name) {
    const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const entry = { id, name, chunks: [], subscribers: new Set(), done: false, error: null, startedAt: Date.now() };
    liveRuns.set(id, entry);
    setTimeout(() => liveRuns.delete(id), 5 * 60_000).unref?.();
    return entry;
  }
  function pushChunk(entry, kind, payload) {
    if (!entry) return;
    const msg = JSON.stringify({ kind, payload });
    entry.chunks.push(msg);
    for (const r of entry.subscribers) { try { r.write(`data: ${msg}\n\n`); } catch {} }
  }
  function finishLive(entry, { error = null } = {}) {
    if (!entry) return;
    entry.done = true; entry.error = error;
    const msg = JSON.stringify({ kind: 'done', payload: { error } });
    entry.chunks.push(msg);
    for (const r of entry.subscribers) { try { r.write(`data: ${msg}\n\n`); r.end(); } catch {} }
    entry.subscribers.clear();
  }

  function ownerJid() {
    return (process.env.OWNER_JIDS || process.env.ALLOWED_JIDS || '')
      .split(',').map((s) => s.trim()).filter(Boolean)[0];
  }
  function ownerJids() {
    return (process.env.OWNER_JIDS || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
  }
  function estimateTokens(text) { return Math.ceil(String(text || '').length / 4); }
  function humanAgo(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
  function badgeFromLastRun(last) {
    if (!last) return '<span class="text-[10px] text-zinc-600">never run</span>';
    const ago = humanAgo(new Date(last.finishedAt || last.startedAt).getTime());
    const ok = last.status === 'ok';
    const color = ok ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' : 'text-rose-400 bg-rose-500/10 border-rose-500/20';
    const icon = ok ? 'check' : 'x';
    const dur = last.durationMs ? ` · ${(last.durationMs / 1000).toFixed(1)}s` : '';
    return `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] ${color}"><i data-lucide="${icon}" class="size-3"></i>${esc(ago)}${dur}</span>`;
  }

  // Shared run helper. Used by manual runs, scheduled fires, and chains.
  async function runPlaybook({ name, params = {}, target = null, persona = null, chainOf = null, sendToWhatsApp = true, live = null } = {}) {
    const safe = safePlaybookName(name);
    const full = await loadPlaybookFull(safe);
    if (!full) throw new Error(`unknown playbook "${safe}"`);
    const costMod = await import('./cost-guard.js');
    const cost = await costMod.check().catch(() => ({ ok: true }));
    if (cost && cost.ok === false && cost.level === 'hard') {
      throw new Error(`daily token hard limit reached (${cost.total} tokens)`);
    }
    const finalParams = { ...(full.meta?.defaults || {}), ...params };
    const promptBody = applyVariables(full.body, finalParams);
    const effectivePersona = persona || full.persona || null;
    const personaTag = effectivePersona ? ` [persona: ${effectivePersona}]` : '';
    const chainTag = chainOf ? ` (chain of ${chainOf})` : '';
    const prompt = `[playbook: ${safe}]${chainTag}${personaTag}\n\n${promptBody}`;
    const dest = target || ownerJid();
    if (!dest && sendToWhatsApp) throw new Error('no target JID');

    const startedAt = new Date();
    let output = ''; let usage = null; let status = 'ok'; let errorMsg = null;
    try {
      const result = await askClaude(dest || 'webui:dryrun', prompt, {
        onChunk: live ? (chunk) => { output += chunk; pushChunk(live, 'chunk', chunk); } : undefined,
      });
      const text = typeof result === 'string' ? result : (result?.text || '');
      if (!output) output = text;
      usage = result?.usage || null;
      if (sendToWhatsApp && dest && text) {
        for (const part of splitForWhatsApp(text)) {
          await sock.sendMessage(dest, { text: part }).catch((err) => console.error(`playbook ${safe}: send failed:`, err.message));
        }
      }
    } catch (err) {
      status = 'error'; errorMsg = err.message || String(err);
      console.error(`playbook ${safe} failed:`, errorMsg);
      if (sendToWhatsApp && dest) {
        await sock.sendMessage(dest, { text: `⚠ Playbook "${safe}" failed: ${errorMsg.slice(0, 200)}` }).catch(() => {});
      }
    }
    const finishedAt = new Date();
    const row = await playbookRuns.recordRun({
      name: safe,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt - startedAt,
      status, error: errorMsg,
      tokensIn: usage?.input_tokens || 0,
      tokensOut: usage?.output_tokens || 0,
      target: dest || null,
      params: Object.keys(finalParams).length ? finalParams : null,
      outputPreview: output.slice(0, 800),
      persona: effectivePersona,
      chainOf,
    });
    if (live) finishLive(live, { error: errorMsg });

    if (status === 'ok' && Array.isArray(full.chain) && full.chain.length > 0) {
      for (const next of full.chain) {
        try { await runPlaybook({ name: next, target, persona, chainOf: safe, sendToWhatsApp }); }
        catch (err) { console.error(`playbook chain ${safe}->${next} failed:`, err.message); }
      }
    }
    return row;
  }

  // Wire scheduled fires.
  playbookSchedules.initPlaybookSchedules({
    onFire: async (entry) => {
      await runPlaybook({
        name: entry.name, params: entry.params || {},
        target: entry.target, persona: entry.persona, sendToWhatsApp: true,
      }).catch((err) => console.error('scheduled playbook fire failed:', err.message));
    },
  }).catch((err) => console.error('playbook schedules init failed:', err.message));

  // ───────────────────────────────────────────── /playbooks (list)
  app.get('/playbooks', async (req, res) => {
    const [list, tags, pins, lastByName] = await Promise.all([
      listPlaybooks(), allTags(), playbookPins.listPins(), playbookRuns.lastRunByName(),
    ]);
    const q = (req.query.q || '').toString().toLowerCase();
    const tag = (req.query.tag || '').toString();
    const ran = req.query.ran ? String(req.query.ran) : null;
    const running = req.query.running ? String(req.query.running) : null;
    const errMsg = req.query.error ? String(req.query.error) : null;
    const pinSet = new Set(pins);
    const filtered = list.filter((p) => {
      if (tag && !p.tags.includes(tag)) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q)
        || (p.description || '').toLowerCase().includes(q)
        || (p.tags || []).some((t) => t.toLowerCase().includes(q))
        || (p.triggers || []).some((t) => t.toLowerCase().includes(q));
    });
    filtered.sort((a, b) => {
      const ai = pinSet.has(a.name) ? pins.indexOf(a.name) : 999;
      const bi = pinSet.has(b.name) ? pins.indexOf(b.name) : 999;
      if (ai !== bi) return ai - bi;
      return a.name.localeCompare(b.name);
    });

    const renderCard = (p) => {
      const last = lastByName.get(p.name);
      const pinned = pinSet.has(p.name);
      const tagsChips = (p.tags || []).slice(0, 4).map((t) => `<a href="/playbooks?tag=${encodeURIComponent(t)}" class="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-800/60 text-zinc-400 hover:text-emerald-300 border border-zinc-700/60">#${esc(t)}</a>`).join('');
      const triggerChips = (p.triggers || []).slice(0, 3).map((t) => `<span class="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-300 border border-violet-500/20 mono">${esc(t)}</span>`).join('');
      const varBadge = p.variables.length > 0 ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/20"><i data-lucide="braces" class="size-3 inline"></i> ${p.variables.length} var${p.variables.length === 1 ? '' : 's'}</span>` : '';
      const chainBadge = (p.chain && p.chain.length) ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-300 border border-sky-500/20"><i data-lucide="link" class="size-3 inline"></i> chain ${p.chain.length}</span>` : '';
      const personaBadge = p.persona ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-fuchsia-500/10 text-fuchsia-300 border border-fuchsia-500/20"><i data-lucide="sparkles" class="size-3 inline"></i> ${esc(p.persona)}</span>` : '';
      const ownerBadge = p.ownerOnly ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-500/20"><i data-lucide="lock" class="size-3 inline"></i> owner</span>` : '';
      return `
        <div class="card p-5 flex flex-col gap-3 playbook-card" data-name="${esc(p.name)}" data-search="${esc((p.name + ' ' + (p.description || '') + ' ' + (p.tags || []).join(' ') + ' ' + (p.triggers || []).join(' ')).toLowerCase())}">
          <div class="flex items-start gap-3">
            <div class="icon-tile ${pinned ? 'icon-tile-amber' : 'icon-tile-emerald'}"><i data-lucide="${pinned ? 'star' : 'book-open-check'}" class="size-4"></i></div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 min-w-0 flex-wrap">
                <div class="font-medium truncate">${esc(p.name)}</div>
                ${badgeFromLastRun(last)}
              </div>
              ${p.description ? `<div class="text-xs text-zinc-400 mt-0.5 line-clamp-2">${esc(p.description)}</div>` : '<div class="text-xs text-zinc-600 mt-0.5">No description</div>'}
            </div>
            <form method="POST" action="/playbooks/${esc(p.name)}/pin" class="shrink-0">
              <button class="btn btn-ghost btn-icon" title="${pinned ? 'Unpin' : 'Pin'}"><i data-lucide="${pinned ? 'pin-off' : 'pin'}" class="size-4 ${pinned ? 'text-amber-400' : ''}"></i></button>
            </form>
          </div>
          ${(tagsChips || triggerChips || varBadge || chainBadge || personaBadge || ownerBadge) ? `<div class="flex flex-wrap items-center gap-1.5">${tagsChips}${triggerChips}${varBadge}${chainBadge}${personaBadge}${ownerBadge}</div>` : ''}
          <div class="flex items-center gap-2 mt-auto pt-1">
            <a href="/playbooks/${esc(p.name)}" class="btn btn-ghost flex-1"><i data-lucide="eye" class="size-4"></i>View</a>
            ${p.variables.length > 0
              ? `<a href="/playbooks/${esc(p.name)}#run" class="btn btn-primary flex-1"><i data-lucide="play" class="size-4"></i>Run…</a>`
              : `<form method="POST" action="/playbooks/${esc(p.name)}/run" class="flex-1"><button class="btn btn-primary w-full"><i data-lucide="play" class="size-4"></i>Run</button></form>`}
          </div>
        </div>`;
    };

    const tagChips = tags.length ? `<div class="flex flex-wrap gap-1.5 mb-4">
        <a href="/playbooks" class="text-xs px-2.5 py-1 rounded-full ${tag ? 'bg-zinc-800/60 text-zinc-400 border border-zinc-700/60' : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'}">all</a>
        ${tags.map((t) => `<a href="/playbooks?tag=${encodeURIComponent(t)}" class="text-xs px-2.5 py-1 rounded-full ${tag === t ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30' : 'bg-zinc-800/60 text-zinc-400 hover:text-zinc-200 border border-zinc-700/60'}">#${esc(t)}</a>`).join('')}
      </div>` : '';

    const body = `
<div class="flex flex-wrap items-baseline justify-between mb-4 gap-3">
  <div>
    <h1 class="text-2xl md:text-3xl font-semibold tracking-tight">Playbooks</h1>
    <p class="text-sm text-zinc-500 mt-1">Canned prompts in <code class="mono text-zinc-400">playbooks/*.md</code>. Click run to fire one at the bot.</p>
  </div>
  <div class="flex items-center gap-2">
    <a href="/playbooks/runs" class="btn btn-ghost"><i data-lucide="history" class="size-4"></i>History</a>
    <a href="/playbooks/new" class="btn btn-primary"><i data-lucide="plus" class="size-4"></i>New</a>
  </div>
</div>

<div class="flex flex-col md:flex-row gap-3 mb-4">
  <div class="relative flex-1">
    <i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-zinc-500"></i>
    <input id="pb-search" class="input pl-9" type="search" placeholder="Search name, description, tags, triggers… (press / to focus)" value="${esc(q)}" autocomplete="off">
  </div>
</div>

${tagChips}

${ran ? `<section class="card p-4 mb-5 border-emerald-500/30 bg-emerald-500/5 flex items-center gap-3">
  <i data-lucide="check-circle-2" class="size-5 text-emerald-400 shrink-0"></i>
  <div><span class="font-medium text-emerald-300">Ran "${esc(ran)}"</span><div class="text-xs text-emerald-200/70">Reply was DM'd to you on WhatsApp.</div></div>
</section>` : ''}

${errMsg ? `<section class="card p-4 mb-5 border-rose-500/30 bg-rose-500/5 flex items-center gap-3">
  <i data-lucide="circle-alert" class="size-5 text-rose-400 shrink-0"></i>
  <div><span class="font-medium text-rose-300">Failed:</span> <span class="text-rose-200/80">${esc(errMsg)}</span></div>
</section>` : ''}

${running ? `<section id="live-banner" data-run-id="${esc(running)}" class="card p-4 mb-5 border-sky-500/30 bg-sky-500/5">
  <div class="flex items-center gap-3 mb-2">
    <span class="typing-dot"></span>
    <div class="flex-1"><span class="font-medium text-sky-300">Running…</span> <span class="text-xs text-sky-200/70" id="live-elapsed">0s</span></div>
    <button class="btn btn-ghost btn-icon" onclick="document.getElementById('live-banner').remove()" title="Close"><i data-lucide="x" class="size-4"></i></button>
  </div>
  <pre id="live-output" class="text-xs text-zinc-300 whitespace-pre-wrap mono bg-zinc-950/60 rounded-md p-3 border border-zinc-800/60 max-h-64 overflow-y-auto">(waiting for first chunk…)</pre>
</section>` : ''}

${filtered.length === 0
  ? `<section class="card p-10 text-center">
      <i data-lucide="book-open" class="size-10 text-zinc-600 mx-auto mb-3"></i>
      <p class="text-zinc-300 font-medium">${list.length === 0 ? 'No playbooks yet.' : 'Nothing matches.'}</p>
      <p class="text-sm text-zinc-500 mt-1">${list.length === 0 ? 'Hit "New" to create one, or drop a markdown file into <code class="mono">playbooks/</code>.' : 'Try a different search or clear the filter.'}</p>
    </section>`
  : `<section id="pb-grid" class="grid gap-3 md:grid-cols-2">${filtered.map(renderCard).join('')}</section>`
}

<script>
  (function() {
    const input = document.getElementById('pb-search');
    const grid = document.getElementById('pb-grid');
    if (input && grid) {
      let lastQ = input.value.toLowerCase();
      input.addEventListener('input', () => {
        const q = input.value.toLowerCase().trim();
        if (q === lastQ) return;
        lastQ = q;
        for (const card of grid.querySelectorAll('.playbook-card')) {
          const blob = card.getAttribute('data-search') || '';
          card.style.display = (!q || blob.includes(q)) ? '' : 'none';
        }
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
      if (e.key === '/') { e.preventDefault(); input?.focus(); }
      else if (e.key === 'n') { window.location.href = '/playbooks/new'; }
      else if (e.key === 'h') { window.location.href = '/playbooks/runs'; }
    });
    const banner = document.getElementById('live-banner');
    if (banner) {
      const runId = banner.getAttribute('data-run-id');
      const out = document.getElementById('live-output');
      const elapsed = document.getElementById('live-elapsed');
      const t0 = Date.now();
      const tick = setInterval(() => { if (elapsed) elapsed.textContent = Math.round((Date.now() - t0) / 1000) + 's'; }, 500);
      const es = new EventSource('/playbooks/run/stream/' + runId);
      let buf = '';
      es.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.kind === 'chunk') { buf += m.payload; if (out) out.textContent = buf; out?.scrollTo({ top: out.scrollHeight }); }
          else if (m.kind === 'done') {
            clearInterval(tick); es.close();
            if (m.payload?.error) banner.classList.add('border-rose-500/40');
            else banner.classList.add('border-emerald-500/40');
            const pulse = banner.querySelector('.typing-dot');
            if (pulse) pulse.remove();
          }
        } catch {}
      };
      es.onerror = () => { clearInterval(tick); es.close(); };
    }
  })();
</script>
`;
    res.send(LAYOUT('Playbooks', body, '/playbooks'));
  });

  // ───────────────────────────────────────────── /playbooks/new
  app.get('/playbooks/new', (_req, res) => {
    const template = `---\ndescription: One-line summary shown on the card\ntags: [daily]\n# persona: terse\n# chain: []\n# owner_only: false\n# triggers: [/example, "do the thing"]\n---\n# Title\n\nWrite the prompt body here. Use {{variable_name}} for parameters.\n`;
    res.send(LAYOUT('New playbook', renderPlaybookEditor({ name: '', raw: template, isNew: true }), '/playbooks'));
  });

  // ───────────────────────────────────────────── /playbooks/runs (global)
  app.get('/playbooks/runs', async (_req, res) => {
    const [runs, stats] = await Promise.all([
      playbookRuns.listRuns({ limit: 100 }), playbookRuns.aggregateStats(),
    ]);
    const body = `
<div class="flex flex-wrap items-center gap-3 mb-5">
  <a href="/playbooks" class="btn btn-ghost"><i data-lucide="arrow-left" class="size-4"></i>Back</a>
  <h1 class="text-2xl font-semibold tracking-tight">Run history</h1>
</div>
<div class="grid gap-3 md:grid-cols-4 mb-5">
  <div class="stat"><div class="label mb-1">Runs (kept)</div><div class="text-xl font-semibold">${stats.runs}</div></div>
  <div class="stat"><div class="label mb-1">Success rate</div><div class="text-xl font-semibold">${stats.runs ? Math.round((stats.ok / stats.runs) * 100) : 0}%</div></div>
  <div class="stat"><div class="label mb-1">Avg duration</div><div class="text-xl font-semibold">${(stats.avgMs / 1000).toFixed(1)}s</div></div>
  <div class="stat"><div class="label mb-1">Tokens (in+out)</div><div class="text-xl font-semibold">${(stats.totalTokensIn + stats.totalTokensOut).toLocaleString()}</div></div>
</div>
<section class="card overflow-hidden">
  <table class="w-full text-sm">
    <thead class="text-xs text-zinc-500 border-b border-zinc-800/60">
      <tr><th class="text-left p-3">When</th><th class="text-left p-3">Playbook</th><th class="text-left p-3">Status</th><th class="text-right p-3">Duration</th><th class="text-right p-3">Tokens</th></tr>
    </thead>
    <tbody>
      ${runs.length === 0 ? '<tr><td colspan="5" class="p-6 text-center text-zinc-500">No runs yet.</td></tr>' : runs.map((r) => `
        <tr class="border-b border-zinc-900/60 hover:bg-zinc-900/30">
          <td class="p-3 text-xs text-zinc-400">${esc(humanAgo(new Date(r.finishedAt || r.startedAt).getTime()))}</td>
          <td class="p-3"><a href="/playbooks/${esc(r.name)}" class="text-emerald-300 hover:text-emerald-200">${esc(r.name)}</a></td>
          <td class="p-3">${r.status === 'ok' ? '<span class="text-emerald-400 inline-flex items-center gap-1"><i data-lucide="check" class="size-3"></i>ok</span>' : `<span class="text-rose-400 inline-flex items-center gap-1" title="${esc(r.error || '')}"><i data-lucide="x" class="size-3"></i>error</span>`}</td>
          <td class="p-3 text-right text-xs text-zinc-400 mono">${(r.durationMs / 1000).toFixed(1)}s</td>
          <td class="p-3 text-right text-xs text-zinc-400 mono">${(r.tokensIn + r.tokensOut).toLocaleString()}</td>
        </tr>`).join('')}
    </tbody>
  </table>
</section>
`;
    res.send(LAYOUT('Run history', body, '/playbooks'));
  });

  // ───────────────────────────────────────────── /playbooks/:name (view+edit)
  app.get('/playbooks/:name', async (req, res) => {
    const name = safePlaybookName(req.params.name);
    const full = await loadPlaybookFull(name);
    if (!full) {
      return res.status(404).send(LAYOUT('Not found', `<section class="card p-8 text-center"><i data-lucide="circle-alert" class="size-8 text-rose-400 mx-auto mb-2"></i><p>Playbook "<code class="mono">${esc(name)}</code>" not found.</p><a href="/playbooks" class="btn btn-ghost mt-4 inline-flex"><i data-lucide="arrow-left" class="size-4"></i>Back</a></section>`, '/playbooks'));
    }
    const [personas, contacts, schedules, history] = await Promise.all([
      listPersonas().catch(() => []),
      listContacts().catch(() => []),
      playbookSchedules.listSchedules({ name }),
      playbookRuns.listRuns({ name, limit: 10 }),
    ]);
    const saved = !!req.query.saved;
    const scheduled = !!req.query.scheduled;
    const error = req.query.error ? String(req.query.error) : null;
    res.send(LAYOUT(name, renderPlaybookEditor({ name, raw: full.raw, full, personas, contacts, schedules, history, saved, scheduled, error }), '/playbooks'));
  });

  // ───────────────────────────────────────────── /playbooks/:name/runs
  app.get('/playbooks/:name/runs', async (req, res) => {
    const name = safePlaybookName(req.params.name);
    if (!(await playbookExists(name))) return res.redirect('/playbooks?error=' + encodeURIComponent(`playbook "${name}" not found`));
    const [runs, stats] = await Promise.all([
      playbookRuns.listRuns({ name, limit: 100 }), playbookRuns.aggregateStats(name),
    ]);
    const body = `
<div class="flex flex-wrap items-center gap-3 mb-5">
  <a href="/playbooks/${esc(name)}" class="btn btn-ghost"><i data-lucide="arrow-left" class="size-4"></i>Back</a>
  <h1 class="text-2xl font-semibold tracking-tight">${esc(name)} <span class="text-zinc-500 font-normal">· history</span></h1>
</div>
<div class="grid gap-3 md:grid-cols-4 mb-5">
  <div class="stat"><div class="label mb-1">Runs</div><div class="text-xl font-semibold">${stats.runs}</div></div>
  <div class="stat"><div class="label mb-1">OK / Errors</div><div class="text-xl font-semibold">${stats.ok} / ${stats.errors}</div></div>
  <div class="stat"><div class="label mb-1">Avg duration</div><div class="text-xl font-semibold">${(stats.avgMs / 1000).toFixed(1)}s</div></div>
  <div class="stat"><div class="label mb-1">Tokens</div><div class="text-xl font-semibold">${(stats.totalTokensIn + stats.totalTokensOut).toLocaleString()}</div></div>
</div>
<section class="card overflow-hidden">
  <table class="w-full text-sm">
    <thead class="text-xs text-zinc-500 border-b border-zinc-800/60">
      <tr><th class="text-left p-3">When</th><th class="text-left p-3">Status</th><th class="text-right p-3">Duration</th><th class="text-right p-3">Tokens</th><th class="text-left p-3">Output preview</th></tr>
    </thead>
    <tbody>
      ${runs.length === 0 ? '<tr><td colspan="5" class="p-6 text-center text-zinc-500">No runs yet.</td></tr>' : runs.map((r) => `
        <tr class="border-b border-zinc-900/60 align-top">
          <td class="p-3 text-xs text-zinc-400 whitespace-nowrap">${esc(humanAgo(new Date(r.finishedAt || r.startedAt).getTime()))}</td>
          <td class="p-3">${r.status === 'ok' ? '<span class="text-emerald-400 inline-flex items-center gap-1"><i data-lucide="check" class="size-3"></i>ok</span>' : `<span class="text-rose-400 inline-flex items-center gap-1"><i data-lucide="x" class="size-3"></i>err</span>`}</td>
          <td class="p-3 text-right text-xs text-zinc-400 mono">${(r.durationMs / 1000).toFixed(1)}s</td>
          <td class="p-3 text-right text-xs text-zinc-400 mono">${(r.tokensIn + r.tokensOut).toLocaleString()}</td>
          <td class="p-3 text-xs text-zinc-400 max-w-md"><pre class="whitespace-pre-wrap mono text-[11px] line-clamp-3">${esc(r.error || r.outputPreview || '')}</pre></td>
        </tr>`).join('')}
    </tbody>
  </table>
</section>
`;
    res.send(LAYOUT(`${name} · history`, body, '/playbooks'));
  });

  // ───────────────────────────────────────────── save / delete / pin
  app.post('/playbooks/:name/save', async (req, res) => {
    const requestedName = req.body?.rename ? safePlaybookName(req.body.rename) : safePlaybookName(req.params.name);
    const originalName = safePlaybookName(req.params.name);
    const raw = (req.body?.raw || '').toString();
    if (!requestedName) return res.redirect('/playbooks?error=' + encodeURIComponent('invalid name'));
    const result = await savePlaybook(requestedName, raw);
    if (!result.ok) return res.redirect(`/playbooks/${encodeURIComponent(originalName || requestedName)}?error=` + encodeURIComponent(result.error));
    if (originalName && originalName !== requestedName && originalName !== '__new__') {
      await deletePlaybook(originalName).catch(() => {});
    }
    res.redirect(`/playbooks/${encodeURIComponent(requestedName)}?saved=1`);
  });

  app.post('/playbooks/:name/delete', async (req, res) => {
    const name = safePlaybookName(req.params.name);
    if (!name) return res.redirect('/playbooks');
    await deletePlaybook(name);
    if (await playbookPins.isPinned(name)) await playbookPins.togglePin(name);
    const schedules = await playbookSchedules.listSchedules({ name });
    for (const s of schedules) await playbookSchedules.removeSchedule(s.id);
    res.redirect('/playbooks?ran=' + encodeURIComponent(`deleted ${name}`));
  });

  app.post('/playbooks/:name/pin', async (req, res) => {
    const name = safePlaybookName(req.params.name);
    if (name) await playbookPins.togglePin(name);
    res.redirect(req.get('referer') || '/playbooks');
  });

  // ───────────────────────────────────────────── run
  app.post('/playbooks/:name/run', async (req, res) => {
    const name = safePlaybookName(req.params.name);
    if (!(await playbookExists(name))) return res.redirect('/playbooks?error=' + encodeURIComponent('not found'));
    const params = {};
    for (const [k, v] of Object.entries(req.body || {})) if (k.startsWith('param_')) params[k.slice(6)] = String(v);
    const target = (req.body?.target || '').toString() || null;
    const persona = (req.body?.persona || '').toString() || null;
    const owner = ownerJid();
    if (!owner && !target) return res.redirect('/playbooks?error=' + encodeURIComponent('no owner JID configured'));

    const live = makeLiveRun(name);
    (async () => {
      try { await runPlaybook({ name, params, target, persona, live, sendToWhatsApp: true }); }
      catch (err) { finishLive(live, { error: err.message || String(err) }); }
    })();

    if ((req.get('accept') || '').includes('application/json')) {
      return res.json({ ok: true, runId: live.id });
    }
    res.redirect(`/playbooks?running=${encodeURIComponent(live.id)}&ran=${encodeURIComponent(name)}`);
  });

  app.get('/playbooks/run/stream/:runId', (req, res) => {
    const entry = liveRuns.get(req.params.runId);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
    if (!entry) {
      res.write(`data: ${JSON.stringify({ kind: 'done', payload: { error: 'unknown run' } })}\n\n`);
      return res.end();
    }
    for (const c of entry.chunks) res.write(`data: ${c}\n\n`);
    if (entry.done) return res.end();
    entry.subscribers.add(res);
    req.on('close', () => { entry.subscribers.delete(res); });
  });

  app.post('/playbooks/:name/estimate', async (req, res) => {
    const name = safePlaybookName(req.params.name);
    const full = await loadPlaybookFull(name);
    if (!full) return res.status(404).json({ error: 'not found' });
    const params = {};
    for (const [k, v] of Object.entries(req.body || {})) if (k.startsWith('param_')) params[k.slice(6)] = String(v);
    const body = applyVariables(full.body, params);
    const estTokens = estimateTokens(body);
    const daily = await dailyTokens().catch(() => 0);
    const t = costThresholds();
    res.json({
      estimatedInputTokens: estTokens,
      dailyTokensSoFar: daily,
      softLimit: t.soft, hardLimit: t.hard,
      overSoft: t.soft > 0 && daily + estTokens >= t.soft,
      overHard: t.hard > 0 && daily + estTokens >= t.hard,
    });
  });

  // ───────────────────────────────────────────── schedule
  app.post('/playbooks/:name/schedule', async (req, res) => {
    const name = safePlaybookName(req.params.name);
    if (!(await playbookExists(name))) return res.redirect('/playbooks?error=' + encodeURIComponent('not found'));
    const cron = (req.body?.cron || '').toString().trim();
    if (!cron) return res.redirect(`/playbooks/${encodeURIComponent(name)}?error=` + encodeURIComponent('cron expression required'));
    const target = (req.body?.target || '').toString() || null;
    const persona = (req.body?.persona || '').toString() || null;
    const params = {};
    for (const [k, v] of Object.entries(req.body || {})) if (k.startsWith('param_')) params[k.slice(6)] = String(v);
    try {
      await playbookSchedules.addSchedule({ name, cron, target, persona, params: Object.keys(params).length ? params : null });
    } catch (err) {
      return res.redirect(`/playbooks/${encodeURIComponent(name)}?error=` + encodeURIComponent(err.message));
    }
    res.redirect(`/playbooks/${encodeURIComponent(name)}?scheduled=1`);
  });

  app.post('/playbooks/schedule/:id/delete', async (req, res) => {
    const id = String(req.params.id || '').replace(/[^\w-]/g, '');
    await playbookSchedules.removeSchedule(id);
    res.redirect(req.get('referer') || '/playbooks');
  });

  // renderPlaybookEditor — shared by /playbooks/new and /playbooks/:name.
  function renderPlaybookEditor({ name, raw, isNew = false, full = null, personas = [], contacts = [], schedules = [], history = [], saved = false, scheduled = false, error = null }) {
    const variables = full?.variables || [];
    const triggers = full?.triggers || [];
    const tags = full?.tags || [];
    const owner = ownerJid();
    const contactOpts = contacts.map((c) => {
      const jid = c.phoneJid || (c.phone ? c.phone + '@s.whatsapp.net' : '');
      const label = c.label || formatPhoneForDisplay(c.phone);
      return `<option value="${esc(jid)}">${esc(label)}${jid === owner ? ' (owner)' : ''}</option>`;
    }).join('');
    const personaOpts = personas.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    const formAction = isNew ? '/playbooks/__new__/save' : `/playbooks/${esc(name)}/save`;
    const estimateName = name || '__new__';

    const paramsForm = variables.length === 0 ? '' : `
<section class="card p-5" id="run">
  <div class="flex items-center gap-2 mb-3">
    <i data-lucide="braces" class="size-4 text-amber-400"></i>
    <h2 class="font-semibold">Run with parameters</h2>
  </div>
  <form method="POST" action="/playbooks/${esc(name)}/run" class="space-y-3" id="pb-run-form">
    ${variables.map((v) => `
      <div>
        <label class="label mb-1 block">${esc(v)}</label>
        <input class="input" name="param_${esc(v)}" placeholder="value for {{${esc(v)}}}" autocomplete="off">
      </div>`).join('')}
    <div class="grid md:grid-cols-2 gap-3 pt-2 border-t border-zinc-800/60">
      <div>
        <label class="label mb-1 block">Send reply to</label>
        <select class="input" name="target">
          <option value="">Owner (default)</option>
          ${contactOpts}
        </select>
      </div>
      <div>
        <label class="label mb-1 block">Persona override</label>
        <select class="input" name="persona">
          <option value="">— playbook default —</option>
          ${personaOpts}
        </select>
      </div>
    </div>
    <div class="flex items-center gap-2 pt-2">
      <button type="submit" class="btn btn-primary"><i data-lucide="play" class="size-4"></i>Run now</button>
      <button type="button" class="btn btn-ghost" onclick="window.estimateCost()"><i data-lucide="gauge" class="size-4"></i>Estimate</button>
      <span id="pb-estimate" class="text-xs text-zinc-500"></span>
    </div>
  </form>
</section>`;

    const runFormSimple = (variables.length > 0 || isNew) ? '' : `
<form method="POST" action="/playbooks/${esc(name)}/run" id="run">
  <section class="card p-5">
    <div class="flex items-center gap-2 mb-3">
      <i data-lucide="play" class="size-4 text-emerald-400"></i>
      <h2 class="font-semibold">Run</h2>
    </div>
    <div class="grid md:grid-cols-2 gap-3">
      <div>
        <label class="label mb-1 block">Send reply to</label>
        <select class="input" name="target">
          <option value="">Owner (default)</option>
          ${contactOpts}
        </select>
      </div>
      <div>
        <label class="label mb-1 block">Persona override</label>
        <select class="input" name="persona">
          <option value="">— playbook default —</option>
          ${personaOpts}
        </select>
      </div>
    </div>
    <div class="flex items-center gap-2 pt-3">
      <button type="submit" class="btn btn-primary"><i data-lucide="play" class="size-4"></i>Run now</button>
      <button type="button" class="btn btn-ghost" onclick="window.estimateCost()"><i data-lucide="gauge" class="size-4"></i>Estimate</button>
      <span id="pb-estimate" class="text-xs text-zinc-500"></span>
    </div>
  </section>
</form>`;

    const schedulesSection = isNew ? '' : `
<section class="card p-5">
  <div class="flex items-center gap-2 mb-3">
    <i data-lucide="calendar-clock" class="size-4 text-sky-400"></i>
    <h2 class="font-semibold">Scheduled runs</h2>
  </div>
  ${schedules.length === 0
    ? '<p class="text-sm text-zinc-500 mb-3">No schedules yet.</p>'
    : `<div class="space-y-2 mb-4">${schedules.map((s) => `
        <div class="flex items-center gap-3 p-3 rounded-lg bg-zinc-900/40 border border-zinc-800/60">
          <i data-lucide="clock" class="size-4 text-zinc-500"></i>
          <div class="flex-1 min-w-0">
            <div class="mono text-sm">${esc(s.cron)}</div>
            <div class="text-xs text-zinc-500">next: ${s.nextRun ? esc(new Date(s.nextRun).toLocaleString()) : '—'}${s.target ? ' · target: ' + esc(s.target) : ''}${s.persona ? ' · persona: ' + esc(s.persona) : ''}</div>
          </div>
          <form method="POST" action="/playbooks/schedule/${esc(s.id)}/delete">
            <button class="btn btn-danger btn-icon" title="Remove"><i data-lucide="trash-2" class="size-4"></i></button>
          </form>
        </div>`).join('')}</div>`}
  <form method="POST" action="/playbooks/${esc(name)}/schedule" class="grid md:grid-cols-[1fr_auto] gap-2">
    <input class="input mono" name="cron" placeholder="cron e.g. 0 8 * * *" required>
    <button class="btn btn-primary"><i data-lucide="plus" class="size-4"></i>Add schedule</button>
  </form>
  <div class="text-xs text-zinc-600 mt-2">Examples: <code class="mono">0 8 * * *</code> daily 8am · <code class="mono">0 9 * * 1</code> Mondays 9am · <code class="mono">*/30 * * * *</code> every 30 min</div>
</section>`;

    const historySection = isNew ? '' : `
<section class="card p-5">
  <div class="flex items-center justify-between mb-3">
    <div class="flex items-center gap-2"><i data-lucide="history" class="size-4 text-violet-400"></i><h2 class="font-semibold">Recent runs</h2></div>
    <a href="/playbooks/${esc(name)}/runs" class="text-xs text-emerald-300 hover:text-emerald-200">View all →</a>
  </div>
  ${history.length === 0 ? `<p class="text-sm text-zinc-500">Hasn't run yet.</p>` : `
    <div class="space-y-1.5">${history.map((r) => `
      <div class="flex items-center gap-3 text-xs">
        <span class="${r.status === 'ok' ? 'text-emerald-400' : 'text-rose-400'} mono">${r.status === 'ok' ? '✓' : '✗'}</span>
        <span class="text-zinc-400">${esc(humanAgo(new Date(r.finishedAt || r.startedAt).getTime()))}</span>
        <span class="text-zinc-600 mono">${(r.durationMs / 1000).toFixed(1)}s</span>
        <span class="text-zinc-600 mono">${(r.tokensIn + r.tokensOut).toLocaleString()} tok</span>
        <span class="text-zinc-500 truncate">${esc(r.error || (r.outputPreview || '').slice(0, 80))}</span>
      </div>`).join('')}</div>`}
</section>`;

    const triggersChips = triggers.length === 0 ? '' : `<div class="flex flex-wrap items-center gap-1.5 mt-2"><span class="label">triggers:</span>${triggers.map((t) => `<span class="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-300 border border-violet-500/20 mono">${esc(t)}</span>`).join('')}</div>`;
    const tagsChips = tags.length === 0 ? '' : `<div class="flex flex-wrap items-center gap-1.5 mt-1"><span class="label">tags:</span>${tags.map((t) => `<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-800/60 text-zinc-400 border border-zinc-700/60">#${esc(t)}</span>`).join('')}</div>`;

    const flash = `${saved ? '<div class="card p-3 mb-4 border-emerald-500/30 bg-emerald-500/5 text-sm text-emerald-300 flex items-center gap-2"><i data-lucide="check-circle-2" class="size-4"></i>Saved</div>' : ''}${scheduled ? '<div class="card p-3 mb-4 border-sky-500/30 bg-sky-500/5 text-sm text-sky-300 flex items-center gap-2"><i data-lucide="calendar-check" class="size-4"></i>Schedule added</div>' : ''}${error ? `<div class="card p-3 mb-4 border-rose-500/30 bg-rose-500/5 text-sm text-rose-300 flex items-center gap-2"><i data-lucide="circle-alert" class="size-4"></i>${esc(error)}</div>` : ''}`;

    return `
<div class="flex flex-wrap items-center gap-3 mb-4">
  <a href="/playbooks" class="btn btn-ghost"><i data-lucide="arrow-left" class="size-4"></i>Back</a>
  <h1 class="text-2xl font-semibold tracking-tight">${isNew ? 'New playbook' : esc(name)}</h1>
  ${isNew ? '' : `<a href="/playbooks/${esc(name)}/runs" class="btn btn-ghost"><i data-lucide="history" class="size-4"></i>History</a>`}
  ${isNew ? '' : `<form method="POST" action="/playbooks/${esc(name)}/pin"><button class="btn btn-ghost" title="Pin"><i data-lucide="pin" class="size-4"></i>Pin</button></form>`}
</div>

${triggersChips}${tagsChips}
${flash}

<div class="grid lg:grid-cols-[1fr_360px] gap-5 mt-4">
  <div class="space-y-4">
    <section class="card p-5">
      <form method="POST" action="${formAction}" id="pb-form">
        <div class="flex flex-wrap items-center gap-2 mb-3">
          <label class="label">Name</label>
          <input class="input mono max-w-xs" name="rename" value="${esc(name)}" placeholder="my-playbook" pattern="[\\w.\\-]+" required>
          <span class="text-xs text-zinc-500">→ <code class="mono">playbooks/<span id="name-preview">${esc(name || 'name')}</span>.md</code></span>
          <div class="ml-auto flex items-center gap-2">
            <button type="submit" class="btn btn-primary"><i data-lucide="save" class="size-4"></i>Save</button>
            ${isNew ? '' : `<button class="btn btn-danger" type="button" onclick="if(confirm('Delete this playbook?')){document.getElementById('pb-delete-form').submit()}"><i data-lucide="trash-2" class="size-4"></i>Delete</button>`}
          </div>
        </div>
        <textarea id="pb-editor" name="raw" class="input mono" rows="22" spellcheck="false">${esc(raw)}</textarea>
        <div class="text-xs text-zinc-500 mt-2 flex flex-wrap gap-4">
          <span><code class="mono px-1 rounded bg-zinc-800/60">{{var}}</code> = parameter prompt</span>
          <span><code class="mono px-1 rounded bg-zinc-800/60">Triggers: …</code> in body = WhatsApp triggers</span>
          <span>Frontmatter: <code class="mono">tags · persona · chain · owner_only</code></span>
        </div>
      </form>
      ${isNew ? '' : `<form id="pb-delete-form" method="POST" action="/playbooks/${esc(name)}/delete" class="hidden"></form>`}
    </section>

    ${paramsForm}
    ${runFormSimple}
    ${schedulesSection}
    ${historySection}
  </div>

  <aside class="space-y-4">
    <section class="card p-5">
      <h2 class="font-semibold mb-2 flex items-center gap-2"><i data-lucide="info" class="size-4 text-zinc-500"></i>About</h2>
      <div class="text-sm space-y-1.5">
        <div><span class="text-zinc-500">Description:</span> ${esc(full?.description || '—')}</div>
        <div><span class="text-zinc-500">Persona:</span> ${esc(full?.persona || '—')}</div>
        <div><span class="text-zinc-500">Variables:</span> ${variables.length === 0 ? '—' : variables.map((v) => `<code class="mono text-amber-300">{{${esc(v)}}}</code>`).join(' ')}</div>
        <div><span class="text-zinc-500">Chain:</span> ${(full?.chain || []).length === 0 ? '—' : (full.chain).map((c) => `<a href="/playbooks/${esc(c)}" class="text-sky-300 hover:text-sky-200 mono">${esc(c)}</a>`).join(', ')}</div>
        <div><span class="text-zinc-500">Owner-only:</span> ${full?.ownerOnly ? '<span class="text-rose-300">yes</span>' : 'no'}</div>
      </div>
    </section>

    <section class="card p-5">
      <h2 class="font-semibold mb-2 flex items-center gap-2"><i data-lucide="keyboard" class="size-4 text-zinc-500"></i>Shortcuts</h2>
      <ul class="text-xs space-y-1 text-zinc-400">
        <li><code class="mono px-1 rounded bg-zinc-800/60">Ctrl/⌘ + S</code> save</li>
        <li><code class="mono px-1 rounded bg-zinc-800/60">Ctrl/⌘ + Enter</code> run</li>
        <li><code class="mono px-1 rounded bg-zinc-800/60">Esc</code> back to list</li>
      </ul>
    </section>
  </aside>
</div>

<script>
  (function() {
    const nameInput = document.querySelector('input[name="rename"]');
    const preview = document.getElementById('name-preview');
    nameInput?.addEventListener('input', () => { if (preview) preview.textContent = nameInput.value || 'name'; });
    const editor = document.getElementById('pb-editor');
    if (editor) {
      editor.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const s = editor.selectionStart, en = editor.selectionEnd;
          editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(en);
          editor.selectionStart = editor.selectionEnd = s + 2;
        }
      });
    }
    document.addEventListener('keydown', (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); document.getElementById('pb-form')?.requestSubmit(); }
      else if (meta && e.key === 'Enter') {
        e.preventDefault();
        const form = document.getElementById('pb-run-form') || document.querySelector('form[action$="/run"]');
        form?.requestSubmit();
      } else if (e.key === 'Escape' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        window.location.href = '/playbooks';
      }
    });
    window.estimateCost = async () => {
      const form = document.getElementById('pb-run-form') || document.querySelector('form[action$="/run"]');
      const data = form ? new FormData(form) : new FormData();
      const obj = {}; for (const [k, v] of data.entries()) obj[k] = v;
      const out = document.getElementById('pb-estimate');
      if (out) out.textContent = 'estimating…';
      try {
        const r = await fetch('/playbooks/${esc(estimateName)}/estimate', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(obj) });
        const j = await r.json();
        if (j.error) { if (out) out.textContent = j.error; return; }
        const warn = j.overHard ? ' ⛔ would exceed HARD limit' : (j.overSoft ? ' ⚠ over soft limit' : '');
        if (out) out.textContent = '~' + j.estimatedInputTokens.toLocaleString() + ' input tokens · ' + j.dailyTokensSoFar.toLocaleString() + '/' + (j.hardLimit || j.softLimit || '∞') + ' today' + warn;
      } catch (err) { if (out) out.textContent = 'estimate failed: ' + err.message; }
    };
  })();
</script>`;
  }

  // ─── Proofreader ────────────────────────────────────────────────────────────
  const PROOFREADER_LOG = path.resolve('logs', 'proofreader.jsonl');
  const PROOFREADER_PROMPT_FILE = path.resolve('src', 'proofreader.js');

  app.get('/proofreader', async (_req, res) => {
    // Read current system prompt from proofreader.js
    let systemPrompt = '';
    try {
      const content = await fs.readFile(PROOFREADER_PROMPT_FILE, 'utf-8');
      const match = content.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
      if (match) systemPrompt = match[1];
    } catch {}

    // Read log entries
    let entries = [];
    try {
      const logContent = await fs.readFile(PROOFREADER_LOG, 'utf-8');
      entries = logContent.trim().split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean).reverse().slice(0, 100); // Latest 100
    } catch {}

    const enabled = process.env.PROOFREADER_ENABLED === '1';
    const changedCount = entries.filter(e => e.changed).length;
    const suppressedCount = entries.filter(e => e.action === 'suppressed').length;

    const body = `
<div class="flex flex-wrap items-center justify-between mb-6 gap-3">
  <div>
    <h1 class="text-2xl md:text-3xl font-semibold tracking-tight">Proofreader</h1>
    <p class="text-sm text-zinc-500 mt-1">AI-powered sanitizer to strip internal reasoning from replies</p>
  </div>
  <div class="flex items-center gap-2">
    <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${enabled ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' : 'bg-zinc-700/50 text-zinc-400 border border-zinc-600'}">
      <span class="h-1.5 w-1.5 rounded-full ${enabled ? 'bg-emerald-400' : 'bg-zinc-500'}"></span>
      ${enabled ? 'Enabled' : 'Disabled'}
    </span>
  </div>
</div>

<!-- Stats -->
<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
  <div class="card p-4">
    <div class="text-2xl font-bold text-zinc-100">${entries.length}</div>
    <div class="text-xs text-zinc-500 mt-1">Total processed</div>
  </div>
  <div class="card p-4">
    <div class="text-2xl font-bold text-emerald-400">${changedCount}</div>
    <div class="text-xs text-zinc-500 mt-1">Sanitized</div>
  </div>
  <div class="card p-4">
    <div class="text-2xl font-bold text-amber-400">${suppressedCount}</div>
    <div class="text-xs text-zinc-500 mt-1">Fully suppressed</div>
  </div>
  <div class="card p-4">
    <div class="text-2xl font-bold text-zinc-400">${entries.length - changedCount - suppressedCount}</div>
    <div class="text-xs text-zinc-500 mt-1">Unchanged</div>
  </div>
</div>

<!-- System Prompt -->
<div class="card p-5 mb-6">
  <div class="flex items-center justify-between mb-4">
    <h2 class="font-semibold flex items-center gap-2">
      <i data-lucide="file-text" class="size-4 text-emerald-400"></i>
      System Prompt
    </h2>
    <button type="button" onclick="document.getElementById('promptEditor').classList.toggle('hidden')" class="btn btn-ghost btn-sm">
      <i data-lucide="edit-3" class="size-3.5"></i>Edit
    </button>
  </div>
  <pre class="text-xs text-zinc-400 bg-zinc-900/50 rounded-lg p-4 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">${esc(systemPrompt)}</pre>
  <form id="promptEditor" method="POST" action="/proofreader/prompt" class="hidden mt-4">
    <textarea name="prompt" rows="12" class="input w-full font-mono text-xs">${esc(systemPrompt)}</textarea>
    <div class="flex justify-end gap-2 mt-3">
      <button type="button" onclick="this.closest('form').classList.add('hidden')" class="btn btn-ghost">Cancel</button>
      <button type="submit" class="btn btn-primary"><i data-lucide="save" class="size-4"></i>Save Prompt</button>
    </div>
  </form>
</div>

<!-- Log Entries -->
<div class="card">
  <div class="p-4 border-b border-zinc-800">
    <h2 class="font-semibold flex items-center gap-2">
      <i data-lucide="scroll-text" class="size-4 text-emerald-400"></i>
      Recent Activity
      <span class="text-xs font-normal text-zinc-500">(latest ${entries.length})</span>
    </h2>
  </div>
  <div class="divide-y divide-zinc-800/50 max-h-[600px] overflow-y-auto">
    ${entries.length === 0 ? `
      <div class="p-8 text-center text-zinc-500">
        <i data-lucide="inbox" class="size-8 mx-auto mb-2 opacity-50"></i>
        <p>No proofreader activity yet</p>
        <p class="text-xs mt-1">Entries will appear here when messages are processed</p>
      </div>
    ` : entries.map(e => {
      if (e.action === 'suppressed') {
        return `
        <div class="p-4 bg-amber-500/5">
          <div class="flex items-center gap-2 mb-2">
            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-amber-500/20 text-amber-300">
              <i data-lucide="eye-off" class="size-3"></i>SUPPRESSED
            </span>
            <span class="text-[10px] text-zinc-600">${e.ts ? new Date(e.ts).toLocaleString() : ''}</span>
          </div>
          <div class="text-xs text-zinc-400 bg-zinc-900/50 rounded p-3 whitespace-pre-wrap">${esc(e.original?.slice(0, 500) || '')}</div>
        </div>`;
      }
      if (!e.changed) {
        return `
        <div class="p-4">
          <div class="flex items-center gap-2 mb-2">
            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-zinc-700/50 text-zinc-400">
              <i data-lucide="check" class="size-3"></i>UNCHANGED
            </span>
            <span class="text-[10px] text-zinc-600">${e.ts ? new Date(e.ts).toLocaleString() : ''}</span>
            <span class="text-[10px] text-zinc-600">${e.durMs ? e.durMs + 'ms' : ''}</span>
          </div>
          <div class="text-xs text-zinc-500 truncate">${esc(e.original?.slice(0, 150) || '')}</div>
        </div>`;
      }
      return `
      <div class="p-4">
        <div class="flex items-center gap-2 mb-3">
          <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-500/20 text-emerald-300">
            <i data-lucide="wand-2" class="size-3"></i>SANITIZED
          </span>
          <span class="text-[10px] text-zinc-600">${e.ts ? new Date(e.ts).toLocaleString() : ''}</span>
          <span class="text-[10px] text-zinc-600">${e.durMs ? e.durMs + 'ms' : ''}</span>
          <span class="text-[10px] text-zinc-500">${e.inputLen || 0} → ${e.outputLen || 0} chars</span>
        </div>
        <div class="grid md:grid-cols-2 gap-3">
          <div>
            <div class="text-[10px] uppercase tracking-wider text-zinc-600 mb-1.5 flex items-center gap-1">
              <i data-lucide="file-input" class="size-3"></i>Original
            </div>
            <div class="text-xs text-red-400/80 bg-red-500/5 border border-red-500/10 rounded p-3 whitespace-pre-wrap max-h-40 overflow-y-auto">${esc(e.original || '')}</div>
          </div>
          <div>
            <div class="text-[10px] uppercase tracking-wider text-zinc-600 mb-1.5 flex items-center gap-1">
              <i data-lucide="file-output" class="size-3"></i>Sanitized
            </div>
            <div class="text-xs text-emerald-400/80 bg-emerald-500/5 border border-emerald-500/10 rounded p-3 whitespace-pre-wrap max-h-40 overflow-y-auto">${esc(e.sanitized || '')}</div>
          </div>
        </div>
      </div>`;
    }).join('')}
  </div>
</div>
`;
    res.send(LAYOUT('Proofreader', body, '/proofreader'));
  });

  // Save proofreader prompt
  app.post('/proofreader/prompt', async (req, res) => {
    const newPrompt = req.body?.prompt || '';
    try {
      let content = await fs.readFile(PROOFREADER_PROMPT_FILE, 'utf-8');
      content = content.replace(
        /const SYSTEM_PROMPT = `[\s\S]*?`;/,
        `const SYSTEM_PROMPT = \`${newPrompt.replace(/`/g, '\\`')}\`;`
      );
      await fs.writeFile(PROOFREADER_PROMPT_FILE, content);
      res.redirect('/proofreader');
    } catch (err) {
      res.status(500).send('Failed to save: ' + err.message);
    }
  });

  // ─── Settings ──────────────────────────────────────────────────────────────
  app.get('/settings', (_req, res) => {
    const current = readEnvFile();
    // Merge in process.env so live runtime values show.
    for (const k of EDITABLE_KEYS) if (process.env[k] != null && !(k in current)) current[k] = process.env[k];
    const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const fieldCount = SETTINGS.reduce((n, g) => n + g.items.length, 0);
    const body = `
<div class="flex flex-wrap items-center justify-between mb-6 gap-3">
  <div>
    <h1 class="text-2xl md:text-3xl font-semibold tracking-tight">Settings</h1>
    <p class="text-sm text-zinc-500 mt-1">${fieldCount} fields · edits write to <code class="mono">.env</code></p>
  </div>
  <div class="flex items-center gap-2 flex-wrap">
    <span id="dirtyCount" class="hidden text-xs text-amber-300 items-center gap-1.5">
      <span class="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse"></span>
      <span id="dirtyNumber">0</span> unsaved
    </span>
    <button form="settingsForm" type="submit" class="btn btn-primary"><i data-lucide="save" class="size-4"></i>Save</button>
    <button type="button" onclick="if(confirm('Save and restart now?')){document.getElementById('settingsForm').submit();setTimeout(()=>doRestart(),500)}" class="btn btn-danger"><i data-lucide="rotate-cw" class="size-4"></i>Save & Restart</button>
  </div>
</div>

<div class="grid grid-cols-1 lg:grid-cols-[1fr_220px] gap-6">
  <div class="min-w-0">
    <div class="relative mb-4">
      <i data-lucide="search" class="size-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"></i>
      <input id="settingsFilter" type="search" placeholder="Filter by name, key, or value…" class="input" style="padding-left: 2.25rem;" autocomplete="off">
    </div>

    <form method="POST" action="/settings" class="space-y-4 pb-6" id="settingsForm">
      ${SETTINGS.map((g) => {
        const groupId = `group-${slugify(g.group)}`;
        return `
        <section id="${groupId}" class="card p-5 settings-group" data-group-name="${esc(g.group)}">
          <div class="flex items-center justify-between mb-4 gap-2 flex-wrap">
            <h2 class="font-semibold flex items-center gap-2">
              <i data-lucide="${esc(g.icon || 'sliders-horizontal')}" class="size-4 text-emerald-400"></i>
              ${esc(g.group)}
            </h2>
            ${(g.actions || []).map((a) => `<button type="button" class="btn btn-ghost settings-test-btn" data-test-action="${esc(a.id)}"><i data-lucide="${esc(a.icon)}" class="size-3.5"></i>${esc(a.label)}</button>`).join('')}
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            ${g.items.map((i) => `
              <div class="setting-field"${i.providers ? ` data-provider-scope="${esc(i.providers.join(' '))}"` : ''} data-search="${esc((i.label + ' ' + i.key + ' ' + (current[i.key] || '')).toLowerCase())}">
                <label class="block">
                  <span class="flex items-center justify-between mb-1.5 gap-2">
                    <span class="text-zinc-200 font-medium">${esc(i.label)}${i.unit ? ` <span class="text-zinc-500 font-normal">(${esc(i.unit)})</span>` : ''}</span>
                    <span class="flex items-center gap-1.5 shrink-0">
                      ${i.needsRestart ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30" title="Requires a restart to take effect">restart</span>` : ''}
                      <button type="button" class="text-[10px] text-zinc-500 hover:text-zinc-200 underline-offset-2 hover:underline" data-reset-field="${esc(i.key)}" title="Reset to empty">reset</button>
                    </span>
                  </span>
                  ${renderSettingsField(i, current)}
                  ${i.help ? `<span class="block mt-1.5 text-[11px] text-zinc-500 leading-relaxed">${esc(i.help)}</span>` : ''}
                  <span class="block mt-1 text-[10px] text-zinc-600 mono">${esc(i.key)}</span>
                </label>
              </div>
            `).join('')}
          </div>
        </section>`;
      }).join('')}
    </form>
    <script>
    (function(){
      function syncProviderFields(){
        var sel = document.getElementById('f_AI_PROVIDER');
        if(!sel) return;
        var p = sel.value;
        document.querySelectorAll('[data-provider-scope]').forEach(function(el){
          var scope = (el.getAttribute('data-provider-scope')||'').split(/\\s+/);
          el.style.display = scope.indexOf(p) === -1 ? 'none' : '';
        });
      }
      document.addEventListener('change', function(e){
        if(e.target && e.target.id === 'f_AI_PROVIDER') syncProviderFields();
      });
      document.addEventListener('DOMContentLoaded', syncProviderFields);
      syncProviderFields();
    })();
    </script>
  </div>

  <aside class="hidden lg:block">
    <div class="sticky top-4 card p-4">
      <div class="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-3">Jump to</div>
      <nav class="flex flex-col gap-0.5 text-sm">
        ${SETTINGS.map((g) => {
          const groupId = `group-${slugify(g.group)}`;
          return `<a href="#${groupId}" class="settings-toc-link flex items-center gap-2 px-2 py-1.5 rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors" data-group="${groupId}">
            <i data-lucide="${esc(g.icon || 'sliders-horizontal')}" class="size-3.5"></i>
            <span class="truncate">${esc(g.group)}</span>
          </a>`;
        }).join('')}
      </nav>
    </div>
  </aside>
</div>

<style>
  .setting-field.dirty input,
  .setting-field.dirty select { border-color: rgb(245 158 11 / 0.7); box-shadow: 0 0 0 3px rgb(245 158 11 / 0.1); }
  .setting-field.hidden-by-filter { display: none; }
  .settings-test-btn { padding: 0.3rem 0.625rem; font-size: 0.7rem; }
  #dirtyCount:not(.hidden) { display: inline-flex; }
</style>

<script>
  (function() {
    const filter = document.getElementById('settingsFilter');
    if (!filter) return;
    function apply() {
      const q = filter.value.trim().toLowerCase();
      document.querySelectorAll('.setting-field').forEach((f) => {
        const match = !q || (f.dataset.search || '').includes(q);
        f.classList.toggle('hidden-by-filter', !match);
      });
      document.querySelectorAll('.settings-group').forEach((g) => {
        const visible = g.querySelectorAll('.setting-field:not(.hidden-by-filter)').length;
        g.style.display = visible === 0 ? 'none' : '';
      });
    }
    filter.addEventListener('input', apply);
  })();

  (function() {
    const dirtyCount = document.getElementById('dirtyCount');
    const dirtyNumber = document.getElementById('dirtyNumber');
    function recompute() {
      let n = 0;
      document.querySelectorAll('.setting-input').forEach((el) => {
        const initial = el.dataset.initial ?? '';
        const dirty = String(el.value) !== String(initial);
        el.closest('.setting-field')?.classList.toggle('dirty', dirty);
        if (dirty) n++;
      });
      if (n > 0) { dirtyCount.classList.remove('hidden'); dirtyNumber.textContent = String(n); }
      else { dirtyCount.classList.add('hidden'); }
    }
    document.querySelectorAll('.setting-input').forEach((el) => {
      el.addEventListener('input', recompute);
      el.addEventListener('change', recompute);
    });
    recompute();
  })();

  document.querySelectorAll('[data-toggle-eye]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.toggleEye);
      if (!input) return;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      const icon = btn.querySelector('i[data-lucide]');
      if (icon) icon.setAttribute('data-lucide', showing ? 'eye' : 'eye-off');
      if (window.lucide) window.lucide.createIcons();
    });
  });

  document.querySelectorAll('[data-reset-field]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.querySelector('[name="' + btn.dataset.resetField + '"]');
      if (input) {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  });

  (function() {
    const links = document.querySelectorAll('.settings-toc-link');
    function onScroll() {
      let active = null;
      const top = window.scrollY + 80;
      document.querySelectorAll('.settings-group').forEach((g) => {
        if (g.offsetTop <= top) active = g.id;
      });
      links.forEach((a) => {
        const on = a.dataset.group === active;
        a.classList.toggle('bg-emerald-500/10', on);
        a.classList.toggle('text-emerald-300', on);
      });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  })();

  document.querySelectorAll('[data-test-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.testAction;
      const orig = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<i data-lucide="loader" class="size-3.5 animate-spin"></i>Sending…';
      if (window.lucide) window.lucide.createIcons();
      try {
        const r = await fetch('/api/settings/test/' + id, { method: 'POST' });
        const body = await r.json().catch(() => ({}));
        if (r.ok && body.ok !== false) {
          btn.innerHTML = '<i data-lucide="check" class="size-3.5"></i>Sent';
        } else {
          btn.innerHTML = '<i data-lucide="x" class="size-3.5"></i>' + (body.error ? body.error.slice(0, 40) : 'Failed');
        }
      } catch (err) {
        btn.innerHTML = '<i data-lucide="x" class="size-3.5"></i>' + err.message.slice(0, 40);
      }
      if (window.lucide) window.lucide.createIcons();
      setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; if (window.lucide) window.lucide.createIcons(); }, 2500);
    });
  });
</script>
`;
    res.send(LAYOUT('Settings', body, '/settings'));
  });

  app.post('/api/settings/test/ntfy', async (_req, res) => {
    const topic = process.env.NTFY_TOPIC;
    const server = process.env.NTFY_SERVER || 'https://ntfy.sh';
    const token = process.env.NTFY_TOKEN;
    if (!topic) return res.status(400).json({ ok: false, error: 'NTFY_TOPIC not set' });
    try {
      const headers = { 'Content-Type': 'text/plain', Title: 'Encrypto AI test', Tags: 'wave' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const r = await fetch(`${server.replace(/\/$/, '')}/${encodeURIComponent(topic)}`, {
        method: 'POST',
        headers,
        body: 'Test notification from the bot dashboard. If you see this, ntfy is wired up.',
      });
      if (!r.ok) return res.status(502).json({ ok: false, error: `HTTP ${r.status}` });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message?.slice(0, 120) || 'failed' });
    }
  });

  app.post('/api/settings/test/webhook', async (_req, res) => {
    const secret = process.env.WEBHOOK_SECRET;
    const port = process.env.WEB_PORT || '7777';
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (secret) headers['x-webhook-secret'] = secret;
      const r = await fetch(`http://127.0.0.1:${port}/webhook/alert`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: 'Webhook self-test from the Settings page.' }),
      });
      if (!r.ok) return res.status(502).json({ ok: false, error: `HTTP ${r.status}` });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message?.slice(0, 120) || 'failed' });
    }
  });

  app.post('/settings', (req, res) => {
    const updates = {};
    for (const k of EDITABLE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) updates[k] = String(req.body[k] ?? '');
    }
    patchEnv(updates);
    res.redirect('/settings');
  });

  // ─── Chats ─────────────────────────────────────────────────────────────────
  // ─── Search across chat history ────────────────────────────────────────
  app.get('/search', async (req, res) => {
    const q = (req.query?.q || '').toString().trim();
    const jidFilter = (req.query?.jid || '').toString().trim() || null;

    // Contact options for the filter dropdown — from DB chat list
    // Filter out owner JIDs (privacy)
    const owners = new Set(ownerJids());
    let chatRows = [];
    try { chatRows = await getChatList(); } catch {}
    const filteredChatRows = chatRows.filter((r) => !owners.has(r.jid));
    const contactOptions = await Promise.all(filteredChatRows.map(async (r) => ({
      jid: r.jid,
      name: (await displayName(r.jid).catch(() => null)) || r.jid,
    })));
    contactOptions.sort((a, b) => a.name.localeCompare(b.name));

    const { matches, scanned } = q ? await searchChats(q, { jidFilter, max: 100 }) : { matches: [], scanned: 0 };
    // Filter out owner messages from search results
    const filteredMatches = matches.filter((m) => !owners.has(m.jid));

    // Resolve display names for matches
    const matchesWithNames = await Promise.all(filteredMatches.map(async (m) => ({
      ...m,
      displayName: await displayName(m.jid) || m.jid
    })));

    const body = `
<div class="mb-6">
  <h1 class="text-2xl md:text-3xl font-semibold tracking-tight">Search</h1>
  <p class="text-sm text-zinc-500 mt-1">Search all chat transcripts - newest first</p>
</div>
<form method="GET" action="/search" class="card p-4 mb-6">
  <div class="flex flex-col md:flex-row gap-3">
    <div class="flex-1 flex items-center gap-2 bg-zinc-900/60 rounded-lg px-3 border border-zinc-800">
      <i data-lucide="search" class="size-4 text-zinc-500"></i>
      <input name="q" value="${esc(q)}" placeholder="Type a phrase..." class="bg-transparent flex-1 py-3 outline-none text-zinc-100" autofocus>
    </div>
    <select name="jid" class="input md:w-48">
      <option value="">All contacts</option>
      ${contactOptions.map((c) => `<option value="${esc(c.jid)}" ${jidFilter === c.jid ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
    </select>
    <button class="btn btn-primary"><i data-lucide="search" class="size-4"></i>Search</button>
  </div>
</form>
${
  !q
    ? '<section class="card p-8 text-center"><i data-lucide="search" class="size-10 text-zinc-700 mx-auto mb-3"></i><p class="text-zinc-400">Type a query above to search.</p></section>'
    : matchesWithNames.length === 0
      ? `<section class="card p-8 text-center"><i data-lucide="search-x" class="size-10 text-zinc-700 mx-auto mb-3"></i><p class="text-zinc-400">No matches for <strong class="text-zinc-200">"${esc(q)}"</strong></p><p class="text-xs text-zinc-500 mt-1">Scanned ${scanned.toLocaleString()} messages</p></section>`
      : `<div class="flex items-center justify-between mb-4">
          <div class="text-sm text-zinc-400">${matchesWithNames.length} match${matchesWithNames.length === 1 ? '' : 'es'}</div>
          <div class="text-xs text-zinc-500">Scanned ${scanned.toLocaleString()} messages</div>
        </div>
        <div class="space-y-2">${matchesWithNames.map((m) => `
          <div class="card p-4 hover:border-zinc-700 transition-colors">
            <div class="flex items-center gap-2 mb-2">
              <div class="icon-tile ${m.role === 'user' ? 'icon-tile-sky' : 'icon-tile-emerald'}">
                <i data-lucide="${m.role === 'user' ? 'user' : 'bot'}" class="size-3.5"></i>
              </div>
              <span class="font-medium text-sm">${esc(m.displayName)}</span>
              <span class="text-[10px] text-zinc-500 ml-auto">${esc((m.t || '').slice(0, 16).replace('T', ' '))}</span>
            </div>
            <div class="text-sm text-zinc-300 whitespace-pre-wrap pl-10">${esc(snippetOf(m.text, q, 80)).replace(new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (s) => `<mark class="bg-emerald-500/30 text-emerald-100 px-0.5 rounded">${s}</mark>`)}</div>
          </div>
        `).join('')}</div>`
}
`;
    res.send(LAYOUT('Search', body, '/search'));
  });

  app.get('/chats', async (_req, res) => {
    let rows = [];
    try {
      rows = await getChatList();
    } catch (err) {
      console.error('[webui] /chats DB query failed:', err.message);
    }

    // Filter out owner JIDs from the chat list (privacy: don't show owner chat on dashboard)
    const owners = new Set(ownerJids());
    const filteredRows = rows.filter((r) => !owners.has(r.jid));

    const chatList = await Promise.all(filteredRows.map(async (r) => {
      const jid = r.jid;
      const name = await displayName(jid).catch(() => null);
      const lastMsg = (r.last_msg || '').slice(0, 60);
      const lastTime = r.last_time ? new Date(r.last_time).toISOString() : null;
      const msgCount = r.msg_count;
      // Encode JID for URL (mirrors the legacy filename-safe scheme)
      const fileSafe = jid.replace(/[^\w@.-]/g, '_');
      return { jid, name, lastMsg, lastTime, msgCount, file: fileSafe };
    }));

    const chatCard = (c) => {
      const initial = (c.name || c.jid).charAt(0).toUpperCase();
      const timeAgo = c.lastTime ? c.lastTime.slice(11, 16) : '';
      const searchText = (c.name || '') + ' ' + c.jid + ' ' + (c.lastMsg || '');
      return `<a href="/chats/${esc(c.file)}" class="people-item flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-zinc-900/60 transition-colors border-b border-zinc-800/50 last:border-0" data-search="${esc(searchText.toLowerCase())}">
        <div class="h-10 w-10 rounded-full bg-gradient-to-br from-emerald-500/20 to-emerald-700/20 flex items-center justify-center font-medium text-emerald-300 text-sm shrink-0">
          ${esc(initial)}
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-baseline justify-between gap-2">
            <span class="font-medium text-sm truncate">${esc(c.name || c.jid)}</span>
            ${timeAgo ? `<span class="text-[10px] text-zinc-500 shrink-0">${esc(timeAgo)}</span>` : ''}
          </div>
          ${c.lastMsg ? `<div class="text-xs text-zinc-500 truncate mt-0.5">${esc(c.lastMsg)}</div>` : ''}
        </div>
      </a>`;
    };

    const body = `
<div class="flex flex-wrap items-baseline justify-between mb-6 gap-3">
  <div>
    <h1 class="text-2xl md:text-3xl font-semibold tracking-tight">Chats</h1>
    <p class="text-sm text-zinc-500 mt-1">${chatList.length} conversation${chatList.length === 1 ? '' : 's'}</p>
  </div>
  <a href="/search" class="btn btn-ghost"><i data-lucide="search" class="size-4"></i>Search all</a>
</div>
${
  chatList.length === 0
    ? '<section class="card p-8 text-center"><i data-lucide="messages-square" class="size-10 text-zinc-600 mx-auto mb-3"></i><p class="text-zinc-400">No chats yet.</p></section>'
    : `<div class="grid gap-2">${chatList.map(chatCard).join('')}</div>`
}
`;
    res.send(LAYOUT('Chats', body, '/chats'));
  });

  app.get('/chats/:jid', async (req, res) => {
    const jid = req.params.jid.replace(/_/g, ':');
    const name = await displayName(jid).catch(() => null);
    let entries = [];
    try {
      entries = await getMessages(jid, 200, 0);
    } catch (err) {
      console.error('[webui] /chats/:jid DB query failed:', err.message);
    }
    const body = `
<header class="sticky top-[56px] md:top-0 z-10 -mx-4 md:-mx-8 -mt-4 md:-mt-8 mb-4 px-4 md:px-8 py-3 bg-zinc-950/85 backdrop-blur-md border-b border-zinc-900">
  <div class="flex items-center gap-3">
    <a href="/chats" class="btn btn-icon btn-ghost"><i data-lucide="arrow-left" class="size-4"></i></a>
    <div class="h-10 w-10 rounded-full bg-gradient-to-br from-emerald-500/30 to-emerald-700/30 border border-emerald-500/30 flex items-center justify-center font-semibold text-emerald-300 shrink-0">
      ${esc((name || jid).charAt(0).toUpperCase())}
    </div>
    <div class="flex-1 min-w-0">
      <h1 class="text-lg md:text-xl font-semibold truncate">${esc(name || jid)}</h1>
      <p class="text-xs text-zinc-500">${entries.length} message${entries.length === 1 ? '' : 's'} — showing last 200</p>
    </div>
  </div>
</header>
<div id="chatMessages" class="space-y-2 pb-4">
${(() => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const formatSep = (d) => {
    const dDay = new Date(d); dDay.setHours(0, 0, 0, 0);
    if (dDay.getTime() === today.getTime()) return 'Today';
    if (dDay.getTime() === yesterday.getTime()) return 'Yesterday';
    return dDay.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  };
  let lastDayKey = '';
  const out = [];
  for (const e of entries) {
    const dt = e.created_at instanceof Date ? e.created_at : new Date(e.created_at);
    const dayKey = dt.toISOString().slice(0, 10);
    if (dayKey !== lastDayKey) {
      lastDayKey = dayKey;
      out.push(`<div class="flex items-center gap-3 my-4"><div class="flex-1 h-px bg-zinc-800"></div><span class="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">${esc(formatSep(dt))}</span><div class="flex-1 h-px bg-zinc-800"></div></div>`);
    }
    const isUser = e.role === 'user';
    const time = dt.toISOString().slice(11, 16);
    if (isUser) {
      out.push(`<div class="flex justify-end">
      <div class="max-w-[85%] md:max-w-[70%] rounded-2xl rounded-tr-sm px-4 py-2.5 bg-zinc-800/80 border border-zinc-700">
        <div class="text-sm whitespace-pre-wrap break-words">${esc(e.content)}</div>
        <div class="text-[10px] text-zinc-500 mt-1 text-right">${esc(time)}</div>
      </div>
    </div>`);
    } else {
      out.push(`<div class="flex justify-start">
      <div class="max-w-[85%] md:max-w-[70%] rounded-2xl rounded-tl-sm px-4 py-2.5 bg-gradient-to-br from-emerald-900/40 to-emerald-950/40 border border-emerald-800/50">
        <div class="text-sm whitespace-pre-wrap break-words">${esc(e.content)}</div>
        <div class="text-[10px] text-emerald-600 mt-1">${esc(time)}</div>
      </div>
    </div>`);
    }
  }
  return out.join('');
})()}
</div>

<button id="jumpBottomBtn" class="hidden fixed bottom-20 md:bottom-6 right-4 md:right-8 z-20 btn btn-ghost shadow-lg" onclick="jumpToBottom()" title="Jump to latest">
  <i data-lucide="arrow-down" class="size-4"></i>
</button>

<script>
  // Smart scroll: jump to bottom on initial load. Live updates (SSE) should
  // only auto-scroll if the user is already near the bottom.
  (function() {
    const SCROLL_NEAR_BOTTOM_PX = 120;
    function isNearBottom() {
      return (window.innerHeight + window.scrollY) >= (document.body.scrollHeight - SCROLL_NEAR_BOTTOM_PX);
    }
    window.jumpToBottom = function() {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    };
    // Initial: always at bottom (it's a chat).
    window.scrollTo(0, document.body.scrollHeight);
    // Show "jump to bottom" pill when scrolled up.
    const btn = document.getElementById('jumpBottomBtn');
    function refreshBtn() {
      if (isNearBottom()) btn.classList.add('hidden');
      else btn.classList.remove('hidden');
    }
    window.addEventListener('scroll', refreshBtn, { passive: true });
    // Expose helpers for the upcoming SSE live-update logic.
    window.__chat = {
      isNearBottom,
      autoScrollIfNearBottom() { if (isNearBottom()) window.scrollTo(0, document.body.scrollHeight); },
    };
  })();
</script>

<!-- Composer: send a reply from the web UI. POSTs to /api/send and lets the
     SSE stream deliver the bubble (so manual sends look the same as bot sends). -->
<div class="fixed bottom-16 md:bottom-0 inset-x-0 md:left-60 z-20 bg-zinc-950/95 backdrop-blur-md border-t border-zinc-900 px-4 md:px-8 py-3">
  <form id="composerForm" class="flex items-end gap-2 max-w-5xl">
    <textarea id="composerText" placeholder="Type a reply…" rows="1" class="input flex-1 resize-none" style="max-height: 8rem;" oninput="this.style.height='auto'; this.style.height=Math.min(this.scrollHeight, 128)+'px';"></textarea>
    <button type="submit" class="btn btn-primary shrink-0" id="composerSend">
      <i data-lucide="send" class="size-4"></i><span class="hidden md:inline">Send</span>
    </button>
  </form>
</div>
<div class="h-20 md:h-16"></div>

<script>
  // Composer + live SSE updates.
  (function() {
    const JID = ${JSON.stringify(jid)};
    const $msgs = document.getElementById('chatMessages');
    const $form = document.getElementById('composerForm');
    const $text = document.getElementById('composerText');
    const $send = document.getElementById('composerSend');

    function esc(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function fmtTime(iso) {
      try { return new Date(iso).toISOString().slice(11, 16); } catch { return ''; }
    }
    function appendBubble(role, content, iso) {
      const time = fmtTime(iso);
      const isUser = role === 'user';
      const html = isUser
        ? '<div class="flex justify-end"><div class="max-w-[85%] md:max-w-[70%] rounded-2xl rounded-tr-sm px-4 py-2.5 bg-zinc-800/80 border border-zinc-700"><div class="text-sm whitespace-pre-wrap break-words">' + esc(content) + '</div><div class="text-[10px] text-zinc-500 mt-1 text-right">' + esc(time) + '</div></div></div>'
        : '<div class="flex justify-start"><div class="max-w-[85%] md:max-w-[70%] rounded-2xl rounded-tl-sm px-4 py-2.5 bg-gradient-to-br from-emerald-900/40 to-emerald-950/40 border border-emerald-800/50"><div class="text-sm whitespace-pre-wrap break-words">' + esc(content) + '</div><div class="text-[10px] text-emerald-600 mt-1">' + esc(time) + '</div></div></div>';
      $msgs.insertAdjacentHTML('beforeend', html);
      if (window.__chat) window.__chat.autoScrollIfNearBottom();
    }

    // Submit composer
    $form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const text = $text.value.trim();
      if (!text) return;
      $send.disabled = true;
      try {
        const r = await fetch('/api/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jid: JID, text }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'send failed');
        $text.value = '';
        $text.style.height = 'auto';
        // The SSE stream will deliver the bubble; nothing else to do.
      } catch (err) {
        alert('Send failed: ' + err.message);
      } finally {
        $send.disabled = false;
        $text.focus();
      }
    });

    // Cmd/Ctrl+Enter to send.
    $text.addEventListener('keydown', (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
        ev.preventDefault();
        $form.requestSubmit();
      }
    });

    // SSE: stream new messages for this JID.
    const es = new EventSource('/chats/' + encodeURIComponent(JID.replace(/:/g, '_')) + '/stream');
    es.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m && m.role && typeof m.content === 'string') {
          appendBubble(m.role, m.content, m.created_at);
        }
      } catch {}
    };
  })();
</script>
`;
    res.send(LAYOUT(name || jid, body, '/chats'));
  });

  // SSE: new chat messages for a JID. Subscribers are added/removed per request.
  app.get('/chats/:jid/stream', (req, res) => {
    const jid = req.params.jid.replace(/_/g, ':');
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(': connected\n\n');

    const unsub = subscribeChat(jid, (payload) => {
      try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {}
    });

    // Keep-alive comment every 25s so reverse proxies don't drop the connection.
    const ka = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 25_000);

    req.on('close', () => { clearInterval(ka); unsub(); });
  });

  // ─── Analytics ─────────────────────────────────────────────────────────────
  app.get('/analytics', async (_req, res) => {
    const summary = analytics.getSummary();
    const hourly = analytics.getHourlyTokens(24);
    const daily = analytics.getDailyTokens(14);
    const contactsRaw = analytics.getMessagesByContact();
    const rtDist = analytics.getResponseTimeDistribution();
    const cost = costThresholds();
    const sessionStats = snapshot();

    // PG-backed totals so the top cards survive restarts. sessionStats are
    // in-memory and zero out on every reload — those go into the small
    // "this session" strip below.
    const db = await import('./db.js');
    const [todayTokens, rtStats, dbSummary] = await Promise.all([
      db.getTodayTokens().catch(() => ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 })),
      db.getResponseTimeStats().catch(() => ({ count: 0, avg_ms: 0, median_ms: 0 })),
      db.getAnalyticsSummary().catch(() => null),
    ]);
    const todayIn = Number(todayTokens.input_tokens) || 0;
    const todayOut = Number(todayTokens.output_tokens) || 0;
    const todayCache = Number(todayTokens.cache_read_tokens) || 0;
    const todayTotal = todayIn + todayOut;

    // All-time totals from PG.
    const allTimeTokens = dbSummary?.tokens?.total || { input: 0, output: 0, cache: 0 };
    const allTimeMessages = contactsRaw.reduce((s, c) => s + (c.sent || 0) + (c.received || 0), 0);

    // Resolve contact names
    const contacts = await Promise.all(contactsRaw.slice(0, 8).map(async (c) => ({
      ...c,
      name: await displayName(c.jid) || c.jid,
    })));

    // Simple bar chart using CSS
    const maxHourly = Math.max(...hourly.map(h => h.tokens), 1);
    const maxDaily = Math.max(...daily.map(d => d.tokens), 1);

    // Cache hit rate from today's PG totals — persists across restarts.
    const denomToday = todayIn + todayCache;
    const cacheHitRate = denomToday > 0 ? Math.round(todayCache / denomToday * 100) : 0;

    // Cost estimate from today's tokens (rough: $15/M input, $75/M output for Opus).
    const estimatedCost = ((todayIn / 1_000_000) * 15 + (todayOut / 1_000_000) * 75).toFixed(2);
    const allTimeCost = ((allTimeTokens.input / 1_000_000) * 15 + (allTimeTokens.output / 1_000_000) * 75).toFixed(2);
    const avgRespMs = Number(rtStats?.avg_ms) || 0;

    const body = `
<div class="mb-6">
  <h1 class="text-2xl md:text-3xl font-semibold tracking-tight">Analytics</h1>
  <p class="text-sm text-zinc-500 mt-1">Token usage and activity metrics</p>
</div>

<div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
  <div class="stat">
    <div class="flex items-start gap-3">
      <div class="icon-tile icon-tile-emerald"><i data-lucide="coins" class="size-4"></i></div>
      <div class="flex-1 min-w-0">
        <div class="label">Tokens today</div>
        <div class="text-2xl font-semibold mt-1">${todayTotal.toLocaleString()}</div>
        <div class="text-[11px] text-zinc-500 mt-0.5">${todayIn.toLocaleString()} in / ${todayOut.toLocaleString()} out</div>
      </div>
    </div>
  </div>
  <div class="stat">
    <div class="flex items-start gap-3">
      <div class="icon-tile icon-tile-sky"><i data-lucide="message-circle" class="size-4"></i></div>
      <div class="flex-1 min-w-0">
        <div class="label">Messages (all time)</div>
        <div class="text-2xl font-semibold mt-1">${allTimeMessages.toLocaleString()}</div>
        <div class="text-[11px] text-zinc-500 mt-0.5">${contactsRaw.length} contacts tracked</div>
      </div>
    </div>
  </div>
  <div class="stat">
    <div class="flex items-start gap-3">
      <div class="icon-tile icon-tile-violet"><i data-lucide="database" class="size-4"></i></div>
      <div class="flex-1 min-w-0">
        <div class="label">Cache hit rate (today)</div>
        <div class="text-2xl font-semibold mt-1">${cacheHitRate}%</div>
        <div class="text-[11px] text-zinc-500 mt-0.5">${todayCache.toLocaleString()} cached</div>
      </div>
    </div>
  </div>
  <div class="stat">
    <div class="flex items-start gap-3">
      <div class="icon-tile icon-tile-amber"><i data-lucide="dollar-sign" class="size-4"></i></div>
      <div class="flex-1 min-w-0">
        <div class="label">Est. cost today</div>
        <div class="text-2xl font-semibold mt-1">$${estimatedCost}</div>
        <div class="text-[11px] text-zinc-500 mt-0.5">$${allTimeCost} all time</div>
      </div>
    </div>
  </div>
</div>

<div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
  <div class="stat">
    <div class="flex items-start gap-3">
      <div class="icon-tile icon-tile-rose"><i data-lucide="alert-circle" class="size-4"></i></div>
      <div class="flex-1 min-w-0">
        <div class="label">Errors (session)</div>
        <div class="text-2xl font-semibold mt-1">${sessionStats.errors}</div>
        ${sessionStats.lastError ? `<div class="text-[11px] text-rose-400 mt-0.5 truncate">${esc(sessionStats.lastError.slice(0, 30))}</div>` : '<div class="text-[11px] text-zinc-500 mt-0.5">No errors</div>'}
      </div>
    </div>
  </div>
  <div class="stat">
    <div class="flex items-start gap-3">
      <div class="icon-tile icon-tile-cyan"><i data-lucide="timer" class="size-4"></i></div>
      <div class="flex-1 min-w-0">
        <div class="label">Avg response (24h)</div>
        <div class="text-2xl font-semibold mt-1">${avgRespMs > 0 ? (avgRespMs / 1000).toFixed(1) + 's' : '-'}</div>
        <div class="text-[11px] text-zinc-500 mt-0.5">${Number(rtStats?.count || 0).toLocaleString()} samples</div>
      </div>
    </div>
  </div>
  <div class="stat">
    <div class="flex items-start gap-3">
      <div class="icon-tile icon-tile-orange"><i data-lucide="send" class="size-4"></i></div>
      <div class="flex-1 min-w-0">
        <div class="label">Chunks sent (session)</div>
        <div class="text-2xl font-semibold mt-1">${sessionStats.chunksOut.toLocaleString()}</div>
      </div>
    </div>
  </div>
  <div class="stat">
    <div class="flex items-start gap-3">
      <div class="icon-tile icon-tile-lime"><i data-lucide="gauge" class="size-4"></i></div>
      <div class="flex-1 min-w-0">
        <div class="label">Budget (today)</div>
        <div class="text-2xl font-semibold mt-1">${cost.hard ? Math.round(todayTotal / cost.hard * 100) + '%' : '-'}</div>
        ${cost.hard ? `<div class="text-[11px] text-zinc-500 mt-0.5">${cost.hard.toLocaleString()} daily limit</div>` : '<div class="text-[11px] text-zinc-500 mt-0.5">no limit set</div>'}
      </div>
    </div>
  </div>
</div>

<div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
  <section class="card p-5">
    <div class="flex items-center gap-2 mb-4">
      <i data-lucide="bar-chart-3" class="size-4 text-emerald-400"></i>
      <h2 class="font-semibold">Last 24 hours</h2>
    </div>
    <div class="flex items-end gap-1 h-32">
      ${hourly.map(h => `
        <div class="flex-1 flex flex-col items-center gap-1">
          <div class="w-full bg-emerald-500/20 rounded-t" style="height: ${Math.max(2, h.tokens / maxHourly * 100)}%"></div>
        </div>
      `).join('')}
    </div>
    <div class="flex justify-between text-[10px] text-zinc-500 mt-2">
      <span>${hourly[0]?.label || ''}</span>
      <span>${hourly[Math.floor(hourly.length / 2)]?.label || ''}</span>
      <span>${hourly[hourly.length - 1]?.label || ''}</span>
    </div>
  </section>

  <section class="card p-5">
    <div class="flex items-center gap-2 mb-4">
      <i data-lucide="calendar" class="size-4 text-emerald-400"></i>
      <h2 class="font-semibold">Last 14 days</h2>
    </div>
    <div class="flex items-end gap-1 h-32">
      ${daily.map(d => `
        <div class="flex-1 flex flex-col items-center gap-1">
          <div class="w-full bg-sky-500/20 rounded-t" style="height: ${Math.max(2, d.tokens / maxDaily * 100)}%"></div>
        </div>
      `).join('')}
    </div>
    <div class="flex justify-between text-[10px] text-zinc-500 mt-2">
      <span>${daily[0]?.label || ''}</span>
      <span>${daily[Math.floor(daily.length / 2)]?.label || ''}</span>
      <span>${daily[daily.length - 1]?.label || ''}</span>
    </div>
  </section>
</div>

<div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
  <section class="card p-5">
    <div class="flex items-center gap-2 mb-4">
      <i data-lucide="pie-chart" class="size-4 text-emerald-400"></i>
      <h2 class="font-semibold">Token breakdown</h2>
    </div>
    <div class="flex items-center justify-center">
      <div class="relative w-32 h-32">
        <svg viewBox="0 0 100 100" class="w-full h-full -rotate-90">
          ${(() => {
            const total = todayIn + todayOut + todayCache;
            if (total === 0) return '<circle cx="50" cy="50" r="40" fill="none" stroke="#27272a" stroke-width="12"/>';
            const inPct = todayIn / total * 100;
            const outPct = todayOut / total * 100;
            const cachePct = todayCache / total * 100;
            const inDash = inPct * 2.51;
            const outDash = outPct * 2.51;
            const cacheDash = cachePct * 2.51;
            return `
              <circle cx="50" cy="50" r="40" fill="none" stroke="#10b981" stroke-width="12" stroke-dasharray="${inDash} 251" stroke-dashoffset="0"/>
              <circle cx="50" cy="50" r="40" fill="none" stroke="#f59e0b" stroke-width="12" stroke-dasharray="${outDash} 251" stroke-dashoffset="-${inDash}"/>
              <circle cx="50" cy="50" r="40" fill="none" stroke="#8b5cf6" stroke-width="12" stroke-dasharray="${cacheDash} 251" stroke-dashoffset="-${inDash + outDash}"/>
            `;
          })()}
        </svg>
        <div class="absolute inset-0 flex items-center justify-center">
          <div class="text-center">
            <div class="text-lg font-bold">${((todayIn + todayOut + todayCache) / 1000).toFixed(0)}k</div>
            <div class="text-[10px] text-zinc-500">today</div>
          </div>
        </div>
      </div>
    </div>
    <div class="flex justify-center gap-4 mt-4 text-xs">
      <div class="flex items-center gap-1"><div class="w-2 h-2 rounded-full bg-emerald-500"></div> Input</div>
      <div class="flex items-center gap-1"><div class="w-2 h-2 rounded-full bg-amber-500"></div> Output</div>
      <div class="flex items-center gap-1"><div class="w-2 h-2 rounded-full bg-violet-500"></div> Cache</div>
    </div>
  </section>

  <section class="card p-5">
    <div class="flex items-center gap-2 mb-4">
      <i data-lucide="users" class="size-4 text-emerald-400"></i>
      <h2 class="font-semibold">Top contacts</h2>
    </div>
    ${contacts.length === 0 ? '<p class="text-zinc-500 text-sm">No data yet.</p>' : `
    <div class="space-y-2">
      ${contacts.slice(0, 5).map(c => `<div class="flex items-center gap-3">
          <div class="h-7 w-7 rounded-full bg-gradient-to-br from-emerald-500/30 to-emerald-700/30 flex items-center justify-center text-xs font-medium text-emerald-300">${esc((c.name || '?').charAt(0).toUpperCase())}</div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium truncate">${esc(c.name)}</div>
            <div class="text-[10px] text-zinc-500">${c.received} in / ${c.sent} out</div>
          </div>
          <div class="text-sm font-semibold text-emerald-400">${c.total}</div>
        </div>`).join('')}
    </div>`}
  </section>

  <section class="card p-5">
    <div class="flex items-center gap-2 mb-4">
      <i data-lucide="timer" class="size-4 text-emerald-400"></i>
      <h2 class="font-semibold">Response times</h2>
    </div>
    <div class="space-y-2">
      ${Object.entries(rtDist).map(([label, count]) => {
        const total = Object.values(rtDist).reduce((a, b) => a + b, 0);
        const pct = total > 0 ? Math.round(count / total * 100) : 0;
        const color = label === '<1s' ? 'emerald' : label === '1-3s' ? 'sky' : label === '3-5s' ? 'amber' : label === '5-10s' ? 'orange' : 'rose';
        return `<div class="flex items-center gap-2">
          <div class="w-12 text-[11px] text-zinc-400">${esc(label)}</div>
          <div class="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div class="h-full bg-${color}-500" style="width: ${pct}%"></div>
          </div>
          <div class="w-8 text-[11px] text-zinc-500 text-right">${count}</div>
        </div>`;
      }).join('')}
    </div>
  </section>
</div>

<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
  <section class="card p-5">
    <div class="flex items-center gap-2 mb-4">
      <i data-lucide="activity" class="size-4 text-emerald-400"></i>
      <h2 class="font-semibold">Input vs Output tokens <span class="text-xs text-zinc-500 font-normal">· today</span></h2>
    </div>
    <div class="space-y-3">
      <div>
        <div class="flex justify-between text-xs mb-1">
          <span class="text-zinc-400">Input tokens</span>
          <span class="text-emerald-400">${todayIn.toLocaleString()}</span>
        </div>
        <div class="h-3 bg-zinc-800 rounded-full overflow-hidden">
          <div class="h-full bg-gradient-to-r from-emerald-600 to-emerald-400" style="width: ${todayTotal > 0 ? Math.round(todayIn / todayTotal * 100) : 0}%"></div>
        </div>
      </div>
      <div>
        <div class="flex justify-between text-xs mb-1">
          <span class="text-zinc-400">Output tokens</span>
          <span class="text-amber-400">${todayOut.toLocaleString()}</span>
        </div>
        <div class="h-3 bg-zinc-800 rounded-full overflow-hidden">
          <div class="h-full bg-gradient-to-r from-amber-600 to-amber-400" style="width: ${todayTotal > 0 ? Math.round(todayOut / todayTotal * 100) : 0}%"></div>
        </div>
      </div>
      <div>
        <div class="flex justify-between text-xs mb-1">
          <span class="text-zinc-400">Cache read</span>
          <span class="text-violet-400">${todayCache.toLocaleString()}</span>
        </div>
        <div class="h-3 bg-zinc-800 rounded-full overflow-hidden">
          <div class="h-full bg-gradient-to-r from-violet-600 to-violet-400" style="width: ${cacheHitRate}%"></div>
        </div>
      </div>
      <div>
        <div class="flex justify-between text-xs mb-1">
          <span class="text-zinc-400">Cache write <span class="text-zinc-600">(session)</span></span>
          <span class="text-cyan-400">${sessionStats.cacheWriteTokens.toLocaleString()}</span>
        </div>
        <div class="h-3 bg-zinc-800 rounded-full overflow-hidden">
          <div class="h-full bg-gradient-to-r from-cyan-600 to-cyan-400" style="width: ${sessionStats.tokensIn + sessionStats.cacheWriteTokens > 0 ? Math.round(sessionStats.cacheWriteTokens / (sessionStats.tokensIn + sessionStats.cacheWriteTokens) * 100) : 0}%"></div>
        </div>
      </div>
    </div>
  </section>

  <section class="card p-5">
    <div class="flex items-center gap-2 mb-4">
      <i data-lucide="dollar-sign" class="size-4 text-emerald-400"></i>
      <h2 class="font-semibold">Cost breakdown <span class="text-xs text-zinc-500 font-normal">· today</span></h2>
    </div>
    <div class="space-y-3">
      ${(() => {
        const inputCost = (todayIn / 1_000_000) * 15;
        const outputCost = (todayOut / 1_000_000) * 75;
        const cacheSavings = (todayCache / 1_000_000) * 15 * 0.9; // 90% savings
        const totalCost = inputCost + outputCost;
        return `
        <div class="flex justify-between items-center">
          <span class="text-sm text-zinc-400">Input ($15/M)</span>
          <span class="text-sm font-medium text-emerald-400">$${inputCost.toFixed(3)}</span>
        </div>
        <div class="flex justify-between items-center">
          <span class="text-sm text-zinc-400">Output ($75/M)</span>
          <span class="text-sm font-medium text-amber-400">$${outputCost.toFixed(3)}</span>
        </div>
        <div class="border-t border-zinc-800 pt-2 mt-2">
          <div class="flex justify-between items-center">
            <span class="text-sm text-zinc-400">Total</span>
            <span class="text-lg font-bold text-white">$${totalCost.toFixed(2)}</span>
          </div>
        </div>
        <div class="flex justify-between items-center text-emerald-400">
          <span class="text-sm">Cache savings</span>
          <span class="text-sm font-medium">-$${cacheSavings.toFixed(3)}</span>
        </div>
        `;
      })()}
    </div>
  </section>
</div>
`;
    res.send(LAYOUT('Analytics', body, '/analytics'));
  });

  // ─── Queue ────────────────────────────────────────────────────────────────
  app.get('/queue', async (_req, res) => {
    const bufferRaw = incomingBuffer.listWaiting();
    const bufferAllRaw = incomingBuffer.listAll();
    const bufferProcessingRaw = bufferAllRaw.filter(i => i.status === 'processing');
    const processingRaw = processingState.getState();
    const holdAll = incomingBuffer.getHoldAll();
    const counts = incomingBuffer.counts();

    // Resolve names upfront
    const waiting = await Promise.all(bufferRaw.map(async (item) => ({
      ...item,
      name: await displayName(item.jid) || item.jid,
    })));

    // Merge buffer processing items with processingState
    // Buffer has the item id, processingState has elapsed time
    const processingItems = await Promise.all(bufferProcessingRaw.map(async (item) => {
      const stateItem = processingRaw.active.find(p => p.bufferId === item.id);
      return {
        jid: item.jid,
        bufferId: item.id,
        preview: item.preview,
        name: await displayName(item.jid) || item.jid,
        elapsedMs: stateItem?.elapsedMs || (Date.now() - item.startedAt) || 0,
        cancelRequested: item.cancelRequested || false,
      };
    }));

    const processing = {
      count: processingItems.length,
      active: processingItems,
    };
    const history = bufferAllRaw.filter(i => i.status === 'done' || i.status === 'cancelled').slice(-10).reverse();
    const recentHistory = await Promise.all(history.map(async (item) => ({
      ...item,
      name: await displayName(item.jid) || item.jid,
    })));

    const autoRelease = incomingBuffer.getAutoRelease();
    const body = `
<div class="flex flex-wrap items-baseline justify-between mb-6 gap-3">
  <div>
    <h1 class="text-2xl md:text-3xl font-semibold tracking-tight">Queue</h1>
    <p class="text-sm text-zinc-500 mt-1">${counts.waiting} waiting, ${counts.processing} processing</p>
  </div>
  <div class="flex items-center gap-2">
    <form method="POST" action="/api/queue/hold" class="inline">
      <input type="hidden" name="hold" value="${holdAll ? '0' : '1'}">
      <button class="btn ${holdAll ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' : 'btn-ghost'}">
        <i data-lucide="${holdAll ? 'play' : 'pause'}" class="size-4"></i>
        ${holdAll ? 'Resume' : 'Hold all'}
      </button>
    </form>
    <form method="POST" action="/api/queue/delay" class="inline flex items-center gap-1">
      <select name="delay" class="input py-1 px-2 text-xs w-20" onchange="this.form.submit()">
        <option value="0" ${autoRelease === 0 ? 'selected' : ''}>0s</option>
        <option value="3000" ${autoRelease === 3000 ? 'selected' : ''}>3s</option>
        <option value="5000" ${autoRelease === 5000 ? 'selected' : ''}>5s</option>
        <option value="10000" ${autoRelease === 10000 ? 'selected' : ''}>10s</option>
        <option value="30000" ${autoRelease === 30000 ? 'selected' : ''}>30s</option>
      </select>
      <span class="text-xs text-zinc-500">delay</span>
    </form>
  </div>
</div>

${processing.count > 0 ? `
<section class="card p-5 mb-6 border-emerald-500/30 bg-emerald-500/5">
  <div class="flex items-center gap-2 mb-3">
    <div class="animate-spin h-4 w-4 border-2 border-emerald-400 border-t-transparent rounded-full"></div>
    <h2 class="font-semibold text-emerald-300">Currently processing</h2>
  </div>
  <div class="space-y-2">
    ${processing.active.map(p => {
      const elapsed = Math.round(p.elapsedMs / 1000);
      const cancelPending = p.cancelRequested;
      return `<div class="flex items-center gap-3 p-3 rounded-lg bg-zinc-900/60 ${cancelPending ? 'border border-rose-500/30' : ''}">
        <div class="h-8 w-8 rounded-full ${cancelPending ? 'bg-rose-500/20' : 'bg-emerald-500/20'} flex items-center justify-center ${cancelPending ? 'text-rose-300' : 'text-emerald-300'} text-sm font-medium">${esc((p.name || '?').charAt(0).toUpperCase())}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium">${esc(p.name)}</span>
            ${cancelPending ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300">cancelling...</span>' : ''}
          </div>
          ${p.preview ? `<div class="text-xs text-zinc-400 truncate">${esc(p.preview)}</div>` : ''}
        </div>
        <div class="text-xs ${cancelPending ? 'text-rose-400' : 'text-emerald-400'} mr-2">${elapsed}s</div>
        ${p.bufferId && !cancelPending ? `<button onclick="cancelProcessing(${p.bufferId})" class="btn btn-danger btn-icon" title="Cancel"><i data-lucide="x" class="size-3.5"></i></button>` : ''}
      </div>`;
    }).join('')}
  </div>
</section>` : ''}

${waiting.length > 0 ? `
<section class="card p-5 mb-6 border-sky-500/30 bg-sky-500/5">
  <div class="flex items-center gap-2 mb-3">
    <i data-lucide="inbox" class="size-4 text-sky-400"></i>
    <h2 class="font-semibold text-sky-300">Waiting messages</h2>
    <span class="text-xs text-zinc-500">${waiting.length} in queue</span>
  </div>
  <div class="space-y-2">
    ${waiting.map((item, idx) => {
      const waitSecs = Math.round((Date.now() - item.addedAt) / 1000);
      return `<div class="flex items-center gap-3 p-3 rounded-lg bg-zinc-900/60 border border-zinc-800">
        <div class="h-8 w-8 rounded-full bg-sky-500/20 flex items-center justify-center text-sky-300 text-sm font-medium">${esc((item.name || '?').charAt(0).toUpperCase())}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium">${esc(item.name)}</span>
            <span class="text-[10px] text-zinc-500">#${item.id}</span>
            ${item.priority > 0 ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">priority ${item.priority}</span>` : ''}
          </div>
          ${item.preview ? `<div class="text-xs text-zinc-400 truncate mt-0.5">${esc(item.preview)}</div>` : ''}
        </div>
        <div class="text-xs text-sky-400 mr-2">${waitSecs}s</div>
        <div class="flex items-center gap-1">
          ${idx > 0 ? `<button onclick="prioritizeItem(${item.id})" class="btn btn-ghost btn-icon" title="Move to front"><i data-lucide="arrow-up-to-line" class="size-3.5"></i></button>` : ''}
          <button onclick="cancelIncoming(${item.id})" class="btn btn-danger btn-icon" title="Cancel"><i data-lucide="x" class="size-3.5"></i></button>
        </div>
      </div>`;
    }).join('')}
  </div>
</section>` : ''}

${waiting.length === 0 && processing.count === 0 ? `
<section class="card p-8 text-center">
  <i data-lucide="inbox" class="size-10 text-zinc-600 mx-auto mb-3"></i>
  <p class="text-zinc-400">Queue is empty</p>
  <p class="text-sm text-zinc-500 mt-1">Messages appear here when waiting to be processed.</p>
</section>` : ''}

${recentHistory.length > 0 ? `
<section class="card p-5">
  <div class="flex items-center gap-2 mb-4">
    <i data-lucide="history" class="size-4 text-zinc-400"></i>
    <h2 class="font-semibold text-zinc-400">Recent history</h2>
  </div>
  <div class="space-y-2 max-h-48 overflow-y-auto">
    ${recentHistory.map(item => {
      const icon = item.status === 'done' ? 'check' : 'x';
      const color = item.status === 'done' ? 'emerald' : 'rose';
      return `<div class="flex items-center gap-3 p-2 rounded bg-zinc-900/40 text-sm">
        <i data-lucide="${icon}" class="size-4 text-${color}-400"></i>
        <span class="text-zinc-400 truncate flex-1">${esc(item.name)}: ${esc(item.preview || '').slice(0, 50)}</span>
        <span class="text-[10px] text-zinc-600">${item.status}</span>
      </div>`;
    }).join('')}
  </div>
</section>` : ''}

<script>
async function cancelIncoming(id) {
  if (!confirm('Cancel this message?')) return;
  const res = await fetch('/api/queue/incoming/' + id, { method: 'DELETE' });
  if (res.ok) location.reload();
  else alert('Failed to cancel');
}

async function cancelProcessing(id) {
  if (!confirm('Cancel current processing?')) return;
  const res = await fetch('/api/queue/processing/' + id + '/cancel', { method: 'POST' });
  if (res.ok) location.reload();
  else alert('Failed to cancel');
}

async function prioritizeItem(id) {
  const res = await fetch('/api/queue/incoming/' + id + '/prioritize', { method: 'POST' });
  if (res.ok) location.reload();
  else alert('Failed to prioritize');
}

// Live queue updates via SSE. EventSource auto-reconnects, no polling needed.
(function() {
  const es = new EventSource('/queue/stream');
  let debounce = null;
  es.onmessage = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => location.reload(), 100);
  };
})();
</script>
`;
    res.send(LAYOUT('Queue', body, '/queue'));
  });

  // Queue SSE stream - notifies when queue changes
  app.get('/queue/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
    const offBuffer = incomingBuffer.onChange(() => res.write('data: update\n\n'));
    const offProc = processingState.onStateChange(() => res.write('data: update\n\n'));
    req.on('close', () => { offBuffer(); offProc(); res.end(); });
  });

  // Queue API - cancel incoming message
  app.delete('/api/queue/incoming/:id', (req, res) => {
    const id = Number(req.params.id);
    const ok = incomingBuffer.cancel(id);
    res.status(ok ? 200 : 404).json({ ok });
  });

  // Queue API - prioritize incoming message
  app.post('/api/queue/incoming/:id/prioritize', (req, res) => {
    const id = Number(req.params.id);
    const ok = incomingBuffer.moveToFront(id);
    res.status(ok ? 200 : 404).json({ ok });
  });

  // Queue API - hold/resume processing
  app.post('/api/queue/hold', express.urlencoded({ extended: false }), (req, res) => {
    const hold = req.body.hold === '1';
    incomingBuffer.setHoldAll(hold);
    res.redirect('/queue');
  });

  // Queue API - set auto-release delay
  app.post('/api/queue/delay', express.urlencoded({ extended: false }), (req, res) => {
    const delay = Math.max(0, parseInt(req.body.delay) || 0);
    incomingBuffer.setAutoRelease(delay);
    res.redirect('/queue');
  });

  // Queue API - cancel currently processing message
  app.post('/api/queue/processing/:id/cancel', async (req, res) => {
    const id = Number(req.params.id);
    const flagged = incomingBuffer.cancelProcessing(id);
    // Also interrupt the live AI run for that chat, so cancel works mid-run
    // and not just before/after the call.
    const item = incomingBuffer.listAll().find((i) => i.id === id);
    const stopped = item ? await activeRuns.stop(item.jid).catch(() => 0) : 0;
    const ok = flagged || stopped > 0;
    res.status(ok ? 200 : 404).json({ ok, stopped });
  });

  // ─── Upload ────────────────────────────────────────────────────────────────
  // Drop files (zips, docs, anything) from the dashboard; they land in
  // data/uploads/ where the bot (and Claude's tools) can read them.
  const UPLOAD_DIR = path.resolve('data', 'uploads');
  fsSync.mkdirSync(UPLOAD_DIR, { recursive: true });
  const safeName = (name) => path.basename(String(name || 'file'))
    .replace(/[^\w.\-() ]+/g, '_').slice(0, 200) || 'file';
  const uploadStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      let name = safeName(file.originalname);
      // avoid clobbering an existing file
      let target = path.join(UPLOAD_DIR, name);
      if (fsSync.existsSync(target)) {
        const ext = path.extname(name);
        const base = name.slice(0, name.length - ext.length);
        name = `${base}-${Date.now()}${ext}`;
      }
      cb(null, name);
    },
  });
  const upload = multer({ storage: uploadStorage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } }); // 2GB

  function listUploads() {
    try {
      return fsSync.readdirSync(UPLOAD_DIR)
        .filter((f) => !f.startsWith('.'))
        .map((f) => {
          const st = fsSync.statSync(path.join(UPLOAD_DIR, f));
          return { name: f, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch { return []; }
  }
  const fmtSize = (n) => n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? (n / 1e3).toFixed(0) + ' KB' : n + ' B';

  app.get('/upload', (_req, res) => {
    const files = listUploads();
    const rows = files.length ? files.map((f) => `
      <div class="flex items-center justify-between p-3 rounded-lg bg-zinc-900/60 border border-zinc-800">
        <div class="min-w-0">
          <a href="/uploads/${encodeURIComponent(f.name)}" class="text-sm text-emerald-300 hover:underline truncate block">${esc(f.name)}</a>
          <span class="text-xs text-zinc-500">${fmtSize(f.size)} · ${new Date(f.mtime).toLocaleString()}</span>
        </div>
        <button onclick="delFile('${esc(f.name).replace(/'/g, "\\'")}')" class="btn btn-ghost text-xs text-red-400">Delete</button>
      </div>`).join('') : '<p class="text-sm text-zinc-500">No files uploaded yet.</p>';
    const body = `
<div class="mb-6">
  <h1 class="text-2xl md:text-3xl font-semibold tracking-tight">Upload</h1>
  <p class="text-sm text-zinc-500 mt-1">Drop files here and they're stored in <code>data/uploads/</code> on the server.</p>
</div>
<form id="upForm" method="POST" action="/api/upload" enctype="multipart/form-data">
  <label id="drop" for="fileInput" class="flex flex-col items-center justify-center gap-2 p-10 rounded-xl border-2 border-dashed border-zinc-700 hover:border-emerald-500/50 bg-zinc-900/40 cursor-pointer transition-colors">
    <i data-lucide="upload-cloud" class="size-8 text-zinc-500"></i>
    <span class="text-sm text-zinc-400">Drag &amp; drop files here, or click to choose</span>
    <span id="picked" class="text-xs text-emerald-300"></span>
    <input id="fileInput" type="file" name="files" multiple class="hidden">
  </label>
  <div class="mt-3 flex items-center gap-3">
    <button type="submit" class="btn bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">Upload</button>
    <span id="status" class="text-xs text-zinc-500"></span>
  </div>
</form>
<div class="mt-8">
  <h2 class="text-sm font-semibold text-zinc-300 mb-3">Uploaded files</h2>
  <div class="space-y-2">${rows}</div>
</div>
<script>
  const drop = document.getElementById('drop');
  const input = document.getElementById('fileInput');
  const picked = document.getElementById('picked');
  const form = document.getElementById('upForm');
  const status = document.getElementById('status');
  input.addEventListener('change', () => { picked.textContent = input.files.length ? input.files.length + ' file(s) selected' : ''; });
  ['dragover','dragenter'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add('border-emerald-500/60'); }));
  ['dragleave','drop'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.remove('border-emerald-500/60'); }));
  drop.addEventListener('drop', ev => { input.files = ev.dataTransfer.files; picked.textContent = input.files.length + ' file(s) selected'; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.files.length) { status.textContent = 'Pick a file first.'; return; }
    status.textContent = 'Uploading…';
    const fd = new FormData();
    for (const f of input.files) fd.append('files', f);
    try {
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      if (r.ok) { status.textContent = 'Done.'; location.reload(); }
      else { status.textContent = 'Upload failed (' + r.status + ').'; }
    } catch (err) { status.textContent = 'Upload error: ' + err.message; }
  });
  async function delFile(name) {
    if (!confirm('Delete ' + name + '?')) return;
    const r = await fetch('/api/uploads/' + encodeURIComponent(name), { method: 'DELETE' });
    if (r.ok) location.reload();
  }
</script>`;
    res.send(LAYOUT('Upload', body, '/upload'));
  });

  app.post('/api/upload', upload.array('files', 50), (req, res) => {
    const names = (req.files || []).map((f) => f.filename);
    console.log(`upload: stored ${names.length} file(s) -> ${UPLOAD_DIR}: ${names.join(', ')}`);
    res.json({ ok: true, stored: names });
  });

  app.get('/api/uploads', (_req, res) => res.json({ files: listUploads(), dir: UPLOAD_DIR }));

  app.get('/uploads/:name', (req, res) => {
    const name = safeName(req.params.name);
    const fp = path.join(UPLOAD_DIR, name);
    if (!fsSync.existsSync(fp)) return res.status(404).send('Not found');
    res.download(fp, name);
  });

  app.delete('/api/uploads/:name', (req, res) => {
    const name = safeName(req.params.name);
    const fp = path.join(UPLOAD_DIR, name);
    try { fsSync.unlinkSync(fp); res.json({ ok: true }); }
    catch { res.status(404).json({ ok: false }); }
  });

  // Processing state SSE
  app.get('/processing/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
    // Send initial state
    res.write(`data: ${JSON.stringify(processingState.getState())}\n\n`);
    const off = processingState.onStateChange((state) => res.write(`data: ${JSON.stringify(state)}\n\n`));
    req.on('close', () => { off(); res.end(); });
  });

  // ─── Logs / stats endpoints ────────────────────────────────────────────────
  app.get('/logs/recent', (req, res) => {
    const n = Math.min(500, Math.max(1, Number(req.query.n) || 200));
    res.json(recentLogs(n));
  });

  app.get('/logs/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
    const off = onLog((entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`));
    req.on('close', () => { off(); res.end(); });
  });

  // SSE endpoint for live processing/typing indicator
  app.get('/processing/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
    // Send initial state
    res.write(`data: ${JSON.stringify(processingState.getState())}\n\n`);
    const off = processingState.onStateChange((state) => res.write(`data: ${JSON.stringify(state)}\n\n`));
    req.on('close', () => { off(); res.end(); });
  });

  app.get('/processing/state', (_req, res) => {
    res.json(processingState.getState());
  });

  app.get('/stats.json', (_req, res) => {
    res.json({ ...snapshot(), queueDepth: queueDepth(), plugins: listPlugins(), allowlist: listAllowed() });
  });

  // Health endpoint — returns 200 only when the WhatsApp socket is actually
  // open. pm2-style watchdogs can poll this and restart on failure.
  app.get('/healthz', (_req, res) => {
    // The Baileys websocket can remain OPEN briefly after WhatsApp reports a
    // terminal logout. socket-holder is updated from connection.update and is
    // therefore the authoritative application-level connection state.
    const open = isSocketOpen();
    const status = open ? 200 : 503;
    res.status(status).json({
      ok: open,
      uptimeMs: snapshot().uptimeMs,
      socket: open ? 'open' : 'closed',
      checkedAt: new Date().toISOString(),
    });
  });

  let server = null;
  return {
    start({ port = Number(process.env.WEB_PORT) || 7777, host = process.env.WEB_HOST || '127.0.0.1' } = {}) {
      return new Promise((resolve) => {
        server = app.listen(port, host, () => {
          console.log(`webui listening on http://${host}:${port}`);
          resolve();
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      });
    },
  };
}
