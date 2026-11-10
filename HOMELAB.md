# HOMELAB.md — services Encrypto AI can reach

Inventory of the owner's home stack. URLs work both internally and (where `.home`)
via Caddy/Pi-hole. Use the **local IP** for service-to-service calls from
this bot — `.home` domains need TLS handshake + DNS round-trip.

Host: `your-server`  ·  reverse-proxy: Caddy  ·  DNS: Pi-hole

## Media
- **Jellyfin** — Movies & TV. `https://jellyfin.home` · `http://localhost:8096`
- **Plex** — Streaming. `http://your-server:32400/web`
- **Radarr** — Movie automation. `https://radarr.home` · `http://localhost:7878` · API key in `homepage/config/services.yaml`
- **Sonarr** — TV automation. `https://sonarr.home` · `http://localhost:8989`
- **Overseerr** — Request UI. `http://your-server:5055`

## Downloads / indexers
- **qBittorrent** — `https://qbit.home` · `http://localhost:9090`
- **Prowlarr** — Indexer manager. `http://your-server:9696`

## Security / network
- **Pi-hole** — DNS + ad blocking. `https://pihole.home` · `http://localhost:8084`. Local DNS records in `/etc/pihole/pihole.toml` (in the `pihole` container). After edits: `docker exec pihole pihole reloaddns`.
- **CrowdSec** — Intrusion detection. Container name `crowdsec`. Check decisions: `docker exec crowdsec cscli decisions list`. Ban an IP: `docker exec crowdsec cscli decisions add -i <ip> -d 24h -t ban`.
- **Uptime Kuma** — Service monitoring. `https://uptime.home`
- **Endlessh** — SSH tarpit honeypot. `http://your-server:7682`
- **Tailscale** — Mesh VPN. Admin: <https://login.tailscale.com/admin/machines>
- **Router** — `http://192.168.10.1`
- **Caddy** — Reverse proxy. Config: `/media/storage/caddy/Caddyfile` (root-owned). After edits: `docker exec caddy caddy reload --config /etc/caddy/Caddyfile`.

## AI / tools
- **Encrypto AI** (this bot) — `https://ai.home` · `http://localhost:7777`. PM2 process `whatsapp-claude-bot`.
- **Encrypto Lab** (Homepage dashboard) — `https://encrypto.home` · `http://localhost:3333`. Config: `$HOME/homepage/config/`. After edits: `docker restart homepage`.
- **Ollama** — Local LLM runtime. `http://your-server:11434`
- **Open WebUI** — Chat UI for Ollama. `http://your-server:3800`
- **DK VPN Monitor** — Config tracker. `http://dkvpn.home`

## Personal apps
- **Vaultwarden** — Passwords. `https://vault.home`. NEVER expose secrets from here.
- **Budget Tracker** — `https://budget.home`. the owner's personal spending app.
- **Baby Buddy** — `https://baby.home`. Childcare tracker.

## Process management
- **PM2** — Manages `whatsapp-claude-bot`. `pm2 status`, `pm2 logs whatsapp-claude-bot`, `pm2 restart whatsapp-claude-bot`.
- **Docker** — `docker ps`, `docker logs <name>`. Most services run here.

## When asked "is X up?"
Prefer the `siteMonitor` URL from `homepage/config/services.yaml` (it's always the local-port version) and just `curl -sf -o /dev/null -m 5 <url> && echo up || echo down`.
