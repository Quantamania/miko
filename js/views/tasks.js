/* Task views: Today, Upcoming, List, Board, Calendar.
 *
 * One query model feeds all five. Filters, sort and grouping are held in a
 * plain object that serialises to a saved view, so "save this view" is just
 * persisting the object.
 */

import * as store from '../core/store.js';
import * as history from '../core/history.js';
import * as search from '../core/search.js';
import * as rules from '../domain/rules.js';
import * as nlp from '../domain/nlp.js';
import {
  dayKey,
  todayKey,
  addDaysKey,
  diffDaysKey,
  weekdayKey,
  keyToInstant,
  fmtDue,
  fmtDate,
  fmtDuration,
  plural,
  hashColor,
  debounce,
  groupBy,
  sortBy,
  parts,
} from '../core/util.js';
import { icon, STATUS_ICON } from '../ui/icons.js';
import {
  el,
  frag,
  clear,
  menu,
  toast,
  confirm,
  promptText,
  emptyState,
  VirtualList,
  autoGrow,
  announce,
  $,
  $$,
} from '../ui/kit.js';
import { taskRow, selection, onSelectionChange, openTask, datePicker, dueMenu, statusMenu, priorityMenu, projectMenu, assigneeMenu } from '../ui/task.js';

/* ============================== QUERY MODEL ============================== */

export function blankQuery(overrides = {}) {
  return {
    view: 'list', // list | board | calendar
    scope: 'all', // all | today | upcoming | project | label | assignee
    project_id: null,
    label_id: null,
    assignee_id: null,
    statuses: [],
    priorities: [],
    text: '',
    showCompleted: false,
    sort: 'smart', // smart | due | priority | created | updated | title | manual
    group: 'none', // none | status | priority | project | assignee | due
    ...overrides,
  };
}

let query = blankQuery();
let calendarAnchor = todayKey();

export function getQuery() {
  return query;
}

export function setQuery(patch, { rerender = true } = {}) {
  query = { ...query, ...patch };
  if (rerender) render();
}

/* ============================== FILTERING ============================== */

const SORTS = {
  smart: (a, b) => {
    // Overdue first, then due soon, then priority, then age.
    const ad = a.due_at ? new Date(a.due_at).getTime() : Infinity;
    const bd = b.due_at ? new Date(b.due_at).getTime() : Infinity;
    if (ad !== bd) return ad - bd;
    const ap = store.PRIORITY_RANK[a.priority];
    const bp = store.PRIORITY_RANK[b.priority];
    if (ap !== bp) return ap - bp;
    return a.created_at < b.created_at ? -1 : 1;
  },
  due: (a, b) => {
    const ad = a.due_at ? new Date(a.due_at).getTime() : Infinity;
    const bd = b.due_at ? new Date(b.due_at).getTime() : Infinity;
    return ad - bd;
  },
  priority: (a, b) => store.PRIORITY_RANK[a.priority] - store.PRIORITY_RANK[b.priority],
  created: (a, b) => (a.created_at > b.created_at ? -1 : 1),
  updated: (a, b) => (a.updated_at > b.updated_at ? -1 : 1),
  title: (a, b) => a.title.localeCompare(b.title),
  manual: (a, b) => a.position - b.position,
};

export function applyQuery(q = query) {
  let tasks = store.allTasks();
  const today = todayKey();

  if (q.text) {
    const hits = search.index.search(q.text, { limit: 400 });
    const rank = new Map(hits.map((h, i) => [h.id, i]));
    tasks = tasks.filter((t) => rank.has(t.id));
    tasks.sort((a, b) => rank.get(a.id) - rank.get(b.id));
  }

  if (q.scope === 'today') {
    tasks = tasks.filter(
      (t) => t.status !== 'done' && t.due_at && dayKey(t.due_at) <= today
    );
  } else if (q.scope === 'upcoming') {
    tasks = tasks.filter((t) => t.status !== 'done' && t.due_at && dayKey(t.due_at) > today);
  } else if (q.scope === 'inbox') {
    tasks = tasks.filter((t) => t.status !== 'done' && !t.project_id);
  }

  if (q.project_id) tasks = tasks.filter((t) => t.project_id === q.project_id);
  if (q.label_id) tasks = tasks.filter((t) => (t.labels || []).includes(q.label_id));
  if (q.assignee_id) tasks = tasks.filter((t) => t.assignee_id === q.assignee_id);
  if (q.statuses?.length) tasks = tasks.filter((t) => q.statuses.includes(t.status));
  if (q.priorities?.length) tasks = tasks.filter((t) => q.priorities.includes(t.priority));

  if (!q.showCompleted && !q.statuses?.includes('done')) {
    tasks = tasks.filter((t) => t.status !== 'done');
  }

  if (!q.text && q.sort !== 'none') {
    tasks = [...tasks].sort(SORTS[q.sort] || SORTS.smart);
  }
  return tasks;
}

