/* Insights, Workload, Focus mode, Daily review, Activity, and Trash. */

import * as store from '../core/store.js';
import * as history from '../core/history.js';
import * as analytics from '../domain/analytics.js';
import * as rules from '../domain/rules.js';
import {
  fmtDue,
  fmtDuration,
  fmtRelative,
  fmtDate,
  dayKey,
  todayKey,
  clockTime,
  initials,
  plural,
  hashColor,
  clamp,
} from '../core/util.js';
import { icon, STATUS_ICON } from '../ui/icons.js';
import { el, frag, clear, toast, confirm, emptyState, menu, $, $$ } from '../ui/kit.js';
import { taskRow, openTask } from '../ui/task.js';

/* ================================ shared ================================ */

function statCard(label, value, sub, tone, { brand = false } = {}) {
  return el(
    `div.stat${brand ? '.tone-brand' : ''}`,
    {},
    el('div.stat-label', { text: label }),
    el('div.stat-value', { text: String(value) }),
    sub ? el('div.stat-delta', { class: tone || 'faint', text: sub }) : null
  );
}

function ring(pct, size = 56) {
  const r = size / 2 - 3;
  const circ = 2 * Math.PI * r;
  return el(
    'div.ring',
    { style: { width: `${size}px`, height: `${size}px` } },
    el('span', {
      html: `<svg width="${size}" height="${size}" aria-hidden="true">
        <circle class="track" cx="${size / 2}" cy="${size / 2}" r="${r}"/>
        <circle class="bar" cx="${size / 2}" cy="${size / 2}" r="${r}"
          stroke-dasharray="${circ}" stroke-dashoffset="${circ - (clamp(pct, 0, 100) / 100) * circ}"/>
      </svg>`,
    }),
    el('div.ring-label', { text: `${Math.round(pct)}%` })
  );
}

function section(title, ...children) {
  return el(
    'section.section',
    {},
    el('div.section-head', {}, el('h2.t-eyebrow', { text: title })),
    ...children
  );
}

/* =============================== INSIGHTS =============================== */

