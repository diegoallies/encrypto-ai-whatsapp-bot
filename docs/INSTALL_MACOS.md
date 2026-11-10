# Install on macOS (M2 Apple Silicon)

Fresh install of the WhatsApp bot on a stock M2 MacBook. Assumes macOS 14+ and
you are the sole user of the machine.

## 1. Prerequisites (one-time)

```sh
# Install Xcode Command Line Tools (compiler, git)
xcode-select --install

# Homebrew (package manager)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
# After install completes, add brew to your shell (Apple Silicon path):
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"

# Core tools
brew install node@22 postgresql@16 git ffmpeg tmux jq rsync sqlite wget curl gh
brew services start postgresql@16

# PM2 (bot process manager)
npm install -g pm2

# Ollama (LLM runtime)
brew install ollama
brew services start ollama
ollama pull phi3:mini              # match what was on Kali; add more later

# Colima (Docker Linux VM for containers)
brew install colima docker docker-compose
colima start --cpu 4 --memory 8 --disk 60 --arch aarch64

# Optional but useful
brew install --cask utm             # full VMs when needed
brew install --cask plex-media-server jellyfin
```

## 2. Clone the bot

```sh
mkdir -p ~/dev && cd ~/dev
git clone https://github.com/example/whatsapp-bot.git
cd whatsapp-bot
npm install
```

## 3. Create the bot's Postgres role + DB

Match the credentials used on Kali (`POSTGRES_USER=encrypto`,
`POSTGRES_DB=encrypto_bot`, `POSTGRES_PASSWORD=encrypto_ai_2026`):

```sh
createuser -s encrypto
createdb -O encrypto encrypto_bot
psql -d postgres -c "ALTER USER encrypto WITH PASSWORD 'encrypto_ai_2026';"
```

(If you're restoring from Kali's backup, skip this — the dump creates the role
itself. See `RESTORE_ON_MAC.md`.)

## 4. .env file

Copy `.env.example` (if present) to `.env`, or restore from backup. Required keys
are documented in `docs/env.md`. At minimum:

```
POSTGRES_URL=postgres://encrypto:encrypto_ai_2026@127.0.0.1:5432/encrypto_bot
ANTHROPIC_API_KEY=sk-ant-...
AI_PROVIDER=claude
ANTHROPIC_MODEL=claude-opus-4-8
```

## 5. First boot (fresh state, temporary)

```sh
npm start
# scan the QR that prints in the terminal with the Encrypto AI WhatsApp number
```

Verify:
- QR pairing succeeds.
- `curl http://localhost:7777` returns the web UI.
- Send a test WhatsApp message to the bot number and it responds.

## 6. Register with PM2

```sh
pm2 start ecosystem.config.js   # or: pm2 start src/index.js --name whatsapp-bot
pm2 save
pm2 startup                     # follow the printed command (uses launchd)
```

## 7. Restore Baileys session from Kali (skips QR re-pair)

Only do this once the Kali box's bot is STOPPED. Two live sessions with the
same auth conflict and WhatsApp will kick one out.

```sh
# on Kali:
pm2 stop whatsapp-bot

# on macOS:
rsync -avP user@your-server:/tmp/homelab-backup/bot/baileys-auth.tar.gz ~/
pm2 stop whatsapp-bot
rm -rf ~/dev/whatsapp-bot/auth_info_baileys
tar xzf ~/baileys-auth.tar.gz -C ~/dev/whatsapp-bot/
pm2 restart whatsapp-bot
pm2 logs whatsapp-bot --lines 40   # look for "WhatsApp connected"
```

## 8. Optional homelab services

- Full service restore: see `RESTORE_ON_MAC.md`
- Media stack (Plex/Sonarr/Radarr): see `HOMELAB_SERVICES.md`
- Redamon pentest: `cd ~/dev/redamon && ./redamon.sh install` (Colima must be
  running first)

## Firewall / networking

macOS firewall is off by default for LAN. For remote access:
- SSH: System Settings → General → Sharing → Remote Login (enable)
- Screen: same panel → Screen Sharing
- Bot web UI (`:7777`) and services published on ports: reachable on the LAN
  once firewall permits Node/Docker.
