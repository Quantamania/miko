/* Settings, Templates, Automations, and the data controls. */

import * as store from '../core/store.js';
import * as db from '../core/db.js';
import * as sync from '../core/sync.js';
import * as rules from '../domain/rules.js';
import * as io from '../domain/io.js';
import * as ai from '../domain/ai.js';
import * as auth from '../core/auth.js';
import {
  id,
  nowISO,
  localZone,
  plural,
  hashColor,
  fmtRelative,
  fmtDuration,
  esc,
} from '../core/util.js';
import { icon } from '../ui/icons.js';
import {
  el,
  frag,
  clear,
  modal,
  confirm,
  promptText,
  toast,
  menu,
  emptyState,
  copyText,
  spinner,
  $,
  $$,
} from '../ui/kit.js';

/* ============================== SETTINGS ============================== */

const PANELS = [
  ['account', 'Account'],
  ['profile', 'Profile'],
  ['appearance', 'Appearance'],
  ['workflow', 'Workflow'],
  ['notifications', 'Notifications'],
  ['assistant', 'Assistant'],
  ['projects', 'Projects & labels'],
  ['team', 'Team'],
  ['integrations', 'Integrations'],
  ['data', 'Data & privacy'],
  ['about', 'About'],
];

let activePanel = 'account';

export function renderSettings(startPanel) {
  if (startPanel) activePanel = startPanel;
  const pad = el('div.content-pad');
  const grid = el('div.settings-grid');

  const nav = el('nav.settings-nav', { 'aria-label': 'Settings sections' });
  const body = el('div');

  for (const [key, label] of PANELS) {
    nav.appendChild(
      el('button', {
        type: 'button',
        text: label,
        'aria-current': activePanel === key ? 'true' : null,
        onclick: () => {
          activePanel = key;
          clear(body);
          body.appendChild(panel(key));
          for (const b of $$('button', nav)) {
            b.setAttribute('aria-current', b.textContent === label ? 'true' : 'false');
          }
        },
      })
    );
  }

  body.appendChild(panel(activePanel));
  grid.append(nav, body);
  pad.appendChild(grid);
  return pad;
}

function block(title, description, ...children) {
  return el(
    'section.settings-block',
    {},
    el('h2.t-title', { text: title }),
    description ? el('p.hint', { style: { marginTop: '4px' }, text: description }) : null,
    el('div', { style: { marginTop: 'var(--s4)' } }, ...children)
  );
}

function switchRow(label, description, checked, onChange) {
  const input = el('input', { type: 'checkbox', checked: checked || null });
  input.addEventListener('change', () => onChange(input.checked));
  return el(
    'div.switch-row',
    {},
    el('div', {}, el('div.t-body', { text: label }), description ? el('div.hint', { text: description }) : null),
    el('label.switch', {}, input, el('span'))
  );
}

function panel(key) {
  switch (key) {
    case 'account':
      return accountPanel();
    case 'profile':
      return profilePanel();
    case 'appearance':
      return appearancePanel();
    case 'workflow':
      return workflowPanel();
    case 'notifications':
      return notificationsPanel();
    case 'assistant':
      return assistantPanel();
    case 'projects':
      return projectsPanel();
    case 'team':
      return teamPanel();
    case 'integrations':
      return integrationsPanel();
    case 'data':
      return dataPanel();
    default:
      return aboutPanel();
  }
}

/* ------------------------------- account ------------------------------- */

function accountPanel() {
  const session = auth.currentSession();
  const user = store.state.user;

  const cfg = auth.backendConfig();
  // Preview mode applies settings in memory but never writes them, so saving a
  // project here would appear to work and be gone after the reload. Say so
  // rather than letting it fail silently.
  const previewing = store.isReadOnly();
  const sbUrl = el('input.input', {
    type: 'url',
    placeholder: 'https://your-project.supabase.co',
    autocomplete: 'off',
    spellcheck: 'false',
    value: cfg.url || '',
    disabled: cfg.fromSource || previewing,
  });
  const sbKey = el('input.input', {
    type: 'password',
    placeholder: cfg.hasKey ? '•••••••• (saved)' : 'anon public key',
    autocomplete: 'off',
    spellcheck: 'false',
    disabled: cfg.fromSource || previewing,
  });

  const clientId = el('input.input', {
    type: 'text',
    placeholder: '1234567890-abc.apps.googleusercontent.com',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  auth.getClientId().then((v) => {
    clientId.value = v;
  });

  const identity = el(
    'div.card.card-pad',
    {},
    el(
      'div.row',
      {},
      user?.avatar
        ? el('img', {
            src: user.avatar,
            alt: '',
            referrerpolicy: 'no-referrer',
            style: { width: '40px', height: '40px', borderRadius: '50%' },
          })
        : el('span.avatar', { text: (user?.name || '?').slice(0, 2).toUpperCase(), style: { width: '40px', height: '40px', fontSize: '14px' } }),
      el(
        'div',
        { style: { flex: '1', minWidth: '0' } },
        el('div.t-sub', { text: user?.name || 'You' }),
        el('div.hint', { text: session?.email || user?.email || 'No email on file' })
      ),
      el('span.badge', {
        class: session?.provider === 'google' ? 'badge-info' : 'badge-neutral',
        text: session ? (session.provider === 'google' ? 'Google' : 'Email') : 'Not signed in',
      })
    )
  );

  return frag(
    block('Signed in as', null, identity,
      el(
        'div.row-wrap',
        { style: { marginTop: 'var(--s4)' } },
        el(
          'button.btn.btn-sm',
          {
            type: 'button',
            onclick: async () => {
              const ok = await confirm({
                title: 'Sign out?',
                message: 'Your tasks stay on this device. You can sign back in at any time.',
                confirmLabel: 'Sign out',
              });
              if (ok) await auth.signOut();
            },
          },
          el('span', { html: icon('lock', { size: 13 }) }),
          el('span', { text: 'Sign out' })
        ),
        el(
          'button.btn.btn-sm',
          {
            type: 'button',
            onclick: async () => {
              const ok = await confirm({
                title: 'Sign out and forget me?',
                message:
                  'Clears your name, email and avatar from this device. **Your tasks are not deleted** — use Data & privacy for that.',
                confirmLabel: 'Sign out and forget',
                danger: true,
              });
              if (ok) await auth.signOut({ forget: true });
            },
          },
          el('span', { text: 'Sign out and forget me' })
        )
      )
    ),

    block(
      'Account server',
      previewing
        ? 'Not available in preview — preview never writes anything down. Sign in first, then come back.'
        : cfg.fromSource
        ? 'Configured in js/config.js, which is what a deployed copy uses. Clear it there to override here.'
        : 'Point this browser at a Supabase project to turn on real accounts and sync. Stored on this device only — for a deployed copy, put the same values in js/config.js so visitors can sign in too.',
      el('label.field', {}, el('span', { text: 'Project URL' }), sbUrl),
      el('label.field', {}, el('span', { text: 'Anon public key' }), sbKey),
      el(
        'div.row',
        { style: { marginTop: 'var(--s3)' } },
        el('button.btn.btn-primary', {
          type: 'button',
          text: 'Save and connect',
          disabled: cfg.fromSource || previewing,
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              const okCfg = await auth.setBackendConfig({ url: sbUrl.value, key: sbKey.value });
              if (!okCfg) {
                toast('Enter both the project URL and the anon key.', { kind: 'error' });
                btn.disabled = false;
                return;
              }
              toast('Connected. Sign in to start syncing.', { kind: 'success' });
              setTimeout(() => location.reload(), 700);
            } catch (err) {
              toast(err.message, { kind: 'error' });
              btn.disabled = false;
            }
          },
        }),
        el('div.spacer'),
        el('button.btn', {
          type: 'button',
          text: 'Clear',
          disabled: cfg.fromSource || previewing,
          onclick: async () => {
            await auth.setBackendConfig({ url: '', key: '' });
            toast('Account server cleared — back to local-only.', { kind: 'success' });
            setTimeout(() => location.reload(), 700);
          },
        })
      ),
      el('p.hint', {
        style: { marginTop: 'var(--s3)' },
        text: 'The anon key is safe in a browser: Row Level Security decides what it can read. Never paste the service_role key here.',
      })
    ),

    block(
      'Google sign-in',
      auth.isBackendConfigured()
        ? 'Handled by Supabase while an account server is set — enable Google under Authentication → Providers there. This client ID is only used without one.'
        : 'Optional. Without a client ID or an account server, MIKŌ offers email sign-in only.',
      el('label.field', {}, el('span', { text: 'Google OAuth client ID' }),
        el('div.row', {}, clientId,
          el('button.btn', {
            type: 'button',
            text: 'Save',
            onclick: async () => {
              await auth.setClientId(clientId.value);
              toast(clientId.value ? 'Client ID saved' : 'Client ID removed', { kind: 'success' });
            },
          })
        )
      ),
      el(
        'div.card.card-pad',
        { style: { marginTop: 'var(--s4)' } },
        el('div.t-sub', { text: 'How to get one' }),
        el('ol', { style: { margin: 'var(--s2) 0 0 18px', listStyle: 'decimal' } },
          el('li.t-body', { html: 'Open <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Google Cloud → Credentials</a>.' }),
          el('li.t-body', { text: 'Create an OAuth 2.0 Client ID of type “Web application”.' }),
          el('li.t-body', { html: `Add <code>${esc(location.origin)}</code> under Authorised JavaScript origins.` }),
          el('li.t-body', { text: 'Paste the client ID above.' })
        ),
        el('p.hint', {
          style: { marginTop: 'var(--s3)' },
          text: 'The origin must match exactly — a different port or a bare IP will be rejected by Google.',
        })
      )
    ),

    block(
      'What sign-in does here',
      null,
      el(
        'div.card.card-pad',
        {},
        el(
          'div.row',
          { style: { alignItems: 'flex-start', gap: 'var(--s3)' } },
          el('span.c-warn', { html: icon('warning') }),
          el('div.t-body', {
            html:
              'Sign-in names your work — it is <b>not</b> a security boundary. MIKŌ has no server, so nobody can verify an identity ' +
              'or withhold data from someone using this browser: your tasks live in IndexedDB on this device and are reachable from devtools either way. ' +
              'Google returns a genuinely signed token; validating that signature and issuing a real session is the one job that needs a backend.',
          })
        )
      )
    )
  );
}

