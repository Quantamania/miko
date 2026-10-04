/* App chrome: the left rail, top bar, assistant panel, and the router. */

import * as store from '../core/store.js';
import * as sync from '../core/sync.js';
import * as history from '../core/history.js';
import * as rules from '../domain/rules.js';
import * as ai from '../domain/ai.js';
import * as analytics from '../domain/analytics.js';
import * as tasksView from '../views/tasks.js';
import * as insights from '../views/insights.js';
import * as settingsView from '../views/settings.js';
import {
  dayKey,
  todayKey,
  initials,
  plural,
  hashColor,
  debounce,
  clockTime,
  esc,
} from '../core/util.js';
import { icon, VIEW_ICON } from './icons.js';
import {
  el,
  frag,
  clear,
  menu,
  toast,
  confirm,
  promptText,
  mdBlock,
  autoGrow,
  announce,
  closeMenu,
  $,
  $$,
} from './kit.js';
import { openTask, closeTask, isOpen, selection } from './task.js';

/* ================================ ROUTES ================================ */

const ROUTES = {
  today: { title: 'Today', sub: () => new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) },
  upcoming: { title: 'Upcoming' },
  inbox: { title: 'Inbox', sub: () => 'Tasks with no project' },
  all: { title: 'All tasks' },
  review: { title: 'Daily review' },
  insights: { title: 'Insights' },
  workload: { title: 'Workload' },
  focus: { title: 'Focus' },
  activity: { title: 'Activity' },
  trash: { title: 'Trash' },
  templates: { title: 'Templates' },
  automations: { title: 'Automations' },
  settings: { title: 'Settings' },
};

let route = { name: 'today', param: null };
let els = {};

export function currentRoute() {
  return route;
}

export function navigate(name, param) {
  const hash = param ? `#/${name}/${param}` : `#/${name}`;
  if (location.hash === hash) applyRoute();
  else location.hash = hash;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, param] = raw.split('/');
  if (name === 'task' && param) return { name: route.name, param: route.param, task: param };
  if (!name) return { name: store.getSetting('defaultView', 'today'), param: null };
  return { name, param: param || null };
}

/* ================================= BUILD ================================= */

export function build(root) {
  const app = el('div.app');

  els.rail = buildRail();
  /* tabindex="-1" so the region can take programmatic focus. Two things need
     it: the "Skip to content" link above (a skip link pointing at a element
     that cannot hold focus scrolls the page but strands the keyboard user
     where they were), and closing the task panel, which hands focus back here
     when the row it came from has been re-rendered away. */
  els.main = el('main.main', { id: 'main', tabindex: '-1' });
  els.aside = buildAside();
  els.scrim = el('div', { id: 'scrim' });

  els.scrim.addEventListener('click', () => {
    els.rail.classList.remove('mobile-open');
    setAside(false);
    els.scrim.classList.remove('on');
  });

  app.append(els.rail, els.main, els.aside);
  root.append(
    el('a.skip-link', { href: '#main', text: 'Skip to content' }),
    els.scrim,
    app
  );

  window.addEventListener('hashchange', applyRoute);
  wireLive();
  applyRoute();
  return app;
}

/* ================================== RAIL ================================== */

function buildRail() {
  const rail = el('nav.rail', { id: 'rail', 'aria-label': 'Main' });

  rail.appendChild(
    el(
      'div.rail-head',
      {},
      el('div.mark', { text: 'M', 'aria-hidden': 'true' }),
      el(
        'div.brand',
        {},
        // "MIKŌ" as markup, not text: the display face has no Ō, so the macron
        // is drawn in CSS to keep the wordmark in a single typeface.
        el('div.wordmark', { html: 'MIK<span class="o">O</span>', 'aria-label': 'MIKŌ' })
      ),
      el('div.spacer'),
      el('button.icon-btn.sm.desktop-only', {
        type: 'button',
        'aria-label': 'Toggle sidebar',
        title: 'Toggle sidebar (⌘\\)',
        html: icon('panel'),
        onclick: toggleRail,
      })
    )
  );

  els.railScroll = el('div.rail-scroll');
  rail.appendChild(els.railScroll);

  rail.appendChild(
    el(
      'div.rail-foot',
      {},
      /* The way back to the marketing page. Before this the landing page was
         unreachable once you had a session — the gate in main.js sends anyone
         signed in straight to the app, so there was no route to it at all
         short of clearing storage. */
      el(
        'a.nav-item',
        { href: 'index.html?home=1', title: 'Home' },
        el('span', { html: icon('logo'), style: { display: 'contents' } }),
        el('span.nav-label', { text: 'Home' })
      ),
      el(
        'button.nav-item',
        { type: 'button', onclick: (e) => userMenu(e.currentTarget) },
        el('span.avatar', { text: initials(store.state.user?.name || 'You') }),
        el('span.nav-label.truncate', { text: store.state.user?.name || 'You' })
      )
    )
  );

  return rail;
}

