/* Sync, presence, and the offline outbox.
 *
 * Two transports:
 *   • BroadcastChannel — genuine realtime between tabs/windows on this device.
 *     This is what drives live updates and presence today.
 *   • `adapter` — a pluggable remote. It is null until a backend exists; the
 *     outbox drains through it in order, with retry and backoff. Wiring a
 *     server in means implementing `push`/`pull`, nothing else.
 *
 * Conflict resolution is deterministic and field-level: last-writer-wins per
 * field, with `updated_at` as the clock and `version` as the tiebreak. When
 * both sides changed the *same* field, the row is surfaced to the UI as a
 * conflict rather than silently resolved.
 */

import * as db from './db.js';
import * as store from './store.js';
import { emitter, nowISO, id as newId } from './util.js';

export const bus = emitter();

export const STATE = {
  SYNCED: 'synced',
  SYNCING: 'syncing',
  OFFLINE: 'offline',
  ERROR: 'error',
};

let status = navigator.onLine ? STATE.SYNCED : STATE.OFFLINE;
let pending = 0;
let draining = false;
let backoff = 0;

/** Remote transport. Left null deliberately: with no server configured the
 *  outbox still records and drains, so switching this on later needs no
 *  changes anywhere else in the app. */
export let adapter = null;

export function setAdapter(a) {
  adapter = a;
  bus.emit('adapter', !!a);
  if (a) drain();
}

export function getStatus() {
  return { status, pending, online: navigator.onLine, remote: !!adapter };
}

function setStatus(next) {
  if (status === next) return;
  status = next;
  bus.emit('status', getStatus());
}

/* ------------------------------ BROADCAST ------------------------------ */

const CHANNEL = 'miko:sync';
const TAB_ID = newId('tab');
let channel = null;

/* Presence: every tab heartbeats; stale peers time out. This is real
   multi-window presence, and the same message shape a server would push. */
const peers = new Map();
const PEER_TTL = 12_000;
const HEARTBEAT = 4_000;

function openChannel() {
  if (typeof BroadcastChannel === 'undefined') return;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (e) => handleMessage(e.data);
  heartbeat();
  setInterval(heartbeat, HEARTBEAT);
  setInterval(reapPeers, HEARTBEAT);
}

function post(msg) {
  if (!channel) return;
  try {
    channel.postMessage({ ...msg, from: TAB_ID, at: Date.now() });
  } catch (err) {
    console.warn('[miko] broadcast failed', err);
  }
}

function heartbeat() {
  post({
    kind: 'presence',
    user: store.state.user
      ? { id: store.state.user.id, name: store.state.user.name }
      : null,
    workspace_id: store.state.workspace?.id ?? null,
    viewing: currentViewing,
  });
}

let currentViewing = null;

/** Tell other tabs which project/task this one is looking at. Drives the
 *  "who's here" avatars scoped to the open project. */
export function setViewing(ctx) {
  currentViewing = ctx;
  heartbeat();
}

function reapPeers() {
  const cutoff = Date.now() - PEER_TTL;
  let changed = false;
  for (const [pid, p] of peers) {
    if (p.at < cutoff) {
      peers.delete(pid);
      changed = true;
    }
  }
  if (changed) bus.emit('presence', listPeers());
}

export function listPeers(scope) {
  const out = [];
  for (const p of peers.values()) {
    if (p.workspace_id !== store.state.workspace?.id) continue;
    if (scope && p.viewing?.project_id !== scope) continue;
    out.push(p);
  }
  return out;
}

function handleMessage(msg) {
  if (!msg || msg.from === TAB_ID) return;

  if (msg.kind === 'presence') {
    peers.set(msg.from, { ...msg, at: msg.at });
    bus.emit('presence', listPeers());
    return;
  }

  if (msg.kind === 'mutation') {
    if (msg.workspace_id !== store.state.workspace?.id) return;
    if (msg.entity === 'task') {
      if (Array.isArray(msg.ids) && msg.ids.length > 1) {
        Promise.all(msg.ids.map((i) => store.refreshTask(i)));
      } else {
        store.refreshTask(msg.entity_id || msg.ids?.[0]);
      }
    } else {
      store.reload();
    }
    bus.emit('remote-change', msg);
    return;
  }

  if (msg.kind === 'settings') {
    store.state.settings[msg.key] = msg.value;
    store.bus.emit('settings:changed', { key: msg.key, value: msg.value, remote: true });
  }
}

/* -------------------------------- OUTBOX -------------------------------- */

export async function countPending() {
  const rows = await db.byIndex('outbox', 'state', 'pending');
  pending = rows.length;
  return pending;
}

/** Drain the queue in creation order. Stops at the first hard failure so
 *  operations are never applied out of sequence. */
