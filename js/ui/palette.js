/* Command palette (⌘K) and the global keyboard map.
 *
 * The palette is the keyboard-first surface: every navigation target, every
 * command, and every task is reachable from one input. Commands are generated
 * fresh on open so their state (undo label, current theme, running timer) is
 * always accurate.
 */

import * as store from '../core/store.js';
import * as history from '../core/history.js';
import * as search from '../core/search.js';
import * as rules from '../domain/rules.js';
import * as io from '../domain/io.js';
import * as shell from './shell.js';
import * as tasksView from '../views/tasks.js';
import * as settingsView from '../views/settings.js';
import { icon, STATUS_ICON } from './icons.js';
import {
  el,
  frag,
  clear,
  modal,
  toast,
  confirm,
  promptText,
  trapFocus,
  closeMenu,
  topModal,
  $,
  $$,
} from './kit.js';
import { openTask, closeTask, selection } from './task.js';
import { hashColor, plural, fmtDue, debounce } from '../core/util.js';

/* ============================== COMMANDS ============================== */

function commands() {
  const undo = history.status();

  const out = [
    { id: 'new', label: 'New task', icon: 'plus', kbd: 'C', run: () => tasksView.focusQuickAdd() },
    {
      id: 'new-project',
      label: 'New project',
      icon: 'project',
      run: async () => {
        const name = await promptText({ title: 'New project', label: 'Name', confirmLabel: 'Create' });
        if (!name) return;
        const p = await store.createProject({ name, color: hashColor(name) });
        shell.navigate('project', p.id);
      },
    },
    'separator',
    { id: 'go-today', label: 'Go to Today', icon: 'today', run: () => shell.navigate('today') },
    { id: 'go-upcoming', label: 'Go to Upcoming', icon: 'upcoming', run: () => shell.navigate('upcoming') },
    { id: 'go-inbox', label: 'Go to Inbox', icon: 'inbox', run: () => shell.navigate('inbox') },
    { id: 'go-all', label: 'Go to All tasks', icon: 'list', run: () => shell.navigate('all') },
    { id: 'go-review', label: 'Go to Daily review', icon: 'target', run: () => shell.navigate('review') },
    { id: 'go-focus', label: 'Start focus mode', icon: 'focus', run: () => shell.navigate('focus') },
    { id: 'go-insights', label: 'Go to Insights', icon: 'insights', run: () => shell.navigate('insights') },
    { id: 'go-workload', label: 'Go to Workload', icon: 'workload', run: () => shell.navigate('workload') },
    { id: 'go-activity', label: 'Go to Activity', icon: 'activity', run: () => shell.navigate('activity') },
    { id: 'go-templates', label: 'Go to Templates', icon: 'templates', run: () => shell.navigate('templates') },
    { id: 'go-automations', label: 'Go to Automations', icon: 'automation', run: () => shell.navigate('automations') },
    { id: 'go-trash', label: 'Go to Trash', icon: 'trash', run: () => shell.navigate('trash') },
    { id: 'go-settings', label: 'Go to Settings', icon: 'settings', kbd: ',', run: () => shell.navigate('settings') },
    'separator',
    { id: 'view-list', label: 'Switch to List view', icon: 'list', run: () => tasksView.setQuery({ view: 'list' }) },
    { id: 'view-board', label: 'Switch to Board view', icon: 'board', run: () => tasksView.setQuery({ view: 'board' }) },
    { id: 'view-calendar', label: 'Switch to Calendar view', icon: 'calendar', run: () => tasksView.setQuery({ view: 'calendar' }) },
    'separator',
  ];

  if (undo.canUndo) {
    out.push({
      id: 'undo',
      label: `Undo — ${undo.undoLabel}`,
      icon: 'undo',
      kbd: '⌘Z',
      run: () => history.undo(),
    });
  }
  if (undo.canRedo) {
    out.push({
      id: 'redo',
      label: `Redo — ${undo.redoLabel}`,
      icon: 'redo',
      kbd: '⇧⌘Z',
      run: () => history.redo(),
    });
  }

  out.push(
    {
      id: 'theme',
      label: store.getSetting('theme') === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
      icon: store.getSetting('theme') === 'dark' ? 'sun' : 'moon',
      run: async () => {
        const next = store.getSetting('theme') === 'dark' ? 'light' : 'dark';
        await store.setSetting('theme', next);
        settingsView.applyTheme(next);
      },
    },
    {
      id: 'density',
      label:
        store.getSetting('density') === 'compact' ? 'Use comfortable density' : 'Use compact density',
      icon: 'panel',
      run: async () => {
        const next = store.getSetting('density') === 'compact' ? 'comfortable' : 'compact';
        await store.setSetting('density', next);
        document.documentElement.dataset.density = next;
      },
    },
    {
      id: 'assistant',
      label: 'Open assistant',
      icon: 'sparkle',
      run: () => shell.setAside(true),
    },
    'separator',
    {
      id: 'export-csv',
      label: 'Export tasks as CSV',
      icon: 'download',
      run: () => {
        io.download(`miko-tasks-${io.stamp()}.csv`, io.exportTasksCSV(), 'text/csv');
        toast('CSV downloaded', { kind: 'success' });
      },
    },
    {
      id: 'export-backup',
      label: 'Download a full backup',
      icon: 'archive',
      run: async () => {
        const backup = await io.exportBackup();
        io.download(`miko-backup-${io.stamp()}.json`, JSON.stringify(backup), 'application/json');
        toast('Backup downloaded', { kind: 'success' });
      },
    },
    {
      id: 'shortcuts',
      label: 'Keyboard shortcuts',
      icon: 'keyboard',
      kbd: '?',
      run: () => showShortcuts(),
    }
  );

  if (rules.runningEntry()) {
    out.splice(1, 0, {
      id: 'stop-timer',
      label: 'Stop the running timer',
      icon: 'stop',
      run: () => rules.stopTimer(),
    });
  }

  return out;
}