/* ------------------------------- profile ------------------------------- */

function profilePanel() {
  const user = store.state.user;
  const name = el('input.input', { type: 'text', value: user.name || '' });
  const email = el('input.input', { type: 'email', value: user.email || '', placeholder: 'you@example.com' });
  const handle = el('input.input', { type: 'text', value: user.handle || '', placeholder: 'used for @mentions' });

  const zones = (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [localZone()]) || [];
  const tz = el('select.select');
  for (const z of zones.length ? zones : [localZone()]) {
    tz.appendChild(el('option', { value: z, selected: z === user.timezone || null, text: z }));
  }

  const save = async () => {
    const next = {
      ...user,
      name: name.value.trim() || 'You',
      email: email.value.trim(),
      handle: handle.value.trim().replace(/^@/, ''),
      timezone: tz.value,
    };
    await db.put('users', next);
    store.state.user = next;
    store.state.members = store.state.members.map((m) =>
      m.user_id === next.id ? { ...m, user: next } : m
    );
    const { setZone } = await import('../core/util.js');
    setZone(next.timezone);
    store.bus.emit('profile:changed', next);
    toast('Profile saved', { kind: 'success' });
  };

  for (const input of [name, email, handle]) input.addEventListener('change', save);
  tz.addEventListener('change', save);

  return frag(
    block(
      'Profile',
      'Who you are in this workspace.',
      el('div.grid.grid-2',
        {},
        el('label.field', {}, el('span', { text: 'Name' }), name),
        el('label.field', {}, el('span', { text: 'Email' }), email),
        el('label.field', {}, el('span', { text: 'Handle' }), handle),
        el('label.field', {}, el('span', { text: 'Timezone' }), tz)
      ),
      el('p.hint', {
        style: { marginTop: 'var(--s3)' },
        text: 'All times are stored in UTC and displayed in your timezone. Changing it re-renders every date without touching the stored data.',
      })
    ),
    block(
      'Workspace',
      null,
      el('label.field', {}, el('span', { text: 'Workspace name' }),
        (() => {
          const input = el('input.input', { type: 'text', value: store.state.workspace.name });
          input.addEventListener('change', async () => {
            const next = { ...store.state.workspace, name: input.value.trim() || 'Workspace' };
            await db.put('workspaces', next);
            store.state.workspace = next;
            store.bus.emit('workspace:changed', next);
            toast('Workspace renamed', { kind: 'success' });
          });
          return input;
        })()
      )
    )
  );
}

/* ------------------------------ appearance ------------------------------ */

function appearancePanel() {
  const themeRow = el('div.seg', { role: 'group', 'aria-label': 'Theme' });
  for (const [value, label, iconName] of [
    ['light', 'Light', 'sun'],
    ['dark', 'Dark', 'moon'],
    ['system', 'System', 'panel'],
  ]) {
    themeRow.appendChild(
      el('button', {
        type: 'button',
        'aria-pressed': String(store.getSetting('theme', 'system') === value),
        html: `${icon(iconName, { size: 13 })}<span>${label}</span>`,
        onclick: async () => {
          await store.setSetting('theme', value);
          applyTheme(value);
          for (const b of $$('button', themeRow)) {
            b.setAttribute('aria-pressed', String(b.textContent.trim() === label));
          }
        },
      })
    );
  }

  const densityRow = el('div.seg', { role: 'group', 'aria-label': 'Density' });
  for (const [value, label] of [
    ['comfortable', 'Comfortable'],
    ['compact', 'Compact'],
  ]) {
    densityRow.appendChild(
      el('button', {
        type: 'button',
        'aria-pressed': String(store.getSetting('density', 'comfortable') === value),
        text: label,
        onclick: async () => {
          await store.setSetting('density', value);
          document.documentElement.dataset.density = value;
          for (const b of $$('button', densityRow)) {
            b.setAttribute('aria-pressed', String(b.textContent === label));
          }
        },
      })
    );
  }

  return frag(
    block('Theme', 'Follows your operating system unless you choose otherwise.', themeRow),
    block('Density', 'How much vertical space each row takes.', densityRow),
    block(
      'Defaults',
      null,
      switchRow(
        'Show completed tasks',
        'Keep finished tasks visible in lists instead of hiding them.',
        store.getSetting('showCompleted', false),
        (v) => store.setSetting('showCompleted', v)
      )
    )
  );
}

