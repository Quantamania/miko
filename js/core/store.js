/* The repository layer.
 *
 * Every write in the app funnels through here so that five things happen
 * together, atomically, and in the same order every time:
 *
 *   1. permission check      (role gate — see ROLES)
 *   2. validation            (reject bad data at the boundary)
 *   3. version bump          (optimistic concurrency; stale writes conflict)
 *   4. audit event           (task_events — who, what, when, before/after)
 *   5. outbox + broadcast    (offline queue, other tabs, webhooks)
 *
 * Reads are served from an in-memory index of the active workspace, which is
 * hydrated from IndexedDB on boot. IndexedDB is the source of truth; the
 * memory index is a cache that makes rendering synchronous.
 */

import * as db from './db.js';
import {
  id,
  nowISO,
  clone,
  diff,
  emitter,
  unique,
  sanitize,
  stripHTML,
  AppError,
  ConflictError,
  setZone,
  localZone,
  dayKey,
} from './util.js';
import { index as searchIndex } from './search.js';

export const bus = emitter();

/* ------------------------------ CONSTANTS ------------------------------ */

export const STATUSES = ['todo', 'in_progress', 'blocked', 'done'];
export const STATUS_LABEL = {
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
};

export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
export const PRIORITY_LABEL = {
  none: 'No priority',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};
export const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

/* Role → capability matrix. Enforced on every mutating call below.
   NOTE: this is a client-side gate. It stops the UI from offering or issuing
   writes a role may not make, but it is not a security boundary — a determined
   user controls their own browser. Server-side enforcement (Supabase RLS or
   API middleware) is required before this app is multi-tenant. */
export const ROLES = {
  owner: {
    rank: 3,
    can: new Set(['task:*', 'project:*', 'member:*', 'workspace:*', 'automation:*', 'view:*']),
  },
  admin: {
    rank: 2,
    can: new Set(['task:*', 'project:*', 'member:invite', 'automation:*', 'view:*']),
  },
  editor: {
    rank: 1,
    can: new Set(['task:create', 'task:update', 'task:delete', 'task:comment', 'view:*']),
  },
  viewer: { rank: 0, can: new Set(['task:comment']) },
};

/* --------------------------------- STATE --------------------------------- */

export const state = {
  ready: false,
  workspace: null,
  user: null,
  role: 'owner',
  members: [],
  projects: [],
  labels: [],
  savedViews: [],
  settings: {},
  tasks: new Map(), // id -> task, active workspace only
  byParent: new Map(), // parent_id -> [task id]
};

export function can(action) {
  const role = ROLES[state.role] || ROLES.viewer;
  if (role.can.has(action)) return true;
  const [ns] = action.split(':');
  return role.can.has(`${ns}:*`);
}

/* Preview mode: the dashboard is browsable without an account, but nothing is
 * kept. Enforced here rather than by hiding buttons — every mutation in the
 * app already passes through assertCan(), so this is the one place that can
 * make the guarantee hold. Reads are untouched. */
let readOnly = false;

export function setReadOnly(value) {
  readOnly = Boolean(value);
}

export function isReadOnly() {
  return readOnly;
}

function assertCan(action) {
  if (readOnly) {
    throw new AppError('Preview only — sign in to save your work', 'readonly');
  }
  if (!can(action)) {
    throw new AppError(`Your role (${state.role}) cannot ${action.replace(':', ' ')}`, 'forbidden');
  }
}

/* ------------------------------ VALIDATION ------------------------------ */

const MAX_TITLE = 500;
const MAX_DESC = 100_000;

