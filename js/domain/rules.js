/* Automations, reminders, smart scheduling, and time tracking.
 *
 * These four share a heartbeat (one interval, not four) and all react to the
 * same store events, so they live together. Everything here runs on the
 * background path: it never pushes onto the undo stack, because a person did
 * not perform it.
 */

import * as db from '../core/db.js';
import * as store from '../core/store.js';
import {
  id,
  nowISO,
  toISO,
  dayKey,
  todayKey,
  keyToInstant,
  addDaysKey,
  parts,
  hasTime,
  emitter,
  clamp,
} from '../core/util.js';
import * as rrule from './recurrence.js';

export const bus = emitter();

/* ============================== AUTOMATIONS ============================== */

export const TRIGGERS = {
  'task.created': 'When a task is created',
  'task.completed': 'When a task is completed',
  'status.changed': 'When status changes',
  'priority.changed': 'When priority changes',
  'label.added': 'When a label is added',
  'task.assigned': 'When a task is assigned',
  'due.soon': 'When a task is due soon',
  'due.overdue': 'When a task becomes overdue',
};

export const ACTIONS = {
  set_status: 'Set status to',
  set_priority: 'Set priority to',
  add_label: 'Add label',
  remove_label: 'Remove label',
  assign: 'Assign to',
  move_project: 'Move to project',
  set_due: 'Set due date',
  create_followup: 'Create a follow-up task',
  notify: 'Send a notification',
  webhook: 'Call a webhook',
};

export function blankAutomation() {
  return {
    id: id('atm'),
    workspace_id: store.state.workspace?.id ?? null,
    name: 'New rule',
    enabled: true,
    trigger: 'status.changed',
    conditions: [], // [{ field, op, value }]
    actions: [], // [{ type, value }]
    runs: 0,
    last_run_at: null,
    created_at: nowISO(),
  };
}

export async function listAutomations() {
  if (!store.state.workspace) return [];
  return db.byIndex('automations', 'workspace_id', store.state.workspace.id);
}

export async function saveAutomation(rule) {
  store.can('automation:update') || store.can('automation:*');
  await db.put('automations', rule);
  await store.audit('automation.saved', { payload: { id: rule.id, name: rule.name } });
  bus.emit('automations:changed');
  return rule;
}

export async function deleteAutomation(rid) {
  await db.del('automations', rid);
  bus.emit('automations:changed');
}

function matches(cond, task) {
  const get = (f) => {
    if (f === 'label') return task.labels || [];
    return task[f];
  };
  const actual = get(cond.field);
  const expected = cond.value;
  switch (cond.op) {
    case 'is':
      return String(actual) === String(expected);
    case 'is_not':
      return String(actual) !== String(expected);
    case 'contains':
      return Array.isArray(actual)
        ? actual.includes(expected)
        : String(actual || '').toLowerCase().includes(String(expected).toLowerCase());
    case 'not_contains':
      return Array.isArray(actual)
        ? !actual.includes(expected)
        : !String(actual || '').toLowerCase().includes(String(expected).toLowerCase());
    case 'is_empty':
      return Array.isArray(actual) ? !actual.length : actual == null || actual === '';
    case 'is_set':
      return Array.isArray(actual) ? actual.length > 0 : actual != null && actual !== '';
    default:
      return true;
  }
}

/* Guard against a rule whose action re-fires its own trigger. Each task gets a
   small budget per event loop; exceeding it disables nothing but stops the
   cascade and reports it. */
const fireBudget = new Map();

function spend(taskId) {
  const n = (fireBudget.get(taskId) || 0) + 1;
  fireBudget.set(taskId, n);
  setTimeout(() => fireBudget.delete(taskId), 1500);
  return n <= 6;
}