export function renderInsights() {
  const pad = el('div.content-pad');
  const s = analytics.summary({ days: 30 });
  const st = analytics.streak();

  pad.appendChild(
    el(
      'div.grid.grid-4',
      { style: { marginBottom: 'var(--s6)' } },
      statCard(
        'Completed (30d)',
        s.completed,
        s.completedDelta != null
          ? `${s.completedDelta >= 0 ? '+' : ''}${s.completedDelta}% vs previous 30d`
          : 'no earlier data',
        s.completedDelta > 0 ? 'c-ok' : s.completedDelta < 0 ? 'c-danger' : 'faint',
        { brand: true }
      ),
      statCard('Open', s.open, s.overdue ? `${s.overdue} overdue` : 'nothing overdue', s.overdue ? 'c-danger' : 'c-ok'),
      statCard('Completion rate', `${s.completionRate}%`, `${plural(s.created, 'task')} created`),
      statCard(
        'Avg cycle time',
        s.avgCycleDays != null ? `${s.avgCycleDays}d` : '—',
        `${s.throughputPerWeek}/week throughput`
      )
    )
  );

  /* activity chart */
  const series = analytics.activitySeries(14);
  const peak = Math.max(1, ...series.map((d) => Math.max(d.created, d.completed)));
  const chart = el('div.chart', { role: 'img', 'aria-label': 'Tasks created and completed over the last 14 days' });

  for (const d of series) {
    const hDone = (d.completed / peak) * 100;
    const hOpen = (Math.max(0, d.created - d.completed) / peak) * 100;
    chart.appendChild(
      el(
        'div.chart-col',
        { title: `${d.key}: ${d.completed} completed, ${d.created} created` },
        el(
          'div.chart-stack',
          { style: { height: `${Math.max(2, hDone + hOpen)}%` } },
          el('div.chart-seg.done', { style: { height: `${(hDone / Math.max(0.01, hDone + hOpen)) * 100}%` } }),
          el('div.chart-seg.open', { style: { height: `${(hOpen / Math.max(0.01, hDone + hOpen)) * 100}%` } })
        ),
        el('div.chart-label', { text: d.key.slice(8) })
      )
    );
  }

  pad.appendChild(
    section(
      'Last 14 days',
      el('div.card.card-pad', {}, chart,
        el(
          'div.legend',
          { style: { marginTop: 'var(--s3)' } },
          el('span', { html: '<i style="background:var(--accent)"></i>Completed' }),
          el('span', { html: '<i style="background:var(--surface-3)"></i>Created, still open' })
        )
      )
    )
  );

  /* heatmap + streak */
  const heat = analytics.heatmap(16);
  const heatGrid = el('div.heat', { role: 'img', 'aria-label': `Completions over the last ${heat.weeks} weeks` });
  for (const c of heat.cells) {
    heatGrid.appendChild(
      el('div.heat-cell', {
        'data-level': String(c.level),
        title: `${c.key}: ${plural(c.count, 'task')} completed`,
      })
    );
  }

  pad.appendChild(
    section(
      'Consistency',
      el(
        'div.card.card-pad',
        {},
        el(
          'div.row',
          { style: { marginBottom: 'var(--s3)' } },
          el('div', {}, el('div.stat-value', { text: String(st.current) }), el('div.stat-label', { text: 'day streak' })),
          el('div.spacer'),
          el('div.t-meta', { text: `Best: ${plural(st.best, 'day')}` })
        ),
        heatGrid
      )
    )
  );

  /* per-project table */
  const rows = analytics.byProject();
  if (rows.length) {
    const table = el('table.table');
    table.appendChild(
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', { text: 'Project' }),
          el('th.num', { text: 'Open' }),
          el('th.num', { text: 'Done' }),
          el('th.num', { text: 'Overdue' }),
          el('th', { text: 'Progress', style: { width: '140px' } })
        )
      )
    );
    const tbody = el('tbody');
    for (const r of rows) {
      tbody.appendChild(
        el(
          'tr',
          {},
          el(
            'td',
            {},
            el(
              'span.row',
              {},
              el('span.chip-dot', {
                style: {
                  background: r.project ? r.project.color || hashColor(r.project.name) : 'var(--text-3)',
                },
              }),
              el('span', { text: r.project?.name || 'No project' })
            )
          ),
          el('td.num', { text: String(r.open) }),
          el('td.num', { text: String(r.done) }),
          el('td.num', { class: r.overdue ? 'c-danger' : '', text: String(r.overdue) }),
          el(
            'td',
            {},
            el(
              'div.wl-bar',
              {},
              el('div.wl-fill.ok', { style: { width: `${r.pct}%` } })
            )
          )
        )
      );
    }
    table.appendChild(tbody);
    pad.appendChild(section('By project', el('div.card.card-pad', {}, table)));
  }

  /* estimate accuracy — async, appended when ready */
  const estWrap = el('div');
  pad.appendChild(estWrap);
  analytics.estimateAccuracy().then((acc) => {
    if (!acc.sample) return;
    estWrap.appendChild(
      section(
        'Estimates vs actual',
        el(
          'div.card.card-pad',
          {},
          el('div.t-body', {
            text:
              acc.avgRatio > 1.15
                ? `Tasks take about ${Math.round((acc.avgRatio - 1) * 100)}% longer than you estimate.`
                : acc.avgRatio < 0.85
                ? `You over-estimate by about ${Math.round((1 - acc.avgRatio) * 100)}%.`
                : 'Your estimates are close to actual time.',
          }),
          el('div.hint', { text: `Based on ${plural(acc.sample, 'task')} with both an estimate and logged time.` }),
          el(
            'div.col',
            { style: { marginTop: 'var(--s3)' } },
            ...acc.rows.slice(0, 5).map((r) =>
              el(
                'div.row',
                {},
                el('span.truncate', { text: r.task.title, style: { flex: '1' } }),
                el('span.t-meta', { text: `est ${fmtDuration(r.estimate)}` }),
                el('span.t-meta', {
                  class: r.ratio > 1.2 ? 'c-danger' : r.ratio < 0.8 ? 'c-warn' : 'c-ok',
                  text: `actual ${fmtDuration(r.actual)}`,
                })
              )
            )
          )
        )
      )
    );
  });

  return pad;
}

