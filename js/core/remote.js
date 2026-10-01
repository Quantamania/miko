/* Data sync against Supabase.
 *
 * The shape of it:
 *   • push — the outbox drains through here in order. An op is turned into an
 *     upsert of the *current* local row rather than a replay of the original
 *     patch, which makes it idempotent: a retry after a half-finished drain
 *     sends the same final state instead of applying an edit twice.
 *   • sweep — the outbox only carries task ops, so anything else (projects,
 *     labels, views, templates, automations) is caught by upserting whatever
 *     changed locally since the last cursor. That avoids threading an enqueue
 *     call through every mutation in the store.
 *   • pull — rows changed remotely since the cursor, merged field-by-field
 *     through sync.reconcile(), so a simultaneous edit on two devices is
 *     resolved per field and reported rather than clobbered wholesale.
 *
 * Deletes never travel as deletes: the app soft-deletes with `deleted_at`, so
 * a removal is just another upsert and arrives in the right order like
 * anything else.
 *
 * Not synced, deliberately: `attachments` (blobs belong in Supabase Storage,
 * which is its own piece of work) and `task_events` (an append-only audit log
 * that would dominate the traffic for little benefit).
 */

import * as db from './db.js';
import * as store from './store.js';
import * as sync from './sync.js';
import * as auth from './auth.js';
import * as rest from './postgrest.js';
import * as storage from './storage.js';
import { isConfigured } from './supabase.js';
import { nowISO, emitter } from './util.js';

export const bus = emitter();

/** Order matters on the first push: a task references a project, so the
 *  project has to exist first or the foreign key is rejected. */
export const TABLES = [
  'workspaces',
  'projects',
  'labels',
  'tasks',
  'attachments',
  'comments',
  'saved_views',
  'templates',
  'automations',
];

/* Two watermarks, not one.
 *
 * `sync:cursor` tracks the newest *remote* `updated_at` seen, and is what the
 * next pull asks for. `sync:pushed` tracks when this device last swept its own
 * rows upward. They cannot be the same value: remote timestamps come from
 * other devices' clocks and routinely run ahead of this one, so using the pull
 * cursor to select local changes silently skips anything stamped earlier than
 * the furthest-ahead peer — a local delete would simply never be sent. */
const CURSOR_KEY = 'sync:cursor';
const PUSHED_KEY = 'sync:pushed';

/* The merge base: the last version of a row this device and the server
   agreed on. Without it sync.merge() has no common ancestor, cannot tell
   which side changed a field, and resolves every conflict in the remote's
   favour — which loses local edits silently. */
async function rememberBase(table, row) {
  if (table !== 'tasks' || !row?.id) return;
  await db.put('sync_base', { id: row.id, row });
}

async function baseFor(id) {
  return (await db.get('sync_base', id))?.row || null;
}
const PULL_EVERY = 60_000;

let timer = null;
let connected = false;
let pulling = false;

/* -------------------------------- cursor -------------------------------- */

async function getCursor() {
  return (await db.get('meta', CURSOR_KEY))?.value || null;
}

async function setCursor(value) {
  await db.put('meta', { key: CURSOR_KEY, value });
}

async function getPushMark() {
  return (await db.get('meta', PUSHED_KEY))?.value || null;
}

async function setPushMark(value) {
  await db.put('meta', { key: PUSHED_KEY, value });
}

function token() {
  const s = auth.currentSession();
  if (!s?.accessToken) throw new Error('Not signed in.');
  return s.accessToken;
}

function workspaceId() {
  return store.state.workspace?.id || null;
}

/** The Supabase account id, which is not the local user id. Local ids are
 *  generated offline (`usr_…`) and mean nothing to the server; `members` and
 *  `workspaces.owner_id` must carry the auth uuid or `is_member()` is false
 *  and every policy refuses. */
function accountId() {
  return auth.currentSession()?.userId || null;
}

/** Rewrite the few columns whose local value is not the server's value. */
function toRemote(table, row) {
  if (table === 'workspaces') return { ...row, owner_id: accountId() };
  if (table === 'attachments') {
    // The blob never goes to Postgres — only a pointer to where it lives.
    const { blob, ...meta } = row;
    return { ...meta, storage_path: storage.pathFor(row) };
  }
  return row;
}