export async function runAutomations(trigger, task, extra = {}) {
  if (!task || task.deleted_at) return;
  if (!spend(task.id)) {
    console.warn('[miko] automation cascade stopped for', task.id);
    return;
  }

  const rules = (await listAutomations()).filter((r) => r.enabled && r.trigger === trigger);
  if (!rules.length) return;

  for (const rule of rules) {
    const current = store.getTask(task.id) || task;
    if (!rule.conditions.every((c) => matches(c, current))) continue;

    const patch = {};
    const after = [];

    for (const action of rule.actions) {
      switch (action.type) {
        case 'set_status':
          patch.status = action.value;
          break;
        case 'set_priority':
          patch.priority = action.value;
          break;
        case 'add_label':
          patch.labels = [...new Set([...(current.labels || []), action.value])];
          break;
        case 'remove_label':
          patch.labels = (current.labels || []).filter((l) => l !== action.value);
          break;
        case 'assign':
          patch.assignee_id = action.value;
          break;
        case 'move_project':
          patch.project_id = action.value || null;
          break;
        case 'set_due':
          patch.due_at = keyToInstant(addDaysKey(todayKey(), parseInt(action.value, 10) || 0), 9, 0);
          break;
        case 'create_followup':
          after.push(() =>
            store.createTask({
              title: (action.value || 'Follow up: {title}').replace('{title}', current.title),
              project_id: current.project_id,
              assignee_id: current.assignee_id,
              priority: current.priority,
              due_at: keyToInstant(addDaysKey(todayKey(), 1), 9, 0),
            })
          );
          break;
        case 'notify':
          after.push(() =>
            notify(action.value || `Rule "${rule.name}" fired`, { body: current.title })
          );
          break;
        case 'webhook':
          after.push(() => fireWebhooks(trigger, current, { rule: rule.name }));
          break;
        default:
          break;
      }
    }

    if (Object.keys(patch).length) {
      await store.updateTask(task.id, patch, { silent: false });
    }
    for (const fn of after) {
      try {
        await fn();
      } catch (err) {
        console.warn('[miko] automation action failed', err);
      }
    }

    await db.put('automations', {
      ...rule,
      runs: (rule.runs || 0) + 1,
      last_run_at: nowISO(),
    });
    await store.audit('automation.fired', {
      task_id: task.id,
      payload: { rule: rule.name, trigger },
    });
    bus.emit('automation:fired', { rule, task: store.getTask(task.id), trigger });
  }
}

/* =============================== WEBHOOKS =============================== */
/* Outgoing only — a browser can call out, it just cannot receive. Deliveries
   are fire-and-forget with `keepalive` so they survive a tab close. */

export async function listWebhooks() {
  if (!store.state.workspace) return [];
  return db.byIndex('webhooks', 'workspace_id', store.state.workspace.id);
}

export async function saveWebhook(hook) {
  await db.put('webhooks', hook);
  bus.emit('webhooks:changed');
  return hook;
}

export async function deleteWebhook(hid) {
  await db.del('webhooks', hid);
  bus.emit('webhooks:changed');
}

export async function fireWebhooks(event, task, meta = {}) {
  const hooks = (await listWebhooks()).filter(
    (h) => h.enabled && (!h.events?.length || h.events.includes(event))
  );
  if (!hooks.length) return;

  const payload = {
    event,
    at: nowISO(),
    workspace: { id: store.state.workspace.id, name: store.state.workspace.name },
    actor: { id: store.state.user.id, name: store.state.user.name },
    task: task
      ? {
          id: task.id,
          title: task.title,
          status: task.status,
          priority: task.priority,
          due_at: task.due_at,
          project_id: task.project_id,
          assignee_id: task.assignee_id,
          url: `${location.origin}${location.pathname}#/task/${task.id}`,
        }
      : null,
    ...meta,
  };

  await Promise.allSettled(
    hooks.map((h) =>
      fetch(h.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(h.secret ? { 'x-miko-secret': h.secret } : {}),
        },
        body: JSON.stringify(payload),
        keepalive: true,
        mode: 'cors',
      }).catch((err) => {
        console.warn('[miko] webhook failed', h.url, err);
      })
    )
  );
}