/* =============================== WORKLOAD =============================== */

export function renderWorkload() {
  const pad = el('div.content-pad');
  const rows = analytics.workload({ days: 7 });
  const atRisk = rules.atRisk();

  pad.appendChild(
    el('p.hint', {
      style: { marginBottom: 'var(--s4)' },
      text: `Estimated effort due in the next 7 days, against ${fmtDuration(
        Number(store.getSetting('dailyCapacityMin', 360))
      )} per working day. Tasks with no estimate count as 30 minutes.`,
    })
  );

  if (!rows.length) {
    pad.appendChild(emptyState({ icon: 'workload', title: 'Nothing to weigh up', body: 'Assign some tasks and give them estimates.' }));
    return pad;
  }

  const card = el('div.card.card-pad');
  for (const r of rows) {
    card.appendChild(
      el(
        'div.wl-row',
        {},
        el(
          'div.wl-person',
          {},
          el('span.avatar.sm', { text: initials(r.name) }),
          el('span.truncate', { text: r.name })
        ),
        el(
          'div.wl-bar',
          { title: `${fmtDuration(r.minutes)} of ${fmtDuration(r.capacity)}` },
          el(`div.wl-fill.${r.band}`, { style: { width: `${Math.min(100, r.pct)}%` } })
        ),
        el(
          'div.wl-num',
          {},
          el('div', { text: `${r.pct}%` }),
          el('div.faint', { text: plural(r.open, 'task'), style: { fontSize: 'var(--t-xs)' } })
        )
      )
    );
  }
  pad.appendChild(section('This week', card));

  if (atRisk.length) {
    const list = el('div.task-list', { role: 'list' });
    for (const p of atRisk.slice(0, 20)) list.appendChild(taskRow(p.task, {}));
    pad.appendChild(
      section(
        'Will not fit before its deadline',
        el(
          'div',
          {},
          el('p.hint', {
            style: { marginBottom: 'var(--s2)' },
            text: 'At current capacity these cannot be finished by their due date. Move the date, cut the scope, or hand them off.',
          }),
          list
        )
      )
    );
  }

  return pad;
}

/* ================================ FOCUS ================================ */

let focusState = {
  taskId: null,
  running: false,
  endsAt: null,
  remaining: 0,
  onBreak: false,
  tick: null,
};

