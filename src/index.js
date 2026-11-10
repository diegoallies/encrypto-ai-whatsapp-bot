// The dashboard persists settings to .env. PM2 can retain stale values from a
// previous restart, so explicitly let the persisted settings win at boot.
import dotenv from 'dotenv';
dotenv.config({ override: true });
import { promises as fs } from 'fs';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from 'baileys';
import { getMessage, bindOutboundStore } from './outbound-store.js';
import { bindAntiDelete, startWacliAntiDelete } from './anti-delete.js';
import { createCache } from './cache.js';
import { setSocket, markOpen, markClosed, liveSocket, getSocket } from './socket-holder.js';
import { reliableSend } from './reliable-send.js';
import qrcode from 'qrcode-terminal';
import { createLogger } from './logger.js';
import { isAllowed, allowlistSize } from './allowlist.js';
import { askClaude, resetSession } from './claude-agent.js';
import { createHandler } from './handler.js';
import { snapshot } from './stats.js';
import { queueDepth } from './queue.js';
import { splitForWhatsApp } from './chunk.js';
import * as scheduler from './scheduler.js';
import * as memoryModule from './memory.js';
import { ensureMemoryLayout } from './memory.js';
import * as heartbeat from './heartbeat.js';
import { emailCheckPlugin } from './integrations/himalaya.js';
import { authBackupPlugin } from './integrations/auth-backup.js';
import { gitBackupPlugin } from './integrations/git-backup.js';
import { wacliSyncPlugin } from './integrations/wacli-sync.js';
import { crowdsecPlugin } from './integrations/crowdsec.js';
import relayReminderPlugin from './heartbeat-plugins/relay-reminder.js';
import missedRelayCheckPlugin from './heartbeat-plugins/missed-relay-check.js';
import { pendingReplyPlugin } from './pending-reply-check.js';
import { parseDuration } from './cron-time.js';
import { installLogCapture } from './log-buffer.js';
import { createWebUI } from './webui.js';
import { startNtfyBridge } from './integrations/ntfy.js';
import { loadAnalytics } from './analytics.js';
import { initDb } from './db.js';
import * as connectionState from './connection-state.js';
import * as botPower from './bot-power.js';
import * as incomingBuffer from './incoming-buffer.js';
import './builtin-commands.js'; // side-effect: registers /reset, /stats, /restart, /remind, /cron, /poll, /help
installLogCapture();

// Catch async errors that escape the route handlers / heartbeat plugins.
// Express 4 swallows async errors silently (that's how the chat freeze
// happened pre-await fix); without this we'd never see them.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.stack || err);
});

const AUTH_DIR = 'auth_info_baileys';
const HEARTBEAT_MS = 5 * 60_000;

const logger = createLogger();

let shuttingDown = false;

// One-time vs per-connection state. The heavy setup (DB, scheduler, handler,
// heartbeat, webui) runs ONCE in bootOnce(). Only the socket itself is rebuilt
// on reconnect, in connect(). Everything downstream reads the live socket
// through the `liveSocket` proxy, so a reconnect never strands them on a dead
// socket. This is the fix for "bot goes silent after reconnecting".
let booted = false;
let connecting = false;
let reconnectAttempts = 0;
let dispatchFn = null;

// Caches that fix the "Waiting for this message" retry race. Kept at module
// scope so they survive reconnects (Baileys requires msgRetryCounterCache to
// be external and stable).
const msgRetryCounterCache = createCache({ ttlMs: 60 * 60_000, max: 5000 });
const userDevicesCache = createCache({ ttlMs: 5 * 60_000, max: 1000 });
const mediaCache = createCache({ ttlMs: 60 * 60_000, max: 1000 });
const groupCache = createCache({ ttlMs: 5 * 60_000, max: 500 });

