/* Entry point. Boots the database, starts the background engines, builds the
 * shell, and registers the service worker. Order matters: nothing renders
 * until the store has hydrated, so the first paint is real data rather than a
 * skeleton that flashes. */

import * as db from './core/db.js';
import * as store from './core/store.js';
import * as sync from './core/sync.js';
import * as remote from './core/remote.js';
import * as rules from './domain/rules.js';
import * as shell from './ui/shell.js';
import * as palette from './ui/palette.js';
import * as auth from './core/auth.js';
import { applyTheme } from './views/settings.js';
import { el, toast } from './ui/kit.js';
import { icon } from './ui/icons.js';

const root = document.getElementById('app');
const landingRoot = document.getElementById('landing');

/* The splash carries the wordmark, so give it long enough to read as a brand
   moment rather than a flicker. This only ever pads a *fast* boot — a slow one
   has already exceeded the floor and waits for nothing. */
/* The splash writes the wordmark, draws the macron, opens the rule and fades
 * the byline in — a sequence that finishes around 1.9s. Holding for less than
 * that cut it off partway, so a fast boot never showed the whole thing. */
const SPLASH_MIN_MS = 2300;
const bootStarted = performance.now();

function holdSplash() {
  const remaining = SPLASH_MIN_MS - (performance.now() - bootStarted);
  return remaining > 0 ? new Promise((r) => setTimeout(r, remaining)) : Promise.resolve();
}

/** IndexedDB can hang rather than fail — a connection held open by another
 *  tab mid-upgrade never resolves and never errors. Without a ceiling the user
 *  sits on the boot screen forever, so treat "too slow" as a failure we can
 *  explain and offer a retry for. */
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

async function boot() {
  try {
    await withTimeout(
      store.boot(),
      12_000,
      'Timed out opening the local database. Another MIKŌ tab may be mid-update — close the others and try again.'
    );
  } catch (err) {
    console.error('[miko] failed to open the database', err);
    showFatal(err);
    return;
  }

  // Theme and density before first paint, so nothing flashes the wrong colour.
  applyTheme(store.getSetting('theme', 'system'));
  document.documentElement.dataset.density = store.getSetting('density', 'comfortable');

  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      if (store.getSetting('theme', 'system') === 'system') applyTheme('system');
    });

  // The landing page's demo is this same application in an iframe, pointed at
  // its own database. It has no one to sign in as and nothing to install, so
  // it skips the gate, the splash hold and the PWA plumbing, and goes straight
  // to a seeded workspace.
  // Preview: the dashboard without an account. Same app, same seeded data as
  // the landing demo, but the store refuses writes — so "you cannot save
  // anything" is a property of the write path, not of which buttons are shown.
  if (db.IS_PREVIEW) {
    document.documentElement.dataset.preview = '1';
    const wanted = new URLSearchParams(location.search).get('theme');
    if (wanted === 'light' || wanted === 'dark') applyTheme(wanted);
    try {
      await store.seedDemoContent();
    } catch (err) {
      console.error('[miko] preview seed failed', err);
    }
    store.setReadOnly(true);
    await holdSplash();
    document.body.classList.add('ready');
    startApp();
    showPreviewBar();
    return;
  }

  if (db.IS_DEMO) {
    document.documentElement.dataset.demo = '1';
    // The landing page passes its own theme down, so the demo opens matching
    // the visitor instead of flashing whatever the last tour left behind.
    const wanted = new URLSearchParams(location.search).get('theme');
    if (wanted === 'light' || wanted === 'dark') applyTheme(wanted);
    // An empty demo is a poor demo, but it is far better than a blank frame on
    // the landing page — never let seeding take the boot down with it.
    try {
      await store.seedDemoContent();
    } catch (err) {
      console.error('[miko] demo seed failed', err);
    }
    document.body.classList.add('ready');
    startApp();
    return;
  }

  // Any locally-stored project details, before anything asks whether a
  // backend exists.
  await auth.loadBackendConfig();

  // An OAuth or magic-link hand-back arrives with tokens in the URL fragment.
  // This has to run before anything reads location.hash, or the router will
  // try to navigate to a route called `access_token=...`.
  try {
    await auth.completeRedirect();
  } catch (err) {
    console.error('[miko] sign-in redirect failed', err);
    toast(err.message || 'Sign-in could not be completed.', { kind: 'error' });
  }

  // Sign-in gate. Without a backend, email sign-in is instant and works
  // offline, so requiring it can never lock someone out of data already on
  // their device. With one, this restores and refreshes a real session.
  await auth.resume();
  if (!auth.isSignedIn()) {
    await holdSplash();
    document.body.classList.add('ready');
    const landing = await import('./ui/landing.js');
    landing.render(landingRoot, {
      onSignedIn: () => {
        landing.destroy(landingRoot);
        startApp();
      },
    });
    return;
  }

  await holdSplash();
  document.body.classList.add('ready');
  startApp();
}

