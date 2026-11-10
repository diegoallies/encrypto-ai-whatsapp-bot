# Environment variables

Most of these are configurable from the **/settings** page in the web UI — that page is the canonical source of help text. This doc captures both the UI-exposed settings and the internals (mostly tuning knobs) that aren't on the page.

Settings marked **(restart)** require a process restart to take effect.

## Web UI

| Var | Default | Notes |
|---|---|---|
| `PUBLIC_URL` | — | Shown on the dashboard header. Cosmetic. |
| `WEB_HOST` | `127.0.0.1` | Bind address. Leave on loopback unless reverse-proxied. **(restart)** |
| `WEB_PORT` | `7777` | TCP port. **(restart)** |
| `WEB_UI` | `1` | Set `0` to skip starting the web UI entirely. |
| `LOG_LEVEL` | `info` | One of `silent error warn info debug trace`. |
| `WORK_DIR` | repo root | Sandbox dir for the Bash/Write/Edit tools. |

## Postgres

| Var | Default | Notes |
|---|---|---|
| `PG_HOST` | `localhost` | |
| `PG_PORT` | `5432` | |
| `PG_DATABASE` | `encrypto_bot` | |
| `PG_USER` | `encrypto` | |
| `PG_PASSWORD` | (in db.js fallback) | Move to `.env` for prod. |

## Reply streaming

| Var | Default | Notes |
|---|---|---|
| `STREAM_REPLIES` | `1` | `1` = chunked while generating, `0` = wait for full reply. |
| `STREAM_AS_EDITS` | `0` | `1` = edit one message in place, `0` = separate chunks. |
| `STREAM_MIN_CHARS` | `280` | Min chunk size at sentence boundary. **(restart)** |
| `STREAM_MAX_CHARS` | `1400` | Hard flush at this size. **(restart)** |
| `STREAM_MIN_GAP_MS` | `900` ms | Throttle between flushes. **(restart)** |

## Message coalescing (burst handling)

| Var | Default | Notes |
|---|---|---|
| `COALESCE_DISABLE` | `0` | `1` = reply per message instead of batching bursts. |
| `COALESCE_QUIET_MS` | `1500` ms | Wait this long after last message in burst. **(restart)** |
| `COALESCE_MAX_MS` | `8000` ms | Max wait before forcing a reply. **(restart)** |

## Allowlist / identity

| Var | Default | Notes |
|---|---|---|
| `ALLOWED_JIDS` | empty | Comma-separated JIDs allowed to talk to the bot. |
| `OWNER_JIDS` | empty | JIDs treated as "you". Include both `@s.whatsapp.net` and any `@lid`. |
| `ACK_REACTIONS` | `1` | Send ⏳/✅/❌ reactions on incoming messages. |
| `ACK_RECEIVED` / `ACK_DONE` / `ACK_ERROR` | ⏳ / ✅ / ❌ | Emoji overrides for the ack reactions. |
| `STRANGER_NOTIFY` | `1` | Forward stranger DMs to owner with an Allow prompt. |
| `STRANGER_NOTIFY_TTL_MS` | — | How long pending stranger prompts stay valid. |

## Daily caps / cost guard

| Var | Default | Notes |
|---|---|---|
| `DAILY_TOKEN_SOFT_LIMIT` | `500000` | Amber warning on dashboard. **(restart)** |
| `DAILY_TOKEN_HARD_LIMIT` | `1000000` | Bot refuses new calls past this. **(restart)** |
| `DAILY_MSG_CAP_DEFAULT` | `0` | Per-JID per-day cap. `0` = unlimited. **(restart)** |
| `DAILY_MSG_CAP_PER_JID` | empty | `jid:n,jid:n` overrides. **(restart)** |
| `DAILY_MSG_LIMIT_TEXT_PER_JID` | — | Custom "you hit your daily cap" message per JID. |

## Voice / video / media

| Var | Default | Notes |
|---|---|---|
| `WHISPER_MODEL` | `base` | `tiny base small medium large`. |
| `WHISPER_LANGUAGE` | empty | ISO 639-1, empty = auto-detect. |
| `WHISPER_TIMEOUT_MS` | `120000` | Abort transcription past this. |
| `VOICE_REPLY` | `0` | `1` = also send replies as opus voice notes. |
| `VIDEO_TRANSCRIBE` | `0` | `1` = transcribe audio from incoming video. |
| `VIDEO_MAX_FRAMES` | `8` | Frames sampled when describing a video. |
| `VIDEO_FRAME_QUALITY` | `2` | ffmpeg `-q:v` for sampled frames. |

## Notifications / integrations

| Var | Default | Notes |
|---|---|---|
| `NTFY_SERVER` | `https://ntfy.sh` | ntfy push server URL. |
| `NTFY_TOPIC` | — | Topic name. Required to enable push. |
| `NTFY_TOKEN` | — | Bearer token for protected topics. |
| `WEBHOOK_SECRET` | — | Required `x-webhook-secret` header on `/webhook/*`. |
| `HEARTBEAT_EMAIL_CHECK` | `0` | `1` = poll Himalaya for new mail. **(restart)** |
| `HEARTBEAT_EMAIL_INTERVAL` | `30m` | Duration string. **(restart)** |
| `HIMALAYA_ACCOUNT` | `gmail` | Account name in `~/.config/himalaya/config.toml`. |
| `AUTH_BACKUP` | `0` | Tarball `auth_info_baileys/` nightly. |
| `AUTH_BACKUP_KEEP` | `7` | Older daily backups deleted. |
| `GIT_BACKUP` | `0` | Push repo to git remote nightly. |
| `WACLI_STORE` | `$HOME/.wacli-main` | Path for contact name lookups. |
| `MCP_CONFIG` | `mcp.json` | Path to MCP servers config. |
| `CROWDSEC` | `0` | Enable CrowdSec ban check. |
| `WAKE_UP` | `0` | Heartbeat ping to a wake-up endpoint. |

## Bot memory / context

| Var | Default | Notes |
|---|---|---|
| `JOURNAL_TODAY_LINES` | `15` | Last N bot-action lines from today's note injected into the prompt. |
| `JOURNAL_YESTERDAY_LINES` | `5` | Same, from yesterday's tail. |
| `FOCUS_TTL_MS` | — | How long `/focus` mode lasts. |
| `OUTBOUND_STORE_MAX` | — | Max outbound messages kept for retry/edit lookup. |
| `MAX_MSG_RETRY` | — | Bot's own retry attempts for failed sends. |
| `RETRY_REQUEST_DELAY_MS` | — | Backoff between retries. |
| `URL_UNFURL` | `1` | Unfurl URLs in messages for context. |

## Cron / digest

| Var | Default | Notes |
|---|---|---|
| `DAILY_DIGEST` | `0` | Generate a daily digest message. |
| `DAILY_DIGEST_CRON` | — | Cron expression for when. |
| `DAILY_DIGEST_PROMPT` | — | Prompt template used. |

---

**Tip:** to find every env var the bot reads, run:

```sh
grep -hoE "process\.env\.[A-Z_]+" src/*.js | sort -u
```

The `/settings` page in the web UI is the source of truth for help text and "needs restart" flags — keep this doc in sync when you add new vars there.
