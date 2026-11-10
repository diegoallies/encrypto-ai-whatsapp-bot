# WhatsApp Claude Bot

## First-run setup

The repo ships with **no personal details**. On first run the bot asks you who
it works for and fills itself in:

**Option A - over WhatsApp (self-onboarding):** start the bot, pair it, then DM
it. The first person to DM it becomes the owner and gets walked through a short
Q&A (assistant name, your name, phone, timezone). It writes `.env` and fills the
`{{OWNER_NAME}}` placeholders in `soul.md` automatically.

**Option B - CLI:**

```bash
npm install
npm run setup     # interactive: asks name, phone, timezone, …
npm start
```

Placeholders used until setup runs: `{{ASSISTANT_NAME}}`, `{{OWNER_NAME}}`,
`{{OWNER_FIRST_NAME}}`, `{{OWNER_PHONE}}`. After setup, `soul.md` is yours to
evolve - keep it free of anyone else's private data.

A personal WhatsApp bot powered by your **Claude Code subscription** by default, with optional OpenAI/ChatGPT/Codex-compatible API token modes. It links to your phone via QR code like WhatsApp Web. In Claude mode, Claude has full filesystem + shell access to the machine it runs on.

## How it works

```
Your phone (WhatsApp)
       │
       ▼  Baileys (multi-device protocol, QR pairing)
  Node process on your PC
       │
       ▼  Claude Agent SDK / OpenAI Responses API / Codex CLI
  AI provider
       │
       ▼  reply
  Back to your phone
```

The Agent SDK auto-detects your local Claude Code login and uses your subscription. If `ANTHROPIC_API_KEY` is set, it falls back to Anthropic API billing instead.

### API Token Modes

Set `AI_PROVIDER` to `openai`, `chatgpt`, or `codex` to use the OpenAI-compatible Responses API instead of the Claude Agent SDK. This keeps WhatsApp chat behavior and persona context, but does not automatically provide local Bash/Read/Edit tool access.

```env
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5
# Optional: CODEX_API_KEY=...       # used when AI_PROVIDER=codex, falls back to OPENAI_API_KEY
# Optional: OPENAI_BASE_URL=https://api.openai.com/v1
```

For Codex CLI mode, install the CLI first with `npm install --global @openai/codex`, then use `AI_PROVIDER=codex-cli`. This shells out to `codex exec`, giving Codex a local terminal/sandbox workflow similar in spirit to Claude Code mode.

```env
AI_PROVIDER=codex-cli
# CODEX_API_KEY=sk-...       # optional; leave blank to use `codex login` subscription auth
# CODEX_MODEL=gpt-5          # optional; leave blank for Codex CLI default
CODEX_CLI_SANDBOX=workspace-write
```

Codex CLI mode runs non-interactively. Leave `CODEX_API_KEY` blank to use the ChatGPT/Codex subscription account cached by `codex login`; set it only when you want Platform API-key billing. Commands that would need approval should be avoided or scoped via sandbox settings.

## Setup - one script

Everything is wrapped in a single interactive script: **`encryptoai`**.

```
cd whatsapp-bot
./encryptoai
```

On first run it walks you through:

