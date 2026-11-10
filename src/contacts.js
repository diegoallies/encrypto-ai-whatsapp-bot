// Best-effort JID → display-name lookup, backed by wacli's contacts table.
// Cached for 30 minutes so we don't fork wacli on every group message.

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execCb);

const TTL_MS = 30 * 60_000;
const cache = new Map(); // jid → { name, expires }
let lastFullLoad = 0;
const FULL_RELOAD_MS = 60 * 60_000;

function stores() {
  const list = [process.env.WACLI_STORE, '$HOME/.wacli-main', '$HOME/.wacli-alt']
    .filter(Boolean);
  return [...new Set(list)];
}

async function loadAll() {
  if (Date.now() - lastFullLoad < FULL_RELOAD_MS) return;
  lastFullLoad = Date.now();
  for (const store of stores()) {
    try {
      const { stdout } = await exec(`wacli --store ${JSON.stringify(store)} contacts list --json`, {
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const arr = JSON.parse(stdout);
      if (!Array.isArray(arr)) continue;
      for (const c of arr) {
        const jid = c.jid || c.id;
        const name = c.name || c.pushName || c.displayName || c.notify || null;
        if (jid && name) cache.set(jid, { name, expires: Date.now() + TTL_MS });
      }
    } catch {}
  }
}

// Look this JID up in the user-curated data/contacts.json first — those
// labels (a contact, a contact, …) are the canonical "what to call this person".
// Falls back to the wacli-backed cache if the label isn't set there.
async function labelFromOnboard(jid) {
  if (!jid) return null;
  try {
    const { listContacts } = await import('./contact-onboard.js');
    const all = await listContacts();
    const match = all.find((c) => c.phoneJid === jid || c.lid === jid);
    return match?.label || null;
  } catch {
    return null;
  }
}

export async function displayName(jid) {
  if (!jid) return null;

  // Handle group chats - lookup group name
  if (jid.endsWith('@g.us')) {
    const cached = cache.get(jid);
    if (cached && cached.expires > Date.now()) return cached.name;
    // Try to get group name from wacli
    const groupInfo = await lookupContact(jid);
    if (groupInfo?.name) {
      cache.set(jid, { name: groupInfo.name, expires: Date.now() + TTL_MS });
      return groupInfo.name;
    }
    return null; // Will show raw JID for unknown groups
  }

  // 1. Check user-curated contacts.json
  const fromOnboard = await labelFromOnboard(jid);
  if (fromOnboard) return fromOnboard;

  // 2. Check wacli cache
  const cached = cache.get(jid);
  if (cached && cached.expires > Date.now()) return cached.name;

  // 3. For @lid JIDs, do a direct wacli lookup to resolve
  if (jid.endsWith('@lid')) {
    const info = await lookupContact(jid);
    if (info?.name) {
      cache.set(jid, { name: info.name, expires: Date.now() + TTL_MS });
      return info.name;
    }
    // If we got a phone number, try to match against onboard contacts
    if (info?.phone) {
      const { listContacts } = await import('./contact-onboard.js');
      const all = await listContacts();
      const digits = info.phone.replace(/\D+/g, '');
      const match = all.find((c) => c.phoneJid?.includes(digits));
      if (match?.label) {
        cache.set(jid, { name: match.label, expires: Date.now() + TTL_MS });
        return match.label;
      }
    }
  }

  // 4. Refresh cache lazily for next time
  loadAll().catch(() => {});
  return cached?.name || null;
}

// Force a refresh on demand.
export async function refresh() {
  lastFullLoad = 0;
  await loadAll();
}

// Direct `wacli contacts show --jid <jid>` lookup. Returns null on miss.
// Useful for stranger pings — even random @lid's may have a wacli name.
export async function lookupContact(jid) {
  if (!jid) return null;
  for (const store of stores()) {
    try {
      const { stdout } = await exec(
        `wacli --store ${JSON.stringify(store)} contacts show --jid ${JSON.stringify(jid)} --json`,
        { timeout: 5_000 },
      );
      const body = JSON.parse(stdout);
      if (body?.success && body.data) {
        const d = body.data;
        const name = d.Alias || d.Name || d.PushName || null;
        const phone = d.Phone || null;
        if (name || phone) return { name, phone, raw: d };
      }
    } catch {}
  }
  return null;
}