/* =============================== REMINDERS =============================== */

export async function requestNotifications() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export async function notify(title, opts = {}) {
  bus.emit('notify', { title, ...opts });
  if (!store.getSetting('notifications', true)) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    // Prefer the service worker so notifications survive the tab closing.
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg?.showNotification) {
      await reg.showNotification(title, {
        badge: 'icons/badge.svg',
        icon: 'icons/icon-192.png',
        tag: opts.tag || 'miko',
        ...opts,
      });
      return;
    }
    new Notification(title, opts);
  } catch (err) {
    console.warn('[miko] notification failed', err);
  }
}

/** Create (or move) the reminder attached to a task's due date. */
export async function syncReminder(task) {
  const existing = (await db.byIndex('reminders', 'task_id', task.id)).filter(
    (r) => r.kind === 'due'
  );

  const shouldExist = task.due_at && task.status !== 'done' && !task.deleted_at;
  if (!shouldExist) {
    for (const r of existing) await db.del('reminders', r.id);
    return null;
  }

  const lead = Number(store.getSetting('reminderLeadMin', 10)) || 0;
  const fire = new Date(new Date(task.due_at).getTime() - lead * 60_000).toISOString();

  if (existing.length) {
    const row = { ...existing[0], fire_at: fire, state: 'pending', snooze_until: null };
    await db.put('reminders', row);
    for (const extra of existing.slice(1)) await db.del('reminders', extra.id);
    return row;
  }

  const row = {
    id: id('rmd'),
    workspace_id: task.workspace_id,
    task_id: task.id,
    kind: 'due',
    fire_at: fire,
    state: 'pending',
    snooze_until: null,
    created_at: nowISO(),
  };
  await db.put('reminders', row);
  return row;
}

export async function snooze(reminderId, minutes) {
  const r = await db.get('reminders', reminderId);
  if (!r) return null;
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  const row = { ...r, state: 'pending', snooze_until: until, fire_at: until };
  await db.put('reminders', row);
  bus.emit('reminders:changed');
  return row;
}

export async function dismissReminder(reminderId) {
  const r = await db.get('reminders', reminderId);
  if (!r) return;
  await db.put('reminders', { ...r, state: 'done', dismissed_at: nowISO() });
  bus.emit('reminders:changed');
}

async function checkReminders() {
  if (!store.state.ready) return;
  const now = nowISO();
  const due = (await db.byIndex('reminders', 'state', 'pending')).filter(
    (r) => r.fire_at && r.fire_at <= now
  );

  for (const r of due) {
    const task = store.getTask(r.task_id);
    if (!task || task.deleted_at || task.status === 'done') {
      await db.put('reminders', { ...r, state: 'done' });
      continue;
    }
    await db.put('reminders', { ...r, state: 'fired', fired_at: now });
    await notify(task.title, {
      body: task.due_at ? `Due ${new Date(task.due_at).toLocaleString()}` : 'Reminder',
      tag: `task-${task.id}`,
      data: { taskId: task.id },
      requireInteraction: false,
    });
    bus.emit('reminder:fired', { reminder: r, task });
  }
}

/** Watch for tasks crossing the due-soon / overdue thresholds. */
const announced = new Set();

async function checkDueTransitions() {
  if (!store.state.ready) return;
  const now = Date.now();
  const soonMs = 60 * 60 * 1000;

  for (const task of store.allTasks()) {
    if (!task.due_at || task.status === 'done') continue;
    const due = new Date(task.due_at).getTime();
    const overdueKey = `over:${task.id}`;
    const soonKey = `soon:${task.id}`;

    if (due < now && !announced.has(overdueKey)) {
      announced.add(overdueKey);
      announced.delete(soonKey);
      await runAutomations('due.overdue', task);
      await fireWebhooks('due.overdue', task);
    } else if (due >= now && due - now <= soonMs && !announced.has(soonKey)) {
      announced.add(soonKey);
      await runAutomations('due.soon', task);
    }
  }
}

