// Built-in slash commands. Imported for side effect from index.js so they
// register themselves at startup. Default auth is 'owner' (see commands.js);
// commands that should be open to any allowlisted JID set auth: 'allowlist'.

import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { registerCommand } from './commands.js';
import { resolveNodePath } from './util/node-path.js';
import { queueDepth } from './queue.js';
import { formatStats } from './stats.js';
import { parseWhen } from './cron-time.js';
import { sendPoll } from './poll.js';
import { addAllowed, removeAllowed, listAllowed, reloadAllowlist } from './allowlist.js';
import { setAwake, isAwake } from './group-mode.js';
import { chatType } from './parse.js';
import { mostRecentPending } from './stranger-notify.js';
import { appendDailyNote } from './memory.js';
import { listPlaybooks, loadPlaybook } from './playbooks.js';
import { searchChats, snippetOf } from './chat-search.js';

function fmtJobLine(job) {
  const when = new Date(job.runAt).toLocaleString();
  const rep = job.recurring
    ? `  ↻ ${job.recurring.every ? `every ${job.recurring.every}` : `cron "${job.recurring.cron}"`}`
    : '';
  return `${job.id}  ${when}  [${job.mode}]${rep}  ${job.text}`;
}

// Allowlist-open: any allowed user can clear their own thread.
registerCommand({
  name: 'reset',
  auth: 'allowlist',
  async handler({ sock, jid, agent }) {
    agent.resetSession(jid);
    await sock.sendMessage(jid, { text: 'Conversation reset.' });
  },
});

// Allowlist-open: help text is harmless to anyone allowed in.
registerCommand({
  name: 'help',
  auth: 'allowlist',
  async handler({ sock, jid }) {
    await sock.sendMessage(jid, {
      text:
        'Commands:\n' +
        '  /reset                   clear your conversation history\n' +
        '  /help                    this message\n' +
        '  /stop  (or stop, esc)    stop what I\'m doing right now\n' +
        '\n' +
        'Owner-only:\n' +
        '  /stats                   uptime, message + error counts\n' +
        '  /remind <when> <text>    one-shot reminder (+1h, 18:00, ISO)\n' +
        '  /cron list | rm <id>     scheduled jobs\n' +
        '  /poll Q | a | b | …      WhatsApp native poll\n' +
        '  /allow <jid>             let a stranger through\n' +
        '  /deny <jid>              revoke a JID\n' +
        '  /who                     list allowlisted JIDs\n' +
        '  /opencode <prompt>       route a task to OpenCode free model\n' +
        '  /stop all                stop every chat\'s running task\n' +
        '  /restart                 restart the bot\n' +
        '\n' +
        'Texting while I work feeds your message into the running task.',
    });
  },
});

// Everything below defaults to owner-only (commands.js default).
registerCommand({
  name: 'stats',
  async handler({ sock, jid }) {
    await sock.sendMessage(jid, { text: formatStats({ queueDepth: queueDepth() }) });
  },
});

registerCommand({
  name: 'restart',
  async handler({ sock, jid }) {
    await sock.sendMessage(jid, { text: 'Restarting...' }).catch(() => {});
    appendDailyNote(`restart requested by ${jid}`).catch(() => {});
    const restartScript = path.resolve('scripts/restart.mjs');
    // Use resolveNodePath() rather than process.execPath: the latter can be a
    // stale version-pinned Homebrew Cellar path after `brew upgrade node`, in
    // which case spawn() throws ENOENT. Also wrap in try/catch so a spawn
    // failure logs instead of crashing the bot with uncaughtException.
    try {
      const child = spawn(resolveNodePath(), [restartScript], { detached: true, stdio: 'ignore' });
      child.on('error', (err) => {
        console.error(`restart: spawn failed: ${err.message}`);
      });
      child.unref();
    } catch (err) {
      console.error(`restart: spawn threw: ${err.message}`);
      await sock.sendMessage(jid, { text: `Restart failed: ${err.message}` }).catch(() => {});
    }
  },
});

registerCommand({
  name: 'reload-allowlist',
  async handler({ sock, jid }) {
    const count = await reloadAllowlist();
    if (count >= 0) {
      await sock.sendMessage(jid, { text: `Allowlist reloaded: ${count} entries` });
    } else {
      await sock.sendMessage(jid, { text: 'Allowlist reload failed' });
    }
  },
});

