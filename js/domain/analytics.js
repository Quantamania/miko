/* Analytics: completion rate, cycle time, throughput, overdue trend, workload.
 *
 * All computed from the task table and task_events on demand. Nothing is
 * pre-aggregated, because at the scale a single workspace reaches in a browser
 * a full pass costs less than maintaining counters correctly.
 */

import * as store from '../core/store.js';
import * as db from '../core/db.js';
import {
  dayKey,
  todayKey,
  addDaysKey,
  diffDaysKey,
  startOfWeekKey,
  groupBy,
} from '../core/util.js';

const DAY_MS = 86_400_000;

export function range(days = 30, from = todayKey()) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(addDaysKey(from, -i));
  return out;
}

/** Headline numbers for the Insights view. */
export function summary({ days = 30 } = {}) {
  const tasks = store.allTasks();
  const keys = new Set(range(days));
  const prevKeys = new Set(range(days, addDaysKey(todayKey(), -days)));
  const today = todayKey();

  let created = 0;
  let completed = 0;
  let prevCompleted = 0;
  let open = 0;
  let overdue = 0;
  let dueToday = 0;
  let cycleTotal = 0;
  let cycleCount = 0;
  let estimated = 0;

  for (const t of tasks) {
    const cKey = dayKey(t.created_at);
    if (keys.has(cKey)) created++;

    if (t.completed_at) {
      const dKey = dayKey(t.completed_at);
      if (keys.has(dKey)) {
        completed++;
        const ms = new Date(t.completed_at) - new Date(t.created_at);
        if (ms >= 0) {
          cycleTotal += ms;
          cycleCount++;
        }
      } else if (prevKeys.has(dKey)) {
        prevCompleted++;
      }
    } else {
      open++;
      if (t.due_at) {
        const k = dayKey(t.due_at);
        if (k < today) overdue++;
        else if (k === today) dueToday++;
      }
      if (t.estimate_min) estimated += t.estimate_min;
    }
  }

  const total = completed + open;
  return {
    created,
    completed,
    open,
    overdue,
    dueToday,
    estimatedMin: estimated,
    completionRate: total ? Math.round((completed / total) * 100) : 0,
    avgCycleDays: cycleCount ? +(cycleTotal / cycleCount / DAY_MS).toFixed(1) : null,
    throughputPerWeek: +((completed / days) * 7).toFixed(1),
    completedDelta: prevCompleted ? Math.round(((completed - prevCompleted) / prevCompleted) * 100) : null,
  };
}

/** Created vs completed, bucketed by day. Feeds the bar chart. */
export function activitySeries(days = 14) {
  const keys = range(days);
  const createdBy = new Map();
  const doneBy = new Map();

  for (const t of store.allTasks()) {
    const c = dayKey(t.created_at);
    createdBy.set(c, (createdBy.get(c) || 0) + 1);
    if (t.completed_at) {
      const d = dayKey(t.completed_at);
      doneBy.set(d, (doneBy.get(d) || 0) + 1);
    }
  }

  return keys.map((k) => ({
    key: k,
    created: createdBy.get(k) || 0,
    completed: doneBy.get(k) || 0,
  }));
}

/** Contribution heatmap, GitHub style: completions per day over N weeks. */
export function heatmap(weeks = 16) {
  const end = todayKey();
  const startKey = startOfWeekKey(addDaysKey(end, -(weeks * 7 - 1)));
  const counts = store.completionByDay();
  const cells = [];
  const total = diffDaysKey(end, startKey) + 1;
  let max = 0;

  for (let i = 0; i < total; i++) {
    const key = addDaysKey(startKey, i);
    const n = counts.get(key) || 0;
    if (n > max) max = n;
    cells.push({ key, count: n });
  }

  for (const c of cells) {
    c.level = c.count === 0 ? 0 : Math.min(4, Math.ceil((c.count / Math.max(1, max)) * 4));
  }
  return { cells, max, weeks: Math.ceil(total / 7) };
}

/** Current streak of consecutive days with at least one completion. */
export function streak() {
  const counts = store.completionByDay();
  let current = 0;
  let key = todayKey();
  // Today not being done yet shouldn't break yesterday's streak.
  if (!counts.get(key)) key = addDaysKey(key, -1);
  while (counts.get(key)) {
    current++;
    key = addDaysKey(key, -1);
  }

  let best = 0;
  let run = 0;
  const sorted = [...counts.keys()].sort();
  let prev = null;
  for (const k of sorted) {
    run = prev && diffDaysKey(k, prev) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = k;
  }
  return { current, best };
}

