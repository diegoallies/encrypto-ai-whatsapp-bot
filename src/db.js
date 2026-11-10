// PostgreSQL database module for Encrypto AI bot
// Stores analytics, messages, contacts, cron jobs, and more

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: Number(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE || 'encrypto_bot',
  user: process.env.PG_USER || 'encrypto',
  password: process.env.PG_PASSWORD || 'encrypto_ai_2026',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Test connection on startup
pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

// Initialize database schema
export async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      -- Analytics: daily token usage
      CREATE TABLE IF NOT EXISTS token_usage (
        id SERIAL PRIMARY KEY,
        date DATE NOT NULL DEFAULT CURRENT_DATE,
        input_tokens BIGINT DEFAULT 0,
        output_tokens BIGINT DEFAULT 0,
        cache_read_tokens BIGINT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(date)
      );

      -- Analytics: hourly token rollups (drives the 24h chart after restart)
      CREATE TABLE IF NOT EXISTS token_usage_hourly (
        hour TIMESTAMPTZ PRIMARY KEY,
        input_tokens BIGINT DEFAULT 0,
        output_tokens BIGINT DEFAULT 0,
        cache_read_tokens BIGINT DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_token_usage_hourly_hour ON token_usage_hourly(hour);

      -- Analytics: messages per contact
      CREATE TABLE IF NOT EXISTS message_stats (
        id SERIAL PRIMARY KEY,
        jid VARCHAR(100) NOT NULL,
        sent INT DEFAULT 0,
        received INT DEFAULT 0,
        last_message_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(jid)
      );

      -- Analytics: response times
      CREATE TABLE IF NOT EXISTS response_times (
        id SERIAL PRIMARY KEY,
        response_ms INT NOT NULL,
        recorded_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Chat messages
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        jid VARCHAR(100) NOT NULL,
        role VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        msg_id VARCHAR(100),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_messages_jid ON messages(jid);
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

      -- Contacts
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        jid VARCHAR(100) NOT NULL UNIQUE,
        phone VARCHAR(30),
        name VARCHAR(100),
        label VARCHAR(100),
        lid VARCHAR(100),
        is_allowed BOOLEAN DEFAULT FALSE,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      -- In case the table was created before lid existed.
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lid VARCHAR(100);
      CREATE INDEX IF NOT EXISTS idx_contacts_lid ON contacts(lid) WHERE lid IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone) WHERE phone IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_contacts_is_allowed ON contacts(is_allowed) WHERE is_allowed = TRUE;

      -- Cron jobs
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id SERIAL PRIMARY KEY,
        job_id VARCHAR(50) NOT NULL UNIQUE,
        jid VARCHAR(100),
        schedule_type VARCHAR(20) NOT NULL,
        schedule_value VARCHAR(100),
        notify_text TEXT,
        prompt_text TEXT,
        enabled BOOLEAN DEFAULT TRUE,
        last_run_at TIMESTAMPTZ,
        next_run_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Daily notes / journal
      CREATE TABLE IF NOT EXISTS daily_notes (
        id SERIAL PRIMARY KEY,
        date DATE NOT NULL DEFAULT CURRENT_DATE,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_daily_notes_date ON daily_notes(date);

      -- Memory items (saved messages, pinned content)
      CREATE TABLE IF NOT EXISTS memory_items (
        id SERIAL PRIMARY KEY,
        key VARCHAR(100) NOT NULL,
        value TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(key)
      );

      -- Open threads (paused work that needs to resume) — surfaced in system prompt + /memory page
      CREATE TABLE IF NOT EXISTS open_threads (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT,
        status VARCHAR(20) DEFAULT 'open',
        jid VARCHAR(100),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_open_threads_status ON open_threads(status);

      -- Session stats (resets on restart, for dashboard)
      CREATE TABLE IF NOT EXISTS session_stats (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(50) NOT NULL,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        messages INT DEFAULT 0,
        tokens_in BIGINT DEFAULT 0,
        tokens_out BIGINT DEFAULT 0,
        errors INT DEFAULT 0
      );

      -- Scheduler jobs (replaces data/scheduled.json)
      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        job_id VARCHAR(50) PRIMARY KEY,
        jid VARCHAR(100) NOT NULL,
        text TEXT NOT NULL,
        mode VARCHAR(20) NOT NULL DEFAULT 'notify',
        run_at TIMESTAMPTZ NOT NULL,
        recurring JSONB,
        paused BOOLEAN DEFAULT FALSE,
        last_fired_at TIMESTAMPTZ,
        last_fire_ok BOOLEAN,
        last_fire_error TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_run_at ON scheduled_jobs(run_at);

      -- Misc process state (restart counter, kv flags)
      CREATE TABLE IF NOT EXISTS app_state (
        key VARCHAR(100) PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('[db] Schema initialized');
  } finally {
    client.release();
  }
}

// ─── Token Usage ───────────────────────────────────────────────────────────

export async function recordTokens(input, output, cacheRead = 0) {
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(`
    INSERT INTO token_usage (date, input_tokens, output_tokens, cache_read_tokens)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (date) DO UPDATE SET
      input_tokens = token_usage.input_tokens + $2,
      output_tokens = token_usage.output_tokens + $3,
      cache_read_tokens = token_usage.cache_read_tokens + $4
  `, [today, input, output, cacheRead]);

  // Also bucket per-hour so the "Last 24 hours" chart can be rehydrated
  // after a restart. Without this, hourly data is process-local and the
  // chart blanks out every time PM2 reloads.
  await pool.query(`
    INSERT INTO token_usage_hourly (hour, input_tokens, output_tokens, cache_read_tokens)
    VALUES (date_trunc('hour', NOW()), $1, $2, $3)
    ON CONFLICT (hour) DO UPDATE SET
      input_tokens = token_usage_hourly.input_tokens + $1,
      output_tokens = token_usage_hourly.output_tokens + $2,
      cache_read_tokens = token_usage_hourly.cache_read_tokens + $3
  `, [input, output, cacheRead]).catch((err) => {
    // Table may not exist on older DBs — schedule init has created it but
    // existing installs need a one-time CREATE. Log once and move on.
    if (err.code !== '42P01') console.error('[db] hourly token write failed:', err.message);
  });
}

export async function getTokenUsage(days = 30) {
  // - Cast $1 to INT so Postgres picks the date - int -> date operator
  //   (otherwise the param arrives as 'unknown' type and the parser can't
  //   disambiguate, producing "operator does not exist: date >= integer").
  // - Return date as a YYYY-MM-DD string via TO_CHAR so the JS bucket key
  //   matches new Date().toISOString().slice(0,10). Without this the pg
  //   driver hands back a Date object aligned to the local timezone, which
  //   ends up one day behind UTC when the server is east of UTC and
  //   silently blanks out the daily chart.
  const result = await pool.query(`
    SELECT
      TO_CHAR(date, 'YYYY-MM-DD') AS date_str,
      date,
      input_tokens, output_tokens, cache_read_tokens
    FROM token_usage
    WHERE date >= CURRENT_DATE - $1::INT
    ORDER BY date DESC
  `, [days]);
  return result.rows;
}

// Hourly token rollups for the dashboard sparkline / Analytics "Last 24h"
// chart. hour_str is in UTC (YYYY-MM-DDTHH) so it matches the in-memory
// cache key format used by analytics.js.
export async function getHourlyTokenRollups(hours = 48) {
  const result = await pool.query(`
    SELECT
      TO_CHAR(hour AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24') AS hour_str,
      input_tokens, output_tokens, cache_read_tokens
    FROM token_usage_hourly
    WHERE hour >= NOW() - ($1::INT * INTERVAL '1 hour')
    ORDER BY hour DESC
  `, [hours]);
  return result.rows;
}

export async function getTodayTokens() {
  const result = await pool.query(`
    SELECT input_tokens, output_tokens, cache_read_tokens
    FROM token_usage WHERE date = CURRENT_DATE
  `);
  return result.rows[0] || { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 };
}

// ─── Message Stats ─────────────────────────────────────────────────────────

export async function recordMessageStat(jid, direction) {
  const col = direction === 'sent' ? 'sent' : 'received';
  await pool.query(`
    INSERT INTO message_stats (jid, ${col}, last_message_at)
    VALUES ($1, 1, NOW())
    ON CONFLICT (jid) DO UPDATE SET
      ${col} = message_stats.${col} + 1,
      last_message_at = NOW()
  `, [jid]);
}

export async function getMessageStats() {
  const result = await pool.query(`
    SELECT jid, sent, received, last_message_at
    FROM message_stats
    ORDER BY last_message_at DESC
  `);
  return result.rows;
}

// ─── Response Times ────────────────────────────────────────────────────────

export async function recordResponseTime(ms) {
  await pool.query(`
    INSERT INTO response_times (response_ms) VALUES ($1)
  `, [ms]);
}

// Raw response times for the last N hours — used to rebuild the
// distribution histogram in the analytics cache after a restart.
export async function getResponseTimes(hours = 24, limit = 1000) {
  const result = await pool.query(`
    SELECT response_ms, recorded_at
    FROM response_times
    WHERE recorded_at >= NOW() - ($1::INT * INTERVAL '1 hour')
    ORDER BY recorded_at DESC
    LIMIT $2::INT
  `, [hours, limit]);
  return result.rows;
}

export async function getResponseTimeStats() {
  const result = await pool.query(`
    SELECT
      COUNT(*) as count,
      AVG(response_ms)::INT as avg_ms,
      MIN(response_ms) as min_ms,
      MAX(response_ms) as max_ms,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY response_ms)::INT as median_ms
    FROM response_times
    WHERE recorded_at >= NOW() - INTERVAL '24 hours'
  `);
  return result.rows[0];
}

// ─── Chat Messages ─────────────────────────────────────────────────────────

export async function appendMessage(jid, role, content, metadata = {}) {
  await pool.query(`
    INSERT INTO messages (jid, role, content, msg_id, metadata)
    VALUES ($1, $2, $3, $4, $5)
  `, [jid, role, content, metadata.msgId || null, JSON.stringify(metadata)]);
}

export async function getMessages(jid, limit = 50, offset = 0) {
  const result = await pool.query(`
    SELECT role, content, msg_id, metadata, created_at
    FROM messages
    WHERE jid = $1
    ORDER BY created_at DESC
    LIMIT $2 OFFSET $3
  `, [jid, limit, offset]);
  return result.rows.reverse();
}

// Fetch a single message by jid + WhatsApp msg_id. Used by reaction-commands
// to look up the message a 📌/🔁/❌ reacted to.
export async function getMessageByMsgId(jid, msgId) {
  if (!jid || !msgId) return null;
  const result = await pool.query(`
    SELECT role, content, msg_id, metadata, created_at
    FROM messages
    WHERE jid = $1 AND msg_id = $2
    ORDER BY created_at DESC
    LIMIT 1
  `, [jid, msgId]);
  return result.rows[0] || null;
}

export async function searchMessages(query, limit = 50) {
  const result = await pool.query(`
    SELECT jid, role, content, created_at
    FROM messages
    WHERE content ILIKE $1
    ORDER BY created_at DESC
    LIMIT $2
  `, [`%${query}%`, limit]);
  return result.rows;
}

export async function getRecentChats(limit = 20) {
  const result = await pool.query(`
    SELECT DISTINCT ON (jid) jid, content, created_at
    FROM messages
    ORDER BY jid, created_at DESC
    LIMIT $1
  `, [limit]);
  return result.rows;
}

// Chat list view: one row per jid with last-message preview, last timestamp, and total count.
export async function getChatList() {
  const result = await pool.query(`
    SELECT
      m.jid,
      last.content      AS last_msg,
      last.created_at   AS last_time,
      counts.msg_count  AS msg_count
    FROM (SELECT DISTINCT jid FROM messages) m
    JOIN LATERAL (
      SELECT content, created_at
      FROM messages
      WHERE jid = m.jid
      ORDER BY created_at DESC
      LIMIT 1
    ) last ON true
    JOIN LATERAL (
      SELECT COUNT(*)::int AS msg_count
      FROM messages
      WHERE jid = m.jid
    ) counts ON true
    ORDER BY last.created_at DESC
  `);
  return result.rows;
}

// ─── Contacts ──────────────────────────────────────────────────────────────

export async function upsertContact(jid, data = {}) {
  await pool.query(`
    INSERT INTO contacts (jid, phone, name, label, is_allowed, metadata)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (jid) DO UPDATE SET
      phone = COALESCE($2, contacts.phone),
      name = COALESCE($3, contacts.name),
      label = COALESCE($4, contacts.label),
      is_allowed = COALESCE($5, contacts.is_allowed),
      metadata = contacts.metadata || $6,
      updated_at = NOW()
  `, [jid, data.phone || null, data.name || null, data.label || null, data.isAllowed ?? null, JSON.stringify(data.metadata || {})]);
}

export async function getContact(jid) {
  const result = await pool.query(`
    SELECT * FROM contacts WHERE jid = $1
  `, [jid]);
  return result.rows[0];
}

export async function getAllContacts() {
  const result = await pool.query(`
    SELECT * FROM contacts ORDER BY updated_at DESC
  `);
  return result.rows;
}

// Find a contact by phone (digits-only) or by either JID form.
export async function findContactByPhone(phone) {
  const r = await pool.query(`SELECT * FROM contacts WHERE phone = $1 LIMIT 1`, [phone]);
  return r.rows[0] || null;
}

export async function findContactByJid(jid) {
  const r = await pool.query(`SELECT * FROM contacts WHERE jid = $1 OR lid = $1 LIMIT 1`, [jid]);
  return r.rows[0] || null;
}

// Bulk-load human-known contacts (have a phone) — used by /people.
export async function listKnownContacts() {
  const r = await pool.query(`
    SELECT * FROM contacts
    WHERE phone IS NOT NULL
    ORDER BY COALESCE(label, phone) ASC
  `);
  return r.rows;
}

// Allowlist read — every contact row flagged is_allowed. Patterns are also
// stored here (jid column holds the pattern string for wildcards).
export async function listAllowedJids() {
  const r = await pool.query(`SELECT jid, lid FROM contacts WHERE is_allowed = TRUE`);
  // Include both the primary jid and the lid (if present) so per-message
  // checks find a match no matter which form WhatsApp delivers.
  const out = [];
  for (const row of r.rows) {
    if (row.jid) out.push(row.jid);
    if (row.lid && row.lid !== row.jid) out.push(row.lid);
  }
  return out;
}

export async function setContactAllowed(jid, isAllowed) {
  await pool.query(
    `INSERT INTO contacts (jid, is_allowed)
     VALUES ($1, $2)
     ON CONFLICT (jid) DO UPDATE SET is_allowed = $2, updated_at = NOW()`,
    [jid, Boolean(isAllowed)],
  );
}

export async function removeContactRow(jid) {
  const r = await pool.query(`DELETE FROM contacts WHERE jid = $1`, [jid]);
  return r.rowCount > 0;
}

export async function removeContactByPhone(phone) {
  const r = await pool.query(`DELETE FROM contacts WHERE phone = $1`, [phone]);
  return r.rowCount > 0;
}

// ─── Daily Notes ───────────────────────────────────────────────────────────

export async function appendDailyNote(content) {
  await pool.query(`
    INSERT INTO daily_notes (date, content) VALUES (CURRENT_DATE, $1)
  `, [content]);
}

export async function getDailyNotes(date) {
  const result = await pool.query(`
    SELECT content, created_at FROM daily_notes
    WHERE date = $1
    ORDER BY created_at ASC
  `, [date]);
  return result.rows;
}

// ─── Memory Items ──────────────────────────────────────────────────────────

export async function setMemory(key, value, metadata = {}) {
  await pool.query(`
    INSERT INTO memory_items (key, value, metadata)
    VALUES ($1, $2, $3)
    ON CONFLICT (key) DO UPDATE SET
      value = $2,
      metadata = $3,
      updated_at = NOW()
  `, [key, value, JSON.stringify(metadata)]);
}

export async function getMemory(key) {
  const result = await pool.query(`
    SELECT value, metadata FROM memory_items WHERE key = $1
  `, [key]);
  return result.rows[0];
}

export async function deleteMemory(key) {
  await pool.query(`DELETE FROM memory_items WHERE key = $1`, [key]);
}

// ─── Cron Jobs ─────────────────────────────────────────────────────────────

export async function saveCronJob(job) {
  await pool.query(`
    INSERT INTO cron_jobs (job_id, jid, schedule_type, schedule_value, notify_text, prompt_text, enabled, next_run_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (job_id) DO UPDATE SET
      schedule_type = $3,
      schedule_value = $4,
      notify_text = $5,
      prompt_text = $6,
      enabled = $7,
      next_run_at = $8
  `, [job.id, job.jid, job.scheduleType, job.scheduleValue, job.notify || null, job.prompt || null, job.enabled ?? true, job.nextRunAt || null]);
}

export async function getCronJobs() {
  const result = await pool.query(`
    SELECT * FROM cron_jobs WHERE enabled = TRUE ORDER BY next_run_at ASC
  `);
  return result.rows;
}

export async function deleteCronJob(jobId) {
  await pool.query(`DELETE FROM cron_jobs WHERE job_id = $1`, [jobId]);
}

export async function updateCronJobLastRun(jobId, nextRunAt) {
  await pool.query(`
    UPDATE cron_jobs SET last_run_at = NOW(), next_run_at = $2 WHERE job_id = $1
  `, [jobId, nextRunAt]);
}

// ─── Analytics Summary ─────────────────────────────────────────────────────

export async function getAnalyticsSummary() {
  const [tokens, messages, responseTimes] = await Promise.all([
    getTokenUsage(30),
    getMessageStats(),
    getResponseTimeStats(),
  ]);

  const totalTokens = tokens.reduce((sum, row) => ({
    input: sum.input + Number(row.input_tokens),
    output: sum.output + Number(row.output_tokens),
    cache: sum.cache + Number(row.cache_read_tokens),
  }), { input: 0, output: 0, cache: 0 });

  return {
    tokens: {
      daily: tokens,
      total: totalTokens,
    },
    messages,
    responseTimes,
  };
}

// ─── Scheduled jobs ───────────────────────────────────────────────────────

function scheduledRowToJob(r) {
  const iso = (x) => (x instanceof Date ? x.toISOString() : x);
  const job = {
    id: r.job_id,
    jid: r.jid,
    text: r.text,
    mode: r.mode,
    runAt: iso(r.run_at),
    createdAt: iso(r.created_at),
  };
  if (r.recurring) job.recurring = r.recurring;
  if (r.paused) job.paused = true;
  if (r.last_fired_at) job.lastFiredAt = iso(r.last_fired_at);
  if (r.last_fire_ok === false) job.lastFireOk = false;
  else if (r.last_fire_ok === true) job.lastFireOk = true;
  if (r.last_fire_error) job.lastFireError = r.last_fire_error;
  return job;
}

export async function listScheduledJobs() {
  const r = await pool.query(`SELECT * FROM scheduled_jobs ORDER BY run_at ASC`);
  return r.rows.map(scheduledRowToJob);
}

export async function upsertScheduledJob(job) {
  await pool.query(
    `INSERT INTO scheduled_jobs
       (job_id, jid, text, mode, run_at, recurring, paused, last_fired_at, last_fire_ok, last_fire_error, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11, NOW()), NOW())
     ON CONFLICT (job_id) DO UPDATE SET
       jid = EXCLUDED.jid,
       text = EXCLUDED.text,
       mode = EXCLUDED.mode,
       run_at = EXCLUDED.run_at,
       recurring = EXCLUDED.recurring,
       paused = EXCLUDED.paused,
       last_fired_at = EXCLUDED.last_fired_at,
       last_fire_ok = EXCLUDED.last_fire_ok,
       last_fire_error = EXCLUDED.last_fire_error,
       updated_at = NOW()`,
    [
      job.id,
      job.jid,
      job.text,
      job.mode || 'notify',
      job.runAt,
      job.recurring ? JSON.stringify(job.recurring) : null,
      Boolean(job.paused),
      job.lastFiredAt || null,
      job.lastFireOk == null ? null : Boolean(job.lastFireOk),
      job.lastFireError || null,
      job.createdAt || null,
    ],
  );
}

export async function deleteScheduledJob(jobId) {
  const r = await pool.query(`DELETE FROM scheduled_jobs WHERE job_id = $1`, [jobId]);
  return r.rowCount > 0;
}

export async function deleteScheduledJobs(ids) {
  if (!ids || ids.length === 0) return 0;
  const r = await pool.query(`DELETE FROM scheduled_jobs WHERE job_id = ANY($1::text[])`, [ids]);
  return r.rowCount;
}

// Cheap change-detection fingerprint for the poll loop.
export async function scheduledJobsFingerprint() {
  const r = await pool.query(
    `SELECT COALESCE(EXTRACT(EPOCH FROM MAX(updated_at)) * 1000, 0)::bigint AS m, COUNT(*) AS c FROM scheduled_jobs`,
  );
  return { maxMs: Number(r.rows[0].m), count: Number(r.rows[0].c) };
}

// ─── App state (kv) ───────────────────────────────────────────────────────

export async function getAppState(key, fallback = null) {
  const r = await pool.query(`SELECT value FROM app_state WHERE key = $1`, [key]);
  if (r.rows.length === 0) return fallback;
  return r.rows[0].value;
}

export async function setAppState(key, value) {
  await pool.query(
    `INSERT INTO app_state (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
}

// ─── Open Threads ──────────────────────────────────────────────────────────

export async function addOpenThread(title, { body = null, jid = null } = {}) {
  const result = await pool.query(`
    INSERT INTO open_threads (title, body, jid)
    VALUES ($1, $2, $3)
    RETURNING id
  `, [title, body, jid]);
  return result.rows[0].id;
}

export async function listOpenThreads({ status = 'open', limit = 50 } = {}) {
  const result = await pool.query(`
    SELECT id, title, body, status, jid, created_at, resolved_at
    FROM open_threads
    WHERE status = $1
    ORDER BY created_at DESC
    LIMIT $2
  `, [status, limit]);
  return result.rows;
}

export async function resolveOpenThread(id) {
  await pool.query(`
    UPDATE open_threads
    SET status = 'done', resolved_at = NOW()
    WHERE id = $1
  `, [id]);
}

export async function reopenThread(id) {
  await pool.query(`
    UPDATE open_threads
    SET status = 'open', resolved_at = NULL
    WHERE id = $1
  `, [id]);
}

export async function deleteOpenThread(id) {
  await pool.query(`DELETE FROM open_threads WHERE id = $1`, [id]);
}

// ─── Raw Query (for advanced use) ──────────────────────────────────────────

export async function query(sql, params = []) {
  return pool.query(sql, params);
}

export { pool };
