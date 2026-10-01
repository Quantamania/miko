/* Full-text search over tasks.
 *
 * An in-memory inverted index with prefix matching — the client-side analogue
 * of the Postgres `tsvector` the plan starts with. Tokens are folded to
 * lowercase, stripped of diacritics, and light-stemmed; postings carry a field
 * weight so a title hit outranks a description hit.
 *
 * Prefix queries are answered by binary-searching a sorted token array for the
 * `[prefix, prefix + '￿')` range, which keeps "as-you-type" searching
 * linear in the number of *matching* tokens rather than the whole vocabulary.
 */

import { stripHTML } from './util.js';

const FIELD_WEIGHT = { title: 6, description: 1, label: 3, project: 2 };
const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in',
  'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the',
  'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'will', 'with',
]);

export function normalize(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Very light suffix stripping. Deliberately conservative: over-stemming makes
 *  short task titles match things users did not mean. */
function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('es') && !w.endsWith('ses')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  return w;
}

export function tokenize(text) {
  const out = [];
  for (const raw of normalize(text).split(/[^a-z0-9#@_'-]+/)) {
    const w = raw.replace(/^['-]+|['-]+$/g, '');
    if (!w || w.length < 2 || STOP.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

class Index {
  constructor() {
    this.postings = new Map(); // token -> Map(taskId -> weight)
    this.docs = new Map(); // taskId -> { tokens:Set, updated_at }
    this.sorted = null; // lazily rebuilt sorted token list
  }

  clear() {
    this.postings.clear();
    this.docs.clear();
    this.sorted = null;
  }

  /** Add or replace a document. Idempotent — safe to call on every update. */
  add(task) {
    this.remove(task.id);
    const fields = [
      [task.title, 'title'],
      [stripHTML(task.description), 'description'],
      [(task.labelNames || []).join(' '), 'label'],
      [task.projectName || '', 'project'],
    ];
    const tokens = new Set();
    for (const [text, field] of fields) {
      if (!text) continue;
      const w = FIELD_WEIGHT[field] || 1;
      for (const tok of tokenize(text)) {
        tokens.add(tok);
        let post = this.postings.get(tok);
        if (!post) this.postings.set(tok, (post = new Map()));
        post.set(task.id, (post.get(task.id) || 0) + w);
        this.sorted = null;
      }
    }
    this.docs.set(task.id, { tokens, updated_at: task.updated_at });
  }

  remove(taskId) {
    const doc = this.docs.get(taskId);
    if (!doc) return;
    for (const tok of doc.tokens) {
      const post = this.postings.get(tok);
      if (!post) continue;
      post.delete(taskId);
      if (!post.size) {
        this.postings.delete(tok);
        this.sorted = null;
      }
    }
    this.docs.delete(taskId);
  }

  get size() {
    return this.docs.size;
  }

  tokens() {
    if (!this.sorted) this.sorted = [...this.postings.keys()].sort();
    return this.sorted;
  }

  /** Every indexed token starting with `prefix`. */
  prefixMatches(prefix, limit = 60) {
    const toks = this.tokens();
    let lo = 0;
    let hi = toks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (toks[mid] < prefix) lo = mid + 1;
      else hi = mid;
    }
    const out = [];
    for (let i = lo; i < toks.length && toks[i].startsWith(prefix); i++) {
      out.push(toks[i]);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Ranked search. The final token is treated as a prefix so results update
   *  usefully while the user is still typing. */
  search(query, { limit = 50 } = {}) {
    const terms = tokenize(query);
    if (!terms.length) return [];

    const scores = new Map();
    const matchedTerms = new Map(); // taskId -> Set(term index)

    terms.forEach((term, ti) => {
      const isLast = ti === terms.length - 1;
      const variants = new Map();

      const exact = this.postings.get(term);
      if (exact) variants.set(term, { post: exact, factor: 1 });

      if (isLast) {
        for (const tok of this.prefixMatches(term)) {
          if (variants.has(tok)) continue;
          const post = this.postings.get(tok);
          // Longer completions are weaker matches than the typed prefix.
          if (post) variants.set(tok, { post, factor: term.length / tok.length });
        }
      }

      const df = [...variants.values()].reduce((n, v) => n + v.post.size, 0) || 1;
      const idf = Math.log(1 + this.docs.size / df);

      for (const { post, factor } of variants.values()) {
        for (const [taskId, weight] of post) {
          scores.set(taskId, (scores.get(taskId) || 0) + weight * idf * factor);
          let set = matchedTerms.get(taskId);
          if (!set) matchedTerms.set(taskId, (set = new Set()));
          set.add(ti);
        }
      }
    });

    // Require every term to match somewhere — AND semantics beat OR for task
    // search, where the result set is small and precision matters more.
    const results = [];
    for (const [taskId, score] of scores) {
      if ((matchedTerms.get(taskId)?.size || 0) < terms.length) continue;
      results.push({ id: taskId, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}

export const index = new Index();

/** Highlight query terms inside a plain-text string, returning safe HTML. */
export function highlight(text, query) {
  const terms = tokenize(query);
  if (!terms.length) return escapeText(text);
  const src = String(text ?? '');
  const lower = normalize(src);
  const spans = [];

  for (const term of terms) {
    let from = 0;
    while (from < lower.length) {
      const at = lower.indexOf(term, from);
      if (at === -1) break;
      // Only highlight at a word boundary; mid-word hits read as noise.
      if (at === 0 || /[^a-z0-9]/.test(lower[at - 1])) {
        spans.push([at, at + term.length]);
      }
      from = at + term.length;
    }
  }

  if (!spans.length) return escapeText(src);
  spans.sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  let out = '';
  let cursor = 0;
  for (const [s, e] of merged) {
    out += escapeText(src.slice(cursor, s));
    out += `<mark>${escapeText(src.slice(s, e))}</mark>`;
    cursor = e;
  }
  return out + escapeText(src.slice(cursor));
}

function escapeText(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
