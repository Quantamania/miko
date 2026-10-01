/* Import / export: CSV, JSON, ICS, and a full backup.
 *
 * Export is the escape hatch that makes the rest of the app safe to trust, so
 * it covers everything: tasks, projects, labels, comments, time entries and
 * the audit log. Import is deliberately forgiving about column names — people
 * arrive with files from Todoist, Asana, Notion and a spreadsheet they made.
 */

import * as db from '../core/db.js';
import * as store from '../core/store.js';
import {
  nowISO,
  toISO,
  dayKey,
  stripHTML,
  esc,
  id,
  parts,
} from '../core/util.js';

/* ================================= CSV ================================= */

export function toCSV(rows, columns) {
  const cols = columns || Object.keys(rows[0] || {});
  const cell = (v) => {
    if (v == null) return '';
    const s = Array.isArray(v) ? v.join('; ') : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = cols.map(cell).join(',');
  const body = rows.map((r) => cols.map((c) => cell(r[c])).join(',')).join('\r\n');
  return `${head}\r\n${body}`;
}

/** RFC 4180 parser — handles quoted fields, embedded commas and newlines,
 *  and doubled quotes. A naive split() breaks on the first description
 *  containing a comma, which is roughly every real export. */
export function fromCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text).replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const TASK_COLUMNS = [
  'id',
  'title',
  'description',
  'status',
  'priority',
  'project',
  'labels',
  'assignee',
  'due_at',
  'start_at',
  'estimate_min',
  'recurrence_rule',
  'parent_id',
  'blocked_by',
  'created_at',
  'completed_at',
];

export function exportTasksCSV(tasks = store.allTasks()) {
  const rows = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    description: stripHTML(t.description),
    status: t.status,
    priority: t.priority,
    project: store.projectById(t.project_id)?.name || '',
    labels: (t.labels || []).map((l) => store.labelById(l)?.name || l),
    assignee: store.memberById(t.assignee_id)?.user?.name || '',
    due_at: t.due_at || '',
    start_at: t.start_at || '',
    estimate_min: t.estimate_min ?? '',
    recurrence_rule: t.recurrence_rule || '',
    parent_id: t.parent_id || '',
    blocked_by: (t.blocked_by || []).join('; '),
    created_at: t.created_at,
    completed_at: t.completed_at || '',
  }));
  return toCSV(rows, TASK_COLUMNS);
}

/* Column aliases seen in the wild, normalised to our field names. */
const ALIASES = {
  title: ['title', 'name', 'task', 'task name', 'content', 'summary', 'subject'],
  description: ['description', 'notes', 'note', 'details', 'body', 'comment'],
  status: ['status', 'state', 'column'],
  priority: ['priority', 'importance', 'urgency'],
  project: ['project', 'project name', 'list', 'board', 'category', 'folder'],
  labels: ['labels', 'label', 'tags', 'tag'],
  assignee: ['assignee', 'assigned to', 'owner', 'responsible'],
  due_at: ['due_at', 'due', 'due date', 'deadline', 'date', 'due_date'],
  estimate_min: ['estimate_min', 'estimate', 'estimated time', 'effort'],
  completed_at: ['completed_at', 'completed', 'completed date', 'done date'],
  recurrence_rule: ['recurrence_rule', 'repeat', 'recurrence', 'rrule'],
  parent_id: ['parent_id', 'parent'],
};

function mapHeaders(header) {
  const map = {};
  header.forEach((raw, i) => {
    const h = String(raw).trim().toLowerCase();
    for (const [field, names] of Object.entries(ALIASES)) {
      if (names.includes(h)) {
        if (map[field] == null) map[field] = i;
        return;
      }
    }
  });
  return map;
}

const STATUS_ALIASES = {
  done: 'done', complete: 'done', completed: 'done', closed: 'done', finished: 'done',
  'in progress': 'in_progress', in_progress: 'in_progress', doing: 'in_progress',
  active: 'in_progress', started: 'in_progress',
  blocked: 'blocked', waiting: 'blocked', 'on hold': 'blocked',
};

const PRIORITY_ALIASES = {
  urgent: 'urgent', critical: 'urgent', highest: 'urgent', p1: 'urgent', '1': 'urgent',
  high: 'high', p2: 'high', '2': 'high',
  medium: 'medium', normal: 'medium', med: 'medium', p3: 'medium', '3': 'medium',
  low: 'low', lowest: 'low', p4: 'low', '4': 'low',
};

/** Parse a CSV into task patches without writing anything — lets the UI show
 *  a preview and a row count before the user commits. */
