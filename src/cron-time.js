// Parse the <when> arg for the cron CLI. Accepts:
//   ISO 8601:    2026-05-20T09:00 / 2026-05-20T09:00:00Z
//   Relative:    +30m, +2h, +1d, +1w
//   Time only:   HH:MM (today if future, else tomorrow)
// Returns a Date. Throws on unparseable input.

const REL = /^\+(\d+)([mhdw])$/i;
const HM = /^(\d{1,2}):(\d{2})$/;
const DURATION = /^(\d+)([smhdw])$/i;

// Parse a bare duration like "30m", "2h", "1d", "1w" into milliseconds.
// Throws on unparseable input.
export function parseDuration(input) {
  if (input == null) throw new Error('no duration');
  const m = DURATION.exec(String(input).trim());
  if (!m) throw new Error(`unparseable duration: ${input}`);
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const factor =
    unit === 's' ? 1_000 :
    unit === 'm' ? 60_000 :
    unit === 'h' ? 3_600_000 :
    unit === 'd' ? 86_400_000 :
    /* w */ 604_800_000;
  return n * factor;
}

export function parseWhen(input, now = new Date()) {
  if (input == null) throw new Error('no time given');
  const s = String(input).trim();
  if (!s) throw new Error('empty time');

  const rel = REL.exec(s);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const factor =
      unit === 'm' ? 60_000 :
      unit === 'h' ? 3_600_000 :
      unit === 'd' ? 86_400_000 :
      /* w */ 604_800_000;
    return new Date(now.getTime() + n * factor);
  }

  const hm = HM.exec(s);
  if (hm) {
    const h = parseInt(hm[1], 10);
    const m = parseInt(hm[2], 10);
    if (h > 23 || m > 59) throw new Error(`invalid time: ${s}`);
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d;
  }

  const iso = new Date(s);
  if (!Number.isNaN(iso.getTime())) return iso;

  throw new Error(`unparseable time: ${s}`);
}
