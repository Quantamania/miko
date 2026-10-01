/* Natural-language quick add.
 *
 *   "Call supplier tomorrow 3pm #work !high @amina ~45m every friday"
 *     → title:      Call supplier
 *       due_at:     <tomorrow 15:00, user's zone>
 *       project:    Work
 *       priority:   high
 *       assignee:   Amina
 *       estimate:   45 min
 *       recurrence: FREQ=WEEKLY;BYDAY=FR
 *
 * Design notes:
 *  • Matched spans are recorded so the caller can show the user exactly what
 *    was understood, and so removing them from the title is exact rather than
 *    a second, lossy regex pass.
 *  • Anything not recognised stays in the title. The parser never discards
 *    text it did not positively identify.
 */

import {
  todayKey,
  addDaysKey,
  keyToInstant,
  dayKey,
  weekdayKey,
  parts,
} from '../core/util.js';

const WEEKDAYS = {
  monday: 0, mon: 0, mo: 0,
  tuesday: 1, tues: 1, tue: 1, tu: 1,
  wednesday: 2, weds: 2, wed: 2, we: 2,
  thursday: 3, thurs: 3, thur: 3, thu: 3, th: 3,
  friday: 4, fri: 4, fr: 4,
  saturday: 5, sat: 5, sa: 5,
  sunday: 6, sun: 6, su: 6,
};
const DAY_CODE = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

const PRIORITY_WORDS = {
  urgent: 'urgent', critical: 'urgent', asap: 'urgent', p1: 'urgent', '1': 'urgent',
  high: 'high', important: 'high', p2: 'high', '2': 'high',
  medium: 'medium', med: 'medium', normal: 'medium', p3: 'medium', '3': 'medium',
  low: 'low', minor: 'low', later: 'low', p4: 'low', '4': 'low',
};

class Spans {
  constructor(text) {
    this.text = text;
    this.taken = [];
  }
  /** Reserve [start,end). Returns false if it overlaps something already taken,
   *  which stops two rules from consuming the same words. */
  take(start, end, kind) {
    if (start == null || end == null || end <= start) return false;
    for (const s of this.taken) if (start < s.end && end > s.start) return false;
    this.taken.push({ start, end, kind });
    return true;
  }
  /** The text with every reserved span removed. */
  rest() {
    if (!this.taken.length) return this.text;
    const sorted = [...this.taken].sort((a, b) => a.start - b.start);
    let out = '';
    let cur = 0;
    for (const s of sorted) {
      out += this.text.slice(cur, s.start);
      cur = s.end;
    }
    out += this.text.slice(cur);
    return out;
  }
}

function clean(s) {
  return s.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
}

/* ------------------------------- TIME ------------------------------- */

function parseClock(str) {
  const s = str.toLowerCase().trim();
  if (s === 'noon' || s === 'midday') return { hh: 12, mm: 0 };
  if (s === 'midnight') return { hh: 0, mm: 1 }; // 00:00 means "no time"
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = m[2] ? parseInt(m[2], 10) : 0;
  const mer = m[3];
  if (hh > 23 || mm > 59) return null;
  if (mer === 'pm' && hh < 12) hh += 12;
  if (mer === 'am' && hh === 12) hh = 0;
  if (!mer && hh < 8 && !m[2]) return null; // bare "3" is not a time
  return { hh, mm };
}

/* ----------------------------- MAIN PARSE ----------------------------- */

