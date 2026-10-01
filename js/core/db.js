/* IndexedDB: schema, versioned migrations, and a small promise wrapper.
 *
 * Every user-facing table carries `workspace_id` (indexed), `version` for
 * optimistic concurrency, and `deleted_at` for soft deletes — the three things
 * the plan calls out as hard to retrofit. Migrations are ordered and additive;
 * each one is applied exactly once by the browser's upgrade transaction.
 */

/** `?demo=1` runs the whole application against a separate database. The
 *  landing page's demo is the real app in an iframe, and it must never be able
 *  to see — or write to — anyone's actual tasks. Same schema, same migrations,
 *  different name. */
const PARAMS = new URLSearchParams(location.search);

export const IS_DEMO = PARAMS.has('demo');

/** `?preview=1` is the dashboard without an account: the real app, browsable,
 *  on the throwaway database, with writes refused. See store.setReadOnly(). */
export const IS_PREVIEW = PARAMS.has('preview');

export const DB_NAME = IS_DEMO || IS_PREVIEW ? 'miko-demo' : 'miko';
export const DB_VERSION = 4;

/** Store definitions. `idx` entries become IndexedDB indexes verbatim, so the
 *  index list here *is* the query plan for the whole app. */
export const STORES = {
  workspaces: { key: 'id', idx: [] },
  users: { key: 'id', idx: [['email', 'email', { unique: false }]] },
  members: {
    key: 'id',
    idx: [
      ['workspace_id', 'workspace_id'],
      ['user_id', 'user_id'],
      ['ws_user', ['workspace_id', 'user_id'], { unique: true }],
    ],
  },
  projects: {
    key: 'id',
    idx: [
      ['workspace_id', 'workspace_id'],
      ['ws_archived', ['workspace_id', 'archived']],
    ],
  },
  labels: { key: 'id', idx: [['workspace_id', 'workspace_id']] },
  tasks: {
    key: 'id',
    idx: [
      ['workspace_id', 'workspace_id'],
      ['project_id', 'project_id'],
      ['assignee_id', 'assignee_id'],
      ['parent_id', 'parent_id'],
      ['status', 'status'],
      ['due_at', 'due_at'],
      ['updated_at', 'updated_at'],
      // Composite indexes matching the hot list queries.
      ['ws_status', ['workspace_id', 'status']],
      ['ws_due', ['workspace_id', 'due_at']],
      ['ws_project', ['workspace_id', 'project_id']],
      ['ws_assignee', ['workspace_id', 'assignee_id']],
      ['ws_updated', ['workspace_id', 'updated_at']],
    ],
  },
  task_events: {
    key: 'id',
    idx: [
      ['workspace_id', 'workspace_id'],
      ['task_id', 'task_id'],
      ['created_at', 'created_at'],
      ['ws_created', ['workspace_id', 'created_at']],
    ],
  },
  comments: {
    key: 'id',
    idx: [
      ['workspace_id', 'workspace_id'],
      ['task_id', 'task_id'],
    ],
  },
  attachments: {
    key: 'id',
    idx: [
      ['workspace_id', 'workspace_id'],
      ['task_id', 'task_id'],
    ],
  },
  saved_views: { key: 'id', idx: [['workspace_id', 'workspace_id']] },
  templates: { key: 'id', idx: [['workspace_id', 'workspace_id']] },
  automations: { key: 'id', idx: [['workspace_id', 'workspace_id']] },
  reminders: {
    key: 'id',
    idx: [
      ['workspace_id', 'workspace_id'],
      ['task_id', 'task_id'],
      ['fire_at', 'fire_at'],
      ['state', 'state'],
    ],
  },
  time_entries: {
    key: 'id',
    idx: [
      ['workspace_id', 'workspace_id'],
      ['task_id', 'task_id'],
      ['started_at', 'started_at'],
    ],
  },
  webhooks: { key: 'id', idx: [['workspace_id', 'workspace_id']] },
  outbox: {
    key: 'id',
    idx: [
      ['created_at', 'created_at'],
      ['state', 'state'],
    ],
  },
  meta: { key: 'key', idx: [] },

  /* The last version of a row that this device and the server agreed on.
     Three-way merge needs a common ancestor: without one, "did the local side
     change?" cannot be answered, every remote field wins, and concurrent local
     edits are silently discarded. */
  sync_base: { key: 'id', idx: [] },
};

/* Ordered migrations. Each runs inside the single upgrade transaction, so it
   gets a live `tx` and must not await anything outside it. */
