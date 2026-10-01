/* Task rendering: the list row, the selection model, and the detail drawer. */

import * as store from '../core/store.js';
import * as history from '../core/history.js';
import * as rules from '../domain/rules.js';
import * as rrule from '../domain/recurrence.js';
import * as ai from '../domain/ai.js';
import {
  fmtDue,
  fmtDuration,
  fmtRelative,
  dayKey,
  todayKey,
  toISO,
  hasTime,
  stripHTML,
  initials,
  plural,
  esc,
  clockTime,
  hashColor,
  debounce,
} from '../core/util.js';
import { icon, STATUS_ICON } from './icons.js';
import {
  el,
  frag,
  clear,
  menu,
  modal,
  confirm,
  promptText,
  toast,
  autoGrow,
  mdBlock,
  announce,
  emptyState,
  copyText,
  $,
  $$,
} from './kit.js';

/* ============================== SELECTION ============================== */

export const selection = {
  ids: new Set(),
  anchor: null,

  has(id) {
    return this.ids.has(id);
  },
  get size() {
    return this.ids.size;
  },
  list() {
    return [...this.ids];
  },
  clear() {
    if (!this.ids.size) return;
    this.ids.clear();
    this.anchor = null;
    emit();
  },
  toggle(id) {
    if (this.ids.has(id)) this.ids.delete(id);
    else this.ids.add(id);
    this.anchor = id;
    emit();
  },
  set(ids) {
    this.ids = new Set(ids);
    emit();
  },
  add(ids) {
    for (const i of ids) this.ids.add(i);
    emit();
  },
  /** Shift-click range selection against the currently rendered order. */
  range(toId, ordered) {
    if (!this.anchor) return this.toggle(toId);
    const a = ordered.indexOf(this.anchor);
    const b = ordered.indexOf(toId);
    if (a < 0 || b < 0) return this.toggle(toId);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) this.ids.add(ordered[i]);
    emit();
  },
};

const listeners = new Set();

function emit() {
  for (const fn of listeners) fn(selection);
}

export function onSelectionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ============================== TASK ROW ============================== */

function projectChip(task) {
  const p = store.projectById(task.project_id);
  if (!p) return null;
  return el(
    'span',
    { title: `Project: ${p.name}` },
    el('span.chip-dot', { style: { background: p.color || hashColor(p.name) } }),
    el('span', { text: p.name })
  );
}

function dueChip(task) {
  if (!task.due_at) return null;
  const k = dayKey(task.due_at);
  const today = todayKey();
  const cls = task.status === 'done' ? '' : k < today ? 'overdue' : k === today ? 'due-today' : '';
  return el(
    `span${cls ? `.${cls}` : ''}`,
    { title: new Date(task.due_at).toLocaleString() },
    el('span', { html: icon('clock', { size: 11 }) }),
    el('span', { text: fmtDue(task.due_at) })
  );
}

function assigneeChip(task) {
  if (!task.assignee_id) return null;
  const m = store.memberById(task.assignee_id);
  if (!m) return null;
  // Only worth showing when more than one person can own things.
  if (store.state.members.length < 2) return null;
  return el(
    'span',
    { title: `Assigned to ${m.user?.name}` },
    el('span.avatar.sm', { text: initials(m.user?.name) })
  );
}

function labelChips(task) {
  const ids = task.labels || [];
  if (!ids.length) return null;
  const shown = ids.slice(0, 2);
  const out = shown.map((lid) => {
    const l = store.labelById(lid);
    if (!l) return null;
    return el(
      'span',
      { title: `Label: ${l.name}` },
      el('span.chip-dot', { style: { background: l.color || hashColor(l.name) } }),
      el('span', { text: l.name })
    );
  });
  if (ids.length > shown.length) out.push(el('span', { text: `+${ids.length - shown.length}` }));
  return frag(...out.filter(Boolean));
}

/**
 * Render one task row.
 * @param {object} task
 * @param {object} [opts] { depth, showProject, onOpen, orderedIds, collapsible }
 */
