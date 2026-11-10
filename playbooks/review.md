# Weekly review
> Recap of the last 7 days — wins, open threads, untouched contacts

Generate the owner's weekly review:

1. **Activity recap.** Glance through the last 7 daily notes at `memory/*.md` (yesterday through 7 days ago). Pull out 3-5 "wins" — projects shipped, problems solved, decisions made.

2. **Open threads.** Check `MEMORY.md` "## Open threads" section. List what's still pending. If any have been there >2 weeks, flag them as stale.

3. **Untouched contacts.** the owner has a few key contacts (a contact, a family contact, Walt). Grep `data/chats/<jid>.jsonl` for last `evt:'rx'` timestamp per contact. Flag anyone he hasn't talked to in 5+ days.

4. **Token spend.** Read `memory/heartbeat-state.json` for the `tokens:total` counter. Report this week's daily numbers if available, else just today's.

Format: 4 sections, max 4 lines each. WhatsApp-friendly bullets.