function navButton({ name, param, label, iconName, count }) {
  const active = route.name === name && route.param === (param ?? null);
  const btn = el(
    'button.nav-item',
    {
      type: 'button',
      'aria-current': active ? 'page' : null,
      onclick: () => {
        navigate(name, param);
        els.rail.classList.remove('mobile-open');
        els.scrim.classList.remove('on');
      },
    },
    el('span', { html: icon(iconName || 'list'), style: { display: 'contents' } }),
    el('span.nav-label', { text: label }),
    count ? el('span.nav-count', { text: String(count) }) : null
  );
  btn.title = label;
  return btn;
}

export function paintRail() {
  if (!els.railScroll) return;
  clear(els.railScroll);

  const tasks = store.allTasks();
  const today = todayKey();
  const counts = {
    today: tasks.filter((t) => t.status !== 'done' && t.due_at && dayKey(t.due_at) <= today).length,
    upcoming: tasks.filter((t) => t.status !== 'done' && t.due_at && dayKey(t.due_at) > today).length,
    inbox: tasks.filter((t) => t.status !== 'done' && !t.project_id).length,
    all: tasks.filter((t) => t.status !== 'done').length,
  };

  // Groups collapse and remember it. Sixteen destinations at once is the thing
  // that made this rail feel busy; letting people fold away what they don't use
  // is better than picking for them.
  const group = (label, children, action) => {
    const key = label ? `railGroup:${label}` : null;
    const collapsed = key ? store.getSetting(key, false) : false;
    const g = el(`div.rail-group${collapsed ? '.collapsed' : ''}`);

    if (label) {
      const toggle = el('button.group-toggle', {
        type: 'button',
        'aria-expanded': String(!collapsed),
        title: `Show or hide ${label}`,
        html: icon('chevronDown'),
      });
      toggle.appendChild(el('span.t-eyebrow', { text: label }));
      toggle.addEventListener('click', () => {
        const nowCollapsed = !g.classList.contains('collapsed');
        g.classList.toggle('collapsed', nowCollapsed);
        toggle.setAttribute('aria-expanded', String(!nowCollapsed));
        store.setSetting(key, nowCollapsed);
      });
      g.appendChild(el('div.rail-group-label', {}, toggle, action || null));
    }

    for (const c of children) if (c) g.appendChild(c);
    return g;
  };

  // Native append() stringifies null into a literal "null" text node — the
  // el()/append() helpers filter it, this does not. Drop empties first.
  const groups = [
    group(null, [
      navButton({ name: 'today', label: 'Today', iconName: 'today', count: counts.today }),
      navButton({ name: 'upcoming', label: 'Upcoming', iconName: 'upcoming', count: counts.upcoming }),
      navButton({ name: 'inbox', label: 'Inbox', iconName: 'inbox', count: counts.inbox }),
      navButton({ name: 'all', label: 'All tasks', iconName: 'list', count: counts.all }),
    ]),

    group(
      'Projects',
      [
        ...store.state.projects.map((p) =>
          navButton({
            name: 'project',
            param: p.id,
            label: p.name,
            iconName: 'project',
            count: tasks.filter((t) => t.project_id === p.id && t.status !== 'done').length,
          })
        ),
      ],
      el('button.icon-btn.sm', {
        type: 'button',
        'aria-label': 'New project',
        html: icon('plus'),
        onclick: async () => {
          const name = await promptText({ title: 'New project', label: 'Name', confirmLabel: 'Create' });
          if (!name) return;
          const p = await store.createProject({ name, color: hashColor(name) });
          navigate('project', p.id);
        },
      })
    ),

    store.state.savedViews.length
      ? group(
          'Saved views',
          store.state.savedViews.map((v) =>
            navButton({ name: 'view', param: v.id, label: v.name, iconName: 'filter' })
          )
        )
      : null,

    // Templates, Automations, Trash and Settings used to sit here too. They are
    // visited rarely but were competing for attention with the daily views, so
    // they moved into the account menu at the foot of the rail.
    group('Workspace', [
      navButton({ name: 'review', label: 'Daily review', iconName: 'target' }),
      navButton({ name: 'focus', label: 'Focus', iconName: 'focus' }),
      navButton({ name: 'insights', label: 'Insights', iconName: 'insights' }),
      navButton({ name: 'workload', label: 'Workload', iconName: 'workload' }),
      navButton({ name: 'activity', label: 'Activity', iconName: 'activity' }),
    ]),
  ];

  for (const g of groups) if (g) els.railScroll.appendChild(g);
}

