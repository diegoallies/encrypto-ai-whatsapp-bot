# Reply suggestions

> Given the most recent incoming message, draft 3 short reply options the owner could send.

Look at the most recent incoming message in this chat (from `data/chats/<jid>.jsonl` last line, or your own context).

Produce exactly 3 ready-to-send replies, in the owner's voice (casual, no fluff, ≤120 chars each). Cover three angles:

1. **Friendly / agreeable** — go along with whatever was asked/said.
2. **Defer / buy time** — non-committal, opens a window to think.
3. **Honest / direct** — say what the owner probably really thinks.

Reply ONLY in this format, no preamble:

```
1. <reply>
2. <reply>
3. <reply>
```

After listing them, end with one short sentence asking the owner which to send (he might just react with 1/2/3).
