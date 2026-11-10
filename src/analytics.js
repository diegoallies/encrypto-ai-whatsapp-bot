// Analytics tracking for token usage, message counts, response times.
// Now uses PostgreSQL for persistence.

import * as db from './db.js';

// In-memory cache for fast reads (synced from DB periodically)
let cache = {
  hourlyTokens: {},
  dailyTokens: {},
  hourlyMessages: {},          // "YYYY-MM-DDTHH" -> count
  messagesByContactToday: {},  // jid -> { sent, received } scoped to today
  todayKey: new Date().toISOString().slice(0, 10),
  messagesByContact: {},
  responseTimes: [],
};

// Load from database
export async function loadAnalytics() {
  try {
    // Load daily tokens. Use the YYYY-MM-DD string returned by the query
    // rather than row.date.toISOString() — the pg driver hands DATE columns
    // back as Date objects in local time, which is one day behind UTC when
    // the bot runs east of UTC, so the bucket key wouldn't match what the
    // chart looks up.
    const tokenRows = await db.getTokenUsage(90);
    for (const row of tokenRows) {
      const key = row.date_str || row.date.toISOString().slice(0, 10);
      cache.dailyTokens[key] = Number(row.input_tokens) + Number(row.output_tokens);
    }

    // Load hourly tokens (rebuilds the 24h sparkline on the dashboard and
    // the "Last 24 hours" chart on /analytics after a restart).
    try {
      const hourlyRows = await db.getHourlyTokenRollups(48);
      for (const row of hourlyRows) {
        if (!row.hour_str) continue;
        cache.hourlyTokens[row.hour_str] = Number(row.input_tokens) + Number(row.output_tokens);
      }
    } catch (err) {
      console.error('[analytics] Failed to load hourly tokens:', err.message);
    }

    // Load message stats
    const msgRows = await db.getMessageStats();
    for (const row of msgRows) {
      cache.messagesByContact[row.jid] = {
        sent: row.sent,
        received: row.received,
      };
    }

    // Load recent response times so the distribution histogram survives
    // a restart. Without this the chart blanks out on every PM2 reload.
    try {
      const rtRows = await db.getResponseTimes(24, 1000);
      cache.responseTimes = rtRows.map((r) => ({
        ms: Number(r.response_ms),
        t: r.recorded_at instanceof Date ? r.recorded_at.toISOString() : r.recorded_at,
      }));
    } catch (err) {
      console.error('[analytics] Failed to load response times:', err.message);
    }

    console.log('[analytics] Loaded from PostgreSQL');
  } catch (err) {
    console.error('[analytics] Failed to load from DB:', err.message);
  }
}

// Save is now a no-op since we write to DB immediately
export async function saveAnalytics() {
  // Data is persisted to PostgreSQL on each record call
}

// Record token usage
export function recordTokens(inputTokens, outputTokens, cacheReadTokens = 0) {
  const now = new Date();
  const hourKey = now.toISOString().slice(0, 13);
  const dayKey = now.toISOString().slice(0, 10);

  const total = (inputTokens || 0) + (outputTokens || 0);

  // Update cache
  cache.hourlyTokens[hourKey] = (cache.hourlyTokens[hourKey] || 0) + total;
  cache.dailyTokens[dayKey] = (cache.dailyTokens[dayKey] || 0) + total;

  // Write to DB (async, fire and forget for speed)
  db.recordTokens(inputTokens || 0, outputTokens || 0, cacheReadTokens || 0).catch(err => {
    console.error('[analytics] Failed to record tokens:', err.message);
  });

  // Clean up old hourly data from cache (keep last 7 days)
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 13);
  for (const key of Object.keys(cache.hourlyTokens)) {
    if (key < cutoff) delete cache.hourlyTokens[key];
  }
}