function toggleRail() {
  const open = els.rail.classList.toggle('open');
  store.setSetting('railOpen', open);
}

function userMenu(anchor) {
  const trashed = store.trashedTasks().length;
  menu(anchor, [
    { label: store.state.user?.name || 'You', header: true },
    { label: 'Settings', icon: 'settings', onClick: () => navigate('settings') },
    'separator',
    { label: 'Manage', header: true },
    { label: 'Templates', icon: 'templates', onClick: () => navigate('templates') },
    { label: 'Automations', icon: 'automation', onClick: () => navigate('automations') },
    {
      label: trashed ? `Trash (${trashed})` : 'Trash',
      icon: 'trash',
      onClick: () => navigate('trash'),
    },
    'separator',
    {
      label: 'Keyboard shortcuts',
      icon: 'keyboard',
      kbd: '?',
      onClick: () => import('./palette.js').then((m) => m.showShortcuts()),
    },
    {
      label: store.getSetting('theme') === 'dark' ? 'Light theme' : 'Dark theme',
      icon: store.getSetting('theme') === 'dark' ? 'sun' : 'moon',
      onClick: async () => {
        const next = store.getSetting('theme') === 'dark' ? 'light' : 'dark';
        await store.setSetting('theme', next);
        settingsView.applyTheme(next);
      },
    },
    'separator',
    {
      label: 'Sign out',
      icon: 'lock',
      onClick: async () => {
        const auth = await import('../core/auth.js');
        const { confirm } = await import('./kit.js');
        const ok = await confirm({
          title: 'Sign out?',
          message: 'Your tasks stay on this device. You can sign back in at any time.',
          confirmLabel: 'Sign out',
        });
        if (ok) await auth.signOut();
      },
    },
  ]);
}

/* ================================= TOPBAR ================================= */