export function taskRow(task, opts = {}) {
  const depth = opts.depth || 0;
  const kids = store.childrenOf(task.id);
  const blocked = store.isBlocked(task);
  const doneKids = kids.filter((k) => k.status === 'done').length;
  const checklistDone = (task.checklist || []).filter((c) => c.done).length;

  const row = el('div.task', {
    'data-id': task.id,
    'data-status': task.status,
    'data-priority': task.priority,
    role: 'listitem',
    tabindex: '-1',
    'aria-selected': selection.has(task.id) ? 'true' : 'false',
  });

  if (selection.has(task.id)) row.classList.add('sel');
  if (depth) row.style.paddingLeft = `${depth * 20 + 8}px`;

  row.appendChild(el('span.task-prio', { 'aria-hidden': 'true' }));

  /* expand/collapse for subtasks */
  if (kids.length && opts.collapsible !== false) {
    row.appendChild(
      el('button.subtask-toggle', {
        type: 'button',
        'aria-expanded': String(!task.collapsed),
        'aria-label': task.collapsed ? 'Show subtasks' : 'Hide subtasks',
        html: icon('chevronDown'),
        onclick: (e) => {
          e.stopPropagation();
          store.updateTask(task.id, { collapsed: !task.collapsed });
        },
      })
    );
  } else if (depth) {
    row.appendChild(el('span.task-indent', { style: { width: '16px' } }));
  }

  /* completion */
  const done = task.status === 'done';
  row.appendChild(
    el('button.task-done', {
      type: 'button',
      role: 'checkbox',
      'aria-checked': String(done),
      'aria-label': done ? `Reopen ${task.title}` : `Complete ${task.title}`,
      html: icon('check'),
      onclick: async (e) => {
        e.stopPropagation();
        await history.toggleDone(task.id);
        announce(done ? 'Task reopened' : 'Task completed');
      },
    })
  );

  /* body */
  const meta = el('div.task-meta');
  const metaBits = [
    blocked
      ? el('span.blocked', { title: 'Blocked by another task' }, el('span', { html: icon('blocked', { size: 11 }) }), el('span', { text: 'Blocked' }))
      : null,
    opts.showProject === false ? null : projectChip(task),
    dueChip(task),
    task.recurrence_rule
      ? el('span', { title: rrule.describe(task.recurrence_rule) }, el('span', { html: icon('repeat', { size: 11 }) }))
      : null,
    task.estimate_min
      ? el('span', { title: 'Estimate' }, el('span', { html: icon('timer', { size: 11 }) }), el('span', { text: fmtDuration(task.estimate_min) }))
      : null,
    kids.length
      ? el('span', { title: 'Subtasks' }, el('span', { html: icon('subtask', { size: 11 }) }), el('span', { text: `${doneKids}/${kids.length}` }))
      : null,
    (task.checklist || []).length
      ? el('span', { title: 'Checklist' }, el('span', { html: icon('check', { size: 11 }) }), el('span', { text: `${checklistDone}/${task.checklist.length}` }))
      : null,
    labelChips(task),
    assigneeChip(task),
  ].filter(Boolean);

  for (const bit of metaBits) meta.appendChild(bit);

  const title = el('div.task-title', {
    text: task.title,
    title: task.title,
    onclick: (e) => {
      e.stopPropagation();
      opts.onOpen ? opts.onOpen(task.id) : openTask(task.id);
    },
  });

  row.appendChild(el('div.task-body', {}, el('div.task-line', {}, title), metaBits.length ? meta : null));

  /* actions */
  row.appendChild(
    el(
      'div.task-actions',
      {},
      el('button.icon-btn.sm', {
        type: 'button',
        'aria-label': `Open ${task.title}`,
        html: icon('panel'),
        onclick: (e) => {
          e.stopPropagation();
          openTask(task.id);
        },
      }),
      el('button.icon-btn.sm', {
        type: 'button',
        'aria-label': `More actions for ${task.title}`,
        'aria-haspopup': 'menu',
        html: icon('more'),
        onclick: (e) => {
          e.stopPropagation();
          rowMenu(e.currentTarget, task);
        },
      })
    )
  );

  /* selection interactions */
  row.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    if (e.shiftKey && opts.orderedIds) {
      e.preventDefault();
      selection.range(task.id, opts.orderedIds);
    } else if (e.metaKey || e.ctrlKey) {
      selection.toggle(task.id);
    } else if (selection.size) {
      selection.set([task.id]);
      selection.anchor = task.id;
    }
  });

  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!selection.has(task.id)) selection.set([task.id]);
    rowMenu({ x: e.clientX, y: e.clientY, getBoundingClientRect: () => new DOMRect(e.clientX, e.clientY, 0, 0) }, task);
  });

  row.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    inlineRename(title, task);
  });

  /* drag to reorder / re-parent / drop on a board column or calendar cell */
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    const ids = selection.has(task.id) && selection.size > 1 ? selection.list() : [task.id];
    e.dataTransfer.setData('text/miko-tasks', JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
    row.style.opacity = '0.4';
  });
  row.addEventListener('dragend', () => {
    row.style.opacity = '';
  });

  return row;
}