export function renderFocus() {
  const pad = el('div.content-pad');
  const wrap = el('div.focus-wrap');
  pad.appendChild(wrap);

  const minutes = Number(store.getSetting('pomodoroMin', 25));
  const breakMin = Number(store.getSetting('pomodoroBreakMin', 5));

  const candidates = store
    .allTasks()
    .filter((t) => t.status !== 'done' && !store.isBlocked(t))
    .sort((a, b) => {
      const ad = a.due_at ? new Date(a.due_at).getTime() : Infinity;
      const bd = b.due_at ? new Date(b.due_at).getTime() : Infinity;
      if (ad !== bd) return ad - bd;
      return store.PRIORITY_RANK[a.priority] - store.PRIORITY_RANK[b.priority];
    });

  if (!focusState.taskId || !store.getTask(focusState.taskId)) {
    focusState.taskId = candidates[0]?.id || null;
  }
  const task = focusState.taskId ? store.getTask(focusState.taskId) : null;

  if (!task) {
    wrap.appendChild(
      emptyState({
        icon: 'focus',
        title: 'Nothing to focus on',
        body: 'Every open task is either done or blocked. Add one, or clear a blocker.',
      })
    );
    return pad;
  }

  if (!focusState.running && !focusState.remaining) {
    focusState.remaining = minutes * 60;
  }

  const total = (focusState.onBreak ? breakMin : minutes) * 60;
  const size = 200;
  const r = size / 2 - 4;
  const circ = 2 * Math.PI * r;

  const ringEl = el('div.focus-ring', {}, el('span', {
    html: `<svg width="${size}" height="${size}" aria-hidden="true">
      <circle class="track" cx="${size / 2}" cy="${size / 2}" r="${r}"/>
      <circle class="bar" cx="${size / 2}" cy="${size / 2}" r="${r}"
        stroke-dasharray="${circ}" stroke-dashoffset="0"/>
    </svg>`,
  }));

  const timerEl = el('div.focus-timer', { text: clockTime(focusState.remaining), role: 'timer', 'aria-live': 'off' });
  ringEl.appendChild(
    el(
      'div.focus-inner',
      {},
      timerEl,
      el('div.t-meta', { text: focusState.onBreak ? 'Break' : 'Focus' })
    )
  );

  const paint = () => {
    timerEl.textContent = clockTime(focusState.remaining);
    const bar = ringEl.querySelector('.bar');
    if (bar) bar.setAttribute('stroke-dashoffset', String(circ - (focusState.remaining / total) * circ));
  };
  paint();

  const stop = () => {
    clearInterval(focusState.tick);
    focusState.tick = null;
    focusState.running = false;
  };

  const start = () => {
    if (focusState.running) return;
    focusState.running = true;
    focusState.endsAt = Date.now() + focusState.remaining * 1000;
    if (!focusState.onBreak) rules.startTimer(task.id);

    focusState.tick = setInterval(() => {
      focusState.remaining = Math.max(0, Math.round((focusState.endsAt - Date.now()) / 1000));
      paint();
      if (focusState.remaining <= 0) {
        stop();
        if (!focusState.onBreak) {
          rules.stopTimer();
          rules.notify('Focus block finished', { body: task.title });
          focusState.onBreak = true;
          focusState.remaining = breakMin * 60;
        } else {
          rules.notify('Break over', { body: 'Back to it.' });
          focusState.onBreak = false;
          focusState.remaining = minutes * 60;
        }
        renderIntoCurrent();
      }
    }, 250);
    renderIntoCurrent();
  };

  wrap.append(
    el('div.t-eyebrow', { text: focusState.onBreak ? 'Taking a break' : 'Focusing on' }),
    el('div.focus-task', { text: task.title }),
    ringEl,
    el(
      'div.row',
      {},
      el(
        'button.btn.btn-lg.btn-primary',
        {
          type: 'button',
          onclick: () => {
            if (focusState.running) {
              stop();
              rules.stopTimer();
              renderIntoCurrent();
            } else {
              start();
            }
          },
        },
        el('span', { html: icon(focusState.running ? 'pause' : 'play') }),
        el('span', { text: focusState.running ? 'Pause' : 'Start' })
      ),
      el(
        'button.btn.btn-lg',
        {
          type: 'button',
          onclick: async () => {
            stop();
            await rules.stopTimer();
            await history.toggleDone(task.id);
            focusState.taskId = null;
            focusState.remaining = minutes * 60;
            focusState.onBreak = false;
            renderIntoCurrent();
          },
        },
        el('span', { html: icon('check') }),
        el('span', { text: 'Done' })
      ),
      el(
        'button.btn.btn-lg',
        {
          type: 'button',
          onclick: () => {
            stop();
            rules.stopTimer();
            const i = candidates.findIndex((c) => c.id === focusState.taskId);
            focusState.taskId = candidates[(i + 1) % candidates.length]?.id || null;
            focusState.remaining = minutes * 60;
            focusState.onBreak = false;
            renderIntoCurrent();
          },
        },
        el('span', { html: icon('arrowRight') }),
        el('span', { text: 'Next' })
      )
    ),
    el('button.btn.btn-quiet.btn-sm', {
      type: 'button',
      text: 'Choose a different task',
      onclick: (e) =>
        menu(
          e.currentTarget,
          candidates.slice(0, 15).map((c) => ({
            label: c.title,
            checked: c.id === focusState.taskId,
            onClick: () => {
              stop();
              rules.stopTimer();
              focusState.taskId = c.id;
              focusState.remaining = minutes * 60;
              focusState.onBreak = false;
              renderIntoCurrent();
            },
          }))
        ),
    }),
    el('div.hint', {
      text: `${minutes} minutes of focus, then ${breakMin} off. Change these in Settings.`,
    })
  );

  return pad;
}

