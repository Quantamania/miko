/* Shared primitives: ids, time, text, small functional helpers.
   Everything here is pure and dependency-free. */

/* ------------------------------- IDS ------------------------------- */

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford — no I, L, O, U

let lastMs = 0;
let seq = 0;

/** Lexicographically sortable id. Sorting by id sorts by creation time,
 *  which lets IndexedDB range queries double as "most recent" queries. */
export function id(prefix = '') {
  let now = Date.now();
  if (now === lastMs) {
    seq += 1;
  } else {
    lastMs = now;
    seq = 0;
  }
  let ts = '';
  let n = now;
  for (let i = 0; i < 10; i++) {
    ts = B32[n % 32] + ts;
    n = Math.floor(n / 32);
  }
  const rand = crypto.getRandomValues(new Uint8Array(8));
  let tail = String.fromCharCode(...[...rand].map((b) => B32.charCodeAt(b % 32)));
  tail = B32[seq % 32] + tail.slice(1);
  return prefix ? `${prefix}_${ts}${tail}` : ts + tail;
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ------------------------------- TIME ------------------------------- */
/* Everything is stored as a UTC ISO string. The user's IANA zone lives on
   their profile and is the only thing that turns an instant into a date. */

export function nowISO() {
  return new Date().toISOString();
}

export function toISO(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

let zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function setZone(tz) {
  if (tz) zone = tz;
}

export function getZone() {
  return zone;
}

export function localZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const fmtCache = new Map();

function fmt(opts) {
  const key = JSON.stringify(opts) + zone;
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, { timeZone: zone, ...opts });
    fmtCache.set(key, f);
  }
  return f;
}

/** Calendar parts of an instant, in the user's zone. */
export function parts(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  const p = fmt({
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const out = {};
  for (const { type, value } of p) out[type] = value;
  return {
    y: +out.year,
    m: +out.month,
    d: +out.day,
    hh: +(out.hour === '24' ? '0' : out.hour),
    mm: +out.minute,
  };
}

/** 'YYYY-MM-DD' for an instant, in the user's zone. This is the join key for
 *  every day-bucketed view (calendar, heatmap, agenda). */
export function dayKey(iso) {
  if (!iso) return null;
  const p = parts(iso);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export function todayKey() {
  return dayKey(new Date());
}

/** Local midnight of a 'YYYY-MM-DD' key, returned as a UTC instant.
 *  Resolves the zone offset by probing, so DST is handled without a library. */
export function keyToInstant(key, hour = 0, minute = 0) {
  const [y, m, d] = key.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d, hour, minute);
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(guess));
    const drift =
      (p.y - y) * 525600 + (p.m - m) * 43800 + (p.d - d) * 1440 + (p.hh - hour) * 60 + (p.mm - minute);
    if (drift === 0) break;
    guess -= drift * 60000;
  }
  return new Date(guess).toISOString();
}

export function addDaysKey(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(
    dt.getUTCDate()
  ).padStart(2, '0')}`;
}

export function diffDaysKey(a, b) {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  return Math.round(
    (Date.UTC(pa[0], pa[1] - 1, pa[2]) - Date.UTC(pb[0], pb[1] - 1, pb[2])) / 86400000
  );
}

/** Monday-first weekday index, 0..6 */
export function weekdayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export function startOfWeekKey(key) {
  return addDaysKey(key, -weekdayKey(key));
}

export function hasTime(iso) {
  // A task with a due *time* is stored with a non-midnight local time.
  if (!iso) return false;
  const p = parts(iso);
  return p.hh !== 0 || p.mm !== 0;
}

export function fmtDate(iso, opts) {
  if (!iso) return '';
  return fmt(opts || { month: 'short', day: 'numeric' }).format(new Date(iso));
}

export function fmtTime(iso) {
  if (!iso) return '';
  return fmt({ hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

/** Human due-date label, relative near today and absolute further out. */
export function fmtDue(iso) {
  if (!iso) return '';
  const k = dayKey(iso);
  const diff = diffDaysKey(k, todayKey());
  const time = hasTime(iso) ? ` ${fmtTime(iso)}` : '';
  if (diff === 0) return `Today${time}`;
  if (diff === 1) return `Tomorrow${time}`;
  if (diff === -1) return `Yesterday${time}`;
  if (diff > 1 && diff < 7) return fmt({ weekday: 'long' }).format(new Date(iso)) + time;
  if (diff < 0 && diff > -7) return `${-diff}d overdue`;
  const sameYear = parts(iso).y === parts(new Date()).y;
  return fmtDate(iso, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }) + time;
}

const REL_STEPS = [
  [60, 'second', 1],
  [3600, 'minute', 60],
  [86400, 'hour', 3600],
  [604800, 'day', 86400],
  [2629800, 'week', 604800],
  [31557600, 'month', 2629800],
  [Infinity, 'year', 31557600],
];

export function fmtRelative(iso) {
  if (!iso) return '';
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  const abs = Math.abs(secs);
  if (abs < 45) return 'just now';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [limit, unit, div] of REL_STEPS) {
    if (abs < limit) return rtf.format(-Math.round(secs / div), unit);
  }
  return '';
}

export function fmtDuration(mins) {
  if (!mins) return '';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (!h) return `${m}m`;
  if (!m) return `${h}h`;
  return `${h}h ${m}m`;
}

export function clockTime(secs) {
  const s = Math.max(0, Math.round(secs));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/* ------------------------------- TEXT ------------------------------- */

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Strip HTML to plain text — used for search indexing and CSV export. */
export function stripHTML(html) {
  if (!html) return '';
  const el = document.createElement('div');
  el.innerHTML = html;
  return (el.textContent || '').replace(/\s+/g, ' ').trim();
}

/** Allowlist sanitiser for the rich-text description field. Anything not on
 *  the list is unwrapped, and every attribute except safe hrefs is dropped. */
const ALLOWED = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'CODE', 'UL', 'OL', 'LI', 'A', 'DIV', 'SPAN']);

export function sanitize(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html ?? '');
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) continue;
      if (child.nodeType !== 1) {
        child.remove();
        continue;
      }
      if (!ALLOWED.has(child.tagName)) {
        // keep the text, drop the element
        while (child.firstChild) node.insertBefore(child.firstChild, child);
        child.remove();
        continue;
      }
      for (const attr of [...child.attributes]) {
        const ok =
          child.tagName === 'A' &&
          attr.name === 'href' &&
          /^(https?:|mailto:|#)/i.test(attr.value.trim());
        if (!ok) child.removeAttribute(attr.name);
      }
      if (child.tagName === 'A') {
        child.setAttribute('rel', 'noopener noreferrer');
        child.setAttribute('target', '_blank');
      }
      walk(child);
    }
  };
  walk(tpl.content);
  return tpl.innerHTML;
}

export function initials(name) {
  const t = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!t.length) return '?';
  if (t.length === 1) return t[0].slice(0, 2).toUpperCase();
  return (t[0][0] + t[t.length - 1][0]).toUpperCase();
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + 's'}`;
}

