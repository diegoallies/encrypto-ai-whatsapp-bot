import { getAppState, setAppState } from './db.js';

const STATE_KEY = 'bot_power';
let poweredOn = true;

export async function init() {
  const saved = await getAppState(STATE_KEY, { poweredOn: true });
  poweredOn = saved?.poweredOn !== false;
  return poweredOn;
}

export function isPoweredOn() {
  return poweredOn;
}

export async function setPoweredOn(next) {
  poweredOn = Boolean(next);
  await setAppState(STATE_KEY, { poweredOn, changedAt: new Date().toISOString() });
  return poweredOn;
}

export function assertPoweredOn() {
  if (poweredOn) return;
  const err = new Error('Bot is powered off');
  err.code = 'BOT_POWERED_OFF';
  throw err;
}
