# Summarize URL

> Fetch a URL and return a tight TL;DR + key takeaways.

I'll send you a URL in a moment (or you already have one in context).

Steps:

1. Use the **WebFetch** tool to get the page content. If the URL is a YouTube video, just hit the page — it has the title, channel, and description; transcript scraping is best-effort.
2. Produce a summary in this exact format (Markdown is fine — keep it tight for WhatsApp):

```
*<title>*
_<source domain · ~N min read>_

TL;DR: <one sentence>

Key points:
• <bullet>
• <bullet>
• <bullet 3-5 total>

Useful for: <one line on why someone would care>
```

3. No preamble like "Sure, here's…" — just the summary, ready to forward.

If the page fails to fetch (paywall / 403 / non-HTML), say so in one line with the reason.
