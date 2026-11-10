# Translate

> Detect the language of the most recent incoming message and translate it to English (and English → Afrikaans by default if the owner writes English).

Look up the most recent message from the user in this chat — either in your context or by reading `data/chats/<jid>.jsonl` (last line).

1. **Detect** the source language. If it's English, target Afrikaans (the owner's secondary). Otherwise target English.
2. Reply in this exact format — nothing else:

```
*Translation* (<source> → <target>)
<translation>

Original:
_<source text>_
```

3. Keep the original verbatim under the translation so the owner can verify.
4. If the message is obviously English already and just has slang or typos, instead correct it cleanly under "Cleaned-up English:". Don't be pedantic.

Don't translate anything the owner said — only the most recent message *from someone else*.