function inlineRename(titleEl, task) {
  const input = el('input.edit-inp.input', { type: 'text', value: task.title });
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = async (save) => {
    if (settled) return;
    settled = true;
    const value = input.value.trim();
    if (save && value && value !== task.title) {
      await history.updateTask(task.id, { title: value }, 'Rename task');
    } else {
      input.replaceWith(titleEl);
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

function rowMenu(anchor, task) {
  const ids = selection.size > 1 && selection.has(task.id) ? selection.list() : [task.id];
  const many = ids.length > 1;

  menu(anchor, [
    { label: many ? `${ids.length} tasks selected` : task.title, header: true },
    {
      label: task.status === 'done' ? 'Mark as not done' : 'Mark as done',
      icon: 'circleCheck',
      onClick: () =>
        many
          ? history.bulkUpdate(ids, { status: 'done' }, `Complete ${ids.length} tasks`)
          : history.toggleDone(task.id),
    },
    {
      label: 'Status',
      icon: 'circleDot',
      onClick: (e) => statusMenu(e.currentTarget || anchor, ids),
    },
    {
      label: 'Priority',
      icon: 'flag',
      onClick: (e) => priorityMenu(e.currentTarget || anchor, ids),
    },
    {
      label: 'Due date',
      icon: 'calendar',
      onClick: (e) => dueMenu(e.currentTarget || anchor, ids),
    },
    {
      label: 'Move to project',
      icon: 'project',
      onClick: (e) => projectMenu(e.currentTarget || anchor, ids),
    },
    store.state.members.length > 1
      ? { label: 'Assign', icon: 'user', onClick: (e) => assigneeMenu(e.currentTarget || anchor, ids) }
      : null,
    'separator',
    !many
      ? {
          label: 'Add subtask',
          icon: 'subtask',
          onClick: async () => {
            const title = await promptText({ title: 'New subtask', label: 'Title', confirmLabel: 'Add' });
            if (!title) return;
            await history.createTask(
              { title, parent_id: task.id, project_id: task.project_id },
              'Add subtask'
            );
          },
        }
      : null,
    !many
      ? {
          label: 'Duplicate',
          icon: 'copy',
          onClick: async () => {
            const copy = { ...task };
            delete copy.id;
            await history.createTask(
              { ...copy, title: `${task.title} (copy)`, status: 'todo', completed_at: null },
              'Duplicate task'
            );
          },
        }
      : null,
    !many
      ? {
          label: 'Copy link',
          icon: 'link',
          onClick: async () => {
            const ok = await copyText(`${location.origin}${location.pathname}#/task/${task.id}`);
            toast(ok ? 'Link copied' : 'Could not copy', { kind: ok ? 'success' : 'error' });
          },
        }
      : null,
    'separator',
    {
      label: many ? `Delete ${ids.length} tasks` : 'Delete',
      icon: 'trash',
      danger: true,
      kbd: '⌫',
      onClick: async () => {
        const result = many ? await history.bulkDelete(ids) : await history.deleteTask(task.id);
        selection.clear();
        toast(many ? `${ids.length} tasks moved to trash` : 'Moved to trash', {
          action: { label: 'Undo', onClick: () => history.undo() },
        });
        return result;
      },
    },
  ]);
}

/* ---------------------------- property menus ---------------------------- */

export function statusMenu(anchor, ids) {
  const current = ids.length === 1 ? store.getTask(ids[0])?.status : null;
  menu(
    anchor,
    store.STATUSES.map((s) => ({
      label: store.STATUS_LABEL[s],
      icon: STATUS_ICON[s],
      checked: current === s,
      onClick: () =>
        ids.length > 1
          ? history.bulkUpdate(ids, { status: s }, `Set status on ${ids.length} tasks`)
          : history.updateTask(ids[0], { status: s }, 'Change status'),
    }))
  );
}

export function priorityMenu(anchor, ids) {
  const current = ids.length === 1 ? store.getTask(ids[0])?.priority : null;
  menu(
    anchor,
    store.PRIORITIES.map((p) => ({
      label: store.PRIORITY_LABEL[p],
      color: p === 'none' ? 'transparent' : `var(--p-${p === 'medium' ? 'med' : p})`,
      checked: current === p,
      onClick: () =>
        ids.length > 1
          ? history.bulkUpdate(ids, { priority: p }, `Set priority on ${ids.length} tasks`)
          : history.updateTask(ids[0], { priority: p }, 'Change priority'),
    }))
  );
}

export function projectMenu(anchor, ids) {
  const current = ids.length === 1 ? store.getTask(ids[0])?.project_id : null;
  menu(anchor, [
    { label: 'No project', checked: current == null, onClick: () => setProject(ids, null) },
    'separator',
    ...store.state.projects.map((p) => ({
      label: p.name,
      color: p.color || hashColor(p.name),
      checked: current === p.id,
      onClick: () => setProject(ids, p.id),
    })),
  ]);
}

function setProject(ids, pid) {
  return ids.length > 1
    ? history.bulkUpdate(ids, { project_id: pid }, `Move ${ids.length} tasks`)
    : history.updateTask(ids[0], { project_id: pid }, 'Move task');
}

export function assigneeMenu(anchor, ids) {
  const current = ids.length === 1 ? store.getTask(ids[0])?.assignee_id : null;
  menu(anchor, [
    { label: 'Unassigned', checked: current == null, onClick: () => setAssignee(ids, null) },
    'separator',
    ...store.state.members.map((m) => ({
      label: m.user?.name || m.user_id,
      checked: current === m.user_id,
      onClick: () => setAssignee(ids, m.user_id),
    })),
  ]);
}

function setAssignee(ids, uid) {
  return ids.length > 1
    ? history.bulkUpdate(ids, { assignee_id: uid }, `Reassign ${ids.length} tasks`)
    : history.updateTask(ids[0], { assignee_id: uid }, 'Reassign task');
}

export function dueMenu(anchor, ids) {
  const at = (key, h = 9) =>
    key ? new Date(`${key}T${String(h).padStart(2, '0')}:00:00`).toISOString() : null;
  const addDays = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return dayKey(d.toISOString());
  };
  const set = (iso) =>
    ids.length > 1
      ? history.bulkUpdate(ids, { due_at: iso }, `Set due date on ${ids.length} tasks`)
      : history.updateTask(ids[0], { due_at: iso }, 'Set due date');

  menu(anchor, [
    { label: 'Today', icon: 'today', onClick: () => set(at(todayKey())) },
    { label: 'Tomorrow', icon: 'arrowRight', onClick: () => set(at(addDays(1))) },
    { label: 'Next week', icon: 'upcoming', onClick: () => set(at(addDays(7))) },
    'separator',
    {
      label: 'Pick a date…',
      icon: 'calendar',
      onClick: async () => {
        const current = ids.length === 1 ? store.getTask(ids[0])?.due_at : null;
        const picked = await datePicker(current);
        if (picked !== undefined) set(picked);
      },
    },
    { label: 'No due date', icon: 'x', onClick: () => set(null) },
  ]);
}

/** Date + optional time picker, returns ISO | null, or undefined on cancel. */
export function datePicker(currentISO) {
  return new Promise((resolve) => {
    let settled = false;
    const dateInput = el('input.input', {
      type: 'date',
      value: currentISO ? dayKey(currentISO) : todayKey(),
      autofocus: true,
    });
    const timeInput = el('input.input', {
      type: 'time',
      value: currentISO && hasTime(currentISO) ? new Date(currentISO).toTimeString().slice(0, 5) : '',
    });

    const m = modal({
      title: 'Due date',
      size: 'sm',
      body: frag(
        el('label.field', {}, el('span', { text: 'Date' }), dateInput),
        el('label.field', {}, el('span', { text: 'Time (optional)' }), timeInput),
        el('div.hint', { text: 'Leave the time blank for an all-day task.' })
      ),
      foot: frag(
        el('button.btn.btn-quiet', {
          type: 'button',
          text: 'Clear',
          onclick: () => {
            settled = true;
            resolve(null);
            m.close();
          },
        }),
        el('div.spacer'),
        el('button.btn', { type: 'button', text: 'Cancel', onclick: () => m.close() }),
        el('button.btn.btn-primary', {
          type: 'button',
          text: 'Set',
          onclick: () => {
            if (!dateInput.value) return;
            settled = true;
            const time = timeInput.value || '00:00';
            resolve(new Date(`${dateInput.value}T${time}:00`).toISOString());
            m.close();
          },
        })
      ),
      onClose: () => {
        if (!settled) resolve(undefined);
      },
    });
  });
}

/* ============================ DETAIL DRAWER ============================ */

let drawer = null;
let drawerTaskId = null;

export function openTask(taskId) {
  const task = store.getTask(taskId);
  if (!task) {
    toast('That task no longer exists', { kind: 'warn' });
    return;
  }
  if (drawer) closeTask();
  drawerTaskId = taskId;
  drawer = buildDrawer(task);
  document.body.appendChild(drawer);
  requestAnimationFrame(() => drawer.classList.add('on'));
  location.hash = `#/task/${taskId}`;
}

export function closeTask() {
  if (!drawer) return;
  const node = drawer;
  drawer = null;
  drawerTaskId = null;
  node.classList.remove('on');
  setTimeout(() => node.remove(), 220);
  // `history` here is the undo module, not window.history — be explicit.
  if (location.hash.startsWith('#/task/')) {
    if (window.history.length > 1) window.history.back();
    else location.hash = '';
  }
}

export function isOpen(taskId) {
  return drawerTaskId === taskId;
}

export function refreshDrawer() {
  if (!drawerTaskId) return;
  const task = store.getTask(drawerTaskId);
  if (!task || task.deleted_at) return closeTask();
  const next = buildDrawer(task);
  next.classList.add('on');
  drawer.replaceWith(next);
  drawer = next;
}

function propRow(labelText, iconName, valueNode) {
  return frag(
    el('div.prop-label', {}, el('span', { html: icon(iconName, { size: 13 }) }), el('span', { text: labelText })),
    el('div.prop-value', {}, valueNode)
  );
}

function propButton(text, iconName, onClick, isEmpty) {
  return el(
    `button.prop-btn${isEmpty ? '.empty' : ''}`,
    { type: 'button', onclick: onClick },
    iconName ? el('span', { html: icon(iconName, { size: 13 }) }) : null,
    el('span.truncate', { text })
  );
}

function buildDrawer(task) {
  const node = el('aside.drawer', {
    role: 'dialog',
    'aria-label': `Task: ${task.title}`,
    tabindex: '-1',
  });

  /* ---- head ---- */
  node.appendChild(
    el(
      'div.drawer-head',
      {},
      el('button.icon-btn', {
        type: 'button',
        'aria-label': 'Close',
        html: icon('chevronRight'),
        onclick: closeTask,
      }),
      el('div.spacer'),
      el('button.icon-btn', {
        type: 'button',
        'aria-label': 'Start timer',
        title: 'Start timer',
        html: icon(rules.runningEntry()?.task_id === task.id ? 'pause' : 'play'),
        onclick: async () => {
          const running = rules.runningEntry();
          if (running?.task_id === task.id) {
            await rules.stopTimer();
            toast('Timer stopped');
          } else {
            await rules.startTimer(task.id);
            toast(`Tracking "${task.title}"`);
          }
          refreshDrawer();
        },
      }),
      el('button.icon-btn', {
        type: 'button',
        'aria-label': 'More actions',
        'aria-haspopup': 'menu',
        html: icon('more'),
        onclick: (e) => rowMenu(e.currentTarget, task),
      })
    )
  );

  const body = el('div.drawer-body');
  node.appendChild(body);

  /* ---- title ---- */
  const titleEl = el('textarea.drawer-title', {
    rows: 1,
    'aria-label': 'Task title',
    spellcheck: 'true',
  });
  titleEl.value = task.title;
  autoGrow(titleEl, 200);

  const saveTitle = debounce(() => {
    const v = titleEl.value.trim();
    if (v && v !== store.getTask(task.id)?.title) {
      store.updateTask(task.id, { title: v });
    }
  }, 500);

  titleEl.addEventListener('input', saveTitle);
  titleEl.addEventListener('blur', () => saveTitle.flush());
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      titleEl.blur();
    }
  });
  body.appendChild(titleEl);

  /* ---- done toggle + breadcrumb ---- */
  const parent = task.parent_id ? store.getTask(task.parent_id) : null;
  body.appendChild(
    el(
      'div.row-wrap',
      {},
      el(
        'button.btn',
        {
          type: 'button',
          onclick: async () => {
            await history.toggleDone(task.id);
            refreshDrawer();
          },
        },
        el('span', { html: icon(task.status === 'done' ? 'restore' : 'check') }),
        el('span', { text: task.status === 'done' ? 'Reopen' : 'Mark done' })
      ),
      parent
        ? el(
            'button.chip',
            {
              type: 'button',
              title: 'Open parent task',
              onclick: () => openTask(parent.id),
            },
            el('span', { html: icon('subtask', { size: 12 }) }),
            el('span.truncate', { text: parent.title })
          )
        : null,
      rules.runningEntry()?.task_id === task.id
        ? el('span.badge.badge-accent', { text: 'Tracking' })
        : null
    )
  );

  /* ---- properties ---- */
  const props = el('div.props');

  props.appendChild(
    propRow(
      'Status',
      STATUS_ICON[task.status],
      propButton(store.STATUS_LABEL[task.status], null, (e) => statusMenu(e.currentTarget, [task.id]))
    )
  );
  props.appendChild(
    propRow(
      'Priority',
      'flag',
      propButton(
        store.PRIORITY_LABEL[task.priority],
        null,
        (e) => priorityMenu(e.currentTarget, [task.id]),
        task.priority === 'none'
      )
    )
  );
  props.appendChild(
    propRow(
      'Project',
      'project',
      propButton(
        store.projectById(task.project_id)?.name || 'No project',
        null,
        (e) => projectMenu(e.currentTarget, [task.id]),
        !task.project_id
      )
    )
  );
  if (store.state.members.length > 1) {
    props.appendChild(
      propRow(
        'Assignee',
        'user',
        propButton(
          store.memberById(task.assignee_id)?.user?.name || 'Unassigned',
          null,
          (e) => assigneeMenu(e.currentTarget, [task.id]),
          !task.assignee_id
        )
      )
    );
  }
  props.appendChild(
    propRow(
      'Due',
      'calendar',
      propButton(
        task.due_at ? fmtDue(task.due_at) : 'No due date',
        null,
        (e) => dueMenu(e.currentTarget, [task.id]),
        !task.due_at
      )
    )
  );
  props.appendChild(
    propRow(
      'Estimate',
      'timer',
      propButton(
        task.estimate_min ? fmtDuration(task.estimate_min) : 'No estimate',
        null,
        async () => {
          const v = await promptText({
            title: 'Estimate',
            label: 'Minutes (or e.g. 90)',
            value: task.estimate_min ? String(task.estimate_min) : '',
            confirmLabel: 'Save',
          });
          if (v == null) return;
          const n = parseInt(v, 10);
          await store.updateTask(task.id, { estimate_min: Number.isFinite(n) && n > 0 ? n : null });
          refreshDrawer();
        },
        !task.estimate_min
      )
    )
  );
  props.appendChild(
    propRow(
      'Repeat',
      'repeat',
      propButton(
        task.recurrence_rule ? rrule.describe(task.recurrence_rule) : 'Does not repeat',
        null,
        (e) =>
          menu(e.currentTarget, [
            {
              label: 'Does not repeat',
              checked: !task.recurrence_rule,
              onClick: async () => {
                await store.updateTask(task.id, { recurrence_rule: null });
                refreshDrawer();
              },
            },
            'separator',
            ...rrule.PRESETS.map((preset) => ({
              label: preset.label,
              checked: task.recurrence_rule === preset.rule,
              onClick: async () => {
                await store.updateTask(task.id, { recurrence_rule: preset.rule });
                refreshDrawer();
              },
            })),
          ]),
        !task.recurrence_rule
      )
    )
  );

  /* labels */
  const labelBox = el('div.row-wrap');
  for (const lid of task.labels || []) {
    const l = store.labelById(lid);
    if (!l) continue;
    labelBox.appendChild(
      el(
        'span.chip',
        {},
        el('span.chip-dot', { style: { background: l.color || hashColor(l.name) } }),
        el('span.truncate', { text: l.name }),
        el('button.chip-x', {
          type: 'button',
          'aria-label': `Remove label ${l.name}`,
          html: icon('x'),
          onclick: async () => {
            await store.updateTask(task.id, { labels: task.labels.filter((x) => x !== lid) });
            refreshDrawer();
          },
        })
      )
    );
  }
  labelBox.appendChild(
    el(
      'button.chip',
      {
        type: 'button',
        onclick: (e) =>
          menu(e.currentTarget, [
            ...store.state.labels
              .filter((l) => !(task.labels || []).includes(l.id))
              .map((l) => ({
                label: l.name,
                color: l.color || hashColor(l.name),
                onClick: async () => {
                  await store.updateTask(task.id, { labels: [...(task.labels || []), l.id] });
                  refreshDrawer();
                },
              })),
            store.state.labels.length ? 'separator' : null,
            {
              label: 'New label…',
              icon: 'plus',
              onClick: async () => {
                const name = await promptText({ title: 'New label', label: 'Name', confirmLabel: 'Create' });
                if (!name) return;
                const l = await store.createLabel(name);
                await store.updateTask(task.id, { labels: [...(task.labels || []), l.id] });
                refreshDrawer();
              },
            },
          ]),
      },
      el('span', { html: icon('plus', { size: 12 }) }),
      el('span', { text: (task.labels || []).length ? 'Add' : 'Add label' })
    )
  );
  props.appendChild(propRow('Labels', 'label', labelBox));

  /* dependencies */
  const blockers = store.blockersOf(task);
  const depBox = el('div.col');
  for (const b of blockers) {
    depBox.appendChild(
      el(
        'div.row',
        {},
        el('span', {
          html: icon(b.status === 'done' ? 'circleCheck' : 'circle', { size: 12 }),
          class: b.status === 'done' ? 'c-ok' : 'c-warn',
        }),
        el('button.prop-btn', {
          type: 'button',
          text: b.title,
          style: { flex: '1' },
          onclick: () => openTask(b.id),
        }),
        el('button.icon-btn.sm', {
          type: 'button',
          'aria-label': 'Remove dependency',
          html: icon('x'),
          onclick: async () => {
            await store.updateTask(task.id, {
              blocked_by: task.blocked_by.filter((x) => x !== b.id),
            });
            refreshDrawer();
          },
        })
      )
    );
  }
  depBox.appendChild(
    propButton('Add blocker', 'plus', () => pickBlocker(task), true)
  );
  props.appendChild(propRow('Blocked by', 'blocked', depBox));

  body.appendChild(props);

  /* ---- description ---- */
  body.appendChild(richTextSection(task));

  /* ---- checklist ---- */
  body.appendChild(checklistSection(task));

  /* ---- subtasks ---- */
  body.appendChild(subtaskSection(task));

  /* ---- attachments ---- */
  const attachSection = el('div.section');
  attachSection.appendChild(
    el('div.section-head', {}, el('div.t-eyebrow', { text: 'Attachments' }), el('div.spacer'),
      el('button.btn.btn-sm', {
        type: 'button',
        html: `${icon('attach', { size: 13 })}<span>Attach</span>`,
        onclick: async () => {
          const { pickFile } = await import('../domain/io.js');
          const file = await pickFile();
          if (!file) return;
          try {
            await store.addAttachment(task.id, file);
            refreshDrawer();
          } catch (err) {
            toast(err.message, { kind: 'error' });
          }
        },
      })
    )
  );
  const attachList = el('div.col');
  attachSection.appendChild(attachList);
  store.listAttachments(task.id).then((rows) => {
    if (!rows.length) {
      attachList.appendChild(el('div.hint', { text: 'Nothing attached.' }));
      return;
    }
    for (const a of rows) {
      attachList.appendChild(
        el(
          'div.attach',
          {},
          el('span', { html: icon('attach') }),
          el('button', {
            type: 'button',
            class: 'truncate',
            text: a.name,
            style: { flex: '1', textAlign: 'left' },
            onclick: () => {
              const url = URL.createObjectURL(a.blob);
              window.open(url, '_blank', 'noopener');
              setTimeout(() => URL.revokeObjectURL(url), 30_000);
            },
          }),
          el('span.faint', { text: `${Math.round(a.size / 1024)} KB` }),
          el('button.icon-btn.sm', {
            type: 'button',
            'aria-label': `Remove ${a.name}`,
            html: icon('x'),
            onclick: async () => {
              await store.deleteAttachment(a.id, task.id);
              refreshDrawer();
            },
          })
        )
      );
    }
  });
  body.appendChild(attachSection);

  /* ---- comments + activity ---- */
  body.appendChild(commentSection(task));
  body.appendChild(activitySection(task));

  node.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('.menu')) {
      e.stopPropagation();
      closeTask();
    }
  });

  return node;
}