export async function drain() {
  if (draining) return;
  if (!navigator.onLine) {
    setStatus(STATE.OFFLINE);
    return;
  }
  draining = true;
  try {
    const rows = (await db.byIndex('outbox', 'state', 'pending')).sort((a, b) =>
      a.created_at < b.created_at ? -1 : 1
    );
    pending = rows.length;
    if (!rows.length) {
      setStatus(STATE.SYNCED);
      return;
    }
    setStatus(STATE.SYNCING);

    for (const row of rows) {
      try {
        if (adapter) {
          await adapter.push(row);
        }
        // With no adapter the op is considered settled locally — IndexedDB
        // already holds the authoritative copy.
        await db.put('outbox', { ...row, state: 'done', settled_at: nowISO() });
        pending = Math.max(0, pending - 1);
        bus.emit('status', getStatus());
      } catch (err) {
        const attempts = row.attempts + 1;
        const dead = attempts >= 6;
        await db.put('outbox', {
          ...row,
          attempts,
          state: dead ? 'failed' : 'pending',
          last_error: String(err?.message || err),
        });
        if (dead) {
          bus.emit('op-failed', { row, error: err });
        } else {
          backoff = Math.min(30_000, 1000 * 2 ** attempts);
          setTimeout(drain, backoff);
        }
        setStatus(STATE.ERROR);
        return;
      }
    }

    await prune();
    setStatus(STATE.SYNCED);
    backoff = 0;
  } finally {
    draining = false;
  }
}

/** Keep settled operations around briefly for debugging, then drop them. */
async function prune() {
  const cutoff = Date.now() - 6 * 3600 * 1000;
  const done = await db.byIndex('outbox', 'state', 'done');
  const stale = done.filter((r) => new Date(r.settled_at || r.created_at).getTime() < cutoff);
  if (!stale.length) return;
  await db.tx('outbox', 'readwrite', (t) => {
    const s = t.objectStore('outbox');
    for (const r of stale) s.delete(r.id);
  });
}

export async function retryFailed() {
  const rows = await db.byIndex('outbox', 'state', 'failed');
  await db.tx('outbox', 'readwrite', (t) => {
    const s = t.objectStore('outbox');
    for (const r of rows) s.put({ ...r, state: 'pending', attempts: 0 });
  });
  return drain();
}

/* ------------------------------ CONFLICTS ------------------------------ */

const BOOKKEEPING = new Set(['version', 'updated_at', 'synced_at']);

/** Field-level three-way merge.
 *  Returns `{ merged, conflicts }`. A field is only a conflict when both
 *  sides changed it away from the common base to *different* values;
 *  everything else resolves deterministically. */
export function merge(base, local, remote) {
  const merged = { ...remote };
  const conflicts = [];
  const keys = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})]);

  for (const k of keys) {
    if (BOOKKEEPING.has(k)) continue;
    const b = base?.[k];
    const l = local?.[k];
    const r = remote?.[k];
    const lChanged = JSON.stringify(b) !== JSON.stringify(l);
    const rChanged = JSON.stringify(b) !== JSON.stringify(r);

    if (lChanged && !rChanged) merged[k] = l;
    else if (!lChanged && rChanged) merged[k] = r;
    else if (lChanged && rChanged && JSON.stringify(l) !== JSON.stringify(r)) {
      // Both edited the same field. Fall back to last-writer-wins so the app
      // always has a usable value, but report it so the UI can offer a choice.
      const localNewer =
        new Date(local.updated_at || 0).getTime() >= new Date(remote.updated_at || 0).getTime();
      merged[k] = localNewer ? l : r;
      conflicts.push({ field: k, base: b, local: l, remote: r, resolved: merged[k] });
    }
  }

  merged.version = Math.max(local?.version || 0, remote?.version || 0) + 1;
  merged.updated_at = nowISO();
  return { merged, conflicts };
}

/** Apply a remote record over the local one, reporting genuine conflicts. */
export async function reconcile(remoteTask, baseTask) {
  const local = store.getTask(remoteTask.id);
  if (!local) {
    await db.put('tasks', remoteTask);
    await store.refreshTask(remoteTask.id);
    return { conflicts: [] };
  }
  const { merged, conflicts } = merge(baseTask || local, local, remoteTask);
  await db.put('tasks', merged);
  await store.refreshTask(merged.id);
  if (conflicts.length) bus.emit('conflict', { task: merged, conflicts });
  return { merged, conflicts };
}

/* -------------------------------- HOOKS -------------------------------- */

function wireStore() {
  store.bus.on('tasks:changed', (e) => {
    if (e.type === 'remote' || e.type === 'reload') return;
    post({
      kind: 'mutation',
      entity: 'task',
      entity_id: e.ids?.[0] ?? null,
      ids: e.ids || [],
      workspace_id: store.state.workspace?.id ?? null,
    });
  });

  for (const evt of ['projects:changed', 'labels:changed', 'views:changed']) {
    store.bus.on(evt, () =>
      post({ kind: 'mutation', entity: evt.split(':')[0], workspace_id: store.state.workspace?.id })
    );
  }

  store.bus.on('settings:changed', ({ key, value, remote }) => {
    if (!remote) post({ kind: 'settings', key, value });
  });

  store.bus.on('outbox:queued', () => {
    pending += 1;
    bus.emit('status', getStatus());
    scheduleDrain();
  });
}

let drainTimer = null;

function scheduleDrain() {
  clearTimeout(drainTimer);
  drainTimer = setTimeout(drain, 400);
}

export function init() {
  openChannel();
  wireStore();

  window.addEventListener('online', () => {
    setStatus(STATE.SYNCING);
    drain();
  });
  window.addEventListener('offline', () => setStatus(STATE.OFFLINE));

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      heartbeat();
      drain();
    }
  });

  // A tab that goes away should stop showing up in presence immediately.
  window.addEventListener('pagehide', () => post({ kind: 'presence', gone: true }));

  countPending().then(() => {
    bus.emit('status', getStatus());
    drain();
  });

  return { TAB_ID };
}
