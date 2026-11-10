# Morning briefing
> Today's schedule, urgent emails, and anything notable

Run my morning briefing:

1. Today's scheduled cron jobs / reminders — run `node scripts/cron.mjs list` and filter to jobs firing today.
2. Unread email summary — if `himalaya` is installed, run `himalaya envelopes list --filter "flag NEW" -o json` and give me sender + subject + 1-line gist. 5 max, urgent first.
3. "## Saved" items from MEMORY.md — echo them back. Ask if they should be cleared.
4. Anything notable from yesterday's daily note at `memory/<yesterday>.md` (single sentence).
5. Homelab quick check — `curl -sf -o /dev/null -m 3 http://localhost:7878 && echo "radarr up" || echo "radarr down"` for Radarr, Sonarr, Plex, Jellyfin.

Format: tight bullets, lead with the most urgent item. WhatsApp-friendly, no headings.