// Record a message
export function recordMessage(jid, direction) {
  // Update cache
  if (!cache.messagesByContact[jid]) {
    cache.messagesByContact[jid] = { sent: 0, received: 0 };
  }
  if (direction === 'sent') {
    cache.messagesByContact[jid].sent++;
  } else {
    cache.messagesByContact[jid].received++;
  }

  // Hourly bucket (in-memory only — drives the dashboard sparkline)
  const now = new Date();
  const hourKey = now.toISOString().slice(0, 13);
  cache.hourlyMessages[hourKey] = (cache.hourlyMessages[hourKey] || 0) + 1;
  const dayKey = now.toISOString().slice(0, 10);
  if (cache.todayKey !== dayKey) {
    cache.todayKey = dayKey;
    cache.messagesByContactToday = {};
  }
  if (!cache.messagesByContactToday[jid]) {
    cache.messagesByContactToday[jid] = { sent: 0, received: 0 };
  }
  cache.messagesByContactToday[jid][direction === 'sent' ? 'sent' : 'received']++;
  // Trim hourly buckets older than 48h to keep the map small.
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 13);
  for (const k of Object.keys(cache.hourlyMessages)) {
    if (k < cutoff) delete cache.hourlyMessages[k];
  }

  // Write to DB
  db.recordMessageStat(jid, direction).catch(err => {
    console.error('[analytics] Failed to record message:', err.message);
  });
}

// Hourly message counts for the last N hours, in chronological order.
export function getHourlyMessages(hours = 24) {
  const out = [];
  const now = new Date();
  for (let i = hours - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 13);
    out.push({
      hour: key,
      label: d.toLocaleTimeString('en-US', { hour: '2-digit', hour12: true }),
      count: cache.hourlyMessages[key] || 0,
    });
  }
  return out;
}

// Top contacts today (process-local — resets on restart).
export function getTopContactsToday(limit = 5) {
  return Object.entries(cache.messagesByContactToday)
    .map(([jid, c]) => ({ jid, sent: c.sent, received: c.received, total: c.sent + c.received }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

// Record response time
export function recordResponseTime(ms) {
  // Update cache
  cache.responseTimes.push({ ms, t: new Date().toISOString() });
  if (cache.responseTimes.length > 1000) {
    cache.responseTimes = cache.responseTimes.slice(-1000);
  }

  // Write to DB
  db.recordResponseTime(ms).catch(err => {
    console.error('[analytics] Failed to record response time:', err.message);
  });
}

// Get hourly token usage for last N hours
export function getHourlyTokens(hours = 24) {
  const result = [];
  const now = new Date();
  for (let i = hours - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 13);
    result.push({
      hour: key,
      label: d.toLocaleTimeString('en-US', { hour: '2-digit', hour12: true }),
      tokens: cache.hourlyTokens[key] || 0,
    });
  }
  return result;
}

// Get daily token usage for last N days
export function getDailyTokens(days = 30) {
  const result = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    result.push({
      date: key,
      label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      tokens: cache.dailyTokens[key] || 0,
    });
  }
  return result;
}

// Get message counts per contact
export function getMessagesByContact() {
  return Object.entries(cache.messagesByContact)
    .map(([jid, counts]) => ({
      jid,
      sent: counts.sent,
      received: counts.received,
      total: counts.sent + counts.received,
    }))
    .sort((a, b) => b.total - a.total);
}

// Get average response time
export function getAvgResponseTime() {
  if (cache.responseTimes.length === 0) return 0;
  const sum = cache.responseTimes.reduce((a, b) => a + b.ms, 0);
  return Math.round(sum / cache.responseTimes.length);
}

// Get response time distribution
export function getResponseTimeDistribution() {
  const buckets = { '<1s': 0, '1-3s': 0, '3-5s': 0, '5-10s': 0, '>10s': 0 };
  for (const { ms } of cache.responseTimes) {
    if (ms < 1000) buckets['<1s']++;
    else if (ms < 3000) buckets['1-3s']++;
    else if (ms < 5000) buckets['3-5s']++;
    else if (ms < 10000) buckets['5-10s']++;
    else buckets['>10s']++;
  }
  return buckets;
}

// Get summary stats
export function getSummary() {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  return {
    tokensToday: cache.dailyTokens[today] || 0,
    tokensYesterday: cache.dailyTokens[yesterday] || 0,
    totalContacts: Object.keys(cache.messagesByContact).length,
    avgResponseTime: getAvgResponseTime(),
    totalMessages: Object.values(cache.messagesByContact).reduce((a, b) => a + b.sent + b.received, 0),
  };
}

// Get data from PostgreSQL (for analytics page)
export async function getFromDb() {
  return db.getAnalyticsSummary();
}

// Sync cache from DB every 5 minutes
setInterval(() => loadAnalytics(), 5 * 60 * 1000);