export function previewCSV(text) {
  const rows = fromCSV(text);
  if (rows.length < 2) {
    return { rows: [], errors: ['That file has no data rows.'], columns: [] };
  }
  const header = rows[0];
  const map = mapHeaders(header);
  const errors = [];
  if (map.title == null) {
    errors.push('No title column found. Expected one of: title, name, task, content.');
    return { rows: [], errors, columns: header };
  }

  const parsed = [];
  for (const row of rows.slice(1)) {
    const pick = (f) => (map[f] != null ? String(row[map[f]] ?? '').trim() : '');
    const title = pick('title');
    if (!title) continue;

    const statusRaw = pick('status').toLowerCase();
    const prioRaw = pick('priority').toLowerCase();
    const due = pick('due_at');
    const est = pick('estimate_min');

    parsed.push({
      title,
      description: pick('description'),
      status: STATUS_ALIASES[statusRaw] || (store.STATUSES.includes(statusRaw) ? statusRaw : 'todo'),
      priority: PRIORITY_ALIASES[prioRaw] || (store.PRIORITIES.includes(prioRaw) ? prioRaw : 'none'),
      projectName: pick('project'),
      labelNames: pick('labels')
        .split(/[;,|]/)
        .map((s) => s.trim())
        .filter(Boolean),
      assigneeName: pick('assignee'),
      due_at: due && !Number.isNaN(Date.parse(due)) ? toISO(due) : null,
      estimate_min: est ? parseInt(est, 10) || null : null,
      recurrence_rule: pick('recurrence_rule') || null,
      completed_at: pick('completed_at') ? toISO(pick('completed_at')) : null,
    });
  }

  return { rows: parsed, errors, columns: header };
}

/** Commit a parsed preview. Creates any missing projects and labels. */
export async function importTasks(parsed, { onProgress } = {}) {
  let created = 0;
  const projectCache = new Map(
    store.state.projects.map((p) => [p.name.toLowerCase(), p.id])
  );
  const labelCache = new Map(store.state.labels.map((l) => [l.name.toLowerCase(), l.id]));

  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i];
    let project_id = null;
    if (row.projectName) {
      const key = row.projectName.toLowerCase();
      if (!projectCache.has(key)) {
        const p = await store.createProject({ name: row.projectName });
        projectCache.set(key, p.id);
      }
      project_id = projectCache.get(key);
    }

    const labels = [];
    for (const name of row.labelNames || []) {
      const key = name.toLowerCase();
      if (!labelCache.has(key)) {
        const l = await store.createLabel(name);
        labelCache.set(key, l.id);
      }
      labels.push(labelCache.get(key));
    }

    const assignee = row.assigneeName
      ? store.state.members.find(
          (m) => m.user?.name?.toLowerCase() === row.assigneeName.toLowerCase()
        )
      : null;

    await store.createTask(
      {
        title: row.title,
        description: row.description ? `<p>${esc(row.description)}</p>` : '',
        status: row.status,
        priority: row.priority,
        project_id,
        labels,
        assignee_id: assignee?.user_id ?? store.state.user.id,
        due_at: row.due_at,
        estimate_min: row.estimate_min,
        recurrence_rule: row.recurrence_rule,
        completed_at: row.completed_at,
      },
      { silent: true }
    );
    created++;
    if (onProgress && i % 25 === 0) onProgress(i + 1, parsed.length);
  }

  store.bus.emit('tasks:changed', { type: 'import', ids: [] });
  await store.audit('data.imported', { payload: { count: created, format: 'csv' } });
  return created;
}

/* ================================= JSON ================================= */

const BACKUP_STORES = [
  'workspaces',
  'users',
  'members',
  'projects',
  'labels',
  'tasks',
  'comments',
  'saved_views',
  'templates',
  'automations',
  'reminders',
  'time_entries',
  'webhooks',
  'task_events',
];

export async function exportBackup({ includeEvents = true } = {}) {
  const data = {};
  for (const name of BACKUP_STORES) {
    if (!includeEvents && name === 'task_events') continue;
    data[name] = await db.getAll(name);
  }
  const meta = await db.getAll('meta');
  data.meta = meta.filter((m) => m.key.startsWith('setting:'));

  return {
    format: 'miko.backup',
    version: 1,
    exported_at: nowISO(),
    workspace: store.state.workspace?.name ?? null,
    counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])),
    data,
  };
}

/** Restore a backup. `mode: 'merge'` keeps existing rows and adds unknown ids;
 *  `mode: 'replace'` wipes the affected stores first. */
export async function importBackup(payload, { mode = 'merge' } = {}) {
  if (payload?.format !== 'miko.backup') {
    throw new Error('That file is not a MIKŌ backup.');
  }
  const data = payload.data || {};
  let written = 0;

  for (const [name, rows] of Object.entries(data)) {
    if (!Array.isArray(rows)) continue;
    if (name === 'meta') {
      for (const row of rows) await db.put('meta', row);
      continue;
    }
    if (!BACKUP_STORES.includes(name)) continue;

    if (mode === 'replace') await db.clear(name);

    await db.tx(name, 'readwrite', (t) => {
      const s = t.objectStore(name);
      for (const row of rows) s.put(row);
    });
    written += rows.length;
  }

  await store.audit('data.restored', { payload: { mode, written } });
  await store.reload();
  return written;
}