export function parse(input, ctx = {}) {
  const text = String(input || '');
  const spans = new Spans(text);
  const out = {
    title: '',
    due_at: null,
    dueKey: null,
    time: null,
    priority: null,
    labels: [],
    labelNames: [],
    project_id: null,
    projectName: null,
    assignee_id: null,
    assigneeName: null,
    estimate_min: null,
    recurrence_rule: null,
    matched: [],
  };

  const projects = ctx.projects || [];
  const labels = ctx.labels || [];
  const members = ctx.members || [];

  /* ---- recurrence (before dates, so "every friday" isn't read as "friday") ---- */
  const recur =
    text.match(
      /\b(?:every|each)\s+(?:(\d+)\s+)?(day|days|week|weeks|month|months|year|years|weekday|weekdays|mon(?:day)?s?|tue(?:s|sday)?s?|wed(?:nesday)?s?|thu(?:r|rs|rsday)?s?|fri(?:day)?s?|sat(?:urday)?s?|sun(?:day)?s?)\b/i
    ) || text.match(/\b(daily|weekly|monthly|yearly|annually|fortnightly|biweekly)\b/i);

  if (recur && spans.take(recur.index, recur.index + recur[0].length, 'recurrence')) {
    out.recurrence_rule = buildRule(recur);
    out.matched.push({ kind: 'repeat', text: recur[0].trim() });
  }

  /* ---- #project / #label ---- */
  for (const m of [...text.matchAll(/(^|\s)#([\w-]+)/g)]) {
    const start = m.index + m[1].length;
    if (!spans.take(start, start + m[2].length + 1, 'tag')) continue;
    const name = m[2].replace(/-/g, ' ').toLowerCase();
    const project = projects.find((p) => p.name.toLowerCase() === name);
    if (project && !out.project_id) {
      out.project_id = project.id;
      out.projectName = project.name;
      out.matched.push({ kind: 'project', text: project.name });
      continue;
    }
    const label = labels.find((l) => l.name.toLowerCase() === name);
    if (label) {
      out.labels.push(label.id);
      out.labelNames.push(label.name);
    } else {
      out.labelNames.push(m[2].replace(/-/g, ' '));
    }
    out.matched.push({ kind: 'label', text: m[2].replace(/-/g, ' ') });
  }

  /* ---- @assignee ---- */
  for (const m of [...text.matchAll(/(^|\s)@([\w.-]+)/g)]) {
    const start = m.index + m[1].length;
    const needle = m[2].toLowerCase();
    const person = members.find(
      (mem) =>
        mem.user?.handle?.toLowerCase() === needle ||
        mem.user?.name?.toLowerCase().startsWith(needle) ||
        mem.user?.email?.toLowerCase().split('@')[0] === needle
    );
    if (!person) continue;
    if (!spans.take(start, start + m[2].length + 1, 'assignee')) continue;
    out.assignee_id = person.user_id;
    out.assigneeName = person.user?.name || needle;
    out.matched.push({ kind: 'assignee', text: out.assigneeName });
    break;
  }

  /* ---- !priority / p1..p4 ---- */
  const prio =
    text.match(/(^|\s)!(urgent|critical|asap|high|important|medium|med|normal|low|minor|later|[1-4])\b/i) ||
    text.match(/(^|\s)(p[1-4])\b/i);
  if (prio) {
    const start = prio.index + prio[1].length;
    if (spans.take(start, start + prio[0].length - prio[1].length, 'priority')) {
      const key = prio[2].toLowerCase();
      out.priority = PRIORITY_WORDS[key] || null;
      if (out.priority) out.matched.push({ kind: 'priority', text: out.priority });
    }
  }

  /* ---- ~estimate ---- */
  const est = text.match(/(^|\s)~\s*(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/i);
  if (est) {
    const start = est.index + est[1].length;
    if (spans.take(start, start + est[0].length - est[1].length, 'estimate')) {
      const n = parseFloat(est[2]);
      const unit = est[3].toLowerCase();
      out.estimate_min = Math.round(unit.startsWith('h') ? n * 60 : n);
      out.matched.push({ kind: 'estimate', text: `${out.estimate_min}m` });
    }
  }

  /* ---- date ---- */
  const date = findDate(text, spans);
  if (date) {
    out.dueKey = date.key;
    out.matched.push({ kind: 'date', text: date.text });
  }

  /* ---- time of day ---- */
  const time = findTime(text, spans);
  if (time) {
    out.time = time.clock;
    out.matched.push({ kind: 'time', text: time.text });
  }

  if (out.dueKey || out.time) {
    const key = out.dueKey || todayKey();
    const c = out.time || { hh: 0, mm: 0 };
    let iso = keyToInstant(key, c.hh, c.mm);
    // "at 9am" with no date, already past today → assume tomorrow.
    if (!out.dueKey && out.time && new Date(iso) < new Date()) {
      iso = keyToInstant(addDaysKey(key, 1), c.hh, c.mm);
      out.dueKey = addDaysKey(key, 1);
    } else {
      out.dueKey = key;
    }
    out.due_at = iso;
  }

  out.title = clean(spans.rest()) || clean(text);
  return out;
}

/* ---------------------------- date matching ---------------------------- */

function findDate(text, spans) {
  const t = text.toLowerCase();
  const tryTake = (m, key, label) => {
    if (!m) return null;
    const offset = m[1] ? m.index + m[1].length : m.index;
    const len = m[1] ? m[0].length - m[1].length : m[0].length;
    if (!spans.take(offset, offset + len, 'date')) return null;
    return { key, text: label ?? m[0].trim() };
  };

  let m;

  if ((m = t.match(/(^|\s)(today|tonight)\b/))) return tryTake(m, todayKey(), m[2]);
  if ((m = t.match(/(^|\s)(tomorrow|tmr|tmrw)\b/))) return tryTake(m, addDaysKey(todayKey(), 1), 'tomorrow');
  if ((m = t.match(/(^|\s)yesterday\b/))) return tryTake(m, addDaysKey(todayKey(), -1), 'yesterday');
  if ((m = t.match(/(^|\s)(eod|end of day)\b/))) return tryTake(m, todayKey(), 'end of day');

  // in N days/weeks/months
  if ((m = t.match(/(^|\s)in\s+(a|an|\d+)\s+(day|days|week|weeks|month|months)\b/))) {
    const n = m[2] === 'a' || m[2] === 'an' ? 1 : parseInt(m[2], 10);
    const unit = m[3];
    let key = todayKey();
    if (unit.startsWith('day')) key = addDaysKey(key, n);
    else if (unit.startsWith('week')) key = addDaysKey(key, n * 7);
    else {
      const p = parts(new Date());
      const mm = p.m + n;
      const y = p.y + Math.floor((mm - 1) / 12);
      const mo = ((mm - 1) % 12) + 1;
      const inMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      key = `${y}-${String(mo).padStart(2, '0')}-${String(Math.min(p.d, inMonth)).padStart(2, '0')}`;
    }
    return tryTake(m, key);
  }

  // next week / next month
  if ((m = t.match(/(^|\s)next\s+(week|month)\b/))) {
    const key =
      m[2] === 'week'
        ? addDaysKey(todayKey(), 7 - weekdayKey(todayKey()))
        : (() => {
            const p = parts(new Date());
            const mm = p.m === 12 ? 1 : p.m + 1;
            const y = p.m === 12 ? p.y + 1 : p.y;
            return `${y}-${String(mm).padStart(2, '0')}-01`;
          })();
    return tryTake(m, key);
  }

  // this/next <weekday>, or a bare weekday (meaning the next one)
  if ((m = t.match(/(^|\s)(?:(this|next|on)\s+)?(monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thu|friday|fri|saturday|sat|sunday|sun)\b/))) {
    const target = WEEKDAYS[m[3]];
    if (target != null) {
      const cur = weekdayKey(todayKey());
      let delta = (target - cur + 7) % 7;
      if (delta === 0) delta = 7; // "friday" on a Friday means next Friday
      if (m[2] === 'next' && delta < 7) delta += 7;
      return tryTake(m, addDaysKey(todayKey(), delta));
    }
  }

  // ISO: 2026-03-12
  if ((m = t.match(/(^|\s)(\d{4})-(\d{2})-(\d{2})\b/))) {
    return tryTake(m, `${m[2]}-${m[3]}-${m[4]}`);
  }

  // 12 Mar / Mar 12 (optional year)
  if ((m = t.match(/(^|\s)(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?\b/))) {
    return tryTake(m, ymd(m[4], MONTHS[m[3]], m[2]));
  }
  if ((m = t.match(/(^|\s)(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/))) {
    return tryTake(m, ymd(m[4], MONTHS[m[2]], m[3]));
  }

  // 12/03 or 12/03/2026 — day-first, matching most of the world outside the US
  if ((m = t.match(/(^|\s)(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    let y = m[4];
    if (y && y.length === 2) y = `20${y}`;
    return tryTake(m, ymd(y, m[3], m[2]));
  }

  return null;
}

function ymd(year, month, day) {
  const now = parts(new Date());
  const y = year ? parseInt(year, 10) : now.y;
  const mo = Math.min(12, Math.max(1, parseInt(month, 10)));
  const inMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const d = Math.min(inMonth, Math.max(1, parseInt(day, 10)));
  const key = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // A bare date already past this year almost always means next year.
  if (!year && key < todayKey()) {
    return `${y + 1}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return key;
}

function findTime(text, spans) {
  const t = text.toLowerCase();
  let m;

  if ((m = t.match(/(^|\s)at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight)\b/))) {
    const clock = parseClock(m[2]);
    if (clock) {
      const start = m.index + m[1].length;
      if (spans.take(start, start + m[0].length - m[1].length, 'time')) {
        return { clock, text: m[2] };
      }
    }
  }
  if ((m = t.match(/(^|\s)(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/))) {
    const clock = parseClock(m[2]);
    if (clock) {
      const start = m.index + m[1].length;
      if (spans.take(start, start + m[0].length - m[1].length, 'time')) {
        return { clock, text: m[2] };
      }
    }
  }
  if ((m = t.match(/(^|\s)(\d{1,2}:\d{2})\b/))) {
    const clock = parseClock(m[2]);
    if (clock) {
      const start = m.index + m[1].length;
      if (spans.take(start, start + m[0].length - m[1].length, 'time')) {
        return { clock, text: m[2] };
      }
    }
  }
  if ((m = t.match(/(^|\s)(noon|midnight|tonight)\b/))) {
    const clock = m[2] === 'tonight' ? { hh: 19, mm: 0 } : parseClock(m[2]);
    if (clock) {
      const start = m.index + m[1].length;
      if (spans.take(start, start + m[0].length - m[1].length, 'time')) {
        return { clock, text: m[2] };
      }
    }
  }
  return null;
}

function buildRule(m) {
  const word = (m[2] || m[1] || '').toLowerCase();
  const n = m[2] ? parseInt(m[1], 10) || 1 : 1;

  if (/^(daily)$/.test(word)) return 'FREQ=DAILY';
  if (/^(weekly)$/.test(word)) return 'FREQ=WEEKLY';
  if (/^(fortnightly|biweekly)$/.test(word)) return 'FREQ=WEEKLY;INTERVAL=2';
  if (/^(monthly)$/.test(word)) return 'FREQ=MONTHLY';
  if (/^(yearly|annually)$/.test(word)) return 'FREQ=YEARLY';
  if (/^weekday/.test(word)) return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
  if (/^day/.test(word)) return n > 1 ? `FREQ=DAILY;INTERVAL=${n}` : 'FREQ=DAILY';
  if (/^week/.test(word)) return n > 1 ? `FREQ=WEEKLY;INTERVAL=${n}` : 'FREQ=WEEKLY';
  if (/^month/.test(word)) return n > 1 ? `FREQ=MONTHLY;INTERVAL=${n}` : 'FREQ=MONTHLY';
  if (/^year/.test(word)) return n > 1 ? `FREQ=YEARLY;INTERVAL=${n}` : 'FREQ=YEARLY';

  const base = word.replace(/s$/, '');
  const idx = WEEKDAYS[base];
  if (idx != null) return `FREQ=WEEKLY;BYDAY=${DAY_CODE[idx]}`;
  return 'FREQ=WEEKLY';
}

/** Short syntax reminder shown under the quick-add field. */
export const SYNTAX = [
  { token: 'tomorrow 3pm', what: 'due date and time' },
  { token: '#project', what: 'project or label' },
  { token: '@person', what: 'assignee' },
  { token: '!high', what: 'priority' },
  { token: '~45m', what: 'estimate' },
  { token: 'every friday', what: 'repeat' },
];