/* The focus view repaints itself in place rather than going through the
   router, so the running timer is never interrupted by a re-mount. */
let focusHost = null;

export function setFocusHost(node) {
  focusHost = node;
}

function renderIntoCurrent() {
  if (!focusHost || !focusHost.isConnected) return;
  clear(focusHost);
  focusHost.appendChild(renderFocus());
}

export function stopFocus() {
  clearInterval(focusState.tick);
  focusState.tick = null;
  focusState.running = false;
}

/* ============================= DAILY REVIEW ============================= */

export function renderReview() {
  const pad = el('div.content-pad');
  const r = analytics.dailyReview();
  const s = analytics.summary({ days: 7 });

  pad.appendChild(
    el(
      'div.card.card-pad.tone-brand',
      { style: { marginBottom: 'var(--s6)' } },
      el(
        'div.row',
        {},
        ring(s.completionRate, 56),
        el(
          'div',
          {},
          el('div.t-title', { text: greeting() }),
          el('div.t-meta', {
            text: r.completedToday.length
              ? `${plural(r.completedToday.length, 'task')} done today. ${plural(r.dueToday.length, 'task')} still due.`
              : `${plural(r.dueToday.length, 'task')} due today, ${plural(r.overdue.length, 'task')} overdue.`,
          })
        )
      )
    )
  );

  const block = (title, tasks, empty, tone) => {
    if (!tasks.length) return el('div.hint', { text: empty, style: { marginBottom: 'var(--s5)' } });
    const list = el('div.task-list', { role: 'list' });
    for (const t of tasks.slice(0, 12)) list.appendChild(taskRow(t, {}));
    return section(
      `${title} · ${tasks.length}`,
      list
    );
  };

  pad.append(
    block('Overdue', r.overdue, 'Nothing overdue.', 'c-danger'),
    block('Due today', r.dueToday, 'Nothing due today.'),
    block('Blocked', r.blocked, 'Nothing is blocked.'),
    block('No due date', r.unscheduled.slice(0, 10), 'Everything is scheduled.')
  );

  if (r.completedYesterday.length) {
    pad.appendChild(
      section(
        `Finished yesterday · ${r.completedYesterday.length}`,
        el(
          'div.col',
          {},
          ...r.completedYesterday.slice(0, 10).map((t) =>
            el(
              'div.row',
              {},
              el('span.c-ok', { html: icon('circleCheck', { size: 13 }) }),
              el('span.truncate.muted', { text: t.title })
            )
          )
        )
      )
    );
  }

  return pad;
}

function greeting() {
  const h = new Date().getHours();
  const name = store.state.user?.name?.split(' ')[0] || '';
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  return name && name !== 'You' ? `${part}, ${name}` : part;
}

/* =============================== ACTIVITY =============================== */

const EVENT_LABEL = {
  'task.created': 'created',
  'task.updated': 'updated',
  'task.deleted': 'deleted',
  'task.restored': 'restored',
  'task.purged': 'permanently deleted',
  'task.bulk_updated': 'bulk-updated',
  'comment.added': 'commented on',
  'attachment.added': 'attached a file to',
  'project.created': 'created project',
  'project.updated': 'updated project',
  'project.deleted': 'deleted project',
  'automation.fired': 'automation ran on',
  'automation.saved': 'saved automation',
  'time.logged': 'logged time on',
  'data.imported': 'imported data',
  'data.restored': 'restored a backup',
  'ai.actions_applied': 'applied assistant suggestions',
};

