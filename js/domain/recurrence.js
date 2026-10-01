/* Recurrence — a practical subset of RFC 5545 RRULE.
 *
 * Supported: FREQ (DAILY|WEEKLY|MONTHLY|YEARLY), INTERVAL, BYDAY, BYMONTHDAY,
 * BYSETPOS (-1..4 for "last Friday" style rules), COUNT, UNTIL.
 *
 * The next instance is generated on completion rather than materialised ahead
 * of time, so an unfinished weekly task never silently stacks up 40 copies.
 */

import { parts, keyToInstant, dayKey, addDaysKey, hasTime } from '../core/util.js';

export const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
export const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
export const DAY_NAME = {
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
  SU: 'Sunday',
};

export function parse(str) {
  if (!str) return null;
  const rule = { freq: 'DAILY', interval: 1, byday: [], bymonthday: null, bysetpos: null, count: null, until: null };
  for (const part of String(str).replace(/^RRULE:/i, '').split(';')) {
    const [rawKey, rawVal] = part.split('=');
    if (!rawKey || rawVal == null) continue;
    const key = rawKey.trim().toUpperCase();
    const val = rawVal.trim();
    switch (key) {
      case 'FREQ':
        if (FREQS.includes(val.toUpperCase())) rule.freq = val.toUpperCase();
        break;
      case 'INTERVAL':
        rule.interval = Math.max(1, parseInt(val, 10) || 1);
        break;
      case 'BYDAY':
        rule.byday = val
          .toUpperCase()
          .split(',')
          .map((d) => d.replace(/^[+-]?\d/, '').trim())
          .filter((d) => DAYS.includes(d));
        {
          const pos = val.match(/^([+-]?\d)/);
          if (pos) rule.bysetpos = parseInt(pos[1], 10);
        }
        break;
      case 'BYMONTHDAY':
        rule.bymonthday = parseInt(val, 10) || null;
        break;
      case 'BYSETPOS':
        rule.bysetpos = parseInt(val, 10) || null;
        break;
      case 'COUNT':
        rule.count = parseInt(val, 10) || null;
        break;
      case 'UNTIL': {
        const m = val.match(/^(\d{4})(\d{2})(\d{2})/);
        if (m) rule.until = `${m[1]}-${m[2]}-${m[3]}`;
        else if (!Number.isNaN(Date.parse(val))) rule.until = dayKey(val);
        break;
      }
      default:
        break;
    }
  }
  return rule;
}

export function format(rule) {
  if (!rule) return null;
  const out = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) out.push(`INTERVAL=${rule.interval}`);
  if (rule.byday?.length) {
    out.push(`BYDAY=${rule.bysetpos ? `${rule.bysetpos}${rule.byday[0]}` : rule.byday.join(',')}`);
  }
  if (rule.bymonthday) out.push(`BYMONTHDAY=${rule.bymonthday}`);
  if (rule.count) out.push(`COUNT=${rule.count}`);
  if (rule.until) out.push(`UNTIL=${rule.until.replace(/-/g, '')}T000000Z`);
  return out.join(';');
}

const ORDINAL = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last' };

/** Plain-English summary, shown next to the recurrence control. */
export function describe(rule) {
  if (!rule) return 'Does not repeat';
  const r = typeof rule === 'string' ? parse(rule) : rule;
  const n = r.interval;
  let base;

  switch (r.freq) {
    case 'DAILY':
      base = n === 1 ? 'Daily' : `Every ${n} days`;
      break;
    case 'WEEKLY':
      if (r.byday?.length === 5 && ['MO', 'TU', 'WE', 'TH', 'FR'].every((d) => r.byday.includes(d))) {
        base = 'Every weekday';
      } else if (r.byday?.length) {
        const names = r.byday.map((d) => DAY_NAME[d]).join(', ');
        base = n === 1 ? `Weekly on ${names}` : `Every ${n} weeks on ${names}`;
      } else {
        base = n === 1 ? 'Weekly' : `Every ${n} weeks`;
      }
      break;
    case 'MONTHLY':
      if (r.bysetpos && r.byday?.length) {
        base = `Monthly on the ${ORDINAL[r.bysetpos] || r.bysetpos} ${DAY_NAME[r.byday[0]]}`;
      } else if (r.bymonthday) {
        base = `Monthly on day ${r.bymonthday}`;
      } else {
        base = n === 1 ? 'Monthly' : `Every ${n} months`;
      }
      break;
    case 'YEARLY':
      base = n === 1 ? 'Yearly' : `Every ${n} years`;
      break;
    default:
      base = 'Repeats';
  }

  if (r.count) base += ` · ${r.count} times`;
  if (r.until) base += ` · until ${r.until}`;
  return base;
}