/* ============================== THE PALETTE ============================== */

let paletteOpen = false;

export function open(mode = 'all') {
  if (paletteOpen) return;
  paletteOpen = true;
  closeMenu();

  const input = el('input.cmd-input', {
    type: 'text',
    placeholder: mode === 'search' ? 'Search tasks…' : 'Search tasks or type a command…',
    'aria-label': 'Command palette',
    'aria-controls': 'cmd-list',
    'aria-expanded': 'true',
    role: 'combobox',
    autocomplete: 'off',
    spellcheck: 'false',
  });

  const list = el('div.cmd-list', { id: 'cmd-list', role: 'listbox' });
  const box = el(
    'div.cmd',
    {},
    el('div.cmd-input-row', {}, el('span', { html: icon('search') }), input,
      el('span.kbd', { text: 'esc' })),
    list
  );

  const overlay = el('div.overlay', {}, box);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });

  document.body.appendChild(overlay);
  requestAnimationFrame(() => {
    overlay.classList.add('on');
    input.focus();
  });

  const release = trapFocus(box);
  let items = [];
  let active = 0;

  function close() {
    paletteOpen = false;
    overlay.classList.remove('on');
    release();
    setTimeout(() => overlay.remove(), 200);
  }

  function paint(query) {
    const q = query.trim();
    items = [];
    clear(list);

    /* tasks */
    const taskHits = q
      ? search.index.search(q, { limit: 8 })
      : store
          .allTasks()
          .filter((t) => t.status !== 'done')
          .sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1))
          .slice(0, 5)
          .map((t) => ({ id: t.id }));

    if (taskHits.length) {
      list.appendChild(el('div.menu-label', { text: 'Tasks' }));
      for (const hit of taskHits) {
        const task = store.getTask(hit.id);
        if (!task) continue;
        items.push({
          node: el(
            'button.cmd-item',
            { type: 'button', role: 'option' },
            el('span', { html: icon(STATUS_ICON[task.status], { size: 15 }) }),
            el('span.truncate', { html: q ? search.highlight(task.title, q) : task.title }),
            task.due_at ? el('span.cmd-item-sub', { text: fmtDue(task.due_at) }) : null
          ),
          run: () => openTask(task.id),
        });
      }
    }

    /* projects */
    if (q) {
      const projects = store.state.projects.filter((p) =>
        p.name.toLowerCase().includes(q.toLowerCase())
      );
      if (projects.length) {
        list.appendChild(el('div.menu-label', { text: 'Projects' }));
        for (const p of projects.slice(0, 4)) {
          items.push({
            node: el(
              'button.cmd-item',
              { type: 'button', role: 'option' },
              el('span', { html: icon('project'), style: { display: 'contents' } }),
              el('span.truncate', { text: p.name })
            ),
            run: () => shell.navigate('project', p.id),
          });
        }
      }
    }

    /* commands */
    if (mode !== 'search') {
      const cmds = commands().filter((c) => c !== 'separator');
      const matched = q
        ? cmds.filter((c) => fuzzy(c.label.toLowerCase(), q.toLowerCase()))
        : cmds.slice(0, 8);

      if (matched.length) {
        list.appendChild(el('div.menu-label', { text: 'Commands' }));
        for (const c of matched.slice(0, 12)) {
          items.push({
            node: el(
              'button.cmd-item',
              { type: 'button', role: 'option' },
              el('span', { html: icon(c.icon || 'command', { size: 15 }) }),
              el('span.truncate', { text: c.label }),
              c.kbd ? el('span.kbd', { text: c.kbd }) : null
            ),
            run: c.run,
          });
        }
      }
    }

    /* create fallback */
    if (q && !taskHits.length) {
      items.push({
        node: el(
          'button.cmd-item',
          { type: 'button', role: 'option' },
          el('span', { html: icon('plus', { size: 15 }) }),
          el('span.truncate', { text: `Create task "${q}"` })
        ),
        run: async () => {
          await history.createTask({ title: q }, 'Add task');
          toast('Task created', { kind: 'success' });
        },
      });
    }

    if (!items.length) {
      list.appendChild(el('div.hint', { style: { padding: 'var(--s4)' }, text: 'Nothing matches.' }));
      return;
    }

    items.forEach((item, i) => {
      item.node.addEventListener('click', () => {
        close();
        item.run();
      });
      item.node.addEventListener('mousemove', () => setActive(i));
      list.appendChild(item.node);
    });

    active = 0;
    setActive(0);
  }

  function setActive(i) {
    active = Math.max(0, Math.min(items.length - 1, i));
    items.forEach((item, j) => item.node.setAttribute('aria-selected', String(j === active)));
    items[active]?.node.scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('input', debounce(() => paint(input.value), 80));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(active + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(active - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[active];
      if (item) {
        close();
        item.run();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  paint('');
}

/** Subsequence match — "gotd" finds "Go to Today". */
function fuzzy(haystack, needle) {
  if (haystack.includes(needle)) return true;
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}

/* ============================== SHORTCUTS ============================== */

const SHORTCUTS = [
  ['General', [
    ['⌘K / Ctrl K', 'Command palette'],
    ['/', 'Search'],
    ['C', 'New task'],
    ['?', 'This list'],
    ['⌘\\', 'Toggle sidebar'],
    ['Esc', 'Close whatever is open'],
  ]],
  ['Navigation', [
    ['G then T', 'Today'],
    ['G then U', 'Upcoming'],
    ['G then I', 'Inbox'],
    ['G then A', 'All tasks'],
    ['G then F', 'Focus'],
    ['G then S', 'Settings'],
  ]],
  ['Tasks', [
    ['J / ↓', 'Move down'],
    ['K / ↑', 'Move up'],
    ['X', 'Select'],
    ['⌘A', 'Select all visible'],
    ['Enter', 'Open task'],
    ['E', 'Complete task'],
    ['1 – 5', 'Set priority'],
    ['D', 'Set due date'],
    ['⌫', 'Delete'],
  ]],
  ['Editing', [
    ['⌘Z', 'Undo'],
    ['⇧⌘Z', 'Redo'],
    ['⌘Enter', 'Save and close'],
  ]],
];

export function showShortcuts() {
  modal({
    title: 'Keyboard shortcuts',
    size: 'lg',
    body: frag(
      ...SHORTCUTS.map(([group, rows]) =>
        el(
          'section',
          {},
          el('div.t-eyebrow', { style: { marginBottom: 'var(--s2)' }, text: group }),
          el(
            'div.col',
            {},
            ...rows.map(([keys, what]) =>
              el(
                'div.row',
                { style: { padding: '3px 0' } },
                el('span.kbd', { text: keys }),
                el('span.muted', { text: what })
              )
            )
          )
        )
      )
    ),
  });
}

/* ============================ GLOBAL KEYMAP ============================ */

let chordPrefix = null;
let chordTimer = null;

function inField(e) {
  const t = e.target;
  return (
    t.isContentEditable ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) ||
    t.closest('[contenteditable="true"]')
  );
}

export function installKeymap() {
  document.addEventListener('keydown', async (e) => {
    const meta = e.metaKey || e.ctrlKey;

    /* palette works everywhere, including inside fields */
    if (meta && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      open();
      return;
    }

    if (meta && e.key === '\\') {
      e.preventDefault();
      $('#rail')?.classList.toggle('open');
      return;
    }

    if (meta && e.key.toLowerCase() === 'z') {
      if (inField(e)) return; // let the field handle its own undo
      e.preventDefault();
      try {
        const entry = e.shiftKey ? await history.redo() : await history.undo();
        if (entry) toast(`${e.shiftKey ? 'Redid' : 'Undid'} — ${entry.label}`, { duration: 2200 });
      } catch {
        toast('Could not undo that', { kind: 'warn' });
      }
      return;
    }

    if (e.key === 'Escape') {
      if (topModal() || $('.menu')) return; // those handle their own escape
      if (selection.size) {
        selection.clear();
        return;
      }
      /* The task panel binds its own Escape, but only fires it when focus is
         inside. Click out into the list behind it and Escape stopped working,
         which is not how a dialog is expected to behave. */
      if ($('.drawer.on')) {
        closeTask();
        return;
      }
      return;
    }

    if (inField(e)) return;

    /* chords: G then <key> */
    if (chordPrefix === 'g') {
      clearTimeout(chordTimer);
      chordPrefix = null;
      const map = {
        t: 'today',
        u: 'upcoming',
        i: 'inbox',
        a: 'all',
        f: 'focus',
        r: 'review',
        s: 'settings',
        w: 'workload',
        n: 'insights',
      };
      const dest = map[e.key.toLowerCase()];
      if (dest) {
        e.preventDefault();
        shell.navigate(dest);
      }
      return;
    }

    if (e.key.toLowerCase() === 'g' && !meta) {
      chordPrefix = 'g';
      clearTimeout(chordTimer);
      chordTimer = setTimeout(() => (chordPrefix = null), 1200);
      return;
    }

    if (meta && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      tasksView.selectAllVisible();
      return;
    }

    const focused = tasksView.focusedTaskId();

    switch (e.key) {
      case '/':
        e.preventDefault();
        ($('.topbar input[type="search"]') || {}).focus?.() || open('search');
        return;
      case '?':
        e.preventDefault();
        showShortcuts();
        return;
      case 'c':
      case 'C':
        e.preventDefault();
        tasksView.focusQuickAdd();
        return;
      case ',':
        if (meta) {
          e.preventDefault();
          shell.navigate('settings');
        }
        return;
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        tasksView.moveFocus(1);
        return;
      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        tasksView.moveFocus(-1);
        return;
      case 'Enter':
        if (focused) {
          e.preventDefault();
          openTask(focused);
        }
        return;
      case 'x':
      case 'X':
        if (focused) {
          e.preventDefault();
          selection.toggle(focused);
        }
        return;
      case 'e':
      case 'E':
        if (focused) {
          e.preventDefault();
          await history.toggleDone(focused);
        }
        return;
      case 'd':
      case 'D':
        if (focused) {
          e.preventDefault();
          const row = $(`.task[data-id="${focused}"]`);
          const { dueMenu } = await import('./task.js');
          dueMenu(row, [focused]);
        }
        return;
      case 'Backspace':
      case 'Delete': {
        const ids = selection.size ? selection.list() : focused ? [focused] : [];
        if (!ids.length) return;
        e.preventDefault();
        if (ids.length > 1) {
          await history.bulkDelete(ids, `Delete ${plural(ids.length, 'task')}`);
          selection.clear();
        } else {
          await history.deleteTask(ids[0]);
        }
        toast(`${plural(ids.length, 'task')} moved to trash`, {
          action: { label: 'Undo', onClick: () => history.undo() },
        });
        return;
      }
      default:
        break;
    }

    /* 1–5 set priority on the focused / selected tasks */
    if (/^[1-5]$/.test(e.key)) {
      const ids = selection.size ? selection.list() : focused ? [focused] : [];
      if (!ids.length) return;
      e.preventDefault();
      const priority = ['urgent', 'high', 'medium', 'low', 'none'][Number(e.key) - 1];
      if (ids.length > 1) await history.bulkUpdate(ids, { priority }, `Set priority on ${ids.length} tasks`);
      else await history.updateTask(ids[0], { priority }, 'Set priority');
    }
  });
}