/* ----------------------------- attachments -----------------------------
 *
 * Bytes first, then the row. If the upload fails the metadata is never
 * written, so the table can never point at an object that is not there —
 * whereas the reverse would show a file in the UI that refuses to open. */

async function pushAttachments(since) {
  const t = token();
  const rows = await localChangedSince('attachments', since);
  if (!rows.length) return;

  for (const row of rows) {
    const path = storage.pathFor(row);
    if (row.deleted_at) {
      await storage.remove(path, { token: t });
    } else if (row.blob) {
      await storage.upload(path, row.blob, { token: t, contentType: row.type });
    }
  }
  await rest.upsert('attachments', rows.map((r) => toRemote('attachments', r)), { token: t });
}

/** Fetch bytes for attachments this device has a row for but no file.
 *
 *  Done eagerly rather than on demand: the product promise is that it works
 *  offline, and an attachment you cannot open on a plane is not synced. The
 *  trade is a slower first sync on a workspace with many files. */
async function hydrateAttachment(row) {
  if (row.deleted_at) return;
  const local = await db.get('attachments', row.id);
  if (local?.blob) return;
  try {
    const blob = await storage.download(row.storage_path || storage.pathFor(row), {
      token: token(),
    });
    await db.put('attachments', { ...row, blob });
  } catch (err) {
    // Keep the row: the file is listed, just not cached yet. Losing the
    // metadata would hide it entirely.
    bus.emit('error', { message: `Could not fetch ${row.name}: ${err.message}` });
  }
}

/**
 * Link this account to this workspace, so the policies admit it.
 *
 * Order is awkward and worth spelling out. `members.workspace_id` has a
 * foreign key to `workspaces`, so the workspace has to exist first — but on a
 * *second* device the workspace already exists, which makes the upsert an
 * UPDATE, and that is gated on `is_member()`, which is not true yet. Neither
 * order works alone, so: try membership first (cheap, and allowed whenever the
 * workspace is already there), and fall back to creating the workspace first
 * when it is not.
 */
async function bootstrap() {
  const t = token();
  const uid = accountId();
  const ws = store.state.workspace;
  if (!uid) throw new Error('Signed in, but the account has no id.');
  if (!ws) throw new Error('No workspace to sync.');

  const member = {
    id: `mbr_${ws.id}_${uid}`,
    workspace_id: ws.id,
    user_id: uid,
    role: 'owner',
    created_at: nowISO(),
  };

  try {
    await rest.upsert('members', [member], { token: t });
  } catch {
    // The workspace is not on the server yet — create it, then join it.
    await rest.upsert('workspaces', [toRemote('workspaces', ws)], { token: t });
    await rest.upsert('members', [member], { token: t });
  }

  // Now that membership exists, the workspace row is writable either way.
  await rest.upsert('workspaces', [toRemote('workspaces', ws)], { token: t });
}

/* --------------------------------- push --------------------------------- */

/** Local rows in `table` touched at or after `since`. */
async function localChangedSince(table, since) {
  const all = await db.getAll(table);
  const ws = workspaceId();
  return all.filter((r) => {
    if (ws && r.workspace_id && r.workspace_id !== ws) return false;
    if (!since) return true;
    return String(r.updated_at || r.created_at || '') >= since;
  });
}

/**
 * Drain one outbox op.
 *
 * The op tells us *what* changed; the current local row tells us what it
 * changed to. Sending the latter means a retry is harmless and an op that
 * arrives after a newer edit does not resurrect stale values.
 */
export async function push(row) {
  if (!isConfigured()) return;
  const t = token();

  const ids =
    row.entity_id != null
      ? [row.entity_id]
      : Array.isArray(row.payload?.ids)
        ? row.payload.ids
        : [];
  if (!ids.length) return;

  const table = `${row.entity}s`; // 'task' → 'tasks'
  const rows = [];
  for (const id of ids) {
    const current = await db.get(table, id);
    if (current) rows.push(current);
  }
  if (rows.length) {
    await rest.upsert(table, rows.map((r) => toRemote(table, r)), { token: t });
    for (const r of rows) await rememberBase(table, r);
  }
}

/** Everything the outbox does not cover.
 *
 *  The watermark is read before the work and written after it, so a row
 *  changed mid-sweep is caught by the next one rather than skipped. */