/* ============================== GROUPING ============================== */

const GROUPERS = {
  none: null,
  status: {
    key: (t) => t.status,
    label: (k) => store.STATUS_LABEL[k] || k,
    order: store.STATUSES,
  },
  priority: {
    key: (t) => t.priority,
    label: (k) => store.PRIORITY_LABEL[k] || k,
    order: store.PRIORITIES,
  },
  project: {
    key: (t) => t.project_id || '',
    label: (k) => store.projectById(k)?.name || 'No project',
  },
  assignee: {
    key: (t) => t.assignee_id || '',
    label: (k) => store.memberById(k)?.user?.name || 'Unassigned',
  },
  due: {
    key: (t) => {
      if (!t.due_at) return 'none';
      const d = diffDaysKey(dayKey(t.due_at), todayKey());
      if (d < 0) return 'overdue';
      if (d === 0) return 'today';
      if (d === 1) return 'tomorrow';
      if (d <= 7) return 'week';
      return 'later';
    },
    label: (k) =>
      ({
        overdue: 'Overdue',
        today: 'Today',
        tomorrow: 'Tomorrow',
        week: 'This week',
        later: 'Later',
        none: 'No due date',
      }[k] || k),
    order: ['overdue', 'today', 'tomorrow', 'week', 'later', 'none'],
  },
};

/* ============================== RENDERING ============================== */

let host = null;
let vlist = null;

export function mount(container) {
  host = container;
  render();
}

export function unmount() {
  vlist?.destroy();
  vlist = null;
  host = null;
}

export function render() {
  if (!host) return;
  const scrollTop = host.querySelector('.content')?.scrollTop ?? 0;
  clear(host);

  host.appendChild(buildToolbar());

  const content = el('div.content', { id: 'view-content' });
  host.appendChild(content);

  const tasks = applyQuery();

  if (query.view === 'board') {
    content.appendChild(renderBoard(tasks));
  } else if (query.view === 'calendar') {
    content.appendChild(renderCalendar(tasks));
  } else if (query.scope === 'upcoming') {
    content.appendChild(renderAgenda(tasks));
  } else {
    content.appendChild(renderList(tasks));
  }

  content.scrollTop = scrollTop;
  updateBulkBar();
}

/* ------------------------------ toolbar ------------------------------ */