/* ------------------------------- NEXT ------------------------------- */

function nthWeekdayOfMonth(year, month, dayCode, pos) {
  const target = DAYS.indexOf(dayCode);
  if (pos > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1));
    const firstIdx = (first.getUTCDay() + 6) % 7;
    const offset = (target - firstIdx + 7) % 7;
    const day = 1 + offset + (pos - 1) * 7;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return day > daysInMonth ? null : day;
  }
  // pos === -1 → last matching weekday
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, daysInMonth));
  const lastIdx = (last.getUTCDay() + 6) % 7;
  const back = (lastIdx - target + 7) % 7;
  return daysInMonth - back;
}

/**
 * Next occurrence strictly after `fromISO`.
 * Returns an ISO instant preserving the original time-of-day, or null when the
 * series has ended (COUNT exhausted / past UNTIL).
 */
export function next(rule, fromISO, { occurrences = 0 } = {}) {
  const r = typeof rule === 'string' ? parse(rule) : rule;
  if (!r) return null;
  if (r.count && occurrences + 1 >= r.count) return null;

  const from = fromISO || new Date().toISOString();
  const p = parts(from);
  const keepTime = hasTime(from);
  const hour = keepTime ? p.hh : 0;
  const minute = keepTime ? p.mm : 0;
  let key = dayKey(from);

  const emit = (k) => {
    if (r.until && k > r.until) return null;
    return keyToInstant(k, hour, minute);
  };

  switch (r.freq) {
    case 'DAILY':
      return emit(addDaysKey(key, r.interval));

    case 'WEEKLY': {
      if (!r.byday?.length) return emit(addDaysKey(key, 7 * r.interval));
      const wanted = r.byday.map((d) => DAYS.indexOf(d)).sort((a, b) => a - b);
      const curIdx = (new Date(`${key}T00:00:00Z`).getUTCDay() + 6) % 7;
      // Remaining matching day later this week?
      const laterThisWeek = wanted.find((w) => w > curIdx);
      if (laterThisWeek != null) return emit(addDaysKey(key, laterThisWeek - curIdx));
      // Otherwise jump to the first matching day of the next active week.
      const toMonday = 7 - curIdx;
      const weeksForward = 7 * (r.interval - 1);
      return emit(addDaysKey(key, toMonday + weeksForward + wanted[0]));
    }

    case 'MONTHLY': {
      let y = p.y;
      let m = p.m;
      for (let guard = 0; guard < 60; guard++) {
        m += r.interval;
        while (m > 12) {
          m -= 12;
          y += 1;
        }
        let day;
        if (r.bysetpos && r.byday?.length) {
          day = nthWeekdayOfMonth(y, m, r.byday[0], r.bysetpos);
        } else {
          const target = r.bymonthday || p.d;
          const inMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
          // Clamp rather than skip: "the 31st" on a 30-day month means the 30th.
          day = Math.min(target, inMonth);
        }
        if (day) {
          return emit(`${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
        }
      }
      return null;
    }

    case 'YEARLY': {
      const y = p.y + r.interval;
      const inMonth = new Date(Date.UTC(y, p.m, 0)).getUTCDate();
      const day = Math.min(p.d, inMonth);
      return emit(`${y}-${String(p.m).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }

    default:
      return null;
  }
}

/** Expand the next `limit` occurrences — used to preview a rule in the UI. */
export function preview(rule, fromISO, limit = 5) {
  const out = [];
  let cursor = fromISO;
  for (let i = 0; i < limit; i++) {
    cursor = next(rule, cursor, { occurrences: i });
    if (!cursor) break;
    out.push(cursor);
  }
  return out;
}

/* Presets offered in the recurrence menu. */
export const PRESETS = [
  { label: 'Every day', rule: 'FREQ=DAILY' },
  { label: 'Every weekday', rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
  { label: 'Every week', rule: 'FREQ=WEEKLY' },
  { label: 'Every 2 weeks', rule: 'FREQ=WEEKLY;INTERVAL=2' },
  { label: 'Every month', rule: 'FREQ=MONTHLY' },
  { label: 'Every year', rule: 'FREQ=YEARLY' },
];
