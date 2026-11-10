# Restore on macOS from Kali backup bundle

Assumes `scripts/backup-homelab.sh` has been run on Kali and the
`/tmp/homelab-backup/` tree has been copied to `~/homelab-backup/` on the mac.

## 0. Copy the backup over

```sh
# On mac
mkdir -p ~/homelab-backup
rsync -avP user@your-server:/tmp/homelab-backup/ ~/homelab-backup/
```

## 1. Postgres (bot + budget tracker)

```sh
brew services stop postgresql@16
# fresh cluster if there isn't one already:
initdb -D /opt/homebrew/var/postgresql@16 --auth=trust  # only if fresh
brew services start postgresql@16
sleep 3
psql -d postgres -f ~/homelab-backup/postgres/encrypto-full-dump.sql
psql -d postgres -c "\l"     # confirm encrypto_bot exists
```

## 2. Bot code + Baileys session

```sh
# Bot code is normally cloned from GitHub, but if you want the exact snapshot:
tar xzf ~/homelab-backup/bot/whatsapp-bot-code.tar.gz -C ~/dev/
# Baileys auth (WhatsApp session — CRITICAL, avoids QR re-pair):
pm2 stop whatsapp-bot 2>/dev/null || true
rm -rf ~/dev/whatsapp-bot/auth_info_baileys
tar xzf ~/homelab-backup/bot/baileys-auth.tar.gz -C ~/dev/whatsapp-bot/
# PM2 dump (restores app registrations)
cp ~/homelab-backup/bot/pm2-dump.pm2 ~/.pm2/dump.pm2
pm2 resurrect
```

**Do NOT boot the bot on mac while Kali's bot is still running.** WhatsApp will
kick one of the two sessions and it may not be predictable which. Stop Kali
first, wait 30 seconds, then start mac.

## 3. Sonarr / Radarr / Prowlarr / qBittorrent

For each service:

```sh
# Create the docker-compose file (or use linuxserver's docs)
mkdir -p ~/docker/sonarr && cd ~/docker/sonarr
# ...compose file...
docker compose up -d
docker compose stop         # so we can safely restore config
docker run --rm -v sonarr_config:/config -v ~/homelab-backup/sonarr:/backup alpine \
  sh -c "cd /config && tar xzf /backup/config.tar.gz"
docker compose start
```

Then in each UI, fix the media root paths (see path re-mapping in
`HOMELAB_SERVICES.md`).

## 4. Pi-hole

```sh
mkdir -p ~/docker/pihole && cd ~/docker/pihole
# ...compose file with the standard pihole/pihole:latest image...
docker compose up -d
docker compose stop
docker run --rm -v pihole_etc:/etc/pihole -v ~/homelab-backup/pihole:/backup alpine \
  sh -c "cd / && tar xzf /backup/pihole-config.tar.gz"
docker compose start
```

Router DHCP: point primary DNS at the MacBook's LAN IP.

## 5. Homepage

```sh
mkdir -p ~/docker/homepage
tar xzf ~/homelab-backup/homepage/homepage-config.tar.gz -C ~/docker/homepage/
cd ~/docker/homepage && docker compose up -d
```

## 6. Caddy

```sh
brew install caddy
sudo mkdir -p /usr/local/etc/caddy
sudo cp ~/homelab-backup/caddy/Caddyfile /usr/local/etc/caddy/Caddyfile
brew services start caddy
```

Or run Caddy in Docker if you prefer container isolation.

## 7. schedule-site

```sh
tar xzf ~/homelab-backup/schedule-site/schedule-site-full.tar.gz -C ~/dev/
cd ~/dev/schedule-site
npm install
pm2 start ecosystem.config.js       # or: pm2 start server.mjs --name schedule-site
```

## 8. budget-tracker

```sh
tar xzf ~/homelab-backup/budget-tracker/budget-tracker-src.tar.gz -C ~/dev/
mkdir -p ~/dev/budget-tracker/data
cp ~/homelab-backup/budget-tracker/budget.db ~/dev/budget-tracker/data/budget.db
cd ~/dev/budget-tracker
npm install
pm2 start ecosystem.config.js       # or: pm2 start server.mjs --name budget-tracker
```

## 9. Ollama

```sh
brew services start ollama
# Look at ~/homelab-backup/ollama/models.txt for what to pull:
ollama pull phi3:mini
# add more models as needed — bigger models benefit hugely from Metal on M2:
# ollama pull qwen2.5-coder:7b
# ollama pull llama3.2:3b
```

## 10. Redamon

```sh
cd ~/dev
git clone https://github.com/samugit83/redamon.git
cd redamon
# Redamon uses Docker Compose — Colima must be running
colima status                       # must show "Running"
./redamon.sh install                # takes 20-40 min on first run
```

Point Redamon at Ollama once installed: use `http://host.docker.internal:11434/v1`
in the LLM-provider settings.

## 11. Cron jobs

```sh
crontab ~/homelab-backup/cron/user-crontab.txt
# then edit paths: $HOME/ → /Users/<your-user>/
```

## 12. Final verification

Run through this checklist BEFORE cutting DNS/routing to the mac:

```sh
# bot alive
curl -sI http://localhost:7777 | head -1

# db alive
psql -U encrypto -d encrypto_bot -c "SELECT count(*) FROM allowed_people;"

# ollama alive
curl -s http://localhost:11434/api/tags | jq '.models[].name'

# containers up
docker ps --format 'table {{.Names}}\t{{.Status}}'

# Baileys session
pm2 logs whatsapp-bot --lines 20 --nostream | grep -iE "connected|error"
```

Then send a test WhatsApp message from the owner's number → bot should reply from
the mac. If yes: STOP the Kali bot for good, save the day, we're live.

## Rollback

If anything's wrong after cutover:
```sh
# On mac
pm2 stop whatsapp-bot

# On Kali
pm2 restart whatsapp-bot
```
Baileys will reconnect the Kali session (mac's session goes idle but auth files
survive; you can retry the mac migration later without re-scanning).