/** Build the application itself. Called after the gate, and again after a
 *  sign-in without a page reload. */
async function startApp() {
  // Anything that throws from here leaves an empty page behind the boot
  // screen, which reads as a hang. Catch it and say so.
  try {
      sync.init();
    await withTimeout(rules.init(), 10_000, 'Timed out starting background services.');

    // With an account and a schema in place, the outbox starts draining to
    // Supabase. Without either, this returns quietly and the app stays local.
    remote.connect().then((r) => {
      if (r.connected) return;
      if (r.reason === 'schema') {
        console.warn('[miko] sync is off — missing tables:', r.missing);
        toast('Sync is off: the database schema is incomplete.', {
          kind: 'error',
          action: { label: 'Details', onClick: () => console.table(r.missing) },
        });
      }
    });

    root.innerHTML = '';
    shell.build(root);
    palette.installKeymap();
  } catch (err) {
    console.error('[miko] failed to start the interface', err);
    showFatal(err);
    return;
  }

  // Default to labelled, not icon-only. A column of unlabelled icons is the
  // least learnable state, and it was the default before.
  if (store.getSetting('railOpen', true)) {
    document.getElementById('rail')?.classList.add('open');
  }

  // None of this belongs in the demo: it is a throwaway database inside an
  // iframe, so there is nothing to make durable, no scope to register a worker
  // against that the real page does not already own, and nobody to onboard.
  if (db.IS_DEMO || db.IS_PREVIEW) return;

  // Ask for durable storage once there is something worth keeping.
  if (store.allTasks().length > 2) db.persist();

  registerServiceWorker();
  wireInstallPrompt();

  // Onboarding waits for the splash or the landing fade to clear.
  setTimeout(() => shell.maybeOnboard(), 450);
}

/** Signing out returns to the landing page without a reload, so the fade is
 *  continuous and nothing flashes. */
auth.bus.on('session', (session) => {
  if (!session) {
    remote.disconnect();
    remote.resetCursor().catch(() => {});
  }
  if (session || !document.body.classList.contains('ready')) return;
  import('./ui/landing.js').then((landing) => {
    root.innerHTML = '';
    landing.render(landingRoot, {
      onSignedIn: () => {
        landing.destroy(landingRoot);
        startApp();
      },
    });
  });
});

function showFatal(err) {
  root.innerHTML = '';
  root.appendChild(
    el(
      'div',
      {
        style: {
          display: 'grid',
          placeItems: 'center',
          height: '100dvh',
          padding: '24px',
          textAlign: 'center',
        },
      },
      el(
        'div',
        { style: { maxWidth: '420px' } },
        el('div', { html: icon('warning', { size: 24 }), style: { display: 'flex', justifyContent: 'center', marginBottom: '12px' } }),
        el('h1.t-title', { text: 'MIKŌ could not start' }),
        el('p.hint', {
          style: { margin: '8px 0 16px' },
          text:
            'The local database would not open. This usually means private browsing is blocking storage, or the browser is out of space.',
        }),
        el('p.t-mono.faint', { text: String(err?.message || err), style: { marginBottom: '16px' } }),
        el('button.btn.btn-primary', {
          type: 'button',
          text: 'Try again',
          onclick: () => location.reload(),
        })
      )
    )
  );
}