function append(props, labelText, iconName, node) {
  props.appendChild(propRow(labelText, iconName, node));
  return props;
}

/* ---- description editor ---- */

function richTextSection(task) {
  const section = el('div.section');
  const editor = el('div.rte', {
    contenteditable: 'true',
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-label': 'Description',
    'data-placeholder': 'Add more detail…',
  });
  editor.innerHTML = task.description || '';

  const cmd = (command, value) => {
    editor.focus();
    document.execCommand(command, false, value);
    save();
  };

  const save = debounce(() => {
    const html = editor.innerHTML;
    if (html !== (store.getTask(task.id)?.description || '')) {
      store.updateTask(task.id, { description: html });
    }
  }, 700);

  editor.addEventListener('input', save);
  editor.addEventListener('blur', () => save.flush());
  editor.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      cmd('bold');
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      cmd('italic');
    }
  });
  // Paste as plain text so foreign markup never enters the document.
  editor.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  const tool = (name, label, command, value) =>
    el('button.icon-btn.sm', {
      type: 'button',
      'aria-label': label,
      title: label,
      html: icon(name),
      onmousedown: (e) => e.preventDefault(),
      onclick: () => cmd(command, value),
    });

  section.appendChild(el('div.section-head', {}, el('div.t-eyebrow', { text: 'Description' })));
  section.appendChild(
    el(
      'div.rte-bar',
      {},
      el('button.icon-btn.sm', {
        type: 'button',
        'aria-label': 'Bold',
        title: 'Bold',
        html: '<b style="font-size:12px">B</b>',
        onmousedown: (e) => e.preventDefault(),
        onclick: () => cmd('bold'),
      }),
      el('button.icon-btn.sm', {
        type: 'button',
        'aria-label': 'Italic',
        title: 'Italic',
        html: '<i style="font-size:12px">I</i>',
        onmousedown: (e) => e.preventDefault(),
        onclick: () => cmd('italic'),
      }),
      tool('list', 'Bulleted list', 'insertUnorderedList'),
      tool('sort', 'Numbered list', 'insertOrderedList'),
      tool('link', 'Add link', 'createLink', undefined)
    )
  );
  section.appendChild(editor);

  // Wire the link tool to ask for a URL rather than using the browser prompt.
  section.querySelector('[aria-label="Add link"]').onclick = async () => {
    const url = await promptText({ title: 'Link', label: 'URL', placeholder: 'https://', confirmLabel: 'Add' });
    if (url) cmd('createLink', url);
  };

  return section;
}

