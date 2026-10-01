/* Supabase Storage, over plain `fetch`.
 *
 * Attachment *bytes* live here; attachment *metadata* is an ordinary row in
 * the `attachments` table and syncs like everything else. Keeping them apart
 * matters: Postgres is the wrong place for an 8 MB blob, and a storage object
 * is the wrong place for something you want to query.
 *
 * Object paths are `{workspace_id}/{attachment_id}`. The first path segment is
 * what the storage policy reads to decide whether the caller is a member of
 * that workspace, so the layout is load-bearing — see docs/supabase-schema.sql.
 */

import { AuthError, current } from './supabase.js';

export const BUCKET = 'attachments';

function objectUrl(path) {
  return `${current().url.replace(/\/+$/, '')}/storage/v1/object/${BUCKET}/${path}`;
}

/** Where an attachment's bytes live. */
export function pathFor(attachment) {
  return `${attachment.workspace_id}/${attachment.id}`;
}

async function send(url, { method, body, token, headers = {} }) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { apikey: current().key, Authorization: `Bearer ${token}`, ...headers },
      body,
    });
  } catch {
    throw new AuthError('Could not reach storage.', { code: 'network' });
  }
  if (!res.ok) {
    let message = `Storage request failed (${res.status}).`;
    try {
      const j = await res.json();
      message = j.message || j.error || message;
    } catch {
      /* not JSON */
    }
    throw new AuthError(message, { status: res.status });
  }
  return res;
}

/** Upload bytes, replacing anything already at that path. `x-upsert` is what
 *  makes a retry after a half-finished sync harmless rather than a 409. */
export async function upload(path, blob, { token, contentType }) {
  await send(objectUrl(path), {
    method: 'POST',
    body: blob,
    token,
    headers: {
      'Content-Type': contentType || blob.type || 'application/octet-stream',
      'x-upsert': 'true',
    },
  });
  return { path };
}

export async function download(path, { token }) {
  const res = await send(objectUrl(path), { method: 'GET', token });
  return res.blob();
}

export async function remove(path, { token }) {
  try {
    await send(objectUrl(path), { method: 'DELETE', token });
  } catch (err) {
    // A missing object is the state we wanted anyway.
    if (err.status !== 404) throw err;
  }
  return true;
}

/** Does the bucket exist and admit this user? Checked once at connect so a
 *  misconfigured bucket is one clear message rather than a failure per file. */
export async function probe({ token }) {
  try {
    const url = `${current().url.replace(/\/+$/, '')}/storage/v1/object/list/${BUCKET}`;
    await send(url, {
      method: 'POST',
      token,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 1, prefix: '' }),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, status: err.status, message: err.message };
  }
}