1. Installing npm dependencies
2. Logging in to Claude Code (if you aren't already)
3. Pairing WhatsApp (prints a QR - scan it from your phone: **Settings → Linked Devices → Link a Device**)
4. Discovering your JID (you send a test message, the script auto-detects it from the bot's log and adds it to `.env`)
5. Dropping you into the menu so you can start the bot

### Prerequisites

- Node.js 20+
- Claude Code CLI installed (the script will run `claude login` for you)

### Subcommands

```
./encryptoai setup     # full first-time wizard
./encryptoai status    # current state of node, deps, pairing, allowlist
./encryptoai link      # pair / re-pair WhatsApp (wipes auth, shows new QR)
./encryptoai jid       # auto-discover your JID and add it to .env
./encryptoai allow <jid>   # add a JID to the allowlist
./encryptoai edit      # open .env in $EDITOR
./encryptoai start     # run bot in foreground
./encryptoai daemon    # run bot under pm2 (always-on)
./encryptoai stop      # stop pm2 daemon
./encryptoai logs      # tail pm2 logs
```

### Doing it by hand

If you'd rather not use the script:

```
npm install
cp .env.example .env
npm start              # scan the QR, message yourself, copy the JID it logs
# put the JID in .env as ALLOWED_JIDS=...@s.whatsapp.net
npm start              # live
```

## Usage

Just chat. The bot remembers the conversation per chat (via Agent SDK session resumption).

Special commands:
- `/reset` - clear the conversation history for your chat
- `/stats` - show uptime, message count, error count, queue depth
- `/remind <when> <text>` - schedule a reminder (see formats below)
- `/cron list` - list your scheduled jobs
- `/cron rm <id>` - cancel a scheduled job

## Persona - `soul.md` and `rules.md`

Two markdown files at the repo root define how the bot behaves. Edit them
to change the bot's voice or add new constraints - changes take effect on
the **next message** (no restart needed), thanks to an mtime-cached loader.

- `soul.md` - who EncryptoAI is, voice and tone, default behavior
- `rules.md` - hard rules (confirmation gates, secret-handling, scheduling
  protocol). These get appended to Claude Code's `claude_code` system preset.

Edit shortcuts:

```
./encryptoai soul     # opens soul.md in $EDITOR
./encryptoai rules    # opens rules.md in $EDITOR
```

> Caveat: when a chat *resumes* an existing Agent SDK session, the system
> prompt baked into that session sticks. Use `/reset` after big edits if
> you want them to take effect mid-conversation.

## Scheduling - reminders and prompts

Two ways in, one scheduler under the hood. Jobs persist to
`data/scheduled.json` and survive restarts (overdue-but-not-stale jobs
re-fire on boot; jobs >24h stale are skipped).

**From chat (deterministic, no LLM in the loop):**

```
/remind +1h Take out the trash
/remind 18:00 Call mom
/remind 2026-05-20T09:00 Standup
/cron list
/cron rm a1b2c3d4
```

**From Claude itself** (via the CLI through its Bash tool) - for natural
language like "remind me tomorrow at 9 to call the dentist". The bot's
`rules.md` instructs Claude to call:

```
node scripts/cron.mjs add --at <when> --notify "<text>"
node scripts/cron.mjs add --at <when> --prompt "<task>"
node scripts/cron.mjs list
node scripts/cron.mjs rm <id>
```

`<when>` formats:

| Form | Example | Meaning |
|---|---|---|
| Relative | `+30m`, `+2h`, `+1d` | minutes / hours / days from now |
| Time | `18:00` | today if future, tomorrow if past |
| ISO | `2026-05-20T09:00` | absolute |

`--notify` sends the text as a plain WhatsApp message at fire time.
`--prompt` re-invokes Claude with the given task at fire time and sends
its response. The default `--jid` is the first entry in `ALLOWED_JIDS`.

You can also run the CLI by hand via the wrapper:

```
./encryptoai cron list
./encryptoai cron add --at +5m --notify "test"
```

Examples to try:
- *"What's in my Downloads folder?"*
- *"Read my package.json and tell me what scripts are defined."*
- *"Create a file called notes.md with today's date as the header."*
- *"Find all TODO comments in this repo."*

## ⚠ Security

This bot has **full shell access** as the user running it. Treat it like giving someone an SSH session.

- **Allowlist is fail-closed.** Empty `ALLOWED_JIDS` = nobody can use it.
- **Only allowlist numbers you 100% trust** - anyone on the list can `rm -rf` your home directory through chat.
- **Don't run as root.**
- **Sandbox if you can:** set `WORK_DIR=/home/you/bot-sandbox` so the bot's `cwd` is a scoped folder. (Bash can still escape, but it makes accidents less likely.)
- **WhatsApp ToS:** unofficial libraries on personal numbers technically violate ToS. Low risk for personal use, but consider a secondary number if you care.

## Run it always-on with pm2

[pm2](https://pm2.keymetrics.io) keeps the bot alive across logout/reboot. The easy way:

```
./encryptoai daemon    # offers to install pm2 if needed, then starts the bot
./encryptoai logs      # tail logs (QR shows here on first run)
pm2 startup            # enable boot-time start; follow the printed command
```

Direct pm2 commands also work:

```
pm2 start ecosystem.config.cjs
pm2 logs whatsapp-claude-bot
pm2 restart whatsapp-claude-bot
pm2 stop whatsapp-claude-bot
pm2 delete whatsapp-claude-bot
```

## Run it on a VPS with Docker (optional)

```
docker build -t whatsapp-claude-bot .

docker run -d --name whatsapp-bot \
  --restart unless-stopped \
  --env-file .env \
  -v $PWD/auth_info_baileys:/app/auth_info_baileys \
  whatsapp-claude-bot

docker logs -f whatsapp-bot   # scan the QR on first run
```

Note: in Docker the bot's filesystem access is scoped to the container. Mount whatever host paths you actually want it to reach.

## Development

```
npm run check     # syntax-check every source file
npm test          # run the full node:test suite (46 tests)
```

CI runs both on every push via `.github/workflows/ci.yml`.

Layout:

```
src/
  index.js         entry: wires socket, signals, heartbeat
  handler.js       createHandler({ sock, agent, isAllowed }) - testable core
  parse.js         extractText, describeNonText, isSystemJid (pure)
  chunk.js         splitForWhatsApp (pure)
  queue.js         per-JID serial queue
  allowlist.js     createAllowlist factory + env-backed default
  stats.js         counters + formatStats for /stats
  claude-agent.js  Agent SDK wrapper with per-JID session resume
test/              node:test unit + integration tests, no extra deps
```

## Troubleshooting

- **"Logged out" on startup** → delete `auth_info_baileys/` and re-scan the QR.
- **No reply, no log line** → JID isn't in `ALLOWED_JIDS`. Check the console for the blocked-message log.
- **Hit subscription limits** → set `ANTHROPIC_API_KEY` for Anthropic billing, or set `AI_PROVIDER=openai` with `OPENAI_API_KEY` / `OPENAI_MODEL` to use OpenAI token mode.