function buildTopbar() {
  const def = ROUTES[route.name];
  const project = route.name === 'project' ? store.projectById(route.param) : null;
  const savedView = route.name === 'view' ? store.state.savedViews.find((v) => v.id === route.param) : null;

  const title = project?.name || savedView?.name || def?.title || 'MIKŌ';
  const sub = def?.sub?.() || null;

  const bar = el('header.topbar');

  bar.appendChild(
    el('button.icon-btn.mobile-only', {
      type: 'button',
      'aria-label': 'Open menu',
      html: icon('menu'),
      onclick: () => {
        els.rail.classList.add('mobile-open');
        els.scrim.classList.add('on');
      },
    })
  );

  bar.appendChild(
    el(
      'div.topbar-title',
      {},
      el('h1', { text: title }),
      sub ? el('span.topbar-sub.desktop-only', { text: sub }) : null
    )
  );

  bar.appendChild(el('div.spacer'));

  /* search */
  els.search = el('input.input', {
    type: 'search',
    placeholder: 'Search tasks…',
    'aria-label': 'Search tasks',
    style: { width: '200px', height: '28px' },
    class: 'desktop-only',
  });
  els.search.value = tasksView.getQuery().text || '';
  els.search.addEventListener(
    'input',
    debounce(() => {
      if (!isTaskRoute()) navigate('all');
      tasksView.setQuery({ text: els.search.value });
    }, 200)
  );
  els.search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      els.search.value = '';
      tasksView.setQuery({ text: '' });
      els.search.blur();
    }
  });
  bar.appendChild(els.search);

  bar.appendChild(
    el('button.icon-btn.mobile-only', {
      type: 'button',
      'aria-label': 'Search',
      html: icon('search'),
      onclick: () => import('./palette.js').then((m) => m.open('search')),
    })
  );

  /* timer chip */
  els.timerChip = el('button.sync', {
    type: 'button',
    hidden: true,
    title: 'Stop timer',
    onclick: async () => {
      await rules.stopTimer();
      toast('Timer stopped');
    },
  });
  bar.appendChild(els.timerChip);
  paintTimer();

  /* presence */
  els.presence = el('div.presence', { 'aria-label': 'People here' });
  bar.appendChild(els.presence);
  paintPresence();

  /* sync status */
  els.sync = el('button.sync', {
    type: 'button',
    'data-state': 'synced',
    onclick: (e) => syncMenu(e.currentTarget),
  });
  bar.appendChild(els.sync);
  paintSync();

  bar.appendChild(
    el('button.icon-btn', {
      type: 'button',
      'aria-label': 'Command palette',
      title: 'Command palette (⌘K)',
      html: icon('command'),
      onclick: () => import('./palette.js').then((m) => m.open()),
    })
  );

  bar.appendChild(
    el('button.icon-btn', {
      type: 'button',
      'aria-label': 'Toggle assistant',
      title: 'Assistant',
      html: icon('sparkle'),
      onclick: () => setAside(els.aside.getAttribute('aria-hidden') === 'true'),
    })
  );

  return bar;
}

function isTaskRoute() {
  return ['today', 'upcoming', 'inbox', 'all', 'project', 'view'].includes(route.name);
}

/* ================================= ASIDE ================================= */

function buildAside() {
  const aside = el('aside.aside', { id: 'assistant', 'aria-hidden': 'true', 'aria-label': 'Assistant' });

  aside.appendChild(
    el(
      'div.asst-head',
      {},
      el('span.c-accent', { html: icon('sparkle', { size: 15 }) }),
      el('span.t-sub', { text: 'Assistant' }),
      el('div.spacer'),
      el('button.icon-btn.sm', {
        type: 'button',
        'aria-label': 'Close assistant',
        html: icon('x'),
        onclick: () => setAside(false),
      })
    )
  );

  els.asstScroll = el('div.asst-scroll');
  aside.appendChild(els.asstScroll);

  const input = el('textarea.asst-input', {
    rows: 1,
    placeholder: 'Ask about your tasks…',
    'aria-label': 'Ask the assistant',
  });
  autoGrow(input, 120);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendToAssistant(input.value);
      input.value = '';
      input.style.height = 'auto';
    }
  });
  els.asstInput = input;

  aside.appendChild(
    el(
      'div.asst-foot',
      {},
      input,
      el('button.icon-btn', {
        type: 'button',
        'aria-label': 'Send',
        html: icon('arrowUp'),
        onclick: () => {
          sendToAssistant(input.value);
          input.value = '';
          input.style.height = 'auto';
        },
      })
    )
  );

  return aside;
}

export function setAside(open) {
  els.aside.setAttribute('aria-hidden', String(!open));
  if (window.innerWidth <= 1080) els.scrim.classList.toggle('on', open);
  if (open) {
    if (!els.asstScroll.childElementCount) paintAssistantIntro();
    setTimeout(() => els.asstInput?.focus(), 200);
  }
}

const conversation = [];

