// Chat history search backed by the postgres `messages` table.
// The JSONL files in data/chats/ are still written as a safety net by
// memory.js but the read path lives here.

import * as db from './db.js';

export async function searchChats(query, { jidFilter = null, jids = null, max = 50 } = {}) {
  if (!query || !query.trim()) return { matches: [], scanned: 0 };

  const jidList = jids ? (Array.isArray(jids) ? jids : [jids]) : jidFilter ? [jidFilter] : null;

  const params = [`%${query}%`, max];
  let sql = `
    SELECT jid, role, content AS text, msg_id, created_at
    FROM messages
    WHERE content ILIKE $1
  `;
  if (jidList && jidList.length > 0) {
    sql += ` AND jid = ANY($3::text[])`;
    params.push(jidList);
  }
  sql += `
    ORDER BY created_at DESC
    LIMIT $2
  `;

  const r = await db.query(sql, params);
  const matches = r.rows.map((row) => ({
    jid: row.jid,
    t: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    role: row.role,
    text: row.text,
    msgId: row.msg_id || null,
  }));
  return { matches, scanned: matches.length };
}

// Build a short text snippet around the match (for chat replies).
export function snippetOf(text, query, around = 40) {
  if (!text || !query) return text || '';
  const lower = text.toLowerCase();
  const i = lower.indexOf(query.toLowerCase());
  if (i < 0) return text.slice(0, around * 2);
  const start = Math.max(0, i - around);
  const end = Math.min(text.length, i + query.length + around);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}
