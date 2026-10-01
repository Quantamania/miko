/* Supabase data API (PostgREST), over plain `fetch`.
 *
 * Same reasoning as core/supabase.js: no SDK, no bundler, a handful of URLs.
 * This module knows how to select and upsert rows as the signed-in user; it
 * holds no state and makes no decisions about *what* to sync — that is
 * core/remote.js.
 *
 * Every request carries the user's access token, not just the anon key, so
 * Row Level Security sees a real `auth.uid()` and the policies in
 * docs/supabase-schema.sql actually apply.
 */

import { AuthError, current } from './supabase.js';

function restUrl(table, query) {
  const url = new URL(`${current().url.replace(/\/+$/, '')}/rest/v1/${table}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url.toString();
}

async function call(table, { method = 'GET', query, body, token, prefer } = {}) {
  let res;
  try {
    res = await fetch(restUrl(table, query), {
      method,
      headers: {
        apikey: current().key,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new AuthError('Could not reach the server.', { code: 'network' });
  }

  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON — fall through to the status */
  }

  if (!res.ok) {
    // PostgREST uses `message` with `hint`/`details` alongside. The hint is
    // usually the useful half when a policy refuses a write.
    const msg = parsed?.message || parsed?.hint || `Request failed (${res.status}).`;
    throw new AuthError(msg, { status: res.status, code: parsed?.code || '' });
  }
  return parsed;
}

/** Rows changed at or after `since`, oldest first, paged. */
export function selectSince(table, { token, workspaceId, since, limit = 500 }) {
  const query = { select: '*', order: 'updated_at.asc', limit: String(limit) };
  if (workspaceId) query.workspace_id = `eq.${workspaceId}`;
  if (since) query.updated_at = `gte.${since}`;
  return call(table, { query, token });
}

/** Insert or replace by primary key. PostgREST needs the resolution hint, or
 *  a repeat of the same id is a duplicate-key error rather than an update. */
export function upsert(table, rows, { token }) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return Promise.resolve([]);
  return call(table, {
    method: 'POST',
    body: list,
    token,
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
}

/** Used only to confirm a table exists and the policies admit this user —
 *  cheaper and clearer than discovering it mid-sync. */
export async function probe(table, { token }) {
  try {
    await call(table, { query: { select: 'id', limit: '1' }, token });
    return { ok: true };
  } catch (err) {
    return { ok: false, status: err.status, message: err.message };
  }
}
