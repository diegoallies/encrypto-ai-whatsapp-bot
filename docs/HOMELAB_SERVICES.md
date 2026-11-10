# Homelab services inventory (Kali → MacBook)

Snapshot of what's running on Kali (`your-server`) at migration time. Use
this as a checklist during restore. Each service block lists: what it is, its
port, where its config lives on Kali, and how to bring it up on macOS.

## Bot core

### WhatsApp bot (this repo)
- Port: `7777` (web UI)
- Config on Kali: `~/Desktop/whatsapp bot/whatsapp-bot/.env`
- On mac: `docs/INSTALL_MACOS.md`
- Baileys auth: `auth_info_baileys/` — CRITICAL, transfer it or re-scan QR

### Postgres (`encrypto-postgres` container)
- Port: `5432`
- User/db: `encrypto` / `encrypto_bot`
- Docker image: `postgres:16-alpine`
- On mac: use Homebrew `postgresql@16` (native, faster on M2 than Docker)

### Ollama
- Port: `11434` (loopback on Kali)
- Model: `phi3:mini` (2.2 GB)
- On mac: `brew install ollama; brew services start ollama; ollama pull phi3:mini`
- Config: bind to `127.0.0.1:11434` for local, `0.0.0.0:11434` if Colima needs
  it: `launchctl setenv OLLAMA_HOST 0.0.0.0:11434` + restart

## Media stack

| Service     | Container | Port | Native mac option              |
|-------------|-----------|------|--------------------------------|
| Plex        | `plex`    | 32400| `brew install --cask plex-media-server` (HW transcode via VideoToolbox) |
| Jellyfin    | `jellyfin`| 8096 | `brew install --cask jellyfin` (also HW transcode)                     |
| Sonarr      | `sonarr`  | 8989 | Docker (`linuxserver/sonarr`) — no good native mac build |
| Radarr      | `radarr`  | 7878 | Docker (`linuxserver/radarr`)                                          |
| Prowlarr    | `prowlarr`| 9696 | Docker (`linuxserver/prowlarr`)                                        |
| qBittorrent | `qbittorrent`| 9090 | `brew install qbittorrent` (native) or Docker                        |
| Overseerr   | `overseerr`| 5055 | Docker (`sctx/overseerr`)                                              |

Path re-mapping (Kali → mac):
- `/media/storage/tv` → `/Volumes/media/tv`
- `/media/storage/movies` → `/Volumes/media/movies`
- `/media/storage/downloads` → `/Volumes/media/downloads`

Sonarr/Radarr store paths in their SQLite DBs (`config.xml` + `sonarr.db`). After
restoring the config tar, edit the root folders in the UI, or bulk-update the
DB before starting the container.

## Networking + DNS

### Pi-hole
- Container: `pihole` (host network)
- UI port: `8084` (mapped)
- DNS: 53/udp
- Config on Kali: `/etc/pihole/`, `/etc/dnsmasq.d/`
- On mac: `docker compose up -d pihole` — bind to a non-53 port if macOS
  mDNSResponder is running on 53, or disable mDNSResponder for LAN DNS

### Caddy (reverse proxy for `*.home` domains)
- Container: `caddy`
- Config on Kali: `/media/storage/caddy/Caddyfile`
- On mac: `brew install caddy`, port the Caddyfile, `caddy run` or Docker

### Cloudflared / tunnels
- `dkvpn-monitor.service` runs a small tunnel
- Grep the systemd unit file in the backup for its command

## Personal apps

### schedule-site (routine/reminder daemon)
- Location on Kali: `~/schedule-site`
- Port: `3460`
- On mac: `cd ~/dev/schedule-site && npm install && pm2 start`
- Reminder daemon (`reminder-daemon.mjs`) also runs as a cron entry — see
  `cron` section below.

### Budget tracker
- Location on Kali: `~/dev/budget-tracker`
- SQLite DB: `data/budget.db`
- Port: `3201`
- On mac: `cd ~/dev/budget-tracker && npm install && pm2 start`

### Homepage dashboard
- Container: `homepage`
- Port: `3333`
- Config on Kali: `~/homepage/config/`
- On mac: `docker compose up -d` with the same config folder mounted

### Vaultwarden (passwords)
- Container: `vaultwarden`
- Port: `8222`
- Volume: `/var/lib/docker/volumes/vaultwarden-data`
- CRITICAL to migrate: contains encrypted password vault
- On mac: `docker run` with the volume restored

### Baby Buddy, Speedtest Tracker, ntfy, Open WebUI
- All Docker containers, spec is in `running-containers.txt` in the backup
- Restore compose file for each, run `docker compose up -d`

## Security / monitoring

### CrowdSec
- Container: `crowdsec`
- Config: `/var/lib/docker/volumes/crowdsec-config`
- On mac: install via Homebrew tap or Docker

### Endlessh honeypot
- Container: `honeypot` (port 2222)
- Purely optional — skip unless you specifically want an SSH tarpit on the mac

### Uptime Kuma
- Container name: check `running-containers.txt`
- Data volume: `uptime-kuma`
- Straight Docker restore

## Cron jobs (from Kali user crontab)

Copy these into `crontab -e` on the mac after adjusting paths:

```
*/5 * * * * ~/scripts/plex-watchlist-sync.sh >> /tmp/watchlist-sync.log 2>&1
0 3 * * *   /usr/bin/python3 ~/scripts/plex-cleanup.py >> ~/scripts/plex-cleanup.log 2>&1
*/30 * * * 1-5 cd ~/smc-analyzer && python3 auto_signal.py >> ~/smc-analyzer/cron.log 2>&1
35 6 * * *  node ~/dev/schedule-site/workout.mjs >> /tmp/workout-send.log 2>&1
* * * * *   node ~/dev/schedule-site/reminder-daemon.mjs >> /tmp/sched-reminders.log 2>&1
```

The `openclaw` cron entries are one-off event reminders — check the dates
before restoring; some may be in the past.

## What we're NOT migrating

- `pihole-FTL.db` (query history, 512 MB) — starts fresh, cleaner anyway
- Sonarr/Radarr download history logs — not needed
- Radarr/Sonarr backup files inside the config tar (Sonarr auto-generates)
- Kali-specific tooling (Metasploit, Kali packages) — install via Homebrew or
  run in a Kali Docker container / UTM VM when needed
- Windows partition on Kali disk — leave it, or reclaim after migration