async function sweep() {
  const t = token();
  const startedAt = nowISO();
  const since = await getPushMark();
  for (const table of TABLES) {
    if (table === 'tasks') continue; // the outbox already carries these
    if (table === 'attachments') {
      await pushAttachments(since);
      continue;
    }
    const rows = await localChangedSince(table, since);
    if (rows.length) {
      await rest.upsert(table, rows.map((r) => toRemote(table, r)), { token: t });
    }
  }
  await setPushMark(startedAt);
}

/* --------------------------------- pull --------------------------------- */

/**
 * Fetch remote changes and apply them.
 *
 * Tasks go through sync.reconcile() so a field-level merge happens and real
 * conflicts are surfaced. Other tables are small, flat and rarely edited on
 * two devices at once, so last-writer-wins on `updated_at` is enough — and
 * saying so here is better than implying a merge that is not happening.
 */
export async function pull() {
  if (!isConfigured() || pulling) return { changed: 0 };
  pulling = true;
  try {
    const t = token();
    const ws = workspaceId();
    const since = await getCursor();
    let changed = 0;
    let newest = since || '';

    for (const table of TABLES) {
      const rows = await rest.selectSince(table, { token: t, workspaceId: ws, since });
      for (const remote of rows || []) {
        if (remote.updated_at && remote.updated_at > newest) newest = remote.updated_at;

        if (table === 'tasks') {
          await sync.reconcile(remote, await baseFor(remote.id));
          await rememberBase(table, remote);
          changed++;
          continue;
        }

        if (table === 'attachments') {
          const local = await db.get('attachments', remote.id);
          const localNewer =
            local && String(local.updated_at || '') > String(remote.updated_at || '');
          if (!localNewer) {
            // Keep any blob already cached rather than blanking it with the
            // row from the server, which carries no bytes.
            await db.put('attachments', { ...remote, blob: local?.blob ?? null });
            await hydrateAttachment(remote);
            changed++;
          }
          continue;
        }

        const local = await db.get(table, remote.id);
        const localNewer =
          local && String(local.updated_at || '') > String(remote.updated_at || '');
        if (!localNewer) {
          await db.put(table, remote);
          changed++;
        }
      }
    }

    if (newest) await setCursor(newest);
    if (changed) {
      // Rehydrate from IndexedDB so every view sees the new rows at once.
      await store.reload();
      bus.emit('pulled', { changed });
    }
    return { changed };
  } finally {
    pulling = false;
  }
}

/* ------------------------------- lifecycle ------------------------------- */

/** Does the database actually have the tables, and do the policies let this
 *  user see them? Checked once at connect so the failure is one clear message
 *  rather than six retry cycles. */
export async function preflight() {
  const t = token();
  const missing = [];
  for (const table of TABLES) {
    const r = await rest.probe(table, { token: t });
    if (!r.ok) missing.push({ table, status: r.status, message: r.message });
  }
  const bucket = await storage.probe({ token: t });
  if (!bucket.ok) {
    missing.push({ table: `storage:${storage.BUCKET}`, status: bucket.status, message: bucket.message });
  }
  return { ok: missing.length === 0, missing };
}

export async function connect({ verify = true } = {}) {
  if (!isConfigured() || !auth.isSignedIn()) return { connected: false, reason: 'not-signed-in' };

  if (verify) {
    const check = await preflight();
    if (!check.ok) {
      bus.emit('error', check);
      return { connected: false, reason: 'schema', missing: check.missing };
    }
  }

  sync.setAdapter({ push, pull });
  connected = true;
  bus.emit('connected', true);

  // First run: link the account to the workspace, send anything made before
  // signing in, then take what is already there.
  try {
    await bootstrap();
    await sweep();
  } catch (err) {
    bus.emit('error', { message: err.message });
  }
  await pull().catch((err) => bus.emit('error', { message: err.message }));

  clearInterval(timer);
  timer = setInterval(() => {
    if (navigator.onLine) pull().catch(() => {});
  }, PULL_EVERY);

  return { connected: true };
}

export function disconnect() {
  clearInterval(timer);
  timer = null;
  connected = false;
  sync.setAdapter(null);
  bus.emit('connected', false);
}

export function isConnected() {
  return connected;
}

/** Forget the cursor so the next pull takes everything again. Used after a
 *  sign-out, since the next account must not inherit this one's position. */
export async function resetCursor() {
  await db.del('meta', CURSOR_KEY);
  await db.del('meta', PUSHED_KEY);
}
