// Friendly contact onboarding backed by the postgres `contacts` table.
// The user types a phone + optional label; we resolve the @lid via the live
// socket, add both forms to the allowlist, and persist label + lid + phone
// against the phoneJid row.
//
// One-shot migration imports data/contacts.json on first boot.

import fs from 'node:fs/promises';
import path from 'node:path';
import { addAllowed, removeAllowed } from './allowlist.js';
import * as db from './db.js';

const LEGACY_FILE = path.join('data', 'contacts.json');

// ─── Phone normalization ─────────────────────────────────────────────────
export function normalizePhone(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D+/g, '');
  if (digits.length < 7 || digits.length > 16) return null;
  return digits;
}

function phoneJidFor(digits) { return `${digits}@s.whatsapp.net`; }

// ─── Legacy file migration ───────────────────────────────────────────────
let migrationDone = false;
async function migrateLegacyFileIfNeeded() {
  if (migrationDone) return;
  migrationDone = true;
  // Only migrate if no contact rows have a phone yet.
  const r = await db.query(
    `SELECT COUNT(*)::int AS c FROM contacts WHERE phone IS NOT NULL`,
  ).catch(() => ({ rows: [{ c: 0 }] }));
  if (Number(r.rows[0]?.c) > 0) return;

  let text;
  try { text = await fs.readFile(LEGACY_FILE, 'utf-8'); }
  catch { return; }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return; }
  if (!parsed || typeof parsed !== 'object') return;

  let migrated = 0;
  for (const [phone, c] of Object.entries(parsed)) {
    const phoneJid = c.phoneJid || phoneJidFor(phone);
    await db.upsertContact(phoneJid, {
      phone,
      label: c.label || null,
      isAllowed: true,
      metadata: { addedAt: c.addedAt || null },
    }).catch(() => {});
    if (c.lid) {
      await db.query(
        `UPDATE contacts SET lid = $1, updated_at = NOW() WHERE jid = $2`,
        [c.lid, phoneJid],
      ).catch(() => {});
    }
    migrated++;
  }
  if (migrated > 0) {
    console.log(`contact-onboard: migrated ${migrated} contact(s) from ${LEGACY_FILE} to postgres`);
    await fs.rename(LEGACY_FILE, `${LEGACY_FILE}.imported-${Date.now()}`).catch(() => {});
  }
}

// Run the migration in the background — it'll have completed by the time
// the dashboard actually queries, in practice.
migrateLegacyFileIfNeeded().catch(() => {});

// ─── List ────────────────────────────────────────────────────────────────
export async function listContacts() {
  await migrateLegacyFileIfNeeded();
  const rows = await db.listKnownContacts();
  return rows.map((r) => ({
    phone: r.phone,
    label: r.label || null,
    phoneJid: r.jid,
    lid: r.lid || null,
    addedAt: r.metadata?.addedAt || r.created_at?.toISOString?.() || null,
    active: Boolean(r.is_allowed),
  }));
}

// ─── Add ─────────────────────────────────────────────────────────────────
async function resolveLid(sock, digits) {
  if (!sock || typeof sock.onWhatsApp !== 'function') return null;
  try {
    const res = await sock.onWhatsApp(phoneJidFor(digits));
    const first = Array.isArray(res) ? res[0] : null;
    if (!first?.exists) return { exists: false, lid: null };
    return { exists: true, lid: first.lid || null };
  } catch (err) {
    console.error('contact-onboard: onWhatsApp failed', err.message);
    return null;
  }
}

export async function addContact({ phone, label = '', sock = null }) {
  await migrateLegacyFileIfNeeded();
  const digits = normalizePhone(phone);
  if (!digits) return { ok: false, error: 'Invalid phone number.' };

  const phoneJid = phoneJidFor(digits);
  let lid = null;
  let onWhatsAppExists = null;

  const resolved = await resolveLid(sock, digits);
  if (resolved) {
    onWhatsAppExists = resolved.exists;
    lid = resolved.lid;
  }
  if (onWhatsAppExists === false) {
    return { ok: false, error: `${digits} doesn't appear to be on WhatsApp.` };
  }

  // Allowlist (in-memory + .env mirror + contacts.is_allowed)
  addAllowed(phoneJid);
  if (lid) addAllowed(lid);

  // Persist human metadata. upsertContact already set is_allowed=true via
  // addAllowed → setContactAllowed → INSERT; here we layer the phone + label
  // + lid on the same row.
  await db.upsertContact(phoneJid, {
    phone: digits,
    label: String(label || '').trim() || null,
    isAllowed: true,
    metadata: { addedAt: new Date().toISOString() },
  });
  if (lid) {
    await db.query(
      `UPDATE contacts SET lid = $1, updated_at = NOW() WHERE jid = $2`,
      [lid, phoneJid],
    );
  }

  return {
    ok: true,
    phone: digits,
    label: String(label || '').trim() || null,
    phoneJid,
    lid,
    resolved: lid != null,
  };
}

// ─── Late LID backfill ───────────────────────────────────────────────────
// contact-add.mjs is supposed to resolve a contact's @lid at add-time via
// sock.onWhatsApp, but Baileys v7's LID mapping isn't always populated
// until the contact has actually messaged the account at least once. When
// the LID isn't known at add-time we only allowlist the phone JID, so the
// contact's first inbound (routed via their LID) gets silently blocked.
//
// This helper closes the race: called from the handler's allowlist gate
// whenever an @lid DM misses, it reverse-resolves LID → phone via the
// live socket, checks whether that phone maps to a known + allowed
// contact row, and if so hot-allows the LID + persists the mapping.
//
// Returns the resolved phone JID on success, null on miss.
export async function backfillLidFromMessage(sock, lid) {
  if (!lid || typeof lid !== 'string' || !lid.endsWith('@lid')) return null;
  if (!sock || typeof sock.onWhatsApp !== 'function') return null;

  let phoneJid = null;
  try {
    const res = await sock.onWhatsApp(lid);
    const first = Array.isArray(res) ? res[0] : null;
    if (first?.jid && String(first.jid).endsWith('@s.whatsapp.net')) phoneJid = first.jid;
  } catch {
    return null;
  }
  if (!phoneJid) return null;

  const digits = phoneJid.split('@')[0];
  const row = await db.findContactByPhone(digits).catch(() => null);
  if (!row || !row.is_allowed) return null;

  addAllowed(lid);
  await db.query(
    `UPDATE contacts SET lid = $1, updated_at = NOW() WHERE jid = $2`,
    [lid, phoneJid],
  ).catch(() => {});
  return phoneJid;
}

// ─── Remove ──────────────────────────────────────────────────────────────
export async function removeContact(phoneOrJid) {
  await migrateLegacyFileIfNeeded();
  const digits = normalizePhone(phoneOrJid);

  if (digits) {
    const phoneJid = phoneJidFor(digits);
    const row = await db.findContactByPhone(digits);
    const lid = row?.lid || null;
    removeAllowed(phoneJid);
    if (lid) removeAllowed(lid);
    const ok = await db.removeContactByPhone(digits);
    return { ok };
  }
  // Fallback: treat as raw JID.
  if (String(phoneOrJid).includes('@')) {
    removeAllowed(phoneOrJid);
    await db.removeContactRow(phoneOrJid);
    return { ok: true };
  }
  return { ok: false, error: 'Contact not found.' };
}