/** Per-assignee load for the Workload view. */
export function workload({ days = 7 } = {}) {
  const capacityPerDay = Number(store.getSetting('dailyCapacityMin', 360)) || 360;
  const capacity = capacityPerDay * Math.min(days, 5); // working days only
  const horizon = addDaysKey(todayKey(), days);
  const byPerson = new Map();

  const ensure = (uid) => {
    if (!byPerson.has(uid)) {
      const member = store.memberById(uid);
      byPerson.set(uid, {
        user_id: uid,
        name: member?.user?.name || (uid ? 'Unknown' : 'Unassigned'),
        open: 0,
        overdue: 0,
        minutes: 0,
        tasks: [],
      });
    }
    return byPerson.get(uid);
  };

  // Always show every member, even at zero — an empty row is information.
  for (const m of store.state.members) ensure(m.user_id);
  ensure(null);

  const today = todayKey();
  for (const t of store.allTasks()) {
    if (t.status === 'done') continue;
    if (t.due_at && dayKey(t.due_at) > horizon) continue;
    const row = ensure(t.assignee_id || null);
    row.open++;
    row.minutes += t.estimate_min || 30;
    row.tasks.push(t);
    if (t.due_at && dayKey(t.due_at) < today) row.overdue++;
  }

  return [...byPerson.values()]
    .map((r) => ({
      ...r,
      capacity,
      pct: capacity ? Math.round((r.minutes / capacity) * 100) : 0,
      band: r.minutes > capacity ? 'over' : r.minutes > capacity * 0.8 ? 'near' : 'ok',
    }))
    .filter((r) => r.open > 0 || r.user_id)
    .sort((a, b) => b.minutes - a.minutes);
}

/** Estimate accuracy: logged time vs estimate, for tasks that have both. */
export async function estimateAccuracy() {
  const entries = await db.byIndex(
    'time_entries',
    'workspace_id',
    store.state.workspace.id
  );
  const byTask = groupBy(entries, (e) => e.task_id);
  const rows = [];

  for (const [taskId, list] of byTask) {
    const task = store.getTask(taskId);
    if (!task || !task.estimate_min) continue;
    const actualMin = list.reduce((n, e) => n + (e.seconds || 0), 0) / 60;
    if (actualMin < 1) continue;
    rows.push({
      task,
      estimate: task.estimate_min,
      actual: Math.round(actualMin),
      ratio: +(actualMin / task.estimate_min).toFixed(2),
    });
  }

  const avg = rows.length ? rows.reduce((n, r) => n + r.ratio, 0) / rows.length : null;
  return {
    rows: rows.sort((a, b) => Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1)),
    avgRatio: avg ? +avg.toFixed(2) : null,
    sample: rows.length,
  };
}

/** Time logged per day over the period. */
export async function timeSeries(days = 14) {
  const entries = await db.byIndex(
    'time_entries',
    'workspace_id',
    store.state.workspace.id
  );
  const byDay = new Map();
  for (const e of entries) {
    const k = dayKey(e.started_at);
    byDay.set(k, (byDay.get(k) || 0) + (e.seconds || 0) / 60);
  }
  return range(days).map((k) => ({ key: k, minutes: Math.round(byDay.get(k) || 0) }));
}

/** Per-project rollup for the Insights table. */
export function byProject() {
  const rows = store.state.projects.map((p) => ({
    project: p,
    open: 0,
    done: 0,
    overdue: 0,
    minutes: 0,
  }));
  const none = { project: null, open: 0, done: 0, overdue: 0, minutes: 0 };
  const index = new Map(rows.map((r) => [r.project.id, r]));
  const today = todayKey();

  for (const t of store.allTasks()) {
    const row = (t.project_id && index.get(t.project_id)) || none;
    if (t.status === 'done') row.done++;
    else {
      row.open++;
      row.minutes += t.estimate_min || 0;
      if (t.due_at && dayKey(t.due_at) < today) row.overdue++;
    }
  }

  return [...rows, none]
    .filter((r) => r.open || r.done)
    .map((r) => ({
      ...r,
      total: r.open + r.done,
      pct: r.open + r.done ? Math.round((r.done / (r.open + r.done)) * 100) : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

/** Burndown for a project: remaining open tasks per day over the period. */
export function burndown(projectId, days = 30) {
  const keys = range(days);
  const tasks = store
    .allTasks()
    .filter((t) => (projectId ? t.project_id === projectId : true));

  return keys.map((key) => {
    const end = `${key}T23:59:59.999Z`;
    let remaining = 0;
    for (const t of tasks) {
      if (t.created_at > end) continue;
      if (t.completed_at && t.completed_at <= end) continue;
      remaining++;
    }
    return { key, remaining };
  });
}

/** The daily-review payload: what happened yesterday, what is due now. */
export function dailyReview() {
  const today = todayKey();
  const yesterday = addDaysKey(today, -1);
  const tasks = store.allTasks();

  return {
    completedYesterday: tasks.filter((t) => t.completed_at && dayKey(t.completed_at) === yesterday),
    completedToday: tasks.filter((t) => t.completed_at && dayKey(t.completed_at) === today),
    dueToday: tasks.filter((t) => t.status !== 'done' && t.due_at && dayKey(t.due_at) === today),
    overdue: tasks
      .filter((t) => t.status !== 'done' && t.due_at && dayKey(t.due_at) < today)
      .sort((a, b) => (a.due_at < b.due_at ? -1 : 1)),
    blocked: tasks.filter((t) => t.status !== 'done' && store.isBlocked(t)),
    unscheduled: tasks.filter((t) => t.status !== 'done' && !t.due_at),
  };
}