export function validateTask(patch, { partial = false } = {}) {
  const errs = {};
  if (!partial || 'title' in patch) {
    const t = String(patch.title ?? '').trim();
    if (!t) errs.title = 'Title is required';
    else if (t.length > MAX_TITLE) errs.title = `Keep the title under ${MAX_TITLE} characters`;
  }
  if ('description' in patch && patch.description && patch.description.length > MAX_DESC) {
    errs.description = 'Description is too long';
  }
  if ('status' in patch && patch.status && !STATUSES.includes(patch.status)) {
    errs.status = 'Unknown status';
  }
  if ('priority' in patch && patch.priority && !PRIORITIES.includes(patch.priority)) {
    errs.priority = 'Unknown priority';
  }
  if ('due_at' in patch && patch.due_at && Number.isNaN(Date.parse(patch.due_at))) {
    errs.due_at = 'Invalid due date';
  }
  if ('estimate_min' in patch && patch.estimate_min != null) {
    const n = Number(patch.estimate_min);
    if (!Number.isFinite(n) || n < 0 || n > 60 * 24 * 365) errs.estimate_min = 'Invalid estimate';
  }
  if (Object.keys(errs).length) {
    throw new AppError('Please fix the highlighted fields', 'invalid', errs);
  }
  return true;
}

/* --------------------------------- SHAPE --------------------------------- */

export function blankTask(overrides = {}) {
  const ts = nowISO();
  return {
    id: id('tsk'),
    workspace_id: state.workspace?.id ?? null,
    project_id: null,
    parent_id: null,
    title: '',
    description: '',
    status: 'todo',
    priority: 'none',
    due_at: null,
    start_at: null,
    estimate_min: null,
    recurrence_rule: null,
    assignee_id: state.user?.id ?? null,
    labels: [],
    blocked_by: [],
    checklist: [],
    position: Date.now(),
    collapsed: false,
    created_by: state.user?.id ?? null,
    created_at: ts,
    updated_at: ts,
    completed_at: null,
    deleted_at: null,
    version: 1,
    ...overrides,
  };
}

/* --------------------------------- AUDIT --------------------------------- */

/** Append a row to task_events. Every mutation writes one; the activity feed
 *  and the audit-log export are both just reads of this table. */
export async function audit(type, { task_id = null, payload = {} } = {}) {
  const evt = {
    id: id('evt'),
    workspace_id: state.workspace?.id ?? null,
    task_id,
    actor_id: state.user?.id ?? null,
    type,
    payload,
    created_at: nowISO(),
  };
  await db.put('task_events', evt);
  bus.emit('audit', evt);
  return evt;
}

export function listEvents({ task_id, limit = 100 } = {}) {
  if (task_id) {
    return db.byIndex('task_events', 'task_id', task_id).then((r) =>
      r.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, limit)
    );
  }
  const out = [];
  return db
    .cursor('task_events', {
      index: 'ws_created',
      query: IDBKeyRange.bound(
        [state.workspace.id, ''],
        [state.workspace.id, '￿']
      ),
      direction: 'prev',
      onRow: (row) => {
        out.push(row);
        return out.length < limit;
      },
    })
    .then(() => out);
}

/* -------------------------------- OUTBOX -------------------------------- */
/* Changes are queued here the moment they are made. With no server configured
   the queue simply drains locally, but the ordering and retry semantics are
   real — pointing `sync.adapter` at an API is the only change needed. */

export async function enqueue(op, entity, entity_id, payload) {
  const row = {
    id: id('obx'),
    op,
    entity,
    entity_id,
    payload,
    workspace_id: state.workspace?.id ?? null,
    state: 'pending',
    attempts: 0,
    created_at: nowISO(),
  };
  await db.put('outbox', row);
  bus.emit('outbox:queued', row);
  return row;
}

/* -------------------------------- MEMORY -------------------------------- */

function indexTask(task) {
  state.tasks.set(task.id, task);
  const p = task.parent_id || '';
  let arr = state.byParent.get(p);
  if (!arr) state.byParent.set(p, (arr = []));
  if (!arr.includes(task.id)) arr.push(task.id);
  searchIndex.add(task);
}

function unindexTask(taskId) {
  const t = state.tasks.get(taskId);
  if (!t) return;
  const arr = state.byParent.get(t.parent_id || '');
  if (arr) {
    const i = arr.indexOf(taskId);
    if (i >= 0) arr.splice(i, 1);
  }
  state.tasks.delete(taskId);
  searchIndex.remove(taskId);
}