function paintAssistantIntro() {
  clear(els.asstScroll);

  const s = analytics.summary({ days: 7 });
  els.asstScroll.appendChild(
    el(
      'div.card.card-pad',
      {},
      el('div.row', {},
        el('div', { style: { flex: '1' } },
          el('div.t-sub', { text: 'This week' }),
          el('div.t-meta', { text: `${s.completed} done · ${s.open} open · ${s.overdue} overdue` })
        )
      )
    )
  );

  const actions = el('div.asst-actions');
  for (const [label, iconName, prompt] of [
    ['Prioritise', 'flag', 'What should I do first?'],
    ['Plan my day', 'today', 'Plan my day'],
    ['Summarise', 'insights', 'Summarise my progress'],
    ["What's blocked", 'blocked', 'What is blocked?'],
  ]) {
    actions.appendChild(
      el('button.asst-action', { type: 'button', onclick: () => sendToAssistant(prompt) },
        el('span', { html: icon(iconName, { size: 13 }) }),
        el('span', { text: label })
      )
    );
  }
  els.asstScroll.appendChild(actions);

  ai.isConfigured().then((on) => {
    els.asstScroll.appendChild(
      el('div.hint', {
        text: on
          ? 'Connected to Claude. Ask anything about your work.'
          : 'Answering from your own data. Add a Claude key in Settings for open-ended questions.',
      })
    );
  });
}

function addMessage(from, content, opts = {}) {
  const msg = el(
    `div.msg${from === 'me' ? '.me' : ''}`,
    {},
    el('div.msg-from', { text: from === 'me' ? 'You' : 'MIKŌ' }),
    el('div.msg-bubble', { html: mdBlock(content) })
  );
  els.asstScroll.appendChild(msg);
  els.asstScroll.scrollTop = els.asstScroll.scrollHeight;
  return msg;
}

async function sendToAssistant(text) {
  const question = String(text || '').trim();
  if (!question) return;

  addMessage('me', question);
  conversation.push({ role: 'user', content: question });

  const typing = el('div.typing', {}, el('i'), el('i'), el('i'));
  els.asstScroll.appendChild(typing);
  els.asstScroll.scrollTop = els.asstScroll.scrollHeight;

  let streamNode = null;
  let streamed = '';

  try {
    const result = await ai.ask(question, conversation.slice(0, -1), {
      onDelta: (chunk) => {
        if (!streamNode) {
          typing.remove();
          streamNode = addMessage('miko', '');
        }
        streamed += chunk;
        streamNode.querySelector('.msg-bubble').innerHTML = mdBlock(
          ai.extractActions(streamed).text
        );
        els.asstScroll.scrollTop = els.asstScroll.scrollHeight;
      },
    });

    typing.remove();
    if (streamNode) {
      streamNode.querySelector('.msg-bubble').innerHTML = mdBlock(result.text);
    } else {
      addMessage('miko', result.text);
    }
    conversation.push({ role: 'assistant', content: result.text });

    if (result.actions?.length) {
      els.asstScroll.appendChild(actionCard(result.actions));
      els.asstScroll.scrollTop = els.asstScroll.scrollHeight;
    }
  } catch (err) {
    typing.remove();
    addMessage('miko', `Something went wrong: ${err.message}`);
  }
}

function actionCard(actions) {
  const describe = (a) => {
    switch (a.type) {
      case 'create_task':
        return `Create "${a.title}"${a.due ? ` due ${a.due}` : ''}${a.priority ? ` (${a.priority})` : ''}`;
      case 'set_priority':
        return `Set "${a.task}" to ${a.priority} priority`;
      case 'set_due':
        return a.due ? `Move "${a.task}" to ${a.due}` : `Clear the due date on "${a.task}"`;
      case 'set_status':
        return `Set "${a.task}" to ${store.STATUS_LABEL[a.status] || a.status}`;
      default:
        return a.type;
    }
  };

  const card = el(
    'div.suggest',
    {},
    el('div.t-sub', { text: `${plural(actions.length, 'suggested change')}` }),
    el('ul', { style: { listStyle: 'disc', marginLeft: '16px' } },
      ...actions.map((a) => el('li', { text: describe(a) }))
    )
  );

  card.appendChild(
    el('div.row', {},
      el('button.btn.btn-sm.btn-primary', {
        type: 'button',
        text: 'Apply',
        onclick: async () => {
          const applied = await ai.applyActions(actions);
          card.classList.add('applied');
          toast(`Applied ${plural(applied.length, 'change')}`, { kind: 'success' });
        },
      }),
      el('button.btn.btn-sm', {
        type: 'button',
        text: 'Dismiss',
        onclick: () => card.remove(),
      })
    )
  );

  return card;
}