/* ============================== RECURRENCE ============================== */

/** On completion of a recurring task, spawn the next instance and reset this
 *  one's series pointer. Generating on completion (rather than on a schedule)
 *  keeps an ignored weekly task from piling up. */
export async function rollRecurrence(task) {
  if (!task.recurrence_rule) return null;
  const from = task.due_at || task.completed_at || nowISO();
  const occurrences = task.series_count || 0;
  const nextDue = rrule.next(task.recurrence_rule, from, { occurrences });
  if (!nextDue) {
    await store.audit('task.series_ended', { task_id: task.id, payload: {} });
    return null;
  }

  const copy = await store.createTask({
    title: task.title,
    description: task.description,
    project_id: task.project_id,
    parent_id: task.parent_id,
    assignee_id: task.assignee_id,
    priority: task.priority,
    labels: [...(task.labels || [])],
    estimate_min: task.estimate_min,
    recurrence_rule: task.recurrence_rule,
    due_at: nextDue,
    series_id: task.series_id || task.id,
    series_count: occurrences + 1,
    checklist: (task.checklist || []).map((c) => ({ ...c, done: false })),
  });

  // The completed instance leaves the series so it doesn't roll twice.
  await store.updateTask(task.id, { recurrence_rule: null }, { silent: true });
  await syncReminder(copy);
  bus.emit('recurrence:rolled', { from: task, to: copy });
  return copy;
}

/* ============================== SCHEDULING ============================== */

/** Suggest when to do a set of tasks, given working hours, existing
 *  commitments, and a daily capacity. Greedy by (due date, priority) — the
 *  ordering a person would reach for, made explicit and repeatable. */
export function suggestSchedule(tasks, opts = {}) {
  const hours = store.getSetting('workingHours', { start: 9, end: 17 });
  const capacity = Number(store.getSetting('dailyCapacityMin', 360)) || 360;
  const horizon = opts.days ?? 14;
  const startKey = opts.from || todayKey();
  const defaultEstimate = 30;

  // Time already committed per day by tasks that have a due date.
  const load = new Map();
  for (const t of store.allTasks()) {
    if (t.status === 'done' || !t.due_at) continue;
    const k = dayKey(t.due_at);
    load.set(k, (load.get(k) || 0) + (t.estimate_min || defaultEstimate));
  }

  const queue = [...tasks].sort((a, b) => {
    const ad = a.due_at ? new Date(a.due_at).getTime() : Infinity;
    const bd = b.due_at ? new Date(b.due_at).getTime() : Infinity;
    if (ad !== bd) return ad - bd;
    return store.PRIORITY_RANK[a.priority] - store.PRIORITY_RANK[b.priority];
  });

  const plan = [];
  for (const task of queue) {
    const need = task.estimate_min || defaultEstimate;
    let placed = false;

    for (let d = 0; d < horizon; d++) {
      const key = addDaysKey(startKey, d);
      const dow = new Date(`${key}T00:00:00Z`).getUTCDay();
      if (opts.skipWeekends !== false && (dow === 0 || dow === 6)) continue;

      const used = load.get(key) || 0;
      if (used + need > capacity) continue;

      // Don't schedule a task after its own deadline.
      if (task.due_at && key > dayKey(task.due_at)) break;

      const startHour = hours.start + Math.floor(used / 60);
      if (startHour >= hours.end) continue;

      const at = keyToInstant(key, clamp(startHour, hours.start, hours.end - 1), (used % 60));
      plan.push({ task, at, key, minutes: need });
      load.set(key, used + need);
      placed = true;
      break;
    }

    if (!placed) plan.push({ task, at: null, key: null, minutes: need, reason: 'no capacity' });
  }
  return plan;
}

/** Tasks that will not fit before their due date at current capacity. */
export function atRisk() {
  const plan = suggestSchedule(
    store.allTasks().filter((t) => t.status !== 'done' && t.due_at)
  );
  return plan.filter((p) => !p.at || (p.task.due_at && p.key > dayKey(p.task.due_at)));
}