function buildToolbar() {
  const bar = el('div.subbar');

  /* view switcher */
  const seg = el('div.seg', { role: 'group', 'aria-label': 'View' });
  for (const [v, label, iconName] of [
    ['list', 'List', 'list'],
    ['board', 'Board', 'board'],
    ['calendar', 'Calendar', 'calendar'],
  ]) {
    seg.appendChild(
      el('button', {
        type: 'button',
        'aria-pressed': String(query.view === v),
        html: `${icon(iconName, { size: 13 })}<span>${label}</span>`,
        onclick: () => setQuery({ view: v }),
      })
    );
  }
  bar.appendChild(seg);

  /* filters */
  const activeFilters =
    (query.statuses?.length ? 1 : 0) +
    (query.priorities?.length ? 1 : 0) +
    (query.label_id ? 1 : 0) +
    (query.assignee_id ? 1 : 0);

  bar.appendChild(
    el(
      'button.btn.btn-sm',
      {
        type: 'button',
        'aria-haspopup': 'menu',
        onclick: (e) => filterMenu(e.currentTarget),
      },
      el('span', { html: icon('filter', { size: 13 }) }),
      el('span', { text: 'Filter' }),
      activeFilters ? el('span.badge.badge-accent', { text: String(activeFilters) }) : null
    )
  );

  bar.appendChild(
    el(
      'button.btn.btn-sm',
      {
        type: 'button',
        'aria-haspopup': 'menu',
        onclick: (e) => sortMenu(e.currentTarget),
      },
      el('span', { html: icon('sort', { size: 13 }) }),
      el('span', { text: SORT_LABEL[query.sort] || 'Sort' })
    )
  );

  if (query.view === 'list') {
    bar.appendChild(
      el(
        'button.btn.btn-sm',
        {
          type: 'button',
          'aria-haspopup': 'menu',
          onclick: (e) =>
            menu(
              e.currentTarget,
              Object.keys(GROUPERS).map((g) => ({
                label: g === 'none' ? 'No grouping' : GROUP_LABEL[g],
                checked: query.group === g,
                onClick: () => setQuery({ group: g }),
              }))
            ),
        },
        el('span', { text: query.group === 'none' ? 'Group' : GROUP_LABEL[query.group] })
      )
    );
  }

  /* active filter chips, individually removable */
  if (query.label_id) {
    const l = store.labelById(query.label_id);
    bar.appendChild(filterChip(l?.name || 'Label', () => setQuery({ label_id: null })));
  }
  for (const s of query.statuses || []) {
    bar.appendChild(
      filterChip(store.STATUS_LABEL[s], () =>
        setQuery({ statuses: query.statuses.filter((x) => x !== s) })
      )
    );
  }
  for (const p of query.priorities || []) {
    bar.appendChild(
      filterChip(store.PRIORITY_LABEL[p], () =>
        setQuery({ priorities: query.priorities.filter((x) => x !== p) })
      )
    );
  }
  if (query.assignee_id) {
    bar.appendChild(
      filterChip(
        store.memberById(query.assignee_id)?.user?.name || 'Assignee',
        () => setQuery({ assignee_id: null })
      )
    );
  }

  bar.appendChild(el('div.spacer'));

  if (query.view === 'calendar') {
    bar.appendChild(
      el(
        'div.row',
        {},
        el('button.icon-btn.sm', {
          type: 'button',
          'aria-label': 'Previous month',
          html: icon('chevronLeft'),
          onclick: () => {
            calendarAnchor = shiftMonth(calendarAnchor, -1);
            render();
          },
        }),
        el('button.btn.btn-sm', {
          type: 'button',
          text: 'Today',
          onclick: () => {
            calendarAnchor = todayKey();
            render();
          },
        }),
        el('button.icon-btn.sm', {
          type: 'button',
          'aria-label': 'Next month',
          html: icon('chevronRight'),
          onclick: () => {
            calendarAnchor = shiftMonth(calendarAnchor, 1);
            render();
          },
        })
      )
    );
  }

  bar.appendChild(
    el('button.btn.btn-sm', {
      type: 'button',
      html: `${icon('download', { size: 13 })}<span>Save view</span>`,
      title: 'Save these filters as a view',
      onclick: async () => {
        const name = await promptText({ title: 'Save view', label: 'Name', confirmLabel: 'Save' });
        if (!name) return;
        await store.saveView(name, query);
        toast(`Saved "${name}"`, { kind: 'success' });
      },
    })
  );

  return bar;
}

const SORT_LABEL = {
  smart: 'Smart',
  due: 'Due date',
  priority: 'Priority',
  created: 'Newest',
  updated: 'Recently updated',
  title: 'Title',
  manual: 'Manual',
};

const GROUP_LABEL = {
  none: 'No grouping',
  status: 'Status',
  priority: 'Priority',
  project: 'Project',
  assignee: 'Assignee',
  due: 'Due date',
};

function filterChip(text, onRemove) {
  return el(
    'span.chip',
    {},
    el('span.truncate', { text }),
    el('button.chip-x', {
      type: 'button',
      'aria-label': `Remove filter ${text}`,
      html: icon('x'),
      onclick: onRemove,
    })
  );
}