registerCommand({
  name: 'remind',
  async handler({ sock, jid, args, scheduler }) {
    if (!scheduler) {
      await sock.sendMessage(jid, { text: 'Scheduler not configured.' });
      return;
    }
    const m = /^(\S+)\s+(.+)$/.exec(args);
    if (!m) {
      await sock.sendMessage(jid, {
        text: 'Usage: /remind <when> <text>\nExamples:\n  /remind +1h Take out trash\n  /remind 18:00 Call mom\n  /remind 2026-05-20T09:00 Standup',
      });
      return;
    }
    const [, when, text] = m;
    let runAt;
    try {
      runAt = parseWhen(when);
    } catch {
      await sock.sendMessage(jid, {
        text: `Couldn't parse "${when}". Try +1h, 18:00, or 2026-05-20T09:00.`,
      });
      return;
    }
    const job = await scheduler.addJob({ jid, runAt: runAt.toISOString(), mode: 'notify', text });
    await sock.sendMessage(jid, {
      text: `🗓 Scheduled ${job.id} for ${runAt.toLocaleString()}: ${text}`,
    });
  },
});

registerCommand({
  name: 'cron',
  async handler({ sock, jid, args, scheduler }) {
    if (!scheduler) {
      await sock.sendMessage(jid, { text: 'Scheduler not configured.' });
      return;
    }
    const parts = args.split(/\s+/).filter(Boolean);
    const sub = parts[0];

    if (sub === 'list' || !sub) {
      const jobs = scheduler.listJobsFor(jid);
      if (jobs.length === 0) {
        await sock.sendMessage(jid, { text: '(no scheduled jobs)' });
        return;
      }
      await sock.sendMessage(jid, { text: jobs.map(fmtJobLine).join('\n') });
      return;
    }
    if (sub === 'rm' || sub === 'remove') {
      const id = parts[1];
      if (!id) { await sock.sendMessage(jid, { text: 'Usage: /cron rm <id>' }); return; }
      const ok = await scheduler.removeJob(id);
      await sock.sendMessage(jid, { text: ok ? `✓ removed ${id}` : `no job with id ${id}` });
      return;
    }
    await sock.sendMessage(jid, { text: 'Usage: /cron list · /cron rm <id>' });
  },
});

registerCommand({
  name: 'poll',
  async handler({ sock, jid, args }) {
    const parts = args.split('|').map((s) => s.trim()).filter(Boolean);
    if (parts.length < 3) {
      await sock.sendMessage(jid, {
        text: 'Usage: /poll Question | option 1 | option 2 [ | option 3 ...]',
      });
      return;
    }
    const [question, ...options] = parts;
    try {
      await sendPoll(sock, jid, question, options);
    } catch (err) {
      await sock.sendMessage(jid, { text: `Couldn't send poll: ${err.message}` }).catch(() => {});
    }
  },
});

// ─── Allowlist management ─────────────────────────────────────────────────
registerCommand({
  name: 'allow',
  async handler({ sock, jid, args }) {
    const arg = (args || '').trim();
    // No arg → allow the most recently pinged stranger.
    if (!arg) {
      const recent = mostRecentPending();
      if (!recent) {
        await sock.sendMessage(jid, { text: 'Usage: /allow <jid|phone>\n(or just "allow" as a quote-reply to the stranger-ping message)' });
        return;
      }
      addAllowed(recent.strangerJid);
      const who = recent.strangerName || recent.prettyPhone || recent.strangerJid;
      await sock.sendMessage(jid, { text: `✓ Allowed ${who}.` });
      appendDailyNote(`allow ${who} (${recent.strangerJid}) via /allow`).catch(() => {});
      return;
    }
    // Accept phone numbers too (auto-normalise).
    const target = arg.includes('@') ? arg : `${arg.replace(/\D/g, '')}@s.whatsapp.net`;
    const ok = addAllowed(target);
    await sock.sendMessage(jid, {
      text: ok ? `✓ allowed ${target}` : `${target} is already allowed (or invalid).`,
    });
    if (ok) appendDailyNote(`allow ${target} via /allow`).catch(() => {});
  },
});