/* ============================ TIME TRACKING ============================ */

let running = null;
let tickHandle = null;

export function runningEntry() {
  return running;
}

export async function startTimer(taskId) {
  if (running) await stopTimer();
  running = {
    id: id('tme'),
    workspace_id: store.state.workspace.id,
    task_id: taskId,
    user_id: store.state.user.id,
    started_at: nowISO(),
    ended_at: null,
    seconds: 0,
  };
  await db.put('time_entries', running);
  await db.put('meta', { key: 'timer:running', value: running.id });
  bus.emit('timer:started', running);
  startTick();
  return running;
}

export async function stopTimer() {
  if (!running) return null;
  const secs = Math.round((Date.now() - new Date(running.started_at).getTime()) / 1000);
  const entry = { ...running, ended_at: nowISO(), seconds: secs };
  await db.put('time_entries', entry);
  await db.del('meta', 'timer:running');
  running = null;
  stopTick();
  await store.audit('time.logged', { task_id: entry.task_id, payload: { seconds: secs } });
  bus.emit('timer:stopped', entry);
  return entry;
}

function startTick() {
  stopTick();
  tickHandle = setInterval(() => {
    if (!running) return;
    bus.emit('timer:tick', {
      entry: running,
      seconds: Math.round((Date.now() - new Date(running.started_at).getTime()) / 1000),
    });
  }, 1000);
}

function stopTick() {
  clearInterval(tickHandle);
  tickHandle = null;
}

export async function timeForTask(taskId) {
  const rows = await db.byIndex('time_entries', 'task_id', taskId);
  const logged = rows.reduce((n, r) => n + (r.seconds || 0), 0);
  const live =
    running?.task_id === taskId
      ? Math.round((Date.now() - new Date(running.started_at).getTime()) / 1000)
      : 0;
  return { seconds: logged + live, entries: rows.length };
}

export async function allTimeEntries() {
  if (!store.state.workspace) return [];
  return db.byIndex('time_entries', 'workspace_id', store.state.workspace.id);
}

/* =============================== HEARTBEAT =============================== */

let heartbeatHandle = null;

async function heartbeat() {
  try {
    await checkReminders();
    await checkDueTransitions();
  } catch (err) {
    console.warn('[miko] heartbeat error', err);
  }
}

export async function init() {
  // Resume a timer that was running when the tab closed.
  const runningId = (await db.get('meta', 'timer:running'))?.value;
  if (runningId) {
    const entry = await db.get('time_entries', runningId);
    if (entry && !entry.ended_at) {
      running = entry;
      startTick();
      bus.emit('timer:started', entry);
    } else {
      await db.del('meta', 'timer:running');
    }
  }

  // React to store mutations: keep reminders in step and fire automations.
  store.bus.on('task:created', (task) => {
    syncReminder(task);
    runAutomations('task.created', task);
    fireWebhooks('task.created', task);
  });

  store.bus.on('task:updated', ({ task, before, changes }) => {
    if ('due_at' in changes || 'status' in changes) syncReminder(task);

    if (changes.status) {
      runAutomations('status.changed', task);
      if (task.status === 'done' && before.status !== 'done') {
        runAutomations('task.completed', task);
        fireWebhooks('task.completed', task);
        rollRecurrence(task);
      }
    }
    if (changes.priority) runAutomations('priority.changed', task);
    if (changes.assignee_id && task.assignee_id) runAutomations('task.assigned', task);
    if (changes.labels) {
      const added = (task.labels || []).filter((l) => !(before.labels || []).includes(l));
      if (added.length) runAutomations('label.added', task);
    }
  });

  clearInterval(heartbeatHandle);
  heartbeatHandle = setInterval(heartbeat, 30_000);
  heartbeat();

  // Backfill reminders for anything that predates this code path.
  for (const t of store.allTasks()) {
    if (t.due_at && t.status !== 'done') await syncReminder(t);
  }
}