// One-time initialization. Safe to call repeatedly — only runs once.
async function bootOnce() {
  if (booted) return;
  booted = true;

  await ensureMemoryLayout();
  await initDb();
  await botPower.init();
  incomingBuffer.setHoldAll(!botPower.isPoweredOn());
  await loadAnalytics();
  await connectionState.init();
  await (await import('./allowlist.js')).initAllowlist();

  // Check allowlist AFTER postgres init (allowlist is in postgres now, not .env)
  if (allowlistSize() === 0) {
    console.warn(
      '⚠  Allowlist is empty. The bot will not respond to anyone until you add contacts.',
    );
  }
  await (await import('./sessions-store.js')).ready();

  // Scheduler — initialized once. onFire sends through the live socket via
  // reliableSend, so cron messages survive reconnects.
  await scheduler.initScheduler({
    onFire: async (job) => {
      try {
        let reply;
        if (job.mode === 'prompt') {
          reply = await askClaude(job.jid, `[scheduled task] ${job.text}`);
        } else {
          reply = `🔔 ${job.text}`;
        }
        for (const part of splitForWhatsApp(reply)) {
          await reliableSend(liveSocket, job.jid, { text: part });
        }
        console.log(`cron fired id=${job.id} jid=${job.jid} mode=${job.mode}`);
      } catch (err) {
        console.error('cron fire failed:', err);
      }
    },
  });

  // Handler — created once. It captures the `liveSocket` proxy, which always
  // forwards to whatever socket is currently live.
  const { dispatch } = createHandler({
    sock: liveSocket,
    agent: { askClaude, resetSession },
    isAllowed,
    scheduler,
  });
  dispatchFn = dispatch;

  // Heartbeat plugins — registered once.
  const primaryJid = (process.env.OWNER_JIDS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
  if (process.env.HEARTBEAT_EMAIL_CHECK === '1' && primaryJid) {
    const intervalMs = safeDuration(process.env.HEARTBEAT_EMAIL_INTERVAL, 30 * 60_000);
    heartbeat.register(emailCheckPlugin({ intervalMs }));
  }
  if (process.env.AUTH_BACKUP !== '0') heartbeat.register(authBackupPlugin());
  if (process.env.GIT_BACKUP !== '0') heartbeat.register(gitBackupPlugin());
  if (process.env.WACLI_STORE) heartbeat.register(wacliSyncPlugin());
  if (process.env.CROWDSEC === '1') heartbeat.register(crowdsecPlugin());
  heartbeat.register(relayReminderPlugin);
  if (process.env.WACLI_STORE) heartbeat.register(missedRelayCheckPlugin);
  heartbeat.register(pendingReplyPlugin);
  if (process.env.WAKE_UP === '1') {
    const wm = await import('./integrations/wake-up.js');
    heartbeat.register(wm.wakeUpPlugin());
  }
  if (primaryJid) heartbeat.startHeartbeat({ sock: liveSocket, jid: primaryJid });

  // Anti-delete on the owner's main account (wacli mirror). Bot-account side is
  // bound per socket in connect().
  if (primaryJid) startWacliAntiDelete().catch((err) => console.error('anti-delete start failed:', err));

  // Daily digest — auto-install / remove a recurring prompt cron based on env.
  if (primaryJid) await syncDailyDigest(primaryJid);

  // ntfy bridge (optional, env-gated).
  if (primaryJid) startNtfyBridge({ sock: liveSocket, jid: primaryJid });

  // Web UI (localhost by default) — started once.
  if (process.env.WEB_UI !== '0') {
    try {
      const webui = createWebUI({
        scheduler,
        memoryModule,
        sock: liveSocket,
        power: {
          isOn: botPower.isPoweredOn,
          off: async () => {
            await botPower.setPoweredOn(false);
            incomingBuffer.setHoldAll(true);
            reconnectAttempts = 0;
            try { getSocket()?.end?.(undefined); } catch {}
            markClosed();
          },
          on: async () => {
            await botPower.setPoweredOn(true);
            incomingBuffer.setHoldAll(false);
            await connect();
          },
        },
      });
      await webui.start();
    } catch (err) {
      console.error('webui failed to start:', err.message);
    }
  }
}

// (Re)build the WhatsApp socket and wire its event listeners. Guarded so two
// reconnects can't run at once and pile up dead sockets.
async function connect() {
  if (connecting || shuttingDown || !botPower.isPoweredOn()) return;
  connecting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    await fs.chmod(AUTH_DIR, 0o700).catch(() => {});

    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      // Cacheable wrapper around the signal key store — fixes slow lookups
      // and works around some decrypt retries.
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    browser: ['Claude Bot', 'Chrome', '1.0.0'],
    // Required for WhatsApp's retry-receipt protocol. Without this, when a
    // recipient asks the sender to resend an encrypted message, Baileys has
    // nothing to retry with and the recipient stays on "Waiting for this
    // message. This may take a while."
    getMessage,
    msgRetryCounterCache,
    userDevicesCache,
    mediaCache,
    // Group metadata is fetched on every send to a group otherwise — slow,
    // and on rate-limit it makes the encrypt path fail. Even pure-DM bots
    // benefit because device-list discovery walks group metadata in some
    // edge cases.
    cachedGroupMetadata: async (jid) => groupCache.get(jid),
    // Don't try to decrypt status broadcasts — they're noisy and we never
    // reply to them anyway. Trimming this reduces the retry-receipt churn.
    shouldIgnoreJid: (jid) => Boolean(jid) && (jid === 'status@broadcast' || jid.endsWith('@broadcast')),
    // Tighter retry budget — defaults are 5/250ms. Most real failures want
    // a session reset, not another spin of the retry wheel.
    maxMsgRetryCount: Number(process.env.MAX_MSG_RETRY) || 5,
    retryRequestDelayMs: Number(process.env.RETRY_REQUEST_DELAY_MS) || 500,
  });

    // Publish the new socket so every sender uses it from now on.
    setSocket(sock);
    bindOutboundStore(sock);
    bindAntiDelete(sock);

    // Keep group metadata cache warm so cachedGroupMetadata() actually hits.
    sock.ev.on('groups.update', async (events) => {
      for (const ev of events) {
        try {
          const meta = await sock.groupMetadata(ev.id);
          groupCache.set(ev.id, meta);
        } catch {}
      }
    });
    sock.ev.on('group-participants.update', async (ev) => {
      try {
        const meta = await sock.groupMetadata(ev.id);
        groupCache.set(ev.id, meta);
      } catch {}
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', onConnectionUpdate);
    if (dispatchFn) sock.ev.on('messages.upsert', dispatchFn);
  } finally {
    connecting = false;
  }
}