function filterMenu(anchor) {
  const toggle = (key, value) => {
    const list = query[key] || [];
    setQuery({ [key]: list.includes(value) ? list.filter((x) => x !== value) : [...list, value] });
  };

  menu(anchor, [
    { label: 'Status', header: true },
    ...store.STATUSES.map((s) => ({
      label: store.STATUS_LABEL[s],
      checked: (query.statuses || []).includes(s),
      keepOpen: true,
      onClick: () => toggle('statuses', s),
    })),
    'separator',
    { label: 'Priority', header: true },
    ...store.PRIORITIES.map((p) => ({
      label: store.PRIORITY_LABEL[p],
      checked: (query.priorities || []).includes(p),
      keepOpen: true,
      onClick: () => toggle('priorities', p),
    })),
    store.state.labels.length ? 'separator' : null,
    store.state.labels.length ? { label: 'Label', header: true } : null,
    ...store.state.labels.slice(0, 12).map((l) => ({
      label: l.name,
      color: l.color || hashColor(l.name),
      checked: query.label_id === l.id,
      onClick: () => setQuery({ label_id: query.label_id === l.id ? null : l.id }),
    })),
    'separator',
    {
      label: 'Show completed',
      checked: query.showCompleted,
      keepOpen: true,
      onClick: () => setQuery({ showCompleted: !query.showCompleted }),
    },
    {
      label: 'Clear all filters',
      icon: 'x',
      onClick: () =>
        setQuery({
          statuses: [],
          priorities: [],
          label_id: null,
          assignee_id: null,
          text: '',
          showCompleted: false,
        }),
    },
  ]);
}

function sortMenu(anchor) {
  menu(
    anchor,
    Object.entries(SORT_LABEL).map(([k, label]) => ({
      label,
      checked: query.sort === k,
      onClick: () => setQuery({ sort: k }),
    }))
  );
}

/* ------------------------------ quick add ------------------------------ */

export function quickAdd() {
  const wrap = el('div', { style: { marginBottom: 'var(--s4)' } });
  const input = el('textarea.quickadd-input', {
    rows: 1,
    placeholder: 'Add a task — try "review deck tomorrow 3pm #work !high"',
    'aria-label': 'Add a task',
    'aria-describedby': 'quickadd-parsed',
  });
  autoGrow(input, 120);

  const parsedBar = el('div.parsed', { id: 'quickadd-parsed', 'aria-live': 'polite' });

  const box = el(
    'div.quickadd',
    {},
    el('span', { html: icon('plus') }),
    input,
    el('button.btn.btn-sm.btn-primary', {
      type: 'button',
      text: 'Add',
      onclick: submit,
    })
  );

  wrap.append(box, parsedBar);

  const preview = debounce(() => {
    const text = input.value.trim();
    if (!text) {
      parsedBar.classList.remove('on');
      clear(parsedBar);
      return;
    }
    const p = nlp.parse(text, {
      projects: store.state.projects,
      labels: store.state.labels,
      members: store.state.members,
    });
    clear(parsedBar);
    if (!p.matched.length) {
      parsedBar.classList.remove('on');
      return;
    }
    parsedBar.appendChild(el('span.parsed-hint', { text: 'Understood:' }));
    for (const m of p.matched) {
      parsedBar.appendChild(
        el(
          'span.chip',
          {},
          el('span', { html: icon(MATCH_ICON[m.kind] || 'label', { size: 11 }) }),
          el('span', { text: m.text })
        )
      );
    }
    parsedBar.classList.add('on');
  }, 140);

  input.addEventListener('input', preview);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape') {
      input.value = '';
      preview();
      input.blur();
    }
  });

  async function submit() {
    const text = input.value.trim();
    if (!text) return;

    const p = nlp.parse(text, {
      projects: store.state.projects,
      labels: store.state.labels,
      members: store.state.members,
    });

    // Create any labels the parser saw but that do not exist yet.
    const labelIds = [...p.labels];
    for (const name of p.labelNames) {
      if (store.state.labels.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
        const existing = store.state.labels.find(
          (l) => l.name.toLowerCase() === name.toLowerCase()
        );
        if (existing && !labelIds.includes(existing.id)) labelIds.push(existing.id);
        continue;
      }
      const created = await store.createLabel(name);
      labelIds.push(created.id);
    }

    const created = await history.createTask(
      {
        title: p.title,
        due_at: p.due_at,
        priority: p.priority || 'none',
        labels: labelIds,
        project_id: p.project_id ?? (query.scope === 'project' ? query.project_id : null),
        assignee_id: p.assignee_id ?? store.state.user.id,
        estimate_min: p.estimate_min,
        recurrence_rule: p.recurrence_rule,
        status: query.view === 'board' && query.statuses?.length === 1 ? query.statuses[0] : 'todo',
      },
      'Add task'
    );

    input.value = '';
    input.style.height = 'auto';
    clear(parsedBar);
    parsedBar.classList.remove('on');
    announce('Task added');
    input.focus();

    // A task added from Today that lands next week is filtered straight back
    // out. Silently vanishing reads as a bug, so say where it went.
    if (created && !applyQuery().some((t) => t.id === created.id)) {
      toast(
        created.due_at ? `Added — due ${fmtDue(created.due_at)}` : 'Added to All tasks',
        {
          action: {
            label: 'View',
            onClick: () => openTask(created.id),
          },
        }
      );
    }
  }

  return wrap;
}