export function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

/** Deterministic colour from a string — used for project/label defaults. */
export function hashColor(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const hues = [8, 28, 44, 90, 150, 186, 210, 254, 286, 330];
  return `hsl(${hues[Math.abs(h) % hues.length]} 58% 46%)`;
}

/* ----------------------------- FUNCTIONAL ----------------------------- */

export function debounce(fn, ms = 200) {
  let t;
  const wrapped = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...a) => {
    clearTimeout(t);
    fn(...a);
  };
  return wrapped;
}

export function throttle(fn, ms = 100) {
  let last = 0;
  let queued = null;
  return (...a) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...a);
    } else if (!queued) {
      queued = setTimeout(() => {
        queued = null;
        last = Date.now();
        fn(...a);
      }, ms - (now - last));
    }
  };
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function groupBy(items, keyFn) {
  const map = new Map();
  for (const it of items) {
    const k = keyFn(it);
    let arr = map.get(k);
    if (!arr) map.set(k, (arr = []));
    arr.push(it);
  }
  return map;
}

export function sortBy(items, ...keys) {
  return [...items].sort((a, b) => {
    for (const k of keys) {
      const dir = typeof k === 'object' ? k.dir : 1;
      const fn = typeof k === 'object' ? k.key : k;
      const av = fn(a);
      const bv = fn(b);
      if (av == null && bv == null) continue;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
    }
    return 0;
  });
}

export function unique(arr) {
  return [...new Set(arr)];
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

export function clone(v) {
  if (v == null || typeof v !== 'object') return v;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(v);
    } catch {
      /* Blobs and functions fall through to JSON */
    }
  }
  return JSON.parse(JSON.stringify(v));
}

/** Shallow diff, ignoring bookkeeping fields. Feeds the audit log. */
const IGNORED = new Set(['updated_at', 'version', 'synced_at', '_dirty']);

export function diff(before, after) {
  const out = {};
  const keys = unique([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (IGNORED.has(k)) continue;
    if (!deepEqual(before?.[k], after?.[k])) {
      out[k] = { from: before?.[k] ?? null, to: after?.[k] ?? null };
    }
  }
  return out;
}

/* ------------------------------ EVENTS ------------------------------ */

export function emitter() {
  const map = new Map();
  return {
    on(evt, fn) {
      let set = map.get(evt);
      if (!set) map.set(evt, (set = new Set()));
      set.add(fn);
      return () => set.delete(fn);
    },
    off(evt, fn) {
      map.get(evt)?.delete(fn);
    },
    emit(evt, payload) {
      map.get(evt)?.forEach((fn) => {
        try {
          fn(payload);
        } catch (err) {
          console.error(`[miko] listener for "${evt}" threw`, err);
        }
      });
      if (evt !== '*') map.get('*')?.forEach((fn) => fn(evt, payload));
    },
  };
}

/* ------------------------------ ERRORS ------------------------------ */

export class AppError extends Error {
  constructor(message, code = 'error', detail) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.detail = detail;
  }
}

export class ConflictError extends AppError {
  constructor(local, remote) {
    super('This record changed somewhere else', 'conflict');
    this.local = local;
    this.remote = remote;
  }
}