registerCommand({
  name: 'deny',
  async handler({ sock, jid, args }) {
    const target = args.trim();
    if (!target) {
      await sock.sendMessage(jid, { text: 'Usage: /deny <jid>' });
      return;
    }
    const ok = removeAllowed(target);
    await sock.sendMessage(jid, {
      text: ok ? `✓ removed ${target}` : `${target} wasn't on the allowlist.`,
    });
    if (ok) appendDailyNote(`deny ${target} via /deny`).catch(() => {});
  },
});

registerCommand({
  name: 'suggest',
  async handler({ sock, jid, args, agent, msg }) {
    // Pull the message body to suggest replies to. Two paths:
    //   1. /suggest <text>   — args is the message
    //   2. /suggest          — quote a message and just say /suggest
    const { quotedMessage } = await import('./parse.js');
    const quoted = quotedMessage(msg);
    const target = (args || '').trim() || (quoted?.text || '').trim();
    if (!target) {
      await sock.sendMessage(jid, {
        text: 'Usage: quote a message and reply /suggest, or /suggest <text>',
      });
      return;
    }
    const prompt =
      `Generate exactly 3 SHORT (≤120 chars each) reply suggestions for this WhatsApp message from someone the owner knows. ` +
      `Match the owner's casual, no-bullshit tone. Different angles: 1) friendly/agreeable, 2) deflect/buy time, 3) honest/direct. ` +
      `Reply ONLY in this format, no preamble:\n\n` +
      `1. <reply 1>\n2. <reply 2>\n3. <reply 3>\n\n` +
      `--- the message to reply to ---\n${target}`;
    try {
      const result = await agent.askClaude(jid, prompt);
      const text = typeof result === 'string' ? result : result?.text || '';
      // Parse the 3 options.
      const opts = text.split('\n').map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean).slice(0, 3);
      if (opts.length < 2) {
        await sock.sendMessage(jid, { text: `Couldn't generate clean options. Raw:\n\n${text}` });
        return;
      }
      await sendPoll(sock, jid, 'Pick a reply:', opts);
    } catch (err) {
      await sock.sendMessage(jid, { text: `⚠ Suggest failed: ${err.message.slice(0, 200)}` }).catch(() => {});
    }
  },
});

registerCommand({
  name: 'summarize',
  async handler({ sock, jid, agent }) {
    await sock.sendMessage(jid, { text: '📝 Summarising recent messages…' }).catch(() => {});
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    const file = path.join('data', 'chats', `${jid.replace(/[^\w@.-]/g, '_')}.jsonl`);
    let lines = [];
    try {
      const raw = await fs.readFile(file, 'utf-8');
      lines = raw.split('\n').filter(Boolean).slice(-200);
    } catch {}
    if (lines.length === 0) {
      await sock.sendMessage(jid, { text: 'No transcript on disk for this chat yet.' });
      return;
    }
    const transcript = lines.map((l) => {
      try {
        const e = JSON.parse(l);
        const who = e.role === 'user' ? 'user' : 'me';
        return `${(e.t || '').slice(0, 16)}  ${who}: ${(e.text || '').slice(0, 300)}`;
      } catch { return ''; }
    }).filter(Boolean).join('\n');
    const prompt =
      `Summarise this WhatsApp transcript between user and me (the bot). Pull out:\n` +
      `1. What we were trying to do\n` +
      `2. Decisions made / facts learned about the user\n` +
      `3. Open threads\n\n` +
      `Then run this Bash: append the summary to MEMORY.md under "## Saved" with a header like "### Chat ${jid} — ${new Date().toISOString().slice(0, 10)}". Use a heredoc so newlines survive.\n\n` +
      `Be concise (10 lines max). After you've written the file, confirm in one short sentence.\n\n` +
      `--- transcript (oldest → newest) ---\n${transcript}`;
    try {
      const result = await agent.askClaude(jid, prompt);
      const text = typeof result === 'string' ? result : result?.text || '(no response)';
      await sock.sendMessage(jid, { text });
    } catch (err) {
      await sock.sendMessage(jid, { text: `⚠ Summarise failed: ${err.message.slice(0, 200)}` }).catch(() => {});
    }
  },
});

