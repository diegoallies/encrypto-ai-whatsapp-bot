# Migration — Kali homelab → M2 MacBook (macOS)

Playbook for moving the WhatsApp bot and adjacent homelab services from the
current Kali box (`your-server`) to an M2 MacBook running macOS.

## Why macOS, not Asahi Linux
- M2 VideoToolbox = hardware HEVC/AV1 transcode for Plex/Jellyfin (Asahi hasn't
  wired this up yet — going Linux would make 4K playback *worse*, not better).
- Ollama on M2 with Metal is 3-5× faster than the same model on x86 CPU.
- 16 GB unified memory on M2 vs 7.6 GB on the Kali box → fits Redamon comfortably.
- Docker via Colima runs Linux containers natively; UTM covers anything
  genuinely Linux-only.
- Losing very little vs Linux, gaining a lot on media + LLM performance.

## Phases

### Phase 1 — Backup (done from Kali)
Run `scripts/backup-homelab.sh` on the Kali box. Produces `/tmp/homelab-backup/`
(~200 MB) containing all service configs, DBs, and the bot's Baileys session.

### Phase 2 — Fresh macOS install
Follow `docs/INSTALL_MACOS.md` on the MacBook. Installs Homebrew, Node, Postgres,
Colima, Ollama, PM2, and clones the bot repo. Get the bot booting locally with
no data. Verify it reaches WhatsApp with a fresh QR pair (temporary).

### Phase 3 — Bridge + transfer
On Kali: `rsync -avP /tmp/homelab-backup/ user@macbook.local:~/homelab-backup/`
Or: physically move via USB SSD if network is slow.

### Phase 4 — Restore on macOS
Follow `docs/RESTORE_ON_MAC.md`. Order matters: Postgres first, then Baileys
session (avoids QR re-pair), then per-service configs. Verify each service
before moving on.

### Phase 5 — Cutover
Stop the bot on Kali, start it on macOS. Update the `.env`'s `PUBLIC_URL` if
Caddy is being replaced. Point domain routing at the MacBook.

### Phase 6 — Kali becomes storage / seedbox
Keep the media HDD (`sdb2`, 233 GB) on Kali. Export it via NFS or SMB. MacBook
Plex/Jellyfin mount it as a network drive — no reformat needed.

## What lives where after migration

| Service            | Kali (your-server)  | MacBook              |
|--------------------|------------------------|----------------------|
| WhatsApp bot       | ❌ retired              | ✅ PM2               |
| Postgres           | ❌ retired              | ✅ Homebrew          |
| Ollama             | ❌ retired              | ✅ native (Metal)    |
| Redamon / pentest  | ❌ retired              | ✅ Colima            |
| Pi-hole            | ❌ retired              | ✅ Docker            |
| Homepage / Caddy   | ❌ retired              | ✅ Docker            |
| Plex / Jellyfin    | ❌ retired              | ✅ native (HW transcode) |
| Sonarr / Radarr    | ❌ retired              | ✅ Docker            |
| qBittorrent        | ❌ retired              | ✅ native            |
| schedule-site      | ❌ retired              | ✅ Node              |
| budget-tracker     | ❌ retired              | ✅ Node              |
| Media HDD (`sdb2`) | ✅ kept, NFS-shared     | ➡️ mounted via NFS  |

Physical HDD stays plugged into Kali. Kali becomes a pure storage/backup node.

## Rollback plan
Everything on Kali stays live during migration. If macOS build fails, don't
cut over — keep running Kali as-is. Backup bundle is idempotent (safe to re-run).
Baileys session is *copied*, not moved, so both boxes can hold it (only one
should be *running* at a time to avoid session conflicts).

## Notes
- Do NOT run bot on both boxes at once — WhatsApp disconnects the older session.
- Ollama models re-download fresh on macOS (`ollama pull phi3:mini` etc). The
  backup only saves the model list, not the weights (they're big and easy to
  re-fetch).
- Sonarr/Radarr paths need re-mapping (`/media/storage/tv` → `/Volumes/media/tv`
  or wherever it's mounted). `docs/RESTORE_ON_MAC.md` shows the exact swap.
