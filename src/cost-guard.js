// Daily token-spend guard. Two thresholds:
//
//   DAILY_TOKEN_SOFT_LIMIT   warn-once DM at this token count
//   DAILY_TOKEN_HARD_LIMIT   refuse new askClaude calls (returns true from
//                            shouldRefuse) until the next local day
//
// Counter resets daily via memory.js (counters key off the local day).

import { getCounter, incrementCounter, getState, updateState } from './memory.js';

const SOFT = Number(process.env.DAILY_TOKEN_SOFT_LIMIT) || 0;
const HARD = Number(process.env.DAILY_TOKEN_HARD_LIMIT) || 0;
const COUNTER = 'tokens:total';

export async function recordTokens(usage) {
  if (!usage) return;
  const used =
    Number(usage.input_tokens || 0) +
    Number(usage.output_tokens || 0);
  if (used <= 0) return;
  await incrementCounter(COUNTER, used);
}

export async function dailyTokens() {
  return getCounter(COUNTER);
}

// Returns one of:
//   { ok: true, mode: 'normal' }
//   { ok: true, mode: 'terse', total }   — over 90% of soft, ask Claude to be brief
//   { ok: false, level: 'soft', total }  — over soft limit, send a one-time warning + terse
//   { ok: false, level: 'hard', total }  — over hard limit, refuse
//
// `mode` is what claude-agent.js reads to overlay a "terse system prompt" on
// the prompt build. `level` is what the handler reads to decide whether to DM
// the owner a warning / refuse the call entirely.
export async function check() {
  if (!SOFT && !HARD) return { ok: true, mode: 'normal' };
  const total = await dailyTokens();
  if (HARD > 0 && total >= HARD) return { ok: false, level: 'hard', mode: 'terse', total };
  if (SOFT > 0 && total >= SOFT) {
    const state = await getState();
    const today = new Date().toISOString().slice(0, 10);
    if (state.lastChecks?.['cost-soft-warned'] !== today) {
      await updateState((s) => {
        s.lastChecks['cost-soft-warned'] = today;
        return s;
      }).catch(() => {});
      return { ok: false, level: 'soft', mode: 'terse', total };
    }
    return { ok: true, level: 'soft-already-warned', mode: 'terse', total };
  }
  // Pre-warning terse zone: 90% of soft → shorten replies but stay quiet.
  if (SOFT > 0 && total >= SOFT * 0.9) {
    return { ok: true, mode: 'terse', total };
  }
  return { ok: true, mode: 'normal', total };
}

export async function mode() {
  const r = await check().catch(() => ({ mode: 'normal' }));
  return r.mode || 'normal';
}

export function thresholds() {
  return { soft: SOFT, hard: HARD };
}
