/* Undo / redo.
 *
 * A bounded command stack. Each entry carries an `undo` and a `redo` thunk and
 * a human label, which is what the toast shows ("Undo — moved 3 tasks").
 * Recording is suppressed while a thunk runs, so an undo never pushes itself
 * back onto the stack.
 *
 * Entries store *inverse patches*, not snapshots, so undoing a bulk edit of
 * 200 tasks costs one transaction rather than 200 full records.
 */

import { emitter } from './util.js';
import * as store from './store.js';

export const bus = emitter();

const LIMIT = 100;
const undoStack = [];
const redoStack = [];
let suspended = false;

export function record(entry) {
  if (suspended) return;
  undoStack.push(entry);
  if (undoStack.length > LIMIT) undoStack.shift();
  redoStack.length = 0;
  bus.emit('changed', status());
}

export function status() {
  return {
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoLabel: undoStack[undoStack.length - 1]?.label || null,
    redoLabel: redoStack[redoStack.length - 1]?.label || null,
  };
}

async function run(fn) {
  suspended = true;
  try {
    return await fn();
  } finally {
    suspended = false;
  }
}

export async function undo() {
  const entry = undoStack.pop();
  if (!entry) return null;
  try {
    await run(entry.undo);
    redoStack.push(entry);
    bus.emit('changed', status());
    return entry;
  } catch (err) {
    // The world moved on (record purged, permission lost). Drop the entry
    // rather than leaving a command that can never succeed at the top.
    console.warn('[miko] undo failed', err);
    bus.emit('changed', status());
    throw err;
  }
}

export async function redo() {
  const entry = redoStack.pop();
  if (!entry) return null;
  try {
    await run(entry.redo);
    undoStack.push(entry);
    bus.emit('changed', status());
    return entry;
  } catch (err) {
    console.warn('[miko] redo failed', err);
    bus.emit('changed', status());
    throw err;
  }
}

export function clear() {
  undoStack.length = 0;
  redoStack.length = 0;
  bus.emit('changed', status());
}

/* ------------------------- recorded operations -------------------------
   Thin wrappers over the store that register the inverse as they go. UI code
   calls these instead of the raw store functions so that everything a person
   does by hand is undoable, while background work (sync, automations,
   recurrence) stays off the stack. */

export async function createTask(patch, label = 'Create task') {
  const task = await store.createTask(patch);
  record({
    label,
    undo: () => store.deleteTask(task.id),
    redo: () => store.restoreTask(task.id),
  });
  return task;
}

export async function updateTask(taskId, patch, label) {
  const before = store.getTask(taskId);
  if (!before) return null;
  const inverse = {};
  for (const k of Object.keys(patch)) inverse[k] = before[k];
  const next = await store.updateTask(taskId, patch);
  record({
    label: label || 'Edit task',
    undo: () => store.updateTask(taskId, inverse),
    redo: () => store.updateTask(taskId, patch),
  });
  return next;
}

export async function deleteTask(taskId, label = 'Delete task') {
  const ids = await store.deleteTask(taskId);
  if (!ids) return null;
  record({
    label,
    undo: () => store.restoreTask(taskId),
    redo: () => store.deleteTask(taskId),
  });
  return ids;
}

export async function bulkUpdate(taskIds, patch, label) {
  const applied = await store.bulkUpdate(taskIds, patch);
  if (!applied.length) return applied;
  // One inverse entry per task, replayed in a single transaction on undo.
  const inverse = applied.map(({ before }) => {
    const rev = {};
    for (const k of Object.keys(patch)) rev[k] = before[k];
    return { id: before.id, patch: rev };
  });
  record({
    label: label || `Update ${applied.length} tasks`,
    undo: async () => {
      for (const { id, patch: p } of inverse) {
        if (store.getTask(id)) await store.updateTask(id, p, { silent: true });
      }
      store.bus.emit('tasks:changed', { type: 'bulk', ids: inverse.map((i) => i.id) });
    },
    redo: () => store.bulkUpdate(taskIds, patch),
  });
  return applied;
}

export async function bulkDelete(taskIds, label) {
  const ids = await store.bulkDelete(taskIds);
  record({
    label: label || `Delete ${taskIds.length} tasks`,
    undo: async () => {
      for (const tid of taskIds) await store.restoreTask(tid, { silent: true });
      store.bus.emit('tasks:changed', { type: 'restore', ids: taskIds });
    },
    redo: () => store.bulkDelete(taskIds),
  });
  return ids;
}

export async function toggleDone(taskId) {
  const task = store.getTask(taskId);
  if (!task) return null;
  const to = task.status === 'done' ? 'todo' : 'done';
  return updateTask(taskId, { status: to }, to === 'done' ? 'Complete task' : 'Reopen task');
}