const MIGRATIONS = [
  {
    v: 1,
    up(db) {
      for (const [name, def] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        db.createObjectStore(name, { keyPath: def.key });
      }
    },
  },
  {
    v: 2,
    up(db, tx) {
      // Indexes were split out from store creation so later versions can add
      // to them without recreating stores (which would drop data).
      for (const [name, def] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) continue;
        const store = tx.objectStore(name);
        for (const [idxName, path, opts] of def.idx) {
          if (!store.indexNames.contains(idxName)) {
            store.createIndex(idxName, path, opts || {});
          }
        }
      }
    },
  },
  {
    v: 3,
    up(db, tx) {
      // Backfill: give every task the fields later code assumes exist, so a
      // record written by v1 never reaches the UI missing a key.
      if (!db.objectStoreNames.contains('tasks')) return;
      const store = tx.objectStore('tasks');
      store.openCursor().onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) return;
        const t = cur.value;
        let touched = false;
        const defaults = {
          labels: [],
          blocked_by: [],
          checklist: [],
          version: 1,
          deleted_at: null,
          estimate_min: null,
          start_at: null,
          recurrence_rule: null,
          position: 0,
        };
        for (const [k, v] of Object.entries(defaults)) {
          if (t[k] === undefined) {
            t[k] = v;
            touched = true;
          }
        }
        if (touched) cur.update(t);
        cur.continue();
      };
    },
  },
  {
    v: 4,
    up(db) {
      // Added for sync: the merge base. Additive, so existing data is
      // untouched and a device that has never synced simply has none.
      if (!db.objectStoreNames.contains('sync_base')) {
        db.createObjectStore('sync_base', { keyPath: 'id' });
      }
    },
  },
];

let dbp = null;

export function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = (e) => {
      const db = req.result;
      const tx = req.transaction;
      const from = e.oldVersion || 0;
      for (const m of MIGRATIONS) {
        if (m.v > from) {
          try {
            m.up(db, tx);
          } catch (err) {
            console.error(`[miko] migration v${m.v} failed`, err);
            throw err;
          }
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        // Another tab is upgrading. Close so it isn't blocked.
        db.close();
        dbp = null;
        window.dispatchEvent(new CustomEvent('miko:db-stale'));
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () =>
      console.warn('[miko] database upgrade blocked by another open tab');
  });
  return dbp;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Run `fn(tx)` against one or more stores. The returned promise settles when
 *  the transaction commits, not when the last request resolves — so callers
 *  can trust that a resolved write is durable. */
export async function tx(names, mode, fn) {
  const db = await open();
  const list = Array.isArray(names) ? names : [names];
  return new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction(list, mode);
    } catch (err) {
      reject(err);
      return;
    }
    let result;
    let failed = null;
    t.oncomplete = () => (failed ? reject(failed) : resolve(result));
    t.onerror = () => reject(failed || t.error);
    t.onabort = () => reject(failed || t.error || new Error('transaction aborted'));
    Promise.resolve()
      .then(() => fn(t))
      .then((r) => {
        result = r;
      })
      .catch((err) => {
        failed = err;
        try {
          t.abort();
        } catch {
          /* already finished */
        }
      });
  });
}

/* ---- single-store conveniences ---- */

export function get(store, key) {
  return tx(store, 'readonly', (t) => wrap(t.objectStore(store).get(key)));
}

export function getAll(store, query, count) {
  return tx(store, 'readonly', (t) => wrap(t.objectStore(store).getAll(query, count)));
}

export function put(store, value) {
  return tx(store, 'readwrite', (t) => wrap(t.objectStore(store).put(value)));
}

export function putMany(store, values) {
  return tx(store, 'readwrite', (t) => {
    const s = t.objectStore(store);
    for (const v of values) s.put(v);
    return values.length;
  });
}

export function del(store, key) {
  return tx(store, 'readwrite', (t) => wrap(t.objectStore(store).delete(key)));
}

export function clear(store) {
  return tx(store, 'readwrite', (t) => wrap(t.objectStore(store).clear()));
}

export function count(store, indexName, query) {
  return tx(store, 'readonly', (t) => {
    const s = t.objectStore(store);
    const src = indexName ? s.index(indexName) : s;
    return wrap(src.count(query));
  });
}

/** Read every row on an index matching `query`. */
export function byIndex(store, indexName, query, count) {
  return tx(store, 'readonly', (t) =>
    wrap(t.objectStore(store).index(indexName).getAll(query, count))
  );
}

/** Cursor walk with an early exit — the basis of cursor pagination.
 *  `onRow` returning `false` stops the walk. */
export function cursor(store, { index, query, direction = 'next', onRow }) {
  return tx(store, 'readonly', (t) => {
    const s = t.objectStore(store);
    const src = index ? s.index(index) : s;
    return new Promise((resolve, reject) => {
      const req = src.openCursor(query, direction);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve();
        let keepGoing = true;
        try {
          keepGoing = onRow(cur.value, cur) !== false;
        } catch (err) {
          return reject(err);
        }
        if (keepGoing) cur.continue();
        else resolve();
      };
    });
  });
}

/** Delete the whole database. Backs the "delete my data" control in Settings. */
export async function destroy() {
  const db = await open().catch(() => null);
  if (db) db.close();
  dbp = null;
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // other tabs will close on versionchange
  });
}

/** Rough storage usage, for the Settings data panel. */
export async function usage() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage: used, quota } = await navigator.storage.estimate();
    return { used, quota, pct: quota ? Math.round((used / quota) * 100) : 0 };
  } catch {
    return null;
  }
}

/** Ask the browser not to evict us under storage pressure. */
export async function persist() {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