const MATCH_ICON = {
  date: 'calendar',
  time: 'clock',
  project: 'project',
  label: 'label',
  assignee: 'user',
  priority: 'flag',
  estimate: 'timer',
  repeat: 'repeat',
};

export function focusQuickAdd() {
  $('.quickadd-input')?.focus();
}

/* -------------------------------- list -------------------------------- */

function renderList(tasks) {
  const pad = el('div.content-pad');
  pad.appendChild(quickAdd());

  if (!tasks.length) {
    pad.appendChild(emptyStateFor());
    return pad;
  }

  // Only show roots here; children render nested beneath their parent.
  const visible = new Set(tasks.map((t) => t.id));
  const roots = tasks.filter((t) => !t.parent_id || !visible.has(t.parent_id));

  const grouper = GROUPERS[query.group];
  const listWrap = el('div.task-list', { role: 'list' });

  if (!grouper) {
    renderRows(listWrap, roots, visible);
  } else {
    const groups = groupBy(roots, grouper.key);
    const keys = grouper.order
      ? grouper.order.filter((k) => groups.has(k))
      : [...groups.keys()].sort();
    for (const k of keys) {
      const rows = groups.get(k) || [];
      listWrap.appendChild(
        el(
          'div.group-head',
          {},
          el('span.t-eyebrow', { text: grouper.label(k) }),
          el('span.faint', { text: String(rows.length) })
        )
      );
      renderRows(listWrap, rows, visible);
    }
  }

  pad.appendChild(listWrap);

  const hiddenDone = !query.showCompleted
    ? store.allTasks().filter((t) => t.status === 'done').length
    : 0;
  if (hiddenDone) {
    pad.appendChild(
      el(
        'button.btn.btn-quiet.btn-sm',
        {
          type: 'button',
          style: { marginTop: 'var(--s3)' },
          onclick: () => setQuery({ showCompleted: true }),
        },
        el('span', { html: icon('eye', { size: 13 }) }),
        el('span', { text: `Show ${plural(hiddenDone, 'completed task')}` })
      )
    );
  }

  return pad;
}

function renderRows(container, rows, visible, depth = 0) {
  const ordered = rows.map((t) => t.id);
  for (const task of rows) {
    container.appendChild(taskRow(task, { depth, orderedIds: ordered }));
    if (!task.collapsed) {
      const kids = store.childrenOf(task.id).filter((k) => visible.has(k.id) || depth < 3);
      const shown = kids.filter((k) => query.showCompleted || k.status !== 'done');
      if (shown.length) renderRows(container, shown, visible, depth + 1);
    }
  }
}

function emptyStateFor() {
  if (query.text) {
    return emptyState({
      icon: 'search',
      title: 'No matches',
      body: `Nothing matches "${query.text}".`,
      action: el('button.btn.btn-sm', {
        type: 'button',
        text: 'Clear search',
        onclick: () => setQuery({ text: '' }),
      }),
    });
  }
  if (query.scope === 'today') {
    return emptyState({
      icon: 'circleCheck',
      title: 'Nothing due today',
      body: 'Anything with a due date of today or earlier shows up here.',
    });
  }
  if (query.scope === 'upcoming') {
    return emptyState({
      icon: 'upcoming',
      title: 'Nothing scheduled',
      body: 'Give a task a due date and it will appear here.',
    });
  }
  return emptyState({
    icon: 'inbox',
    title: 'Nothing here yet',
    body: 'Add a task above. Dates, projects and priorities can go straight in the text.',
  });
}

/* ------------------------------- agenda ------------------------------- */