/* ------------------------------ PWA plumbing ------------------------------ */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // A page opened from the filesystem has no scope to register against.
  if (location.protocol === 'file:') return;

  /* Not during development.
   *
   * The worker caches JS and CSS and answers from that cache, which overrides
   * whatever the dev server says about freshness — so an edit silently does
   * not appear, and the obvious conclusion is that the change was wrong. That
   * cost real time while building this. Pass ?sw=1 to test the offline path on
   * purpose. */
  const params = new URLSearchParams(location.search);
  if (LOCAL_HOSTS.has(location.hostname) && !params.has('sw')) {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const r of regs) r.unregister();
    });
    return;
  }

  navigator.serviceWorker
    .register('sw.js')
    .then((reg) => {
      reg.addEventListener('updatefound', () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener('statechange', () => {
          if (next.state === 'installed' && navigator.serviceWorker.controller) {
            toast('A new version of MIKŌ is ready', {
              duration: 0,
              action: {
                label: 'Reload',
                onClick: () => {
                  next.postMessage({ type: 'SKIP_WAITING' });
                  location.reload();
                },
              },
            });
          }
        });
      });
    })
    .catch((err) => console.warn('[miko] service worker registration failed', err));

  // Opening a task from a notification.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'OPEN_TASK' && e.data.taskId) {
      location.hash = `#/task/${e.data.taskId}`;
    }
  });
}

let installPrompt = null;

function wireInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    // Don't interrupt a first-time visitor; offer it once there's real work here.
    if (store.allTasks().length < 3) return;
    if (store.getSetting('installDismissed', false)) return;

    toast('Install MIKŌ for offline access and notifications', {
      duration: 12_000,
      action: {
        label: 'Install',
        onClick: async () => {
          installPrompt.prompt();
          const { outcome } = await installPrompt.userChoice;
          if (outcome !== 'accepted') store.setSetting('installDismissed', true);
          installPrompt = null;
        },
      },
    });
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    store.setSetting('installed', true);
  });
}

/** A standing reminder that nothing here is kept, with the way to change that.
 *  Preview exists to be looked at; it should never feel like a broken app. */
function showPreviewBar() {
  document.body.appendChild(
    el(
      'div.preview-bar',
      { role: 'status' },
      el('span.preview-dot'),
      el('span', { text: 'Preview — exploring with sample data. Nothing is saved.' }),
      el('button.btn.btn-sm', {
        type: 'button',
        text: 'Back to site',
        onclick: () => {
          location.href = 'index.html';
        },
      }),
      el('button.btn.btn-sm.btn-primary', {
        type: 'button',
        text: 'Sign in to keep it',
        // Same destination, different intent — this one opens the panel on
        // arrival so the button does what it says rather than just leaving.
        onclick: () => {
          location.href = 'index.html?signin=1';
        },
      })
    )
  );
}

/* Surface unexpected failures instead of dying silently in the console. */
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message || String(e.reason);
  if (e.reason?.name === 'AbortError') return;
  // In preview this is expected, not a fault: say what it means and offer the
  // way out, rather than logging a scary stack.
  if (e.reason?.code === 'readonly') {
    e.preventDefault();
    toast('Preview only — sign in to keep your work', {
      kind: 'info',
      action: { label: 'Sign in', onClick: () => (location.href = 'index.html?signin=1') },
    });
    return;
  }
  console.error('[miko] unhandled rejection', e.reason);
  if (document.body.classList.contains('ready')) {
    toast(msg.length > 120 ? 'Something went wrong — check the console' : msg, { kind: 'error' });
  }
});

window.addEventListener('error', (e) => {
  console.error('[miko] error', e.error || e.message);
});

boot();