/* ================================= ROUTER ================================= */

export function applyRoute() {
  const parsed = parseHash();
  const changed = parsed.name !== route.name || parsed.param !== route.param;
  route = { name: parsed.name, param: parsed.param };

  closeMenu();
  insights.stopFocus();
  selection.clear();

  clear(els.main);
  els.main.appendChild(buildTopbar());
  paintRail();

  // Views re-render by clearing their own host. Give them a `display:contents`
  // wrapper so a repaint can never take the top bar with it, while the subbar
  // and content still lay out as direct flex children of <main>.
  els.viewHost = el('div', { style: { display: 'contents' } });
  els.main.appendChild(els.viewHost);

  switch (route.name) {
    case 'today':
      tasksView.setQuery({ scope: 'today', project_id: null, label_id: null, view: 'list', group: 'none' }, { rerender: false });
      tasksView.mount(els.viewHost);
      break;
    case 'upcoming':
      tasksView.setQuery({ scope: 'upcoming', project_id: null, label_id: null, view: 'list', group: 'none' }, { rerender: false });
      tasksView.mount(els.viewHost);
      break;
    case 'inbox':
      tasksView.setQuery({ scope: 'inbox', project_id: null, label_id: null, view: 'list' }, { rerender: false });
      tasksView.mount(els.viewHost);
      break;
    case 'all':
      tasksView.setQuery({ scope: 'all', project_id: null, label_id: null }, { rerender: false });
      tasksView.mount(els.viewHost);
      break;
    case 'project':
      tasksView.setQuery({ scope: 'all', project_id: route.param, label_id: null }, { rerender: false });
      tasksView.mount(els.viewHost);
      sync.setViewing({ project_id: route.param });
      break;
    case 'view': {
      const saved = store.state.savedViews.find((v) => v.id === route.param);
      if (saved) tasksView.setQuery({ ...saved.query }, { rerender: false });
      tasksView.mount(els.viewHost);
      break;
    }
    case 'review':
      mountStatic(insights.renderReview());
      break;
    case 'insights':
      mountStatic(insights.renderInsights());
      break;
    case 'workload':
      mountStatic(insights.renderWorkload());
      break;
    case 'focus': {
      const content = el('div.content');
      els.viewHost.appendChild(content);
      insights.setFocusHost(content);
      content.appendChild(insights.renderFocus());
      break;
    }
    case 'activity':
      mountStatic(insights.renderActivity());
      break;
    case 'trash':
      mountStatic(insights.renderTrash());
      break;
    case 'templates':
      mountStatic(settingsView.renderTemplates());
      break;
    case 'automations':
      mountStatic(settingsView.renderAutomations());
      break;
    case 'settings':
      mountStatic(settingsView.renderSettings());
      break;
    default:
      navigate('today');
      return;
  }

  /* The route carries a task id, so the panel should be open — but this runs
     on every hashchange, including the one openTask itself causes. Reopening
     a panel that is already showing that task tore it down and rebuilt it on
     each pass, which is what made the URL and the panel fight each other. */
  if (parsed.task && !isOpen(parsed.task)) {
    setTimeout(() => openTask(parsed.task), 40);
  }

  if (changed) {
    announce(`${ROUTES[route.name]?.title || route.name} view`);
    document.title = `${ROUTES[route.name]?.title || 'MIKŌ'} · MIKŌ`;
  }
}

function mountStatic(node) {
  tasksView.unmount();
  const content = el('div.content', { id: 'view-content' });
  content.appendChild(node);
  els.viewHost.appendChild(content);
}

/* =============================== LIVE BITS =============================== */