/* ---- checklist ---- */

function checklistSection(task) {
  const section = el('div.section');
  const items = task.checklist || [];
  const doneCount = items.filter((i) => i.done).length;

  section.appendChild(
    el(
      'div.section-head',
      {},
      el('div.t-eyebrow', { text: 'Checklist' }),
      items.length ? el('span.faint', { text: `${doneCount}/${items.length}` }) : null
    )
  );

  const write = (next) => store.updateTask(task.id, { checklist: next });

  for (const [i, item] of items.entries()) {
    const input = el('input', { type: 'text', value: item.text, 'aria-label': 'Checklist item' });
    input.addEventListener('change', () => {
      const next = [...items];
      next[i] = { ...item, text: input.value };
      write(next);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
      if (e.key === 'Backspace' && !input.value) {
        e.preventDefault();
        write(items.filter((_, j) => j !== i)).then(refreshDrawer);
      }
    });

    section.appendChild(
      el(
        `div.checklist-item${item.done ? '.done' : ''}`,
        {},
        el('button.check', {
          type: 'button',
          role: 'checkbox',
          'aria-checked': String(!!item.done),
          'aria-label': item.text,
          html: icon('check'),
          onclick: async () => {
            const next = [...items];
            next[i] = { ...item, done: !item.done };
            await write(next);
            refreshDrawer();
          },
        }),
        input,
        el('button.icon-btn.sm', {
          type: 'button',
          'aria-label': 'Remove item',
          html: icon('x'),
          onclick: async () => {
            await write(items.filter((_, j) => j !== i));
            refreshDrawer();
          },
        })
      )
    );
  }

  const adder = el('input.input', { type: 'text', placeholder: 'Add an item…', 'aria-label': 'New checklist item' });
  adder.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const v = adder.value.trim();
    if (!v) return;
    adder.value = '';
    await write([...items, { id: `c${Date.now()}`, text: v, done: false }]);
    refreshDrawer();
    setTimeout(() => $('.drawer input[placeholder="Add an item…"]')?.focus(), 30);
  });
  section.appendChild(adder);

  return section;
}