export function renderActivity() {
  const pad = el('div.content-pad');
  const feed = el('div.feed');
  pad.appendChild(
    el('p.hint', { style: { marginBottom: 'var(--s4)' }, text: 'Every change in this workspace, newest first.' })
  );
  pad.appendChild(feed);

  store.listEvents({ limit: 200 }).then((events) => {
    if (!events.length) {
      feed.appendChild(emptyState({ icon: 'activity', title: 'No activity yet', body: 'Changes appear here as you work.' }));
      return;
    }
    for (const e of events) {
      const who = store.memberById(e.actor_id)?.user?.name || 'Someone';
      const task = e.task_id ? store.getTask(e.task_id) : null;
      const label = EVENT_LABEL[e.type] || e.type;

      feed.appendChild(
        el(
          'div.feed-item',
          {},
          el('span.avatar.sm', { text: initials(who) }),
          el(
            'div.feed-body',
            {},
            el('span.t-sub', { text: who }),
            el('span.muted', { text: ` ${label} ` }),
            task
              ? el('button', {
                  type: 'button',
                  text: task.title,
                  style: { fontWeight: '500', textAlign: 'left' },
                  onclick: () => openTask(task.id),
                })
              : el('span.muted', { text: e.payload?.name || e.payload?.title || '' }),
            el('span.feed-when', { text: ` · ${fmtRelative(e.created_at)}` })
          )
        )
      );
    }
  });

  return pad;
}

/* ================================ TRASH ================================ */

export function renderTrash() {
  const pad = el('div.content-pad');
  const rows = store.trashedTasks();

  pad.appendChild(
    el(
      'div.row',
      { style: { marginBottom: 'var(--s4)' } },
      el('p.hint', {
        style: { flex: '1' },
        text: 'Deleted tasks stay here until you empty the trash. Restoring brings back subtasks too.',
      }),
      rows.length
        ? el(
            'button.btn.btn-sm.btn-danger',
            {
              type: 'button',
              onclick: async () => {
                const ok = await confirm({
                  title: 'Empty trash?',
                  message: `This permanently deletes **${plural(rows.length, 'task')}**, along with their comments and attachments. It cannot be undone.`,
                  confirmLabel: 'Delete permanently',
                  danger: true,
                });
                if (!ok) return;
                const n = await store.emptyTrash();
                toast(`Deleted ${plural(n, 'task')}`, { kind: 'success' });
              },
            },
            el('span', { html: icon('trash', { size: 13 }) }),
            el('span', { text: 'Empty trash' })
          )
        : null
    )
  );

  if (!rows.length) {
    pad.appendChild(emptyState({ icon: 'trash', title: 'Trash is empty', body: 'Deleted tasks land here first.' }));
    return pad;
  }

  const list = el('div.task-list', { role: 'list' });
  for (const t of rows) {
    list.appendChild(
      el(
        'div.task',
        { 'data-status': t.status, 'data-priority': t.priority },
        el('span.task-prio'),
        el(
          'div.task-body',
          {},
          el('div.task-line', {}, el('div.task-title', { text: t.title })),
          el(
            'div.task-meta',
            {},
            el('span', { text: `Deleted ${fmtRelative(t.deleted_at)}` }),
            store.projectById(t.project_id)
              ? el('span', { text: store.projectById(t.project_id).name })
              : null
          )
        ),
        el(
          'div.task-actions',
          { style: { opacity: '1' } },
          el('button.btn.btn-sm', {
            type: 'button',
            html: `${icon('restore', { size: 13 })}<span>Restore</span>`,
            onclick: async () => {
              await store.restoreTask(t.id);
              toast('Restored', { kind: 'success' });
            },
          }),
          el('button.icon-btn.sm', {
            type: 'button',
            'aria-label': `Delete ${t.title} permanently`,
            html: icon('trash'),
            onclick: async () => {
              const ok = await confirm({
                title: 'Delete permanently?',
                message: `**${t.title}** and everything under it will be gone for good.`,
                confirmLabel: 'Delete',
                danger: true,
              });
              if (ok) await store.purgeTask(t.id);
            },
          })
        )
      )
    );
  }
  pad.appendChild(list);
  return pad;
}
