// Tracks WhatsApp socket connection state + a persistent restart counter
// backed by the postgres `app_state` table.

import * as db from './db.js';

const STATE_KEY = 'connection_state';

const state = {
  status: 'connecting', // 'connecting' | 'open' | 'close'
  lastOpenAt: null,
  lastCloseAt: null,
  closeCode: null,
  bootedAt: Date.now(),
  restartCount: 0,
};

let initialized = false;

export async function init() {
  if (initialized) return;
  initialized = true;
  try {
    const prev = await db.getAppState(STATE_KEY, { restartCount: 0 });
    state.restartCount = (Number(prev?.restartCount) || 0) + 1;
  } catch {
    state.restartCount = 1;
  }
  db.setAppState(STATE_KEY, {
    restartCount: state.restartCount,
    lastBootAt: new Date().toISOString(),
  }).catch(() => {});
}

export function recordOpen() {
  state.status = 'open';
  state.lastOpenAt = Date.now();
  state.closeCode = null;
}

export function recordClose(code) {
  state.status = 'close';
  state.lastCloseAt = Date.now();
  state.closeCode = code ?? null;
}

export function getState() {
  return { ...state };
}