registerCommand({
  name: 'search',
  async handler({ sock, jid, args }) {
    const q = (args || '').trim();
    if (!q) {
      await sock.sendMessage(jid, { text: 'Usage: /search <text>\nSearches every chat transcript newest-first.' });
      return;
    }
    const { matches, scanned } = await searchChats(q, { max: 10 });
    if (matches.length === 0) {
      await sock.sendMessage(jid, { text: `No matches for "${q}" (scanned ${scanned} messages).` });
      return;
    }
    const lines = matches.map((m) => {
      const when = (m.t || '').slice(0, 16).replace('T', ' ');
      const who = m.role === 'user' ? '👤' : '🤖';
      return `${when}  ${who}  ${snippetOf(m.text, q, 50)}`;
    });
    await sock.sendMessage(jid, {
      text: `🔎 ${matches.length} match${matches.length === 1 ? '' : 'es'} for "${q}":\n\n${lines.join('\n\n')}`,
    });
  },
});

registerCommand({
  name: 'who',
  async handler({ sock, jid }) {
    const list = listAllowed();
    if (list.length === 0) {
      await sock.sendMessage(jid, { text: '(allowlist is empty)' });
      return;
    }
    await sock.sendMessage(jid, { text: `Allowlist (${list.length}):\n${list.map((j) => `  ${j}`).join('\n')}` });
  },
});

registerCommand({
  name: 'wake',
  auth: 'allowlist',
  async handler({ sock, jid }) {
    if (chatType(jid) !== 'group') {
      await sock.sendMessage(jid, { text: '/wake only makes sense in groups (DMs are already always-on).' });
      return;
    }
    await setAwake(jid, true);
    await sock.sendMessage(jid, { text: "👂 I'm now listening to all messages in this group. Use /sleep to go silent again." });
  },
});

registerCommand({
  name: 'sleep',
  auth: 'allowlist',
  async handler({ sock, jid }) {
    if (chatType(jid) !== 'group') {
      await sock.sendMessage(jid, { text: '/sleep only makes sense in groups.' });
      return;
    }
    await setAwake(jid, false);
    await sock.sendMessage(jid, { text: "💤 Silent mode. I'll only chime in when @-mentioned." });
  },
});

registerCommand({
  name: 'status',
  auth: 'allowlist',
  async handler({ sock, jid }) {
    if (chatType(jid) !== 'group') return;
    const awake = await isAwake(jid);
    await sock.sendMessage(jid, { text: awake ? '👂 Awake (replying to all messages)' : '💤 Silent (only on @mention)' });
  },
});

// Sub-agent shortcuts: focused askClaude prompts.
async function subAgent({ sock, jid, agent }, brief) {
  await sock.sendPresenceUpdate('composing', jid).catch(() => {});
  try {
    const result = await agent.askClaude(jid, brief);
    const reply = typeof result === 'string' ? result : result?.text || '(no reply)';
    await sock.sendMessage(jid, { text: reply });
  } catch (err) {
    await sock.sendMessage(jid, { text: `Couldn't process: ${err.message}` }).catch(() => {});
  } finally {
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
  }
}

registerCommand({
  name: 'email',
  auth: 'owner',
  async handler(ctx) {
    const arg = (ctx.args || '').trim();
    const brief = arg
      ? `Run \`himalaya envelopes list --filter "flag NEW" -o json\` and triage. Then act on the request: ${arg}`
      : 'Run `himalaya envelopes list --filter "flag NEW" -o json` and give me a tight triage: sender, subject, 1-line gist. 5 max, urgent first. WhatsApp-friendly.';
    await subAgent(ctx, brief);
  },
});

registerCommand({
  name: 'trade',
  auth: 'owner',
  async handler(ctx) {
    const arg = (ctx.args || '').trim();
    const brief = arg
      ? `Analyse the IFX trading situation: ${arg}. Be sharp and decisive — entry/exit/stop levels if applicable. Short.`
      : 'I want a quick read on the current IFX trading session. Pull whatever signals you have — recent saved items in MEMORY.md "## Saved", today\'s daily note, anything in MEMORY.md tagged trading. If nothing, say so in one line.';
    await subAgent(ctx, brief);
  },
});