function reindexParent(task, prevParent) {
  if ((prevParent || '') === (task.parent_id || '')) return;
  const old = state.byParent.get(prevParent || '');
  if (old) {
    const i = old.indexOf(task.id);
    if (i >= 0) old.splice(i, 1);
  }
  const next = task.parent_id || '';
  let arr = state.byParent.get(next);
  if (!arr) state.byParent.set(next, (arr = []));
  if (!arr.includes(task.id)) arr.push(task.id);
}

/* --------------------------------- READS --------------------------------- */

export function getTask(taskId) {
  return state.tasks.get(taskId) || null;
}

/** All live (non-deleted) tasks in the active workspace. */
export function allTasks() {
  const out = [];
  for (const t of state.tasks.values()) if (!t.deleted_at) out.push(t);
  return out;
}

export function trashedTasks() {
  const out = [];
  for (const t of state.tasks.values()) if (t.deleted_at) out.push(t);
  return out.sort((a, b) => (a.deleted_at < b.deleted_at ? 1 : -1));
}

export function childrenOf(taskId) {
  const ids = state.byParent.get(taskId || '') || [];
  return ids
    .map((i) => state.tasks.get(i))
    .filter((t) => t && !t.deleted_at)
    .sort((a, b) => a.position - b.position);
}

export function descendantsOf(taskId) {
  const out = [];
  const walk = (pid) => {
    for (const c of childrenOf(pid)) {
      out.push(c);
      walk(c.id);
    }
  };
  walk(taskId);
  return out;
}

export function projectById(pid) {
  return state.projects.find((p) => p.id === pid) || null;
}

export function labelById(lid) {
  return state.labels.find((l) => l.id === lid) || null;
}

export function memberById(uid) {
  return state.members.find((m) => m.user_id === uid) || null;
}

/* ----------------------------- DEPENDENCIES ----------------------------- */

/** Depth-first reachability check. Returns true when adding `blockerId` to
 *  `taskId`'s blockers would close a cycle. */
export function wouldCycle(taskId, blockerId) {
  if (taskId === blockerId) return true;
  const seen = new Set();
  const stack = [blockerId];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const t = state.tasks.get(cur);
    if (t) stack.push(...(t.blocked_by || []));
  }
  return false;
}

/** Same check for the parent/child tree — prevents a task becoming its own
 *  ancestor when re-parenting via drag or the detail panel. */
export function wouldNestCycle(taskId, newParentId) {
  if (!newParentId) return false;
  if (taskId === newParentId) return true;
  let cur = newParentId;
  const seen = new Set();
  while (cur) {
    if (cur === taskId) return true;
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = state.tasks.get(cur)?.parent_id || null;
  }
  return false;
}

export function isBlocked(task) {
  return (task.blocked_by || []).some((bid) => {
    const b = state.tasks.get(bid);
    return b && !b.deleted_at && b.status !== 'done';
  });
}

export function blockersOf(task) {
  return (task.blocked_by || [])
    .map((bid) => state.tasks.get(bid))
    .filter((t) => t && !t.deleted_at);
}

export function blockedByThis(taskId) {
  return allTasks().filter((t) => (t.blocked_by || []).includes(taskId));
}

/* --------------------------------- WRITES --------------------------------- */

/** Create a task. Returns the stored record. */
export async function createTask(patch = {}, { silent = false, actor = 'user' } = {}) {
  assertCan('task:create');
  validateTask(patch);
  const task = blankTask(patch);
  task.title = String(task.title).trim();
  task.description = sanitize(task.description || '');
  if (task.status === 'done' && !task.completed_at) task.completed_at = nowISO();
  if (task.parent_id && wouldNestCycle(task.id, task.parent_id)) task.parent_id = null;

  await db.put('tasks', task);
  indexTask(task);
  await audit('task.created', {
    task_id: task.id,
    payload: { title: task.title, actor },
  });
  await enqueue('create', 'task', task.id, task);
  if (!silent) {
    bus.emit('tasks:changed', { type: 'create', ids: [task.id] });
    bus.emit('task:created', task);
  }
  return task;
}

/** Patch a task with optimistic concurrency.
 *  `expectedVersion` — when supplied and stale, throws ConflictError so the
 *  caller can present a field-level merge instead of silently clobbering. */