function renderAgenda(tasks) {
  const pad = el('div.content-pad');
  pad.appendChild(quickAdd());

  if (!tasks.length) {
    pad.appendChild(emptyStateFor());
    return pad;
  }

  const byDay = groupBy(tasks, (t) => dayKey(t.due_at));
  const keys = [...byDay.keys()].sort();

  for (const key of keys) {
    const rows = byDay.get(key);
    const d = new Date(`${key}T12:00:00Z`);
    const isToday = key === todayKey();

    const day = el(`div.agenda-day${isToday ? '.is-today' : ''}`);
    day.appendChild(
      el(
        'div.agenda-date',
        {},
        el('div.agenda-dow', { text: d.toLocaleDateString(undefined, { weekday: 'short' }) }),
        el('div.agenda-num', { text: String(parts(key + 'T12:00:00Z').d) }),
        el('div.faint', {
          text: d.toLocaleDateString(undefined, { month: 'short' }),
          style: { fontSize: 'var(--t-sm)' },
        })
      )
    );

    const list = el('div.task-list', { role: 'list' });
    const ordered = rows.map((t) => t.id);
    for (const t of rows) list.appendChild(taskRow(t, { orderedIds: ordered }));
    day.appendChild(list);
    pad.appendChild(day);
  }

  return pad;
}

/* -------------------------------- board -------------------------------- */

function renderBoard(tasks) {
  const board = el('div.board');
  const columns = query.group === 'priority' ? store.PRIORITIES : store.STATUSES;
  const keyOf = query.group === 'priority' ? (t) => t.priority : (t) => t.status;
  const labelOf =
    query.group === 'priority'
      ? (k) => store.PRIORITY_LABEL[k]
      : (k) => store.STATUS_LABEL[k];

  const groups = groupBy(tasks, keyOf);

  for (const colKey of columns) {
    const rows = groups.get(colKey) || [];
    const col = el('div.board-col', { 'data-col': colKey });

    col.appendChild(
      el(
        'div.board-col-head',
        {},
        el('span', {
          html: icon(query.group === 'priority' ? 'flag' : STATUS_ICON[colKey], { size: 13 }),
          class: query.group === 'priority' ? `c-${colKey}` : '',
        }),
        el('span.t-sub', { text: labelOf(colKey) }),
        el('span.board-col-count', { text: String(rows.length) })
      )
    );

    const body = el('div.board-col-body');
    for (const t of rows) body.appendChild(boardCard(t));
    col.appendChild(body);

    col.appendChild(
      el(
        'button.board-add',
        {
          type: 'button',
          onclick: async () => {
            const title = await promptText({
              title: `New task — ${labelOf(colKey)}`,
              label: 'Title',
              confirmLabel: 'Add',
            });
            if (!title) return;
            await history.createTask(
              {
                title,
                [query.group === 'priority' ? 'priority' : 'status']: colKey,
                project_id: query.project_id,
              },
              'Add task'
            );
          },
        },
        el('span', { html: icon('plus', { size: 13 }) }),
        el('span', { text: 'Add task' })
      )
    );

    /* drop target */
    col.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/miko-tasks')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.classList.add('drop');
    });
    col.addEventListener('dragleave', (e) => {
      if (!col.contains(e.relatedTarget)) col.classList.remove('drop');
    });
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drop');
      const ids = JSON.parse(e.dataTransfer.getData('text/miko-tasks') || '[]');
      if (!ids.length) return;
      const field = query.group === 'priority' ? 'priority' : 'status';
      await history.bulkUpdate(ids, { [field]: colKey }, `Move ${plural(ids.length, 'task')}`);
      announce(`Moved to ${labelOf(colKey)}`);
    });

    board.appendChild(col);
  }

  return board;
}

function boardCard(task) {
  const card = el('div.board-card', {
    draggable: 'true',
    'data-id': task.id,
    tabindex: '0',
    role: 'button',
    'aria-label': task.title,
  });

  card.appendChild(el('div.board-card-title', { text: task.title }));

  const meta = el('div.board-card-meta');
  const p = store.projectById(task.project_id);
  if (p) {
    meta.appendChild(
      el('span', { text: p.name })
    );
  }
  if (task.due_at) {
    const k = dayKey(task.due_at);
    meta.appendChild(
      el('span', {
        class: k < todayKey() ? 'overdue' : k === todayKey() ? 'due-today' : '',
        text: fmtDue(task.due_at),
      })
    );
  }
  if (task.priority !== 'none') {
    meta.appendChild(el('span', { class: `c-${task.priority}`, html: icon('flag', { size: 11 }) }));
  }
  if (store.isBlocked(task)) meta.appendChild(el('span.badge.badge-warn', { text: 'Blocked' }));
  const kids = store.childrenOf(task.id);
  if (kids.length) {
    meta.appendChild(
      el('span', {}, el('span', { html: icon('subtask', { size: 11 }) }), el('span', { text: `${kids.filter((k) => k.status === 'done').length}/${kids.length}` }))
    );
  }
  if (meta.childElementCount) card.appendChild(meta);

  card.addEventListener('click', () => openTask(task.id));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openTask(task.id);
    }
  });
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/miko-tasks', JSON.stringify([task.id]));
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));

  return card;
}

