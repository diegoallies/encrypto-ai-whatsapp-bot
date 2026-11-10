// Detect bare URLs in incoming text and (asynchronously) hand them to Claude
// for a 3-bullet summary that gets DM'd back. Stays out of the main reply
// path — the user's normal message still gets processed; the unfurl is a
// side-quest delivered as a follow-up.
//
// Gated by URL_UNFURL=1. Otherwise silent.

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/g;

export function extractUrls(text) {
  if (!text) return [];
  const seen = new Set();
  const out = [];
  for (const m of String(text).matchAll(URL_RE)) {
    const u = m[0].replace(/[.,;:!?)]+$/, ''); // strip trailing punctuation
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

export function shouldUnfurl(text) {
  if (process.env.URL_UNFURL !== '1') return false;
  const urls = extractUrls(text);
  if (urls.length === 0) return false;
  // If the message is JUST the URL (or URL + 1-2 words), it's a clear share-
  // and-summarise. Otherwise we stay quiet (user probably had context in mind).
  const without = text.replace(URL_RE, '').trim();
  return without.length <= 16 && urls.length <= 3;
}

const PROMPT = (urls) => `[url unfurl]

The user just shared ${urls.length === 1 ? 'a link' : 'some links'} with little/no extra text. Use WebFetch to read each one, then reply with a tight summary:

${urls.map((u, i) => `${i + 1}. ${u}`).join('\n')}

Format per URL (3 bullets max):
- Title / what it is
- The thing worth reading
- Optional: a date, dollar figure, or name worth remembering

WhatsApp-friendly. No headings. If a URL 404s, say so in one line.`;

export function buildUnfurlPrompt(urls) {
  return PROMPT(urls);
}