/* ---- subtasks ---- */

function subtaskSection(task) {
  const section = el('div.section');
  const kids = store.childrenOf(task.id);

  section.appendChild(
    el(
      'div.section-head',
      {},
      el('div.t-eyebrow', { text: 'Subtasks' }),
      kids.length ? el('span.faint', { text: `${kids.filter((k) => k.status === 'done').length}/${kids.length}` }) : null,
      el('div.spacer'),
      el('button.btn.btn-sm', {
        type: 'button',
        html: `${icon('sparkle', { size: 13 })}<span>Break down</span>`,
        title: 'Suggest subtasks',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = 'Thinking…';
          try {
            const { steps, engine } = await ai.breakdown(task);
            await suggestSubtasks(task, steps, engine);
          } catch (err) {
            toast(err.message, { kind: 'error' });
          } finally {
            refreshDrawer();
          }
        },
      })
    )
  );

  for (const kid of kids) {
    section.appendChild(taskRow(kid, { depth: 0, collapsible: false, showProject: false }));
  }

  const adder = el('input.input', { type: 'text', placeholder: 'Add a subtask…', 'aria-label': 'New subtask' });
  adder.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const v = adder.value.trim();
    if (!v) return;
    adder.value = '';
    await history.createTask({ title: v, parent_id: task.id, project_id: task.project_id }, 'Add subtask');
    refreshDrawer();
    setTimeout(() => $('.drawer input[placeholder="Add a subtask…"]')?.focus(), 30);
  });
  section.appendChild(adder);

  return section;
}