function onConnectionUpdate(update) {
  const { connection, lastDisconnect, qr } = update;
  if (qr) {
    console.log('\nScan this QR with WhatsApp → Settings → Linked Devices → Link a Device:\n');
    qrcode.generate(qr, { small: true });
  }
  if (connection === 'open') {
    reconnectAttempts = 0;
    markOpen();
    console.log('✓ WhatsApp connected. Bot is live.');
    memoryModule.appendDailyNote('boot — WhatsApp connected, bot is live').catch(() => {});
    connectionState.recordOpen();
  }
  if (connection === 'close') {
    markClosed();
    const code = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = code === DisconnectReason.loggedOut;
    connectionState.recordClose(code);
    if (loggedOut) {
      console.log(`Connection closed (code=${code}). Logged out — delete auth_info_baileys/ to re-pair.`);
      return;
    }
    if (shuttingDown || !botPower.isPoweredOn()) return;
    // Exponential backoff so we don't hammer WhatsApp (ban risk) when it keeps
    // closing the connection. 1s, 2s, 4s … capped at 30s.
    reconnectAttempts += 1;
    const delay = Math.min(30_000, 1000 * 2 ** (reconnectAttempts - 1));
    console.log(`Connection closed (code=${code}). Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})…`);
    setTimeout(() => connect().catch((err) => console.error('Reconnect failed:', err)), delay);
  }
}

async function start() {
  await bootOnce();
  await connect();
}

function safeDuration(input, fallback) {
  if (!input) return fallback;
  try { return parseDuration(input); } catch { return fallback; }
}

// Daily digest scheduling. The marker text below lets us find and update the
// auto-installed job across restarts, so we don't duplicate or strand it.
const DIGEST_MARKER = '[daily-digest]';
const DEFAULT_DIGEST_PROMPT = `${DIGEST_MARKER} Generate the owner's morning digest. Pull together:
- Today's scheduled jobs/reminders (\`node scripts/cron.mjs list\`, then filter to today)
- Unread email summary if \`himalaya\` is installed (be brief — sender + subject + 1-line gist)
- The "## Saved" section of MEMORY.md, if any (echo it back and ask if it should be cleared)
- Anything notable from yesterday's daily note (memory/<yesterday>.md)

Lead with the most urgent item. 4-6 bullets max. WhatsApp-friendly — short lines, no headings.`;

async function syncDailyDigest(jid) {
  const enabled = process.env.DAILY_DIGEST === '1';
  const cronExpr = process.env.DAILY_DIGEST_CRON || '0 7 * * *';
  const prompt = process.env.DAILY_DIGEST_PROMPT || DEFAULT_DIGEST_PROMPT;
  const existing = scheduler.listJobs().find(
    (j) => j.jid === jid && typeof j.text === 'string' && j.text.startsWith(DIGEST_MARKER),
  );

  if (!enabled) {
    if (existing) {
      await scheduler.removeJob(existing.id);
      console.log('daily-digest: removed (DAILY_DIGEST != 1)');
    }
    return;
  }
  if (existing) {
    // Refresh cron/prompt if env changed.
    if (existing.recurring?.cron !== cronExpr || existing.text !== prompt) {
      await scheduler.removeJob(existing.id);
    } else {
      return;
    }
  }
  try {
    const job = await scheduler.addJob({
      jid,
      mode: 'prompt',
      text: prompt,
      recurring: { cron: cronExpr },
    });
    console.log(`daily-digest: scheduled id=${job.id} cron="${cronExpr}"`);
  } catch (err) {
    console.error('daily-digest: install failed:', err.message);
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal} — closing WhatsApp connection…`);
  try { scheduler.shutdownScheduler(); } catch {}
  try { (await import('./playbook-schedules.js')).shutdownPlaybookSchedules(); } catch {}
  try { getSocket()?.end?.(undefined); } catch {}
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

setInterval(() => {
  const s = snapshot();
  console.log(
    `heartbeat uptime=${Math.floor(s.uptimeMs / 1000)}s messages=${s.messages} errors=${s.errors} queue=${queueDepth()}`,
  );
}, HEARTBEAT_MS).unref();

start().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