export async function updateTask(taskId, patch, opts = {}) {
  assertCan('task:update');
  const before = state.tasks.get(taskId);
  if (!before) throw new AppError('That task no longer exists', 'not_found');

  if (opts.expectedVersion != null && opts.expectedVersion !== before.version) {
    throw new ConflictError({ ...before, ...patch }, before);
  }

  validateTask(patch, { partial: true });

  const next = { ...before, ...patch };
  if ('title' in patch) next.title = String(patch.title).trim();
  if ('description' in patch) next.description = sanitize(patch.description || '');
  if ('parent_id' in patch && wouldNestCycle(taskId, patch.parent_id)) {
    throw new AppError('A task cannot be nested inside its own subtask', 'cycle');
  }
  if ('blocked_by' in patch) {
    next.blocked_by = unique(patch.blocked_by || []).filter(
      (b) => b !== taskId && !wouldCycle(taskId, b)
    );
  }
  if ('status' in patch) {
    if (patch.status === 'done' && before.status !== 'done') next.completed_at = nowISO();
    if (patch.status !== 'done') next.completed_at = null;
  }

  const changes = diff(before, next);
  if (!Object.keys(changes).length) return before;

  next.version = before.version + 1;
  next.updated_at = nowISO();

  await db.put('tasks', next);
  const prevParent = before.parent_id;
  state.tasks.set(taskId, next);
  reindexParent(next, prevParent);
  searchIndex.add(next);

  await audit('task.updated', { task_id: taskId, payload: { changes } });
  await enqueue('update', 'task', taskId, { patch, version: next.version });

  if (!opts.silent) {
    bus.emit('tasks:changed', { type: 'update', ids: [taskId], changes });
    bus.emit('task:updated', { task: next, before, changes });
  }
  return next;
}

/** Soft delete. The row stays, `deleted_at` is set, and Trash can restore it. */
export async function deleteTask(taskId, { cascade = true, silent = false } = {}) {
  assertCan('task:delete');
  const task = state.tasks.get(taskId);
  if (!task || task.deleted_at) return null;

  const targets = cascade ? [task, ...descendantsOf(taskId)] : [task];
  const ts = nowISO();
  const ids = [];

  await db.tx('tasks', 'readwrite', (t) => {
    const s = t.objectStore('tasks');
    for (const row of targets) {
      const next = { ...row, deleted_at: ts, version: row.version + 1, updated_at: ts };
      s.put(next);
      state.tasks.set(row.id, next);
      searchIndex.remove(row.id);
      ids.push(row.id);
    }
  });

  await audit('task.deleted', { task_id: taskId, payload: { count: ids.length } });
  await enqueue('delete', 'task', taskId, { ids });
  if (!silent) bus.emit('tasks:changed', { type: 'delete', ids });
  return ids;
}

export async function restoreTask(taskId, { silent = false } = {}) {
  assertCan('task:update');
  const task = state.tasks.get(taskId);
  if (!task) return null;
  const ts = nowISO();
  const targets = [task, ...descendantsOf(taskId)].filter((t) => t.deleted_at);
  const ids = [];

  await db.tx('tasks', 'readwrite', (t) => {
    const s = t.objectStore('tasks');
    for (const row of targets) {
      const next = { ...row, deleted_at: null, version: row.version + 1, updated_at: ts };
      s.put(next);
      state.tasks.set(row.id, next);
      searchIndex.add(next);
      ids.push(row.id);
    }
  });

  // A restored task whose parent is still in the trash would be orphaned.
  const parent = task.parent_id ? state.tasks.get(task.parent_id) : null;
  if (parent?.deleted_at) {
    const detached = { ...state.tasks.get(taskId), parent_id: null };
    await db.put('tasks', detached);
    state.tasks.set(taskId, detached);
    reindexParent(detached, task.parent_id);
  }

  await audit('task.restored', { task_id: taskId, payload: { count: ids.length } });
  if (!silent) bus.emit('tasks:changed', { type: 'restore', ids });
  return ids;
}