registerCommand({
  name: 'summary',
  auth: 'allowlist',
  async handler(ctx) {
    const arg = (ctx.args || '').trim();
    const brief = arg
      ? `Summarise the WhatsApp thread with ${arg}. Use \`wacli --store ~/.wacli-main messages list --chat ${arg} --limit 100 --json\` (try ~/.wacli-alt too if no results). 4-6 bullets, who/what/when.`
      : `Summarise the current chat. Use this conversation's recent transcript at \`data/chats/<jid>.jsonl\` for the current jid (${ctx.jid}). 4-6 bullets, who/what/when.`;
    await subAgent(ctx, brief);
  },
});

registerCommand({
  name: 'playbook',
  auth: 'owner',
  async handler(ctx) {
    const arg = (ctx.args || '').trim();
    if (!arg || arg === 'list') {
      const all = await listPlaybooks();
      if (all.length === 0) {
        await ctx.sock.sendMessage(ctx.jid, {
          text: 'No playbooks yet. Drop markdown files into `playbooks/` and they show up here.',
        });
        return;
      }
      const body = all.map((p) => `  /playbook ${p.name}${p.description ? ` — ${p.description}` : ''}`).join('\n');
      await ctx.sock.sendMessage(ctx.jid, { text: `Playbooks:\n${body}` });
      return;
    }
    const [name, ...rest] = arg.split(/\s+/);
    const prompt = await loadPlaybook(name);
    if (!prompt) {
      await ctx.sock.sendMessage(ctx.jid, { text: `Unknown playbook: ${name}. Try /playbook list.` });
      return;
    }
    const extra = rest.join(' ').trim();
    const fullPrompt = extra ? `${prompt}\n\nExtra context for this run: ${extra}` : prompt;
    await ctx.sock.sendPresenceUpdate('composing', ctx.jid).catch(() => {});
    try {
      const result = await ctx.agent.askClaude(ctx.jid, fullPrompt);
      const reply = typeof result === 'string' ? result : result?.text || '(no reply)';
      await ctx.sock.sendMessage(ctx.jid, { text: reply });
    } catch (err) {
      await ctx.sock.sendMessage(ctx.jid, { text: `Playbook ${name} failed: ${err.message}` }).catch(() => {});
    } finally {
      await ctx.sock.sendPresenceUpdate('paused', ctx.jid).catch(() => {});
    }
  },
});

// ─── OpenCode mode: /opencode <prompt> — route a task to OpenCode's free model ─
registerCommand({
  name: 'opencode',
  // owner-only (default). Alternative brain via OpenCode's headless runner.
  async handler({ sock, jid, args }) {
    const prompt = (args || '').trim();
    if (!prompt) {
      await sock.sendMessage(jid, { text: 'Usage: /opencode <prompt>\n(routes to OpenCode free model on the Kali box)' });
      return;
    }
    const script = path.resolve('scripts/opencode-ask.sh');
    await sock.sendMessage(jid, { text: '🧠 OpenCode thinking...' }).catch(() => {});
    execFile('bash', [script, prompt], { timeout: 180000, maxBuffer: 2 * 1024 * 1024 }, async (err, stdout, stderr) => {
      const out = (stdout || '').trim() || (stderr || '').trim() || (err ? `OpenCode error: ${err.message}` : '(no output)');
      await sock.sendMessage(jid, { text: out.slice(0, 4000) }).catch(() => {});
    });
  },
});

// ─── Utility commands: /translate /pomo /qr /budget /yt /sticker /rmbg ─────

registerCommand({
  name: 'translate',
  auth: 'allowlist',
  async handler(ctx) {
    const arg = (ctx.args || '').trim();
    if (!arg) {
      await ctx.sock.sendMessage(ctx.jid, { text: 'Usage: /translate <text>  (auto-detects source, translates to English)\n  /translate to:fr <text>  to force a target language' });
      return;
    }
    const m = /^to:([a-z\-]+)\s+(.+)$/i.exec(arg);
    const target = m ? m[1] : 'English';
    const text = m ? m[2] : arg;
    const brief = `Translate the following into ${target}. Reply with ONLY the translation, no commentary:\n\n${text}`;
    try {
      const r = await ctx.agent.askClaude(ctx.jid, brief);
      const out = typeof r === 'string' ? r : r?.text || '(no reply)';
      await ctx.sock.sendMessage(ctx.jid, { text: out });
    } catch (err) {
      await ctx.sock.sendMessage(ctx.jid, { text: `Translate failed: ${err.message}` }).catch(() => {});
    }
  },
});