function paintSync() {
  if (!els.sync) return;
  const s = sync.getStatus();
  const state = !s.online ? 'offline' : s.status;
  els.sync.dataset.state = state;
  clear(els.sync);
  els.sync.append(
    el('span.sync-dot'),
    el('span.desktop-only', {
      text:
        state === 'offline'
          ? 'Offline'
          : state === 'syncing'
          ? 'Saving…'
          : state === 'error'
          ? 'Sync issue'
          : 'Saved',
    })
  );
  els.sync.title =
    state === 'offline'
      ? 'Working offline — changes are saved on this device and will sync when you reconnect'
      : `${s.pending} pending ${s.pending === 1 ? 'change' : 'changes'}`;
}

function syncMenu(anchor) {
  const s = sync.getStatus();
  menu(anchor, [
    { label: s.remote ? 'Remote sync' : 'Local only', header: true },
    {
      label: navigator.onLine ? 'Online' : 'Offline',
      icon: navigator.onLine ? 'cloud' : 'offline',
      disabled: true,
    },
    { label: `${plural(s.pending, 'pending change')}`, icon: 'upload', disabled: true },
    'separator',
    {
      label: 'Retry failed changes',
      icon: 'restore',
      onClick: async () => {
        await sync.retryFailed();
        toast('Retrying');
      },
    },
    {
      label: 'Download a backup',
      icon: 'archive',
      onClick: async () => {
        const io = await import('../domain/io.js');
        const backup = await io.exportBackup();
        io.download(`miko-backup-${io.stamp()}.json`, JSON.stringify(backup), 'application/json');
      },
    },
  ]);
}

function paintPresence() {
  if (!els.presence) return;
  const peers = sync.listPeers();
  clear(els.presence);
  if (!peers.length) return;
  for (const p of peers.slice(0, 3)) {
    els.presence.appendChild(
      el('span.avatar.sm', {
        text: initials(p.user?.name || '?'),
        title: `${p.user?.name || 'Someone'} · another window`,
      })
    );
  }
  if (peers.length > 3) {
    els.presence.appendChild(el('span.avatar.sm', { text: `+${peers.length - 3}` }));
  }
}

function paintTimer() {
  if (!els.timerChip) return;
  const entry = rules.runningEntry();
  if (!entry) {
    els.timerChip.hidden = true;
    return;
  }
  const task = store.getTask(entry.task_id);
  const secs = Math.round((Date.now() - new Date(entry.started_at).getTime()) / 1000);
  els.timerChip.hidden = false;
  clear(els.timerChip);
  els.timerChip.append(
    el('span.c-accent', { html: icon('timer', { size: 13 }) }),
    el('span.t-mono', { text: clockTime(secs) }),
    el('span.desktop-only.truncate', {
      text: task?.title || '',
      style: { maxWidth: '110px' },
    })
  );
}

function wireLive() {
  sync.bus.on('status', paintSync);
  sync.bus.on('presence', paintPresence);
  window.addEventListener('online', paintSync);
  window.addEventListener('offline', paintSync);

  rules.bus.on('timer:tick', paintTimer);
  rules.bus.on('timer:started', paintTimer);
  rules.bus.on('timer:stopped', paintTimer);

  rules.bus.on('reminder:fired', ({ reminder, task }) => {
    toast(`Due: ${task.title}`, {
      duration: 12_000,
      kind: 'warn',
      action: {
        label: 'Snooze 10m',
        onClick: () => rules.snooze(reminder.id, 10),
      },
    });
  });

  rules.bus.on('automation:fired', ({ rule }) => {
    toast(`Rule "${rule.name}" ran`, { duration: 2500 });
  });

  store.bus.on('tasks:changed', debounce(() => {
    paintRail();
    if (isTaskRoute()) tasksView.render();
    else if (['review', 'insights', 'workload', 'trash', 'activity'].includes(route.name)) {
      applyRoute();
    }
  }, 60));

  store.bus.on('projects:changed', () => {
    paintRail();
    if (isTaskRoute()) tasksView.render();
  });
  store.bus.on('labels:changed', () => paintRail());
  store.bus.on('views:changed', () => paintRail());
  store.bus.on('workspace:changed', () => applyRoute());
  store.bus.on('profile:changed', () => {
    paintRail();
    applyRoute();
  });

  history.bus.on('changed', () => {
    /* the palette reads this on open; nothing to paint continuously */
  });

  sync.bus.on('conflict', ({ task, conflicts }) => {
    showConflict(task, conflicts);
  });

  window.addEventListener('miko:db-stale', () => {
    toast('MIKŌ was updated in another tab. Reload to continue.', {
      duration: 0,
      kind: 'warn',
      action: { label: 'Reload', onClick: () => location.reload() },
    });
  });
}

