// Budget Tracker client. Logs in once, caches the session cookie, hits the
// app's REST endpoints. Endpoints discovered at $HOME/dev/budget-tracker:
//
//   POST /api/auth/login    { username, password } → sets budget_session cookie
//   GET  /api/auth/me
//   GET  /api/months         → [{ id, name, year, month, income, savings, locked }]
//   GET  /api/months/:id
//   GET  /api/expenses       (use ?month=:id for filtering)
//   POST /api/expenses
//   GET  /api/networth
//   GET  /api/assets / /api/debts
//
// Auth via BUDGET_USER / BUDGET_PASS env (defaults from .env).

const BASE_URL = process.env.BUDGET_URL || 'https://budget.home';
const USER = process.env.BUDGET_USER || '';
const PASS = process.env.BUDGET_PASS || '';

let cookie = null;
let cookieExpires = 0;

function jar() { return cookie; }

async function fetchJSON(path, opts = {}) {
  const url = `${BASE_URL}${path}`;
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  // Default fetch follows redirects, which Next.js uses to set the session
  // cookie after /api/auth/login. We DON'T want manual redirect handling.
  const res = await fetch(url, { ...opts, headers });
  // Refresh cookie if Set-Cookie present.
  const sc = res.headers.get('set-cookie');
  if (sc) {
    const m = /budget_session=([^;]+)/.exec(sc);
    if (m) {
      cookie = `budget_session=${m[1]}`;
      cookieExpires = Date.now() + 24 * 60 * 60_000;
    }
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    throw new Error(`expected JSON, got ${ct} (status ${res.status}) at ${path}`);
  }
  const body = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

async function ensureLogin() {
  if (cookie && Date.now() < cookieExpires) {
    try { await fetchJSON('/api/auth/me'); return; } catch {}
  }
  if (!USER || !PASS) throw new Error('BUDGET_USER / BUDGET_PASS not set');
  cookie = null;
  await fetchJSON('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!cookie) throw new Error('budget login succeeded but no session cookie returned');
}

// ─── Public surface ─────────────────────────────────────────────────────

export async function listMonths() {
  await ensureLogin();
  return fetchJSON('/api/months');
}

export async function currentMonth() {
  const all = await listMonths();
  const now = new Date();
  return all.find((m) => m.year === now.getFullYear() && m.month === now.getMonth() + 1) || null;
}

export async function getMonth(id) {
  await ensureLogin();
  return fetchJSON(`/api/months/${id}`);
}

// Expenses live nested under a month in this app — there's no flat
// /api/expenses endpoint. listExpenses(monthId) returns the month's
// budgeted line items, each augmented with `actual_spent` (sum of
// linked transactions).
export async function listExpenses(monthId) {
  if (!monthId) {
    const cur = await currentMonth();
    if (!cur) return [];
    monthId = cur.id;
  }
  const detail = await getMonth(monthId);
  return detail.expenses || [];
}

export async function networth() {
  await ensureLogin();
  return fetchJSON('/api/networth');
}

export async function assets() {
  await ensureLogin();
  return fetchJSON('/api/assets');
}

export async function debts() {
  await ensureLogin();
  return fetchJSON('/api/debts');
}

// ─── Formatted summaries (for chat use) ───────────────────────────────

export async function summary() {
  const month = await currentMonth();
  if (!month) return 'No budget month found for this period.';
  const detail = await getMonth(month.id);
  const fmt = (n) => `R${Math.round(Number(n || 0)).toLocaleString()}`;
  const lines = [
    `📊 ${detail.month.name}`,
    `Income: ${fmt(detail.month.income)}`,
    `Budgeted: ${fmt(detail.totalExpenses)}`,
    `Paid: ${fmt(detail.totalPaid)}`,
    `Actually spent (transactions): ${fmt(detail.totalActualSpent)}`,
    `Savings: ${fmt(detail.month.savings)}`,
    `Surplus: ${fmt(detail.surplus)}`,
    `${detail.expenses.length} expense lines, ${detail.debtPayments.length} debt payments`,
  ];
  return lines.join('\n');
}

// Detail per category: budgeted vs actually spent, sorted by overshoot.
export async function categoryBreakdown(monthId = null) {
  if (!monthId) {
    const cur = await currentMonth();
    if (!cur) return [];
    monthId = cur.id;
  }
  const detail = await getMonth(monthId);
  return detail.expenses
    .map((e) => ({
      name: e.name,
      budgeted: Number(e.amount || 0),
      spent: Number(e.actual_spent || 0),
      paid: Boolean(e.paid),
      delta: Number(e.actual_spent || 0) - Number(e.amount || 0),
    }))
    .sort((a, b) => b.delta - a.delta);
}