registerCommand({
  name: 'pomo',
  auth: 'allowlist',
  async handler({ sock, jid, args, scheduler }) {
    if (!scheduler) { await sock.sendMessage(jid, { text: 'Scheduler not configured.' }); return; }
    const minutes = Math.max(1, Math.min(120, Number((args || '').trim()) || 25));
    const when = new Date(Date.now() + minutes * 60_000);
    await scheduler.addJob({ jid, runAt: when.toISOString(), mode: 'notify', text: `🍅 ${minutes}-min pomodoro done — take a 5-min break.` });
    await sock.sendMessage(jid, { text: `🍅 Pomodoro started. I'll ping you in ${minutes} min.` });
  },
});

registerCommand({
  name: 'qr',
  auth: 'allowlist',
  async handler({ sock, jid, args }) {
    const text = (args || '').trim();
    if (!text) { await sock.sendMessage(jid, { text: 'Usage: /qr <text or URL>' }); return; }
    try {
      const { toBuffer } = await import('qrcode');
      const buf = await toBuffer(text, { type: 'png', margin: 2, width: 512, errorCorrectionLevel: 'M' });
      await sock.sendMessage(jid, { image: buf, mimetype: 'image/png', caption: text.slice(0, 100) });
    } catch (err) {
      await sock.sendMessage(jid, { text: `QR failed: ${err.message}` }).catch(() => {});
    }
  },
});

registerCommand({
  name: 'persona',
  auth: 'owner',
  async handler({ sock, jid, args }) {
    const arg = (args || '').trim();
    const fs = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const { savePersona, deletePersona, loadPersona } = await import('./personas.js');
    const TEMPLATE_DIR = 'personas';
    async function listTemplates() {
      try { return (await fs.readdir(TEMPLATE_DIR)).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort(); }
      catch { return []; }
    }
    if (!arg || arg === 'list') {
      const all = await listTemplates();
      const active = await loadPersona(jid);
      const head = active ? `Active overlay (first line): ${active.split('\n')[0].slice(0, 80)}` : 'No persona active for this chat.';
      const body = all.length ? all.map((p) => `  /persona ${p}`).join('\n') : '(drop a markdown file in personas/<name>.md to add one)';
      await sock.sendMessage(jid, { text: `${head}\n\nAvailable:\n${body}\n\n/persona clear to reset.` });
      return;
    }
    if (arg === 'clear' || arg === 'off' || arg === 'reset') {
      await deletePersona(jid);
      await sock.sendMessage(jid, { text: '✓ Persona cleared. Back to default soul.' });
      return;
    }
    let body;
    try { body = await fs.readFile(pathMod.join(TEMPLATE_DIR, `${arg}.md`), 'utf-8'); }
    catch { await sock.sendMessage(jid, { text: `Persona "${arg}" not found. /persona list.` }); return; }
    await savePersona(jid, body);
    await sock.sendMessage(jid, { text: `✓ Switched to persona "${arg}" for this chat.` });
  },
});

registerCommand({
  name: 'budget',
  auth: 'owner',
  async handler({ sock, jid, args }) {
    const { summary, categoryBreakdown } = await import('./integrations/budget.js');
    try {
      const sub = (args || '').trim().split(/\s+/)[0];
      if (sub === 'cat' || sub === 'categories' || sub === 'breakdown') {
        const cats = await categoryBreakdown();
        if (cats.length === 0) { await sock.sendMessage(jid, { text: 'No expenses this month.' }); return; }
        const fmt = (n) => `R${Math.round(n).toLocaleString()}`;
        const lines = cats.map((c) => {
          const status = c.delta > 0 ? '🔴' : c.delta < 0 ? '🟢' : '⚪';
          return `${status} ${c.name}: ${fmt(c.spent)} / ${fmt(c.budgeted)}`;
        });
        await sock.sendMessage(jid, { text: lines.join('\n') });
        return;
      }
      const s = await summary();
      await sock.sendMessage(jid, { text: s });
    } catch (err) {
      await sock.sendMessage(jid, { text: `Budget unreachable: ${err.message}` }).catch(() => {});
    }
  },
});