/* ============================== CONFLICTS ============================== */

function showConflict(task, conflicts) {
  const choices = new Map(conflicts.map((c) => [c.field, 'local']));

  const rows = conflicts.map((c) => {
    const render = (v) =>
      v == null || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : String(v).slice(0, 120);

    const localBtn = el('button.conflict-opt', {
      type: 'button',
      'aria-pressed': 'true',
      html: `<div class="t-eyebrow">This device</div><div>${esc(render(c.local))}</div>`,
    });
    const remoteBtn = el('button.conflict-opt', {
      type: 'button',
      'aria-pressed': 'false',
      html: `<div class="t-eyebrow">Elsewhere</div><div>${esc(render(c.remote))}</div>`,
    });

    localBtn.onclick = () => {
      choices.set(c.field, 'local');
      localBtn.setAttribute('aria-pressed', 'true');
      remoteBtn.setAttribute('aria-pressed', 'false');
    };
    remoteBtn.onclick = () => {
      choices.set(c.field, 'remote');
      remoteBtn.setAttribute('aria-pressed', 'true');
      localBtn.setAttribute('aria-pressed', 'false');
    };

    return el('div.conflict-row', {}, el('div.t-meta', { text: c.field }), localBtn, remoteBtn);
  });

  import('./kit.js').then(({ modal }) => {
    const m = modal({
      title: 'This task changed in two places',
      body: frag(
        el('p.hint', {
          text: `"${task.title}" was edited here and somewhere else. Pick which version to keep for each field.`,
        }),
        ...rows
      ),
      foot: frag(
        el('div.spacer'),
        el('button.btn.btn-primary', {
          type: 'button',
          text: 'Keep selected',
          onclick: async () => {
            const patch = {};
            for (const c of conflicts) {
              patch[c.field] = choices.get(c.field) === 'local' ? c.local : c.remote;
            }
            await store.updateTask(task.id, patch);
            m.close();
            toast('Conflict resolved', { kind: 'success' });
          },
        })
      ),
    });
  });
}

/* ============================== ONBOARDING ============================== */

export async function maybeOnboard() {
  if (store.getSetting('onboarded', false)) return;
  if (store.allTasks().length > 3) {
    await store.setSetting('onboarded', true);
    return;
  }

  const { modal } = await import('./kit.js');
  const steps = [
    ['Add your first task', 'Type naturally — "call the bank tomorrow 3pm !high" fills in the date and priority for you.'],
    ['Press ⌘K for anything', 'Every command, project and task is one keystroke away.'],
    ['Works offline', 'Everything is stored on your device. Close the tab, lose signal — it keeps working.'],
  ];

  const m = modal({
    title: 'Welcome to MIKŌ',
    size: 'sm',
    body: frag(
      el('p.t-body', { text: 'Three things worth knowing before you start.' }),
      el('div.onboard', {},
        ...steps.map(([title, body], i) =>
          el('div.onboard-step', {},
            el('span.onboard-num', { text: String(i + 1) }),
            el('div', {}, el('div.t-sub', { text: title }), el('div.hint', { text: body }))
          )
        )
      )
    ),
    foot: frag(
      el('div.spacer'),
      el('button.btn.btn-primary', {
        type: 'button',
        text: 'Get started',
        onclick: async () => {
          await store.setSetting('onboarded', true);
          m.close();
          tasksView.focusQuickAdd();
        },
      })
    ),
    onClose: () => store.setSetting('onboarded', true),
  });
}

export function refreshRail() {
  paintRail();
}

export function getEls() {
  return els;
}