export function applyTheme(mode) {
  const value = mode || store.getSetting('theme', 'system');
  if (value === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = value;

  const dark =
    value === 'dark' ||
    (value === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#0d0e10' : '#faf9f7');
}

/* ------------------------------- workflow ------------------------------- */

function workflowPanel() {
  const hours = store.getSetting('workingHours', { start: 9, end: 17 });

  const num = (value, min, max, onChange) => {
    const input = el('input.input', { type: 'number', value: String(value), min: String(min), max: String(max) });
    input.addEventListener('change', () => onChange(Number(input.value)));
    return input;
  };

  return frag(
    block(
      'Working hours',
      'Used when suggesting when to do a task.',
      el(
        'div.grid.grid-2',
        {},
        el('label.field', {}, el('span', { text: 'Start' }),
          num(hours.start, 0, 23, (v) => store.setSetting('workingHours', { ...hours, start: v }))),
        el('label.field', {}, el('span', { text: 'End' }),
          num(hours.end, 1, 24, (v) => store.setSetting('workingHours', { ...hours, end: v })))
      )
    ),
    block(
      'Capacity',
      'How much focused work fits in a day. Drives the workload view and scheduling suggestions.',
      el('label.field', { style: { maxWidth: '240px' } }, el('span', { text: 'Minutes per day' }),
        num(store.getSetting('dailyCapacityMin', 360), 30, 960, (v) =>
          store.setSetting('dailyCapacityMin', v)
        ))
    ),
    block(
      'Focus timer',
      null,
      el(
        'div.grid.grid-2',
        {},
        el('label.field', {}, el('span', { text: 'Focus block (min)' }),
          num(store.getSetting('pomodoroMin', 25), 5, 120, (v) => store.setSetting('pomodoroMin', v))),
        el('label.field', {}, el('span', { text: 'Break (min)' }),
          num(store.getSetting('pomodoroBreakMin', 5), 1, 60, (v) =>
            store.setSetting('pomodoroBreakMin', v)
          ))
      )
    )
  );
}

/* ----------------------------- notifications ----------------------------- */

function notificationsPanel() {
  const permission = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';

  const statusNode = el('div.row', {},
    el('span.badge', {
      class:
        permission === 'granted' ? 'badge-ok' : permission === 'denied' ? 'badge-danger' : 'badge-neutral',
      text:
        permission === 'granted'
          ? 'Allowed'
          : permission === 'denied'
          ? 'Blocked by the browser'
          : permission === 'unsupported'
          ? 'Not supported here'
          : 'Not asked yet',
    }),
    permission === 'default'
      ? el('button.btn.btn-sm', {
          type: 'button',
          text: 'Enable notifications',
          onclick: async () => {
            const res = await rules.requestNotifications();
            toast(res === 'granted' ? 'Notifications enabled' : 'Permission not granted', {
              kind: res === 'granted' ? 'success' : 'warn',
            });
          },
        })
      : null
  );

  const lead = el('input.input', {
    type: 'number',
    min: '0',
    max: '1440',
    value: String(store.getSetting('reminderLeadMin', 10)),
    style: { maxWidth: '120px' },
  });
  lead.addEventListener('change', () => store.setSetting('reminderLeadMin', Number(lead.value)));

  return frag(
    block('Browser notifications', 'Reminders fire even when MIKŌ is in a background tab.', statusNode),
    block(
      'Reminders',
      null,
      switchRow(
        'Remind me about due tasks',
        'A notification shortly before each task is due.',
        store.getSetting('notifications', true),
        (v) => store.setSetting('notifications', v)
      ),
      el('label.field', { style: { marginTop: 'var(--s3)' } },
        el('span', { text: 'Minutes before due' }), lead)
    ),
    block(
      'Per-project',
      'Mute projects you do not want reminders from.',
      ...store.state.projects.map((p) =>
        switchRow(
          p.name,
          null,
          store.getSetting(`notify:${p.id}`, true),
          (v) => store.setSetting(`notify:${p.id}`, v)
        )
      ),
      store.state.projects.length ? null : el('div.hint', { text: 'No projects yet.' })
    ),
    el('p.hint', {
      style: { marginTop: 'var(--s5)' },
      text: 'Push notifications to a phone that is not running MIKŌ need a server to hold the push subscription and send messages — see the README for what that requires.',
    })
  );
}

/* ------------------------------- assistant ------------------------------- */

function assistantPanel() {
  const keyInput = el('input.input', {
    type: 'password',
    placeholder: 'sk-ant-…',
    autocomplete: 'off',
    spellcheck: 'false',
  });

  ai.getKey().then((k) => {
    if (k) keyInput.value = k;
  });

  const modelSelect = el('select.select');
  for (const m of ai.MODELS) {
    modelSelect.appendChild(
      el('option', {
        value: m.id,
        selected: store.getSetting('aiModel', ai.DEFAULT_MODEL) === m.id || null,
        text: `${m.label} — ${m.note}`,
      })
    );
  }
  modelSelect.addEventListener('change', () => store.setSetting('aiModel', modelSelect.value));

  const status = el('div.hint');

  return frag(
    block(
      'Assistant',
      'Without a key, MIKŌ answers from your own data — priorities, plans, what is overdue. With a key, it can also handle open-ended questions.',
      switchRow(
        'Use Claude',
        'Send task context to the Anthropic API for richer answers.',
        store.getSetting('aiEnabled', false),
        async (v) => {
          await store.setSetting('aiEnabled', v);
          store.bus.emit('ai:changed');
        }
      ),
      el('label.field', { style: { marginTop: 'var(--s4)' } },
        el('span', { text: 'Anthropic API key' }),
        el('div.row', {}, keyInput,
          el('button.btn', {
            type: 'button',
            text: 'Save',
            onclick: async () => {
              await ai.setKey(keyInput.value);
              status.textContent = keyInput.value ? 'Key saved on this device.' : 'Key removed.';
              toast(keyInput.value ? 'API key saved' : 'API key removed', { kind: 'success' });
            },
          }),
          el('button.btn', {
            type: 'button',
            text: 'Test',
            onclick: async (e) => {
              const btn = e.currentTarget;
              btn.disabled = true;
              clear(status);
              status.appendChild(spinner());
              status.append(' Checking…');
              try {
                await ai.setKey(keyInput.value);
                const reply = await ai.askClaude([{ role: 'user', content: 'Reply with the single word: ready' }], {
                  maxTokens: 16,
                });
                status.textContent = `Working — model replied "${reply.slice(0, 40)}".`;
                toast('Connection works', { kind: 'success' });
              } catch (err) {
                status.textContent = err.message;
                toast(err.message, { kind: 'error' });
              } finally {
                btn.disabled = false;
              }
            },
          })
        ),
        status
      ),
      el('label.field', { style: { marginTop: 'var(--s4)' } }, el('span', { text: 'Model' }), modelSelect)
    ),
    block(
      'About the key',
      null,
      el('div.card.card-pad', {},
        el('div.row', { style: { alignItems: 'flex-start', gap: 'var(--s3)' } },
          el('span.c-warn', { html: icon('warning') }),
          el('div.t-body', {
            html:
              'A key stored in a browser is readable by anything running in this browser profile, including extensions. ' +
              'Use a key scoped to a workspace you can revoke, and do not use a production key here. ' +
              'The durable fix is a small server that holds the key and proxies requests — MIKŌ is built to point at one without other changes.',
          })
        )
      )
    )
  );
}

/* ------------------------------- projects ------------------------------- */

function projectsPanel() {
  const projectList = el('div.col');
  const labelList = el('div.row-wrap');

  const paint = () => {
    clear(projectList);
    if (!store.state.projects.length) {
      projectList.appendChild(el('div.hint', { text: 'No projects yet.' }));
    }
    for (const p of store.state.projects) {
      const count = store.allTasks().filter((t) => t.project_id === p.id).length;
      projectList.appendChild(
        el(
          'div.row',
          { style: { padding: 'var(--s2) 0', borderTop: '1px solid var(--line-soft)' } },
          el('span', { text: p.name, style: { flex: '1' } }),
          el('span.t-meta', { text: plural(count, 'task') }),
          el('button.icon-btn.sm', {
            type: 'button',
            'aria-label': `Options for ${p.name}`,
            html: icon('more'),
            onclick: (e) =>
              menu(e.currentTarget, [
                {
                  label: 'Rename',
                  icon: 'edit',
                  onClick: async () => {
                    const name = await promptText({ title: 'Rename project', label: 'Name', value: p.name });
                    if (name) {
                      await store.updateProject(p.id, { name });
                      paint();
                    }
                  },
                },
                {
                  label: 'Change colour',
                  icon: 'label',
                  onClick: (ev) =>
                    menu(
                      ev.currentTarget || e.currentTarget,
                      COLORS.map((c) => ({
                        label: c.name,
                        color: c.value,
                        onClick: async () => {
                          await store.updateProject(p.id, { color: c.value });
                          paint();
                        },
                      }))
                    ),
                },
                'separator',
                {
                  label: 'Delete project',
                  icon: 'trash',
                  danger: true,
                  onClick: async () => {
                    const ok = await confirm({
                      title: `Delete "${p.name}"?`,
                      message: count
                        ? `Its ${plural(count, 'task')} will stay, but lose their project.`
                        : 'This project has no tasks.',
                      confirmLabel: 'Delete project',
                      danger: true,
                    });
                    if (!ok) return;
                    await store.deleteProject(p.id);
                    paint();
                    toast('Project deleted');
                  },
                },
              ]),
          })
        )
      );
    }

    clear(labelList);
    for (const l of store.state.labels) {
      labelList.appendChild(
        el(
          'span.chip',
          {},
          el('span.chip-dot', { style: { background: l.color || hashColor(l.name) } }),
          el('span', { text: l.name }),
          el('button.chip-x', {
            type: 'button',
            'aria-label': `Delete label ${l.name}`,
            html: icon('x'),
            onclick: async () => {
              const used = store.allTasks().filter((t) => (t.labels || []).includes(l.id)).length;
              const ok = await confirm({
                title: `Delete "${l.name}"?`,
                message: used ? `It will be removed from ${plural(used, 'task')}.` : '',
                confirmLabel: 'Delete',
                danger: true,
              });
              if (!ok) return;
              await store.deleteLabel(l.id);
              paint();
            },
          })
        )
      );
    }
    if (!store.state.labels.length) labelList.appendChild(el('span.hint', { text: 'No labels yet.' }));
  };

  paint();

  return frag(
    block(
      'Projects',
      null,
      projectList,
      el(
        'button.btn.btn-sm',
        {
          type: 'button',
          style: { marginTop: 'var(--s3)' },
          onclick: async () => {
            const name = await promptText({ title: 'New project', label: 'Name', confirmLabel: 'Create' });
            if (!name) return;
            await store.createProject({ name, color: hashColor(name) });
            paint();
          },
        },
        el('span', { html: icon('plus', { size: 13 }) }),
        el('span', { text: 'New project' })
      )
    ),
    block(
      'Labels',
      null,
      labelList,
      el(
        'button.btn.btn-sm',
        {
          type: 'button',
          style: { marginTop: 'var(--s3)' },
          onclick: async () => {
            const name = await promptText({ title: 'New label', label: 'Name', confirmLabel: 'Create' });
            if (!name) return;
            await store.createLabel(name, hashColor(name));
            paint();
          },
        },
        el('span', { html: icon('plus', { size: 13 }) }),
        el('span', { text: 'New label' })
      )
    )
  );
}

const COLORS = [
  { name: 'Rust', value: 'hsl(20 62% 45%)' },
  { name: 'Amber', value: 'hsl(38 70% 45%)' },
  { name: 'Olive', value: 'hsl(80 40% 38%)' },
  { name: 'Green', value: 'hsl(150 45% 38%)' },
  { name: 'Teal', value: 'hsl(184 45% 38%)' },
  { name: 'Blue', value: 'hsl(212 55% 48%)' },
  { name: 'Indigo', value: 'hsl(250 45% 55%)' },
  { name: 'Plum', value: 'hsl(292 35% 48%)' },
  { name: 'Rose', value: 'hsl(340 55% 52%)' },
  { name: 'Slate', value: 'hsl(215 12% 48%)' },
];

/* --------------------------------- team --------------------------------- */

function teamPanel() {
  const list = el('div.col');

  for (const m of store.state.members) {
    const isMe = m.user_id === store.state.user.id;
    list.appendChild(
      el(
        'div.row',
        { style: { padding: 'var(--s3) 0', borderTop: '1px solid var(--line-soft)' } },
        el('span.avatar', { text: (m.user?.name || '?').slice(0, 2).toUpperCase() }),
        el(
          'div',
          { style: { flex: '1' } },
          el('div.t-body', { text: `${m.user?.name || m.user_id}${isMe ? ' (you)' : ''}` }),
          el('div.hint', { text: m.user?.email || 'No email' })
        ),
        el('span.badge.badge-neutral', { text: m.role })
      )
    );
  }

  return frag(
    block('Members', `${plural(store.state.members.length, 'person')} in this workspace.`, list),
    block(
      'Roles',
      'What each role can do. Enforced in the interface today; a server is required to enforce it for real.',
      el(
        'table.table',
        {},
        el('thead', {}, el('tr', {},
          el('th', { text: 'Role' }),
          el('th', { text: 'Can do' })
        )),
        el('tbody', {},
          el('tr', {}, el('td', { text: 'Owner' }), el('td.muted', { text: 'Everything, including deleting the workspace' })),
          el('tr', {}, el('td', { text: 'Admin' }), el('td.muted', { text: 'Manage tasks, projects, automations, invite people' })),
          el('tr', {}, el('td', { text: 'Editor' }), el('td.muted', { text: 'Create, edit and delete tasks; comment' })),
          el('tr', {}, el('td', { text: 'Viewer' }), el('td.muted', { text: 'Read and comment only' }))
        )
      )
    ),
    block(
      'Inviting people',
      null,
      el('div.card.card-pad', {},
        el('div.row', { style: { alignItems: 'flex-start', gap: 'var(--s3)' } },
          el('span.faint', { html: icon('info') }),
          el('div.t-body', {
            text:
              'Invites need a server: somewhere to hold the shared workspace, authenticate the other person, and enforce their role. ' +
              'Until then, MIKŌ is single-user per device — use Export to hand work to someone else.',
          })
        )
      )
    )
  );
}

/* ----------------------------- integrations ----------------------------- */

function integrationsPanel() {
  const list = el('div.col');

  const paint = async () => {
    clear(list);
    const hooks = await rules.listWebhooks();
    if (!hooks.length) {
      list.appendChild(el('div.hint', { text: 'No webhooks yet.' }));
      return;
    }
    for (const h of hooks) {
      list.appendChild(
        el(
          'div.row',
          { style: { padding: 'var(--s2) 0', borderTop: '1px solid var(--line-soft)' } },
          el('span', { html: icon(h.enabled ? 'cloud' : 'offline'), class: h.enabled ? 'c-ok' : 'faint' }),
          el('div', { style: { flex: '1', minWidth: '0' } },
            el('div.t-mono.truncate', { text: h.url }),
            el('div.hint', { text: h.events?.length ? h.events.join(', ') : 'all events' })
          ),
          el('button.icon-btn.sm', {
            type: 'button',
            'aria-label': 'Delete webhook',
            html: icon('trash'),
            onclick: async () => {
              await rules.deleteWebhook(h.id);
              paint();
            },
          })
        )
      );
    }
  };
  paint();

  return frag(
    block(
      'Outgoing webhooks',
      'MIKŌ POSTs a JSON payload to your URL when tasks change. Useful for Slack, Zapier, Make, or your own endpoint.',
      list,
      el(
        'button.btn.btn-sm',
        {
          type: 'button',
          style: { marginTop: 'var(--s3)' },
          onclick: async () => {
            const url = await promptText({
              title: 'New webhook',
              label: 'URL',
              placeholder: 'https://hooks.example.com/…',
              confirmLabel: 'Add',
            });
            if (!url) return;
            if (!/^https:\/\//i.test(url)) {
              toast('Webhook URLs must use https', { kind: 'error' });
              return;
            }
            await rules.saveWebhook({
              id: id('whk'),
              workspace_id: store.state.workspace.id,
              url,
              events: [],
              secret: '',
              enabled: true,
              created_at: nowISO(),
            });
            paint();
          },
        },
        el('span', { html: icon('plus', { size: 13 }) }),
        el('span', { text: 'Add webhook' })
      ),
      el('p.hint', {
        style: { marginTop: 'var(--s3)' },
        text: 'The endpoint must send permissive CORS headers, since the request comes from your browser rather than a server.',
      })
    ),
    block(
      'Calendar',
      'Export your due dates to any calendar app.',
      el(
        'button.btn.btn-sm',
        {
          type: 'button',
          onclick: () => {
            io.download(`miko-calendar-${io.stamp()}.ics`, io.exportICS(), 'text/calendar');
            toast('Calendar file downloaded', { kind: 'success' });
          },
        },
        el('span', { html: icon('calendar', { size: 13 }) }),
        el('span', { text: 'Download .ics' })
      ),
      el('p.hint', {
        style: { marginTop: 'var(--s3)' },
        text: 'Two-way sync with Google Calendar or Outlook needs OAuth and a server to hold the refresh token, so it is out of reach for a static site.',
      })
    ),
    block(
      'REST API',
      null,
      el('div.card.card-pad', {},
        el('div.t-body', {
          text:
            'A public API needs a server to host it and to authenticate API keys. MIKŌ\'s data layer is already shaped for it — the repository functions map one-to-one onto REST resources.',
        })
      )
    )
  );
}

/* --------------------------------- data --------------------------------- */

function dataPanel() {
  const usageNode = el('div.hint');
  db.usage().then((u) => {
    if (!u) return;
    usageNode.textContent = `Using ${(u.used / 1048576).toFixed(1)} MB of roughly ${(
      u.quota / 1048576
    ).toFixed(0)} MB available to this site.`;
  });

  const exportBtn = (label, iconName, fn) =>
    el('button.btn.btn-sm', { type: 'button', onclick: fn },
      el('span', { html: icon(iconName, { size: 13 }) }), el('span', { text: label }));

  return frag(
    block(
      'Export',
      'Everything, in formats you can read without MIKŌ.',
      el(
        'div.row-wrap',
        {},
        exportBtn('Tasks (CSV)', 'download', () => {
          io.download(`miko-tasks-${io.stamp()}.csv`, io.exportTasksCSV(), 'text/csv');
          toast('CSV downloaded', { kind: 'success' });
        }),
        exportBtn('Tasks (JSON)', 'download', () => {
          io.download(
            `miko-tasks-${io.stamp()}.json`,
            JSON.stringify(io.exportTasksJSON(), null, 2),
            'application/json'
          );
          toast('JSON downloaded', { kind: 'success' });
        }),
        exportBtn('Calendar (ICS)', 'calendar', () => {
          io.download(`miko-calendar-${io.stamp()}.ics`, io.exportICS(), 'text/calendar');
        }),
        exportBtn('Audit log (CSV)', 'activity', async () => {
          io.download(`miko-audit-${io.stamp()}.csv`, await io.exportAuditCSV(), 'text/csv');
        }),
        exportBtn('Full backup', 'archive', async () => {
          const backup = await io.exportBackup();
          io.download(
            `miko-backup-${io.stamp()}.json`,
            JSON.stringify(backup),
            'application/json'
          );
          toast('Backup downloaded', { kind: 'success' });
        })
      )
    ),
    block(
      'Import',
      'CSV from another task app, or a MIKŌ backup.',
      el(
        'div.row-wrap',
        {},
        el(
          'button.btn.btn-sm',
          { type: 'button', onclick: importCSVFlow },
          el('span', { html: icon('upload', { size: 13 }) }),
          el('span', { text: 'Import CSV' })
        ),
        el(
          'button.btn.btn-sm',
          { type: 'button', onclick: importBackupFlow },
          el('span', { html: icon('restore', { size: 13 }) }),
          el('span', { text: 'Restore backup' })
        )
      )
    ),
    block('Storage', null, usageNode,
      el('button.btn.btn-sm', {
        type: 'button',
        style: { marginTop: 'var(--s3)' },
        text: 'Ask browser to keep this data',
        onclick: async () => {
          const ok = await db.persist();
          toast(ok ? 'Storage marked as persistent' : 'The browser declined', {
            kind: ok ? 'success' : 'warn',
          });
        },
      })
    ),
    block(
      'Delete',
      null,
      el(
        'div.danger-zone',
        {},
        el('div.t-sub', { text: 'Delete everything' }),
        el('p.hint', {
          style: { margin: 'var(--s2) 0 var(--s3)' },
          text: 'Removes every task, project, comment, attachment and event from this device. Export first if you want a copy.',
        }),
        el(
          'button.btn.btn-danger',
          {
            type: 'button',
            onclick: async () => {
              const ok = await confirm({
                title: 'Delete all data?',
                message:
                  'This erases the MIKŌ database on this device. **It cannot be undone.** Download a backup first if you might want it back.',
                confirmLabel: 'Delete everything',
                danger: true,
              });
              if (!ok) return;
              const typed = await promptText({
                title: 'Type DELETE to confirm',
                label: 'Confirmation',
                confirmLabel: 'Delete',
              });
              if (typed !== 'DELETE') {
                toast('Cancelled — nothing was deleted');
                return;
              }
              await db.destroy();
              location.reload();
            },
          },
          el('span', { html: icon('trash', { size: 13 }) }),
          el('span', { text: 'Delete all data' })
        )
      )
    )
  );
}

async function importCSVFlow() {
  const file = await io.pickFile('.csv,text/csv');
  if (!file) return;
  const text = await io.readFile(file);
  const { rows, errors } = io.previewCSV(text);

  if (errors.length) {
    toast(errors[0], { kind: 'error' });
    return;
  }
  if (!rows.length) {
    toast('No task rows found in that file', { kind: 'warn' });
    return;
  }

  const sample = rows.slice(0, 6);
  const m = modal({
    title: `Import ${plural(rows.length, 'task')}`,
    body: frag(
      el('div.hint', { text: 'Preview of the first few rows:' }),
      el(
        'table.table',
        {},
        el('thead', {}, el('tr', {},
          el('th', { text: 'Title' }),
          el('th', { text: 'Project' }),
          el('th', { text: 'Due' }),
          el('th', { text: 'Priority' })
        )),
        el('tbody', {}, ...sample.map((r) =>
          el('tr', {},
            el('td.truncate', { text: r.title }),
            el('td.muted', { text: r.projectName || '—' }),
            el('td.muted', { text: r.due_at ? r.due_at.slice(0, 10) : '—' }),
            el('td.muted', { text: r.priority })
          )
        ))
      )
    ),
    foot: frag(
      el('div.spacer'),
      el('button.btn', { type: 'button', text: 'Cancel', onclick: () => m.close() }),
      el('button.btn.btn-primary', {
        type: 'button',
        text: `Import ${rows.length}`,
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = 'Importing…';
          const n = await io.importTasks(rows, {
            onProgress: (done, total) => {
              btn.textContent = `Importing ${done}/${total}…`;
            },
          });
          m.close();
          toast(`Imported ${plural(n, 'task')}`, { kind: 'success' });
        },
      })
    ),
  });
}

async function importBackupFlow() {
  const file = await io.pickFile('.json,application/json');
  if (!file) return;
  let payload;
  try {
    payload = JSON.parse(await io.readFile(file));
  } catch {
    toast('That file is not valid JSON', { kind: 'error' });
    return;
  }

  if (payload?.format === 'miko.backup') {
    const ok = await confirm({
      title: 'Restore backup?',
      message: `Backup from ${payload.exported_at?.slice(0, 10) || 'unknown date'} containing ${
        payload.counts?.tasks ?? '?'
      } tasks. Existing records with the same id will be overwritten.`,
      confirmLabel: 'Restore',
    });
    if (!ok) return;
    const n = await io.importBackup(payload, { mode: 'merge' });
    toast(`Restored ${n} records`, { kind: 'success' });
    return;
  }

  try {
    const n = await io.importTasksJSON(payload);
    toast(`Imported ${plural(n, 'task')}`, { kind: 'success' });
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}

/* --------------------------------- about --------------------------------- */

function aboutPanel() {
  return frag(
    block(
      'MIKŌ',
      'Task intelligence, built to work offline first.',
      el('div.card.card-pad', {},
        el('div.col', {},
          el('div.row', {}, el('span.t-meta', { text: 'Storage' }), el('div.spacer'), el('span', { text: 'IndexedDB, on this device' })),
          el('div.row', {}, el('span.t-meta', { text: 'Sync' }), el('div.spacer'), el('span', { text: sync.getStatus().remote ? 'Remote configured' : 'Local only' })),
          el('div.row', {}, el('span.t-meta', { text: 'Tasks' }), el('div.spacer'), el('span', { text: String(store.allTasks().length) })),
          el('div.row', {}, el('span.t-meta', { text: 'Offline' }), el('div.spacer'), el('span', { text: navigator.serviceWorker?.controller ? 'Ready' : 'Installing…' }))
        )
      )
    ),
    block(
      'Keyboard',
      null,
      el('div.col', {}, ...[
        ['⌘K / Ctrl+K', 'Command palette'],
        ['C', 'New task'],
        ['/', 'Search'],
        ['J / K', 'Move down / up'],
        ['X', 'Select task'],
        ['E', 'Complete task'],
        ['1–5', 'Set priority'],
        ['⌘Z', 'Undo'],
        ['?', 'All shortcuts'],
      ].map(([k, what]) =>
        el('div.row', {}, el('span.kbd', { text: k }), el('span.muted', { text: what }))
      ))
    )
  );
}

/* ============================== TEMPLATES ============================== */

export function renderTemplates() {
  const pad = el('div.content-pad');
  const list = el('div.grid.grid-3');

  pad.appendChild(
    el('div.row', { style: { marginBottom: 'var(--s4)' } },
      el('p.hint', { style: { flex: '1' }, text: 'Reusable sets of tasks. Apply one to create everything at once.' }),
      el('button.btn.btn-sm.btn-primary', {
        type: 'button',
        html: `${icon('plus', { size: 13 })}<span>New template</span>`,
        onclick: () => templateEditor(null, paint),
      })
    )
  );
  pad.appendChild(list);

  async function paint() {
    clear(list);
    const rows = await db.byIndex('templates', 'workspace_id', store.state.workspace.id);
    const all = [...BUILTIN_TEMPLATES, ...rows];

    if (!all.length) {
      list.appendChild(emptyState({ icon: 'templates', title: 'No templates', body: 'Create one to reuse a set of tasks.' }));
      return;
    }

    for (const t of all) {
      list.appendChild(
        el(
          'div.card.card-pad',
          {},
          el('div.row', {},
            el('span', { html: icon('templates', { size: 14 }), class: 'faint' }),
            el('div.t-sub', { text: t.name, style: { flex: '1' } }),
            t.builtin ? el('span.badge.badge-neutral', { text: 'Built in' }) : null
          ),
          el('p.hint', { style: { margin: 'var(--s2) 0' }, text: plural(t.tasks.length, 'task') }),
          el('div.col', { style: { marginBottom: 'var(--s3)' } },
            ...t.tasks.slice(0, 4).map((x) => el('div.t-meta.truncate', { text: `· ${x.title}` })),
            t.tasks.length > 4 ? el('div.t-meta.faint', { text: `+${t.tasks.length - 4} more` }) : null
          ),
          el('div.row', {},
            el('button.btn.btn-sm.btn-primary', {
              type: 'button',
              text: 'Use',
              onclick: () => applyTemplate(t),
            }),
            !t.builtin
              ? el('button.btn.btn-sm', { type: 'button', text: 'Edit', onclick: () => templateEditor(t, paint) })
              : null,
            !t.builtin
              ? el('button.icon-btn.sm', {
                  type: 'button',
                  'aria-label': `Delete ${t.name}`,
                  html: icon('trash'),
                  onclick: async () => {
                    await db.del('templates', t.id);
                    paint();
                  },
                })
              : null
          )
        )
      );
    }
  }

  paint();
  return pad;
}

const BUILTIN_TEMPLATES = [
  {
    id: 'builtin-week',
    builtin: true,
    name: 'Weekly review',
    tasks: [
      { title: 'Clear the inbox' },
      { title: 'Review last week against the plan' },
      { title: 'Check every project has a next action' },
      { title: 'Pick the three things that matter next week' },
      { title: 'Tidy overdue tasks' },
    ],
  },
  {
    id: 'builtin-ship',
    builtin: true,
    name: 'Ship a feature',
    tasks: [
      { title: 'Write the spec', priority: 'high' },
      { title: 'Build it' },
      { title: 'Write tests' },
      { title: 'Code review' },
      { title: 'Deploy to staging' },
      { title: 'Deploy to production', priority: 'high' },
      { title: 'Announce it' },
    ],
  },
  {
    id: 'builtin-onboard',
    builtin: true,
    name: 'Onboard someone',
    tasks: [
      { title: 'Set up accounts and access', priority: 'high' },
      { title: 'Send the welcome pack' },
      { title: 'Book the first-week one-to-ones' },
      { title: 'Assign a starter task' },
      { title: 'Check in at the end of week one' },
    ],
  },
];

async function applyTemplate(template) {
  const projectSelect = el('select.select');
  projectSelect.appendChild(el('option', { value: '', text: 'No project' }));
  for (const p of store.state.projects) {
    projectSelect.appendChild(el('option', { value: p.id, text: p.name }));
  }
  const asProject = el('input', { type: 'checkbox' });
  const newName = el('input.input', { type: 'text', value: template.name, disabled: true });
  asProject.addEventListener('change', () => {
    newName.disabled = !asProject.checked;
    projectSelect.disabled = asProject.checked;
  });

  const m = modal({
    title: `Use "${template.name}"`,
    body: frag(
      el('div.hint', { text: `Creates ${plural(template.tasks.length, 'task')}.` }),
      el('label.field', {}, el('span', { text: 'Add to project' }), projectSelect),
      el('label.switch-row', {},
        el('div', {}, el('div.t-body', { text: 'Create a new project instead' })),
        el('label.switch', {}, asProject, el('span'))
      ),
      el('label.field', {}, el('span', { text: 'New project name' }), newName)
    ),
    foot: frag(
      el('div.spacer'),
      el('button.btn', { type: 'button', text: 'Cancel', onclick: () => m.close() }),
      el('button.btn.btn-primary', {
        type: 'button',
        text: 'Create tasks',
        onclick: async () => {
          m.close();
          let projectId = projectSelect.value || null;
          if (asProject.checked) {
            const p = await store.createProject({
              name: newName.value.trim() || template.name,
              color: hashColor(newName.value || template.name),
            });
            projectId = p.id;
          }
          for (const t of template.tasks) {
            await store.createTask({
              title: t.title,
              priority: t.priority || 'none',
              project_id: projectId,
              estimate_min: t.estimate_min ?? null,
            });
          }
          store.bus.emit('tasks:changed', { type: 'template', ids: [] });
          toast(`Created ${plural(template.tasks.length, 'task')}`, { kind: 'success' });
        },
      })
    ),
  });
}

function templateEditor(existing, onSaved) {
  const name = el('input.input', { type: 'text', value: existing?.name || '', placeholder: 'Template name' });
  const lines = el('textarea.textarea', {
    rows: 8,
    placeholder: 'One task per line',
    style: { minHeight: '180px' },
  });
  lines.value = (existing?.tasks || []).map((t) => t.title).join('\n');

  const m = modal({
    title: existing ? 'Edit template' : 'New template',
    body: frag(
      el('label.field', {}, el('span', { text: 'Name' }), name),
      el('label.field', {}, el('span', { text: 'Tasks' }), lines),
      el('div.hint', { text: 'One per line. Add !high, !urgent and so on to set a priority.' })
    ),
    foot: frag(
      el('div.spacer'),
      el('button.btn', { type: 'button', text: 'Cancel', onclick: () => m.close() }),
      el('button.btn.btn-primary', {
        type: 'button',
        text: 'Save',
        onclick: async () => {
          const title = name.value.trim();
          if (!title) return;
          const tasks = lines.value
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => {
              const pm = l.match(/\s*!(urgent|high|medium|low)\b/i);
              return {
                title: l.replace(/\s*!(urgent|high|medium|low)\b/i, '').trim(),
                priority: pm ? pm[1].toLowerCase() : 'none',
              };
            });
          await db.put('templates', {
            id: existing?.id || id('tpl'),
            workspace_id: store.state.workspace.id,
            name: title,
            tasks,
            created_at: existing?.created_at || nowISO(),
          });
          m.close();
          onSaved?.();
          toast('Template saved', { kind: 'success' });
        },
      })
    ),
  });
}

/* ============================== AUTOMATIONS ============================== */

export function renderAutomations() {
  const pad = el('div.content-pad');
  const list = el('div.col');

  pad.appendChild(
    el('div.row', { style: { marginBottom: 'var(--s4)' } },
      el('p.hint', { style: { flex: '1' }, text: 'When something happens, do something else. Rules run locally as you work.' }),
      el('button.btn.btn-sm.btn-primary', {
        type: 'button',
        html: `${icon('plus', { size: 13 })}<span>New rule</span>`,
        onclick: () => automationEditor(null, paint),
      })
    )
  );
  pad.appendChild(list);

  async function paint() {
    clear(list);
    const rows = await rules.listAutomations();
    if (!rows.length) {
      list.appendChild(
        emptyState({
          icon: 'automation',
          title: 'No rules yet',
          body: 'For example: when a task is marked done, create a follow-up due tomorrow.',
        })
      );
      return;
    }
    for (const r of rows) {
      const toggle = el('input', { type: 'checkbox', checked: r.enabled || null });
      toggle.addEventListener('change', async () => {
        await rules.saveAutomation({ ...r, enabled: toggle.checked });
      });

      list.appendChild(
        el(
          'div.card.card-pad',
          { style: { marginBottom: 'var(--s2)' } },
          el('div.row', {},
            el('span', { html: icon('automation', { size: 14 }), class: r.enabled ? 'c-accent' : 'faint' }),
            el('div', { style: { flex: '1', minWidth: '0' } },
              el('div.t-sub', { text: r.name }),
              el('div.hint', { text: describeRule(r) })
            ),
            r.runs ? el('span.t-meta', { text: `ran ${plural(r.runs, 'time')}` }) : null,
            el('label.switch', {}, toggle, el('span')),
            el('button.icon-btn.sm', {
              type: 'button',
              'aria-label': `Edit ${r.name}`,
              html: icon('edit'),
              onclick: () => automationEditor(r, paint),
            }),
            el('button.icon-btn.sm', {
              type: 'button',
              'aria-label': `Delete ${r.name}`,
              html: icon('trash'),
              onclick: async () => {
                const ok = await confirm({ title: `Delete "${r.name}"?`, danger: true, confirmLabel: 'Delete' });
                if (!ok) return;
                await rules.deleteAutomation(r.id);
                paint();
              },
            })
          )
        )
      );
    }
  }

  paint();
  return pad;
}

function describeRule(r) {
  const trigger = rules.TRIGGERS[r.trigger] || r.trigger;
  const actions = r.actions.map((a) => rules.ACTIONS[a.type] || a.type).join(', ');
  return `${trigger} → ${actions || 'no actions yet'}`;
}

function automationEditor(existing, onSaved) {
  const rule = existing ? { ...existing } : rules.blankAutomation();

  const name = el('input.input', { type: 'text', value: rule.name });
  const trigger = el('select.select');
  for (const [k, label] of Object.entries(rules.TRIGGERS)) {
    trigger.appendChild(el('option', { value: k, selected: rule.trigger === k || null, text: label }));
  }

  const actionsBox = el('div.col');

  const valueControl = (action) => {
    switch (action.type) {
      case 'set_status':
        return selectOf(store.STATUSES.map((s) => [s, store.STATUS_LABEL[s]]), action);
      case 'set_priority':
        return selectOf(store.PRIORITIES.map((p) => [p, store.PRIORITY_LABEL[p]]), action);
      case 'add_label':
      case 'remove_label':
        return selectOf(store.state.labels.map((l) => [l.id, l.name]), action);
      case 'assign':
        return selectOf(store.state.members.map((m) => [m.user_id, m.user?.name || m.user_id]), action);
      case 'move_project':
        return selectOf([['', 'No project'], ...store.state.projects.map((p) => [p.id, p.name])], action);
      case 'set_due': {
        const input = el('input.input', { type: 'number', value: String(action.value ?? 1), min: '0', max: '365' });
        input.addEventListener('change', () => (action.value = input.value));
        return el('label.field', {}, el('span', { text: 'Days from today' }), input);
      }
      case 'create_followup': {
        const input = el('input.input', {
          type: 'text',
          value: action.value || 'Follow up: {title}',
          placeholder: 'Follow up: {title}',
        });
        input.addEventListener('change', () => (action.value = input.value));
        return el('label.field', {}, el('span', { text: 'Title ({title} = original)' }), input);
      }
      case 'notify': {
        const input = el('input.input', { type: 'text', value: action.value || '', placeholder: 'Message' });
        input.addEventListener('change', () => (action.value = input.value));
        return el('label.field', {}, el('span', { text: 'Message' }), input);
      }
      default:
        return null;
    }
  };

  const selectOf = (pairs, action) => {
    const sel = el('select.select');
    for (const [value, label] of pairs) {
      sel.appendChild(el('option', { value, selected: action.value === value || null, text: label }));
    }
    if (!action.value && pairs.length) action.value = pairs[0][0];
    sel.addEventListener('change', () => (action.value = sel.value));
    return sel;
  };

  const paintActions = () => {
    clear(actionsBox);
    rule.actions.forEach((action, i) => {
      const typeSel = el('select.select', { style: { maxWidth: '200px' } });
      for (const [k, label] of Object.entries(rules.ACTIONS)) {
        typeSel.appendChild(el('option', { value: k, selected: action.type === k || null, text: label }));
      }
      typeSel.addEventListener('change', () => {
        action.type = typeSel.value;
        action.value = undefined;
        paintActions();
      });

      actionsBox.appendChild(
        el('div.row', { style: { alignItems: 'flex-end' } },
          typeSel,
          el('div', { style: { flex: '1' } }, valueControl(action)),
          el('button.icon-btn.sm', {
            type: 'button',
            'aria-label': 'Remove action',
            html: icon('x'),
            onclick: () => {
              rule.actions.splice(i, 1);
              paintActions();
            },
          })
        )
      );
    });

    actionsBox.appendChild(
      el('button.btn.btn-sm', {
        type: 'button',
        html: `${icon('plus', { size: 13 })}<span>Add action</span>`,
        onclick: () => {
          rule.actions.push({ type: 'set_priority', value: 'high' });
          paintActions();
        },
      })
    );
  };
  paintActions();

  const m = modal({
    title: existing ? 'Edit rule' : 'New rule',
    size: 'lg',
    body: frag(
      el('label.field', {}, el('span', { text: 'Name' }), name),
      el('label.field', {}, el('span', { text: 'When' }), trigger),
      el('div.field', {}, el('span.label', { text: 'Then' }), actionsBox)
    ),
    foot: frag(
      el('div.spacer'),
      el('button.btn', { type: 'button', text: 'Cancel', onclick: () => m.close() }),
      el('button.btn.btn-primary', {
        type: 'button',
        text: 'Save rule',
        onclick: async () => {
          rule.name = name.value.trim() || 'Untitled rule';
          rule.trigger = trigger.value;
          if (!rule.actions.length) {
            toast('Add at least one action', { kind: 'warn' });
            return;
          }
          await rules.saveAutomation(rule);
          m.close();
          onSaved?.();
          toast('Rule saved', { kind: 'success' });
        },
      })
    ),
  });
}