async function suggestSubtasks(task, steps, engine) {
  const checks = steps.map((s, i) =>
    el(
      'label.checklist-item',
      {},
      el('input', { type: 'checkbox', checked: true, 'data-i': String(i) }),
      el('span', { text: s, style: { flex: '1' } })
    )
  );

  return new Promise((resolve) => {
    const m = modal({
      title: 'Suggested subtasks',
      body: frag(
        el('div.hint', {
          text:
            engine === 'claude'
              ? 'Generated by Claude from this task. Untick anything you do not want.'
              : 'Suggested from the shape of this task. Untick anything you do not want.',
        }),
        ...checks
      ),
      foot: frag(
        el('div.spacer'),
        el('button.btn', { type: 'button', text: 'Cancel', onclick: () => m.close() }),
        el('button.btn.btn-primary', {
          type: 'button',
          text: 'Add selected',
          onclick: async () => {
            const chosen = checks
              .filter((c) => c.querySelector('input').checked)
              .map((c) => c.querySelector('span').textContent);
            m.close();
            for (const title of chosen) {
              await store.createTask({ title, parent_id: task.id, project_id: task.project_id });
            }
            if (chosen.length) toast(`Added ${plural(chosen.length, 'subtask')}`, { kind: 'success' });
            resolve(chosen);
          },
        })
      ),
      onClose: () => resolve([]),
    });
  });
}

/* ---- blocker picker ---- */

async function pickBlocker(task) {
  const candidates = store
    .allTasks()
    .filter((t) => t.id !== task.id && !(task.blocked_by || []).includes(t.id) && t.status !== 'done');

  const input = el('input.input', { type: 'text', placeholder: 'Search tasks…', autofocus: true });
  const list = el('div.col', { style: { maxHeight: '320px', overflowY: 'auto' } });

  const render = (query) => {
    clear(list);
    const q = query.trim().toLowerCase();
    const rows = (q ? candidates.filter((t) => t.title.toLowerCase().includes(q)) : candidates).slice(0, 40);
    if (!rows.length) {
      list.appendChild(el('div.hint', { text: 'No matching tasks.' }));
      return;
    }
    for (const t of rows) {
      const cycles = store.wouldCycle(task.id, t.id);
      list.appendChild(
        el(
          'button.menu-item',
          {
            type: 'button',
            disabled: cycles || null,
            title: cycles ? 'That would create a circular dependency' : '',
            onclick: async () => {
              await store.updateTask(task.id, {
                blocked_by: [...(task.blocked_by || []), t.id],
              });
              m.close();
              refreshDrawer();
            },
          },
          el('span', { html: icon(STATUS_ICON[t.status], { size: 13 }) }),
          el('span.truncate', { text: t.title }),
          cycles ? el('span.badge.badge-warn', { text: 'cycle' }) : null
        )
      );
    }
  };

  input.addEventListener('input', () => render(input.value));
  const m = modal({
    title: 'Blocked by',
    body: frag(
      input,
      el('div.hint', { text: 'Tasks that must finish before this one can start.' }),
      list
    ),
  });
  render('');
}

