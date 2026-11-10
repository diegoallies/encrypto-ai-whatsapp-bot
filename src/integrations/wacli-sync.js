// Heartbeat plugin that runs `wacli sync` periodically to keep the local
// SQLite message store fresh. Claude can then query it via Bash with:
//
//   wacli --store ~/.wacli-main messages search "<text>" --json
//   wacli --store ~/.wacli-main messages list --chat <jid> --limit 50 --json
//
// No-op until WACLI_STORE is set and `wacli` is on PATH.
//
// Lock handling
// -------------
// wacli holds a per-store file lock (~/.wacli-main/LOCK, format
// `pid=<pid>\nacquired_at=<ts>`). If a previous wacli died without releasing
// the lock, every subsequent invocation errors with:
//   "store is locked (another wacli is running?): store locked: resource
//    temporarily unavailable (pid=<PID> acquired_at=<TS>)"
// wacli has no --force flag to release a stale lock, so we:
//   1. Parse pid + acquired_at out of the error.
//   2. If the pid is not currently alive, remove the LOCK file ourselves
//      and retry once. Logged at INFO.
//   3. If the pid *is* alive, throttle log spam to once/hour and, after 3
//      consecutive failures against the same holder pid, stop retrying
//      (return early) until the holder changes or the lock clears.

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const exec = promisify(execCb);

async function have(cmd) {
  try { await exec(`command -v ${cmd}`); return true; } catch { return false; }
}

function parseLockError(text) {
  if (!text) return null;
  const pidMatch = /pid=(\d+)/.exec(text);
  const atMatch = /acquired_at=([^\s)]+)/.exec(text);
  if (!pidMatch) return null;
  return {
    pid: Number(pidMatch[1]),
    acquiredAt: atMatch ? atMatch[1] : null,
  };
}

function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it - treat as alive.
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

function removeStaleLock(store) {
  const lockPath = path.join(store, 'LOCK');
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return true;
    console.error(`wacli-sync: could not remove stale lock ${lockPath}: ${err.message}`);
    return false;
  }
}

async function runSyncOnce({ store, timeoutMs }) {
  return exec(`wacli --store ${JSON.stringify(store)} sync --once 2>&1`, { timeout: timeoutMs });
}

export function wacliSyncPlugin({
  intervalMs = Number(process.env.WACLI_SYNC_INTERVAL_MS) || 5 * 60_000,
  store = process.env.WACLI_STORE || '',
  timeoutMs = 60_000,
} = {}) {
  // Persistent state across ticks, kept in closure.
  const lockState = {
    holderPid: null,       // last observed lock-holder pid
    consecutiveFails: 0,   // fails in a row for the same holderPid
    lastLoggedAt: 0,       // ms since last lock-related log for this holder
    givingUp: false,       // suppress runs until holder clears
  };

  function resetLockState() {
    lockState.holderPid = null;
    lockState.consecutiveFails = 0;
    lockState.lastLoggedAt = 0;
    lockState.givingUp = false;
  }

  function shouldLog(now) {
    const HOUR_MS = 60 * 60 * 1000;
    if (!lockState.lastLoggedAt) return true;
    return now - lockState.lastLoggedAt >= HOUR_MS;
  }

  return {
    name: 'wacli-sync',
    intervalMs,
    async run() {
      if (!store) return null;
      if (!(await have('wacli'))) return null;
      try {
        await runSyncOnce({ store, timeoutMs });
        // Success clears any prior lock-fail state.
        if (lockState.holderPid !== null) {
          console.log(`wacli-sync: lock cleared, sync ok (store=${store})`);
          resetLockState();
        } else {
          console.log(`wacli-sync: ok (store=${store})`);
        }
        return null;
      } catch (err) {
        const m = err.stderr || err.stdout || err.message || String(err);
        // Quiet down non-critical cases.
        if (/not authenticated|run.*auth/i.test(m)) return null;
        // Stale message decryption warnings, not critical.
        if (/old counter|message keys/i.test(m) && /Messages stored/i.test(m)) {
          console.log(`wacli-sync: ok with warnings (store=${store})`);
          return null;
        }

        // Lock-holder path.
        const lock = /store is locked|store locked|resource temporarily unavailable/i.test(m)
          ? parseLockError(m)
          : null;
        if (lock) {
          const now = Date.now();
          const sameHolder = lockState.holderPid === lock.pid;
          if (!sameHolder) {
            // New holder - reset counters, allow a fresh log.
            lockState.holderPid = lock.pid;
            lockState.consecutiveFails = 0;
            lockState.lastLoggedAt = 0;
            lockState.givingUp = false;
          }
          lockState.consecutiveFails += 1;

          // Stale lock: pid is dead. Force-release and retry once.
          if (!pidAlive(lock.pid)) {
            console.log(`wacli-sync: stale lock held by dead pid=${lock.pid} (acquired_at=${lock.acquiredAt || '?'}); removing LOCK and retrying`);
            if (removeStaleLock(store)) {
              try {
                await runSyncOnce({ store, timeoutMs });
                console.log(`wacli-sync: recovered after removing stale lock (store=${store})`);
                resetLockState();
                return null;
              } catch (err2) {
                const m2 = err2.stderr || err2.stdout || err2.message || String(err2);
                console.error(`wacli-sync: retry after stale-lock removal failed: ${m2.slice(0, 200)}`);
                return null;
              }
            }
            return null;
          }

          // Holder is alive. Throttle logs; give up after 3 consecutive fails.
          if (lockState.consecutiveFails >= 3) {
            if (!lockState.givingUp) {
              console.warn(`wacli-sync: lock held by live pid=${lock.pid} (acquired_at=${lock.acquiredAt || '?'}) after 3 attempts; pausing retries until holder changes`);
              lockState.givingUp = true;
              lockState.lastLoggedAt = now;
            }
            return null;
          }

          if (shouldLog(now)) {
            console.log(`wacli-sync: store locked by pid=${lock.pid} (acquired_at=${lock.acquiredAt || '?'}); will retry next tick`);
            lockState.lastLoggedAt = now;
          }
          return null;
        }

        // Any other error path - reset lock state and log once.
        if (lockState.holderPid !== null) resetLockState();
        console.error(`wacli-sync: ${m.slice(0, 200)}`);
        return null;
      }
    },
  };
}
