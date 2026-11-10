// Subscribe to a ntfy.sh topic and forward each message to a WhatsApp JID.
// Gated by env: NTFY_TOPIC (e.g. "myalerts" or "myalerts-security").
// Optional: NTFY_SERVER (default https://ntfy.sh), NTFY_TOKEN for private topics.
//
// Reconnects on disconnect with exponential backoff.

const DEFAULT_SERVER = 'https://ntfy.sh';

export function startNtfyBridge({ sock, jid }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return null;
  if (!jid) return null;

  const server = (process.env.NTFY_SERVER || DEFAULT_SERVER).replace(/\/+$/, '');
  const token = process.env.NTFY_TOKEN;
  const url = `${server}/${encodeURIComponent(topic)}/json`;

  let stop = false;
  let backoff = 2_000;

  async function connect() {
    if (stop) return;
    try {
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(url, { headers });
      if (!res.ok || !res.body) throw new Error(`ntfy http ${res.status}`);
      backoff = 2_000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (!stop) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt.event !== 'message') continue;
          const title = evt.title ? `${evt.title}\n` : '';
          const body = evt.message || '';
          const tags = evt.tags?.length ? `\n[${evt.tags.join(', ')}]` : '';
          await sock.sendMessage(jid, { text: `🔔 ntfy/${topic}\n${title}${body}${tags}` }).catch(() => {});
        }
      }
    } catch (err) {
      console.error(`ntfy bridge: ${err.message} — reconnecting in ${Math.round(backoff / 1000)}s`);
    }
    if (stop) return;
    setTimeout(connect, backoff).unref();
    backoff = Math.min(backoff * 2, 60_000);
  }

  connect();
  console.log(`ntfy bridge: subscribed to ${server}/${topic}`);
  return () => { stop = true; };
}