/* ---- comments ---- */

function commentSection(task) {
  const section = el('div.section');
  section.appendChild(el('div.section-head', {}, el('div.t-eyebrow', { text: 'Comments' })));

  const feed = el('div.feed');
  section.appendChild(feed);

  store.listComments(task.id).then((rows) => {
    if (!rows.length) {
      feed.appendChild(el('div.hint', { text: 'No comments yet.' }));
      return;
    }
    for (const c of rows) {
      const author = store.memberById(c.author_id)?.user;
      feed.appendChild(
        el(
          'div.feed-item',
          {},
          el('span.avatar.sm', { text: initials(author?.name || '?') }),
          el(
            'div',
            {},
            el(
              'div.row',
              {},
              el('span.t-sub', { text: author?.name || 'Someone' }),
              el('span.feed-when', { text: fmtRelative(c.created_at) }),
              el('div.spacer'),
              c.author_id === store.state.user.id
                ? el('button.icon-btn.sm', {
                    type: 'button',
                    'aria-label': 'Delete comment',
                    html: icon('trash'),
                    onclick: async () => {
                      await store.deleteComment(c.id, task.id);
                      refreshDrawer();
                    },
                  })
                : null
            ),
            el('div.feed-note', { html: linkMentions(c.body) })
          )
        )
      );
    }
  });

  const input = el('textarea.asst-input', {
    placeholder: 'Write a comment… use @ to mention',
    rows: 1,
    'aria-label': 'New comment',
  });
  autoGrow(input, 140);

  const send = async () => {
    const v = input.value.trim();
    if (!v) return;
    input.value = '';
    try {
      await store.addComment(task.id, `<p>${esc(v)}</p>`);
      refreshDrawer();
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  section.appendChild(
    el(
      'div.row',
      { style: { alignItems: 'flex-end', marginTop: '8px' } },
      input,
      el('button.icon-btn', {
        type: 'button',
        'aria-label': 'Post comment',
        html: icon('arrowUp'),
        onclick: send,
      })
    )
  );

  return section;
}

function linkMentions(html) {
  return String(html).replace(/@([\w.-]+)/g, (m, handle) => {
    const member = store.state.members.find(
      (x) => x.user?.handle === handle || x.user?.name?.toLowerCase().startsWith(handle.toLowerCase())
    );
    return member ? `<span class="mention">@${esc(member.user.name)}</span>` : m;
  });
}

/* ---- activity ---- */

const EVENT_TEXT = {
  'task.created': 'created this task',
  'task.updated': 'made a change',
  'task.deleted': 'moved this to trash',
  'task.restored': 'restored this from trash',
  'comment.added': 'commented',
  'attachment.added': 'attached a file',
  'automation.fired': 'automation ran',
  'time.logged': 'logged time',
  'task.series_ended': 'ended the repeating series',
};

const FIELD_NAME = {
  status: 'status',
  priority: 'priority',
  due_at: 'due date',
  project_id: 'project',
  assignee_id: 'assignee',
  title: 'title',
  labels: 'labels',
  estimate_min: 'estimate',
  blocked_by: 'blockers',
  description: 'description',
  checklist: 'checklist',
};

function describeChanges(payload) {
  const changes = payload?.changes;
  if (!changes) return null;
  const names = Object.keys(changes)
    .filter((k) => FIELD_NAME[k])
    .map((k) => FIELD_NAME[k]);
  if (!names.length) return null;
  if (changes.status) {
    return `set status to ${store.STATUS_LABEL[changes.status.to] || changes.status.to}`;
  }
  if (changes.priority) {
    return `set priority to ${store.PRIORITY_LABEL[changes.priority.to] || changes.priority.to}`;
  }
  if (changes.due_at) {
    return changes.due_at.to ? `set the due date to ${fmtDue(changes.due_at.to)}` : 'cleared the due date';
  }
  return `changed ${names.slice(0, 3).join(', ')}`;
}

function activitySection(task) {
  const section = el('div.section');
  section.appendChild(el('div.section-head', {}, el('div.t-eyebrow', { text: 'Activity' })));
  const feed = el('div.feed');
  section.appendChild(feed);

  store.listEvents({ task_id: task.id, limit: 40 }).then((events) => {
    if (!events.length) {
      feed.appendChild(el('div.hint', { text: 'Nothing recorded yet.' }));
      return;
    }
    for (const e of events) {
      const who = store.memberById(e.actor_id)?.user?.name || 'Someone';
      const what = describeChanges(e.payload) || EVENT_TEXT[e.type] || e.type;
      feed.appendChild(
        el(
          'div.feed-item',
          {},
          el('span.avatar.sm', { text: initials(who) }),
          el(
            'div.feed-body',
            {},
            el('span.t-sub', { text: who }),
            el('span.muted', { text: ` ${what}` }),
            el('span.feed-when', { text: ` · ${fmtRelative(e.created_at)}` })
          )
        )
      );
    }
  });

  return section;
}

/* ---- keep the drawer live ---- */

store.bus.on('tasks:changed', ({ ids }) => {
  if (drawerTaskId && (!ids?.length || ids.includes(drawerTaskId))) {
    // Don't yank focus out of a field the user is typing in.
    const active = document.activeElement;
    if (drawer?.contains(active) && /INPUT|TEXTAREA/.test(active.tagName)) return;
    if (active?.isContentEditable && drawer?.contains(active)) return;
    refreshDrawer();
  }
});