export function exportTasksJSON(tasks = store.allTasks()) {
  return {
    format: 'miko.tasks',
    version: 1,
    exported_at: nowISO(),
    projects: store.state.projects.map((p) => ({ id: p.id, name: p.name, color: p.color })),
    labels: store.state.labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
    tasks,
  };
}

export async function importTasksJSON(payload) {
  const list = Array.isArray(payload) ? payload : payload?.tasks;
  if (!Array.isArray(list)) throw new Error('No tasks found in that file.');

  const parsed = list.map((t) => ({
    title: t.title || t.name || 'Untitled',
    description: t.description || '',
    status: store.STATUSES.includes(t.status) ? t.status : 'todo',
    priority: store.PRIORITIES.includes(t.priority) ? t.priority : 'none',
    projectName:
      t.projectName ||
      payload?.projects?.find((p) => p.id === t.project_id)?.name ||
      '',
    labelNames: (t.labels || [])
      .map((l) => payload?.labels?.find((x) => x.id === l)?.name || (typeof l === 'string' ? l : ''))
      .filter(Boolean),
    assigneeName: '',
    due_at: t.due_at || null,
    estimate_min: t.estimate_min ?? null,
    recurrence_rule: t.recurrence_rule || null,
    completed_at: t.completed_at || null,
  }));

  return importTasks(parsed);
}

/* ================================== ICS ================================== */

function icsEscape(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function icsStamp(iso, allDay) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  if (allDay) {
    const k = dayKey(iso).replace(/-/g, '');
    return k;
  }
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

/** Fold to 75 octets per RFC 5545 — some calendar clients reject long lines. */
function fold(line) {
  if (line.length <= 73) return line;
  const out = [];
  let rest = line;
  out.push(rest.slice(0, 73));
  rest = rest.slice(73);
  while (rest.length) {
    out.push(' ' + rest.slice(0, 72));
    rest = rest.slice(72);
  }
  return out.join('\r\n');
}

/** Calendar export. Tasks with a due date become VEVENTs (so they show in any
 *  calendar app); recurrence rules carry through as RRULE. */
export function exportICS(tasks = store.allTasks()) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MIKO//Task Intelligence//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(store.state.workspace?.name || 'MIKŌ')}`,
  ];

  for (const t of tasks) {
    if (!t.due_at) continue;
    const allDay = !/T\d{2}:(?!00)/.test('') && !hasClock(t.due_at);
    const start = icsStamp(t.due_at, allDay);
    const dur = t.estimate_min || 30;

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${t.id}@miko`);
    lines.push(`DTSTAMP:${icsStamp(nowISO(), false)}`);
    if (allDay) {
      lines.push(`DTSTART;VALUE=DATE:${start}`);
    } else {
      lines.push(`DTSTART:${start}`);
      lines.push(
        `DTEND:${icsStamp(new Date(new Date(t.due_at).getTime() + dur * 60000).toISOString(), false)}`
      );
    }
    lines.push(fold(`SUMMARY:${icsEscape(t.title)}`));
    if (t.description) lines.push(fold(`DESCRIPTION:${icsEscape(stripHTML(t.description))}`));
    if (t.recurrence_rule) lines.push(`RRULE:${t.recurrence_rule}`);
    lines.push(`STATUS:${t.status === 'done' ? 'CONFIRMED' : 'TENTATIVE'}`);
    const project = store.projectById(t.project_id);
    if (project) lines.push(fold(`CATEGORIES:${icsEscape(project.name)}`));
    lines.push(`PRIORITY:${{ urgent: 1, high: 3, medium: 5, low: 7, none: 0 }[t.priority] ?? 0}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function hasClock(iso) {
  const p = parts(iso);
  return p.hh !== 0 || p.mm !== 0;
}

/* ============================== AUDIT LOG ============================== */

export async function exportAuditCSV() {
  const events = await db.byIndex('task_events', 'workspace_id', store.state.workspace.id);
  const rows = events
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    .map((e) => ({
      created_at: e.created_at,
      type: e.type,
      actor: store.memberById(e.actor_id)?.user?.name || e.actor_id || '',
      task_id: e.task_id || '',
      task_title: store.getTask(e.task_id)?.title || '',
      payload: JSON.stringify(e.payload || {}),
    }));
  return toCSV(rows, ['created_at', 'type', 'actor', 'task_id', 'task_title', 'payload']);
}

/* ============================== DOWNLOAD ============================== */

export function download(filename, content, mime = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function stamp() {
  return dayKey(new Date());
}

export function readFile(file, as = 'text') {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    if (as === 'dataURL') r.readAsDataURL(file);
    else r.readAsText(file);
  });
}

/** Pick a file without leaving a stray <input> in the DOM. */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept || '';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = () => {
      const f = input.files?.[0] || null;
      input.remove();
      resolve(f);
    };
    // No reliable "cancel" event across browsers; clean up on next focus.
    window.addEventListener(
      'focus',
      () => setTimeout(() => { if (input.isConnected && !input.files?.length) { input.remove(); resolve(null); } }, 400),
      { once: true }
    );
    input.click();
  });
}