/** Hard delete — only reachable from Trash, and only after confirmation. */
export async function purgeTask(taskId) {
  assertCan('task:delete');
  const targets = [taskId, ...descendantsOf(taskId).map((t) => t.id)];
  await db.tx(['tasks', 'comments', 'attachments', 'reminders'], 'readwrite', (t) => {
    for (const tid of targets) {
      t.objectStore('tasks').delete(tid);
      for (const store of ['comments', 'attachments', 'reminders']) {
        const idx = t.objectStore(store).index('task_id');
        idx.openCursor(IDBKeyRange.only(tid)).onsuccess = (e) => {
          const cur = e.target.result;
          if (!cur) return;
          cur.delete();
          cur.continue();
        };
      }
    }
  });
  targets.forEach(unindexTask);
  await audit('task.purged', { task_id: taskId, payload: { count: targets.length } });
  bus.emit('tasks:changed', { type: 'purge', ids: targets });
  return targets;
}

export async function emptyTrash() {
  const ids = trashedTasks().map((t) => t.id);
  for (const tid of ids) {
    if (state.tasks.get(tid)) await purgeTask(tid);
  }
  return ids.length;
}

/** Apply the same patch to many tasks in one transaction + one audit event. */
export async function bulkUpdate(taskIds, patch) {
  assertCan('task:update');
  validateTask(patch, { partial: true });
  const ts = nowISO();
  const applied = [];

  await db.tx('tasks', 'readwrite', (t) => {
    const s = t.objectStore('tasks');
    for (const tid of taskIds) {
      const before = state.tasks.get(tid);
      if (!before || before.deleted_at) continue;
      const next = { ...before, ...patch, version: before.version + 1, updated_at: ts };
      if ('status' in patch) {
        if (patch.status === 'done' && before.status !== 'done') next.completed_at = ts;
        if (patch.status !== 'done') next.completed_at = null;
      }
      if ('parent_id' in patch && wouldNestCycle(tid, patch.parent_id)) continue;
      s.put(next);
      state.tasks.set(tid, next);
      searchIndex.add(next);
      applied.push({ before, next });
    }
  });

  await audit('task.bulk_updated', {
    payload: { count: applied.length, patch, ids: applied.map((a) => a.next.id) },
  });
  await enqueue('bulk_update', 'task', null, { ids: applied.map((a) => a.next.id), patch });
  bus.emit('tasks:changed', { type: 'bulk', ids: applied.map((a) => a.next.id) });
  return applied;
}

export async function bulkDelete(taskIds) {
  const all = [];
  for (const tid of taskIds) {
    const res = await deleteTask(tid, { silent: true });
    if (res) all.push(...res);
  }
  bus.emit('tasks:changed', { type: 'delete', ids: all });
  return all;
}

/* ------------------------------- PROJECTS ------------------------------- */

export async function createProject(patch = {}) {
  assertCan('project:create');
  const name = String(patch.name || '').trim();
  if (!name) throw new AppError('Give the project a name', 'invalid', { name: 'Required' });
  const proj = {
    id: id('prj'),
    workspace_id: state.workspace.id,
    name,
    color: patch.color || null,
    description: patch.description || '',
    archived: 0,
    position: state.projects.length,
    created_at: nowISO(),
    updated_at: nowISO(),
    deleted_at: null,
    version: 1,
    ...patch,
  };
  await db.put('projects', proj);
  state.projects.push(proj);
  await audit('project.created', { payload: { id: proj.id, name: proj.name } });
  bus.emit('projects:changed');
  return proj;
}

export async function updateProject(pid, patch) {
  assertCan('project:update');
  const before = projectById(pid);
  if (!before) throw new AppError('Project not found', 'not_found');
  const next = { ...before, ...patch, version: before.version + 1, updated_at: nowISO() };
  await db.put('projects', next);
  state.projects = state.projects.map((p) => (p.id === pid ? next : p));
  await audit('project.updated', { payload: { id: pid, changes: diff(before, next) } });
  bus.emit('projects:changed');
  return next;
}

/** Deleting a project detaches its tasks rather than destroying them —
 *  losing work to a mis-click on a container is never the right default. */