/* ------------------------------- calendar ------------------------------- */

function shiftMonth(key, delta) {
  const p = parts(`${key}T12:00:00Z`);
  let m = p.m + delta;
  let y = p.y;
  while (m > 12) {
    m -= 12;
    y++;
  }
  while (m < 1) {
    m += 12;
    y--;
  }
  const inMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(p.d, inMonth)).padStart(2, '0')}`;
}

function renderCalendar(tasks) {
  const wrap = el('div.cal');
  const anchor = parts(`${calendarAnchor}T12:00:00Z`);
  const firstOfMonth = `${anchor.y}-${String(anchor.m).padStart(2, '0')}-01`;
  const gridStart = addDaysKey(firstOfMonth, -weekdayKey(firstOfMonth));
  const byDay = groupBy(
    tasks.filter((t) => t.due_at),
    (t) => dayKey(t.due_at)
  );

  wrap.appendChild(
    el(
      'div',
      { style: { padding: '10px var(--s5) 6px' } },
      el('div.t-title', {
        text: new Date(`${firstOfMonth}T12:00:00Z`).toLocaleDateString(undefined, {
          month: 'long',
          year: 'numeric',
        }),
      })
    )
  );

  const dow = el('div.cal-dow');
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  for (const n of names) dow.appendChild(el('span', { text: n }));
  wrap.appendChild(dow);

  const grid = el('div.cal-grid');
  const today = todayKey();

  for (let i = 0; i < 42; i++) {
    const key = addDaysKey(gridStart, i);
    const p = parts(`${key}T12:00:00Z`);
    const inMonth = p.m === anchor.m;
    if (i >= 35 && !inMonth) break; // don't render an all-trailing sixth row

    const cell = el(`div.cal-cell${inMonth ? '' : '.other'}${key === today ? '.today' : ''}`, {
      'data-key': key,
    });

    cell.appendChild(el('div.cal-date', { text: String(p.d) }));

    const dayTasks = byDay.get(key) || [];
    const shown = dayTasks.slice(0, 3);
    for (const t of shown) {
      cell.appendChild(
        el('button.cal-pill', {
          type: 'button',
          draggable: 'true',
          class: t.status === 'done' ? 'done' : '',
          'data-priority': t.priority,
          text: t.title,
          title: t.title,
          onclick: (e) => {
            e.stopPropagation();
            openTask(t.id);
          },
          ondragstart: (e) => {
            e.dataTransfer.setData('text/miko-tasks', JSON.stringify([t.id]));
            e.dataTransfer.effectAllowed = 'move';
          },
        })
      );
    }
    if (dayTasks.length > shown.length) {
      cell.appendChild(
        el('button.cal-more', {
          type: 'button',
          text: `+${dayTasks.length - shown.length} more`,
          onclick: () => setQuery({ view: 'list', scope: 'all', text: '' }),
        })
      );
    }

    /* click empty space to add on that day; drop to reschedule */
    cell.addEventListener('dblclick', async (e) => {
      if (e.target.closest('button')) return;
      const title = await promptText({
        title: `New task — ${fmtDate(keyToInstant(key), { month: 'long', day: 'numeric' })}`,
        label: 'Title',
        confirmLabel: 'Add',
      });
      if (!title) return;
      await history.createTask({ title, due_at: keyToInstant(key, 9, 0), project_id: query.project_id }, 'Add task');
    });

    cell.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/miko-tasks')) return;
      e.preventDefault();
      cell.classList.add('drop');
    });
    cell.addEventListener('dragleave', () => cell.classList.remove('drop'));
    cell.addEventListener('drop', async (e) => {
      e.preventDefault();
      cell.classList.remove('drop');
      const ids = JSON.parse(e.dataTransfer.getData('text/miko-tasks') || '[]');
      if (!ids.length) return;
      // Preserve the original time of day when only the date changes.
      const first = store.getTask(ids[0]);
      const time = first?.due_at ? parts(first.due_at) : { hh: 9, mm: 0 };
      await history.bulkUpdate(
        ids,
        { due_at: keyToInstant(key, time.hh, time.mm) },
        `Reschedule ${plural(ids.length, 'task')}`
      );
      announce(`Moved to ${key}`);
    });

    grid.appendChild(cell);
  }

  wrap.appendChild(grid);
  return wrap;
}

/* ------------------------------ bulk bar ------------------------------ */

let bulkBar = null;

function updateBulkBar() {
  if (!bulkBar) {
    bulkBar = el('div.bulkbar', { role: 'toolbar', 'aria-label': 'Bulk actions' });
    document.body.appendChild(bulkBar);
  }

  const ids = selection.list();
  if (!ids.length) {
    bulkBar.classList.remove('on');
    return;
  }

  clear(bulkBar);
  bulkBar.appendChild(el('span.bulkbar-count', { text: `${ids.length} selected` }));
  bulkBar.appendChild(el('span.bulkbar-sep'));

  const act = (label, iconName, onClick) =>
    el(
      'button.btn.btn-sm.btn-quiet',
      { type: 'button', onclick: onClick },
      el('span', { html: icon(iconName, { size: 13 }) }),
      el('span', { text: label })
    );

  bulkBar.append(
    act('Done', 'circleCheck', async () => {
      await history.bulkUpdate(ids, { status: 'done' }, `Complete ${plural(ids.length, 'task')}`);
      selection.clear();
      toast(`Completed ${plural(ids.length, 'task')}`, {
        kind: 'success',
        action: { label: 'Undo', onClick: () => history.undo() },
      });
    }),
    act('Status', 'circleDot', (e) => statusMenu(e.currentTarget, ids)),
    act('Priority', 'flag', (e) => priorityMenu(e.currentTarget, ids)),
    act('Due', 'calendar', (e) => dueMenu(e.currentTarget, ids)),
    act('Project', 'project', (e) => projectMenu(e.currentTarget, ids)),
    store.state.members.length > 1 ? act('Assign', 'user', (e) => assigneeMenu(e.currentTarget, ids)) : null,
    el('span.bulkbar-sep'),
    el(
      'button.btn.btn-sm.btn-danger',
      {
        type: 'button',
        onclick: async () => {
          await history.bulkDelete(ids, `Delete ${plural(ids.length, 'task')}`);
          selection.clear();
          toast(`${plural(ids.length, 'task')} moved to trash`, {
            action: { label: 'Undo', onClick: () => history.undo() },
          });
        },
      },
      el('span', { html: icon('trash', { size: 13 }) }),
      el('span', { text: 'Delete' })
    ),
    el('button.icon-btn.sm', {
      type: 'button',
      'aria-label': 'Clear selection',
      html: icon('x'),
      onclick: () => selection.clear(),
    })
  );

  bulkBar.classList.add('on');
}

onSelectionChange(() => {
  updateBulkBar();
  // Reflect selection without a full re-render.
  for (const row of $$('.task')) {
    const on = selection.has(row.dataset.id);
    row.classList.toggle('sel', on);
    row.setAttribute('aria-selected', String(on));
  }
});

/* --------------------------- keyboard on list --------------------------- */

export function moveFocus(delta) {
  const rows = $$('#view-content .task');
  if (!rows.length) return;
  const current = rows.findIndex((r) => r.classList.contains('focused'));
  const next = Math.max(0, Math.min(rows.length - 1, current < 0 ? 0 : current + delta));
  rows.forEach((r) => r.classList.remove('focused'));
  rows[next].classList.add('focused');
  rows[next].scrollIntoView({ block: 'nearest' });
  rows[next].focus({ preventScroll: true });
}

export function focusedTaskId() {
  return $('#view-content .task.focused')?.dataset.id || null;
}

export function selectAllVisible() {
  const ids = $$('#view-content .task').map((r) => r.dataset.id);
  selection.set(ids);
  announce(`${ids.length} tasks selected`);
}