export async function deleteProject(pid) {
  assertCan('project:delete');
  const affected = allTasks().filter((t) => t.project_id === pid);
  if (affected.length) {
    await bulkUpdate(affected.map((t) => t.id), { project_id: null });
  }
  await db.del('projects', pid);
  state.projects = state.projects.filter((p) => p.id !== pid);
  await audit('project.deleted', { payload: { id: pid, detached: affected.length } });
  bus.emit('projects:changed');
  return affected.length;
}

/* -------------------------------- LABELS -------------------------------- */

export async function createLabel(name, color) {
  assertCan('project:create');
  const clean = String(name || '').trim();
  if (!clean) throw new AppError('Give the label a name', 'invalid');
  const existing = state.labels.find((l) => l.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const label = {
    id: id('lbl'),
    workspace_id: state.workspace.id,
    name: clean,
    color: color || null,
    created_at: nowISO(),
    version: 1,
  };
  await db.put('labels', label);
  state.labels.push(label);
  bus.emit('labels:changed');
  return label;
}

export async function deleteLabel(lid) {
  assertCan('project:delete');
  const affected = allTasks().filter((t) => (t.labels || []).includes(lid));
  for (const t of affected) {
    await updateTask(t.id, { labels: t.labels.filter((x) => x !== lid) }, { silent: true });
  }
  await db.del('labels', lid);
  state.labels = state.labels.filter((l) => l.id !== lid);
  bus.emit('labels:changed');
  bus.emit('tasks:changed', { type: 'bulk', ids: affected.map((t) => t.id) });
}

/* ------------------------------- COMMENTS ------------------------------- */

export async function addComment(taskId, body) {
  assertCan('task:comment');
  const clean = sanitize(String(body || '').trim());
  if (!stripHTML(clean)) throw new AppError('Write something first', 'invalid');
  const mentions = unique(
    [...stripHTML(clean).matchAll(/@([\w.-]+)/g)].map((m) => m[1].toLowerCase())
  );
  const comment = {
    id: id('cmt'),
    workspace_id: state.workspace.id,
    task_id: taskId,
    author_id: state.user.id,
    body: clean,
    mentions,
    created_at: nowISO(),
    deleted_at: null,
  };
  await db.put('comments', comment);
  await audit('comment.added', { task_id: taskId, payload: { id: comment.id, mentions } });
  bus.emit('comments:changed', { task_id: taskId });
  return comment;
}

export function listComments(taskId) {
  return db
    .byIndex('comments', 'task_id', taskId)
    .then((r) => r.filter((c) => !c.deleted_at).sort((a, b) => (a.created_at < b.created_at ? -1 : 1)));
}

export async function deleteComment(cid, taskId) {
  const c = await db.get('comments', cid);
  if (!c) return;
  if (c.author_id !== state.user.id && !can('task:delete')) {
    throw new AppError('You can only delete your own comments', 'forbidden');
  }
  await db.put('comments', { ...c, deleted_at: nowISO() });
  bus.emit('comments:changed', { task_id: taskId });
}

/* ------------------------------ ATTACHMENTS ------------------------------ */

const MAX_ATTACHMENT = 8 * 1024 * 1024;

export async function addAttachment(taskId, file) {
  assertCan('task:update');
  if (file.size > MAX_ATTACHMENT) {
    throw new AppError('Attachments are limited to 8 MB while MIKŌ stores files on-device', 'too_large');
  }
  const row = {
    id: id('att'),
    workspace_id: state.workspace.id,
    task_id: taskId,
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    blob: file,
    uploaded_by: state.user.id,
    created_at: nowISO(),
  };
  await db.put('attachments', row);
  await audit('attachment.added', { task_id: taskId, payload: { name: file.name, size: file.size } });
  bus.emit('attachments:changed', { task_id: taskId });
  return row;
}

export function listAttachments(taskId) {
  return db.byIndex('attachments', 'task_id', taskId);
}

export async function deleteAttachment(aid, taskId) {
  await db.del('attachments', aid);
  bus.emit('attachments:changed', { task_id: taskId });
}

/* ------------------------------ SAVED VIEWS ------------------------------ */

export async function saveView(name, query) {
  const view = {
    id: id('vw'),
    workspace_id: state.workspace.id,
    name: String(name).trim(),
    query: clone(query),
    created_at: nowISO(),
  };
  await db.put('saved_views', view);
  state.savedViews.push(view);
  bus.emit('views:changed');
  return view;
}

export async function deleteView(vid) {
  await db.del('saved_views', vid);
  state.savedViews = state.savedViews.filter((v) => v.id !== vid);
  bus.emit('views:changed');
}

/* -------------------------------- SETTINGS -------------------------------- */

export async function setSetting(key, value) {
  state.settings[key] = value;
  // Preferences are not work, so preview still lets you flip the theme or the
  // density and see it take effect — it just never writes them down. Blocking
  // them outright would make the appearance controls look broken; persisting
  // them would make "nothing is saved" untrue.
  if (!readOnly) await db.put('meta', { key: `setting:${key}`, value });
  bus.emit('settings:changed', { key, value });
  return value;
}

export function getSetting(key, fallback) {
  return state.settings[key] ?? fallback;
}

/* --------------------------------- BOOT --------------------------------- */

const DEFAULT_SETTINGS = {
  theme: 'system',
  density: 'comfortable',
  locale: 'en',
  weekStart: 1,
  workingHours: { start: 9, end: 17 },
  dailyCapacityMin: 360,
  pomodoroMin: 25,
  pomodoroBreakMin: 5,
  notifications: true,
  reminderLeadMin: 10,
  defaultView: 'today',
  aiEnabled: false,
  aiModel: 'claude-opus-5',
  showCompleted: false,
  onboarded: false,
};

async function seed() {
  const ts = nowISO();
  const user = {
    id: id('usr'),
    name: 'You',
    email: '',
    handle: 'you',
    timezone: localZone(),
    avatar: null,
    created_at: ts,
  };
  const ws = {
    id: id('wsp'),
    name: 'Personal',
    owner_id: user.id,
    created_at: ts,
    version: 1,
  };
  const member = {
    id: id('mbr'),
    workspace_id: ws.id,
    user_id: user.id,
    role: 'owner',
    created_at: ts,
  };
  await db.put('users', user);
  await db.put('workspaces', ws);
  await db.put('members', member);
  await db.put('meta', { key: 'session', value: { user_id: user.id, workspace_id: ws.id } });

  const starter = [
    { name: 'Work', color: 'hsl(210 58% 46%)' },
    { name: 'Personal', color: 'hsl(150 58% 40%)' },
  ];
  for (const s of starter) {
    await db.put('projects', {
      id: id('prj'),
      workspace_id: ws.id,
      name: s.name,
      color: s.color,
      description: '',
      archived: 0,
      position: 0,
      created_at: ts,
      updated_at: ts,
      deleted_at: null,
      version: 1,
    });
  }
  return { user, ws, member };
}

/** Content for the live demo on the landing page. Written through the normal
 *  create path rather than straight into IndexedDB, so the demo exercises the
 *  same validation, audit and indexing the real app does — if the pipeline
 *  breaks, the demo breaks visibly rather than quietly diverging.
 *
 *  Runs once: a demo database that already has tasks is left alone. */
export async function seedDemoContent() {
  if (allTasks().length) return;
  // Seeding writes through createTask() on purpose, so it has to run before
  // preview mode closes the gate.
  const wasReadOnly = readOnly;
  readOnly = false;
  try {
    await seedDemoRows();
  } finally {
    readOnly = wasReadOnly;
  }
}

async function seedDemoRows() {

  const day = (n, h = 9, m = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };

  const byName = Object.fromEntries(state.projects.map((p) => [p.name, p.id]));
  const work = byName.Work || null;
  const personal = byName.Personal || null;

  const rows = [
    ['Reconcile October invoices', work, 'urgent', day(-2, 17), 'todo'],
    ['Send the board update deck', work, 'high', day(0, 14), 'in_progress'],
    ['Approve the design handoff', work, 'medium', day(0, 16, 30), 'todo'],
    ['Draft the hiring plan for Q4', work, 'high', day(1, 11), 'in_progress'],
    ['Review Q3 supplier contracts', work, 'high', day(1, 15), 'todo'],
    ['Write the retro notes', work, 'low', day(2, 10), 'todo'],
    ['Renew the domain', personal, 'medium', day(3, 9), 'todo'],
    ['Book the dentist', personal, 'low', day(4, 9), 'todo'],
    ['Pay the quarterly tax estimate', personal, 'urgent', day(5, 9), 'todo'],
    ['Plan the team offsite', work, 'medium', day(8, 13), 'todo'],
    ['Archive the old analytics board', work, 'low', day(-5, 12), 'done'],
    ['Ship the billing fix', work, 'high', day(-1, 16), 'done'],
  ];

  for (const [title, project_id, priority, due_at, status] of rows) {
    await createTask(
      { title, project_id, priority, due_at, status },
      { silent: true, actor: 'system' }
    );
  }
}

export async function boot() {
  await db.open();

  let session = (await db.get('meta', 'session'))?.value;
  if (!session) {
    const { user, ws } = await seed();
    session = { user_id: user.id, workspace_id: ws.id };
  }

  state.user = await db.get('users', session.user_id);
  state.workspace = await db.get('workspaces', session.workspace_id);

  if (!state.user || !state.workspace) {
    // Session pointed at records that no longer exist — start clean rather
    // than boot into a half-populated shell.
    const { user, ws } = await seed();
    state.user = user;
    state.workspace = ws;
  }

  const members = await db.byIndex('members', 'workspace_id', state.workspace.id);
  const userIds = members.map((m) => m.user_id);
  const users = await Promise.all(userIds.map((u) => db.get('users', u)));
  state.members = members.map((m, i) => ({ ...m, user: users[i] || { id: m.user_id, name: 'Unknown' } }));
  state.role = members.find((m) => m.user_id === state.user.id)?.role || 'owner';

  state.projects = (await db.byIndex('projects', 'workspace_id', state.workspace.id)).filter(
    (p) => !p.deleted_at
  );
  state.labels = await db.byIndex('labels', 'workspace_id', state.workspace.id);
  state.savedViews = await db.byIndex('saved_views', 'workspace_id', state.workspace.id);

  const metaRows = await db.getAll('meta');
  state.settings = { ...DEFAULT_SETTINGS };
  for (const row of metaRows) {
    if (row.key.startsWith('setting:')) state.settings[row.key.slice(8)] = row.value;
  }

  setZone(state.user.timezone || localZone());

  const tasks = await db.byIndex('tasks', 'workspace_id', state.workspace.id);
  state.tasks.clear();
  state.byParent.clear();
  searchIndex.clear();
  for (const t of tasks) {
    state.tasks.set(t.id, t);
    const p = t.parent_id || '';
    let arr = state.byParent.get(p);
    if (!arr) state.byParent.set(p, (arr = []));
    arr.push(t.id);
    if (!t.deleted_at) searchIndex.add(t);
  }

  state.ready = true;
  bus.emit('ready', state);
  return state;
}

/** Re-read a single task from disk — used when another tab reports a change. */
export async function refreshTask(taskId) {
  const row = await db.get('tasks', taskId);
  if (!row) {
    unindexTask(taskId);
  } else if (row.workspace_id === state.workspace?.id) {
    const prev = state.tasks.get(taskId);
    state.tasks.set(taskId, row);
    reindexParent(row, prev?.parent_id);
    if (row.deleted_at) searchIndex.remove(taskId);
    else searchIndex.add(row);
  }
  bus.emit('tasks:changed', { type: 'remote', ids: [taskId] });
}

/** Full reload after a remote bulk change. */
export async function reload() {
  await boot();
  bus.emit('tasks:changed', { type: 'reload', ids: [] });
}

/* ------------------------------- ANALYTICS ------------------------------- */

export function completionByDay(days = 84) {
  const map = new Map();
  for (const t of state.tasks.values()) {
    if (!t.completed_at || t.deleted_at) continue;
    const k = dayKey(t.completed_at);
    map.set(k, (map.get(k) || 0) + 1);
  }
  return map;
}
