/* The landing page: hero, product demo, and sign-in.
 *
 * The demo is the application itself, running in an iframe against its own
 * database. A screen recording can replace it by setting DEMO_VIDEO in
 * js/config.js, and a scripted recreation of the interface stands in if the
 * live app cannot start — storage blocked, private browsing, a boot error.
 * A dead frame on the landing page is the one outcome worth engineering
 * against.
 */

import { DEMO_VIDEO } from '../config.js';
import * as auth from '../core/auth.js';
import * as store from '../core/store.js';
import { applyTheme } from '../views/settings.js';
import { icon } from './icons.js';
import { el, frag, clear, modal, toast, $ } from './kit.js';


/* The demo is the application itself. `?demo=1` points it at a separate
   database (`miko-demo`) and skips the sign-in gate, the splash and the
   service worker — see js/core/db.js and js/main.js. */
const APP_SRC = 'index.html?demo=1';

/** What the page is actually showing right now — the attribute when one is
 *  set, the device preference when it is not. */
function pageTheme() {
  return (
    document.documentElement.dataset.theme ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  );
}

let onDone = null;
let demo = null;

/* ================================ RENDER ================================ */

export function render(root, { onSignedIn } = {}) {
  onDone = onSignedIn;
  clear(root);

  const page = el('div.lp');
  const stage = el('div.lp-demo-stage');

  // Pinned to the page, not the nav: the nav sits inside the left pane, so its
  // right edge is the pane's edge rather than the viewport's.
  page.append(buildThemeToggle());

  page.append(
    el(
      'section.lp-split',
      {},
      el(
        'div.lp-pane-left',
        {},
        buildNav(),
        buildHero(),
        // Sits at the foot of the pane, where the old "More below" marker was —
        // it is a signpost to what is further down, so it belongs at the bottom
        // rather than beside the calls to action.
        el(
          'div.lp-pane-foot',
          {},
          el(
            'button.lp-btn.lp-btn-accent',
            {
              type: 'button',
              onclick: () =>
                document
                  .querySelector('.lp-more')
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
            },
            el('span', { html: icon('arrowDown', { size: 14 }) }),
            el('span', { text: 'More below' })
          )
        )
      ),
      el(
        'div.lp-pane-right',
        {},
        el(
          'div.lp-stage-col',
          {},
          buildQuickStart(),
          el(
            'div.lp-demo-frame',
            {},
            el(
              'div.lp-demo-bar',
              {},
              el('span.lp-dot'),
              el('span.lp-dot'),
              el('span.lp-dot'),
              el('span.lp-demo-title', { text: 'MIKŌ' })
            ),
            stage
          )
        )
      )
    ),
    buildFeatures(),
    buildFoot()
  );
  root.appendChild(page);
  root.hidden = false;
  wireHomeGoogle(page);

  // Arriving from the preview's "Sign in to keep it". Drop the parameter once
  // it has been used so a refresh does not reopen the panel.
  if (new URLSearchParams(location.search).has('signin')) {
    history.replaceState(null, '', location.pathname);
    setTimeout(() => openSignIn(), 60);
  }

  demo = startDemo(stage);

  return page;
}

export function destroy(root) {
  demo?.stop();
  demo = null;
  root.hidden = true;
  clear(root);
}

const wordmark = () =>
  el('div.lp-wordmark', { html: 'MIK<span class="o">O</span>', 'aria-label': 'MIKŌ' });

function buildNav() {
  return el(
    'header.lp-nav',
    {},
    el(
      'div.lp-brand',
      {},
      el('div.mark', { text: 'M', 'aria-hidden': 'true' }),
      wordmark()
    ),
    el('div.spacer'),
    el('button.btn.btn-sm', {
      type: 'button',
      text: 'Sign in',
      // The form is on the page — go to it rather than opening a second copy
      // of it in a dialog.
      onclick: () => {
        const field = document.querySelector('.lp-quick-input');
        document.querySelector('#lp-start')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        field?.focus();
      },
    })
  );
}

/* Light, dark, or whatever the device is set to. Writes the same `theme`
   setting the app uses, so the choice made out here survives signing in — and
   applyTheme() is the one place that touches the document, in both. */
const THEMES = [
  ['light', 'Light', 'sun'],
  ['dark', 'Dark', 'moon'],
  ['system', 'Match device', 'panel'],
];

function buildThemeToggle() {
  const group = el('div.lp-theme', { role: 'group', 'aria-label': 'Colour theme' });
  const current = () => store.getSetting('theme', 'system');

  const buttons = THEMES.map(([value, label, iconName]) =>
    el('button.lp-theme-btn', {
      type: 'button',
      title: label,
      'aria-label': label,
      'aria-pressed': String(current() === value),
      html: icon(iconName, { size: 14 }),
      onclick: async () => {
        await store.setSetting('theme', value);
        applyTheme(value);
        sync();
      },
    })
  );

  const sync = () => {
    const now = current();
    buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(THEMES[i][0] === now)));
  };

  buttons.forEach((b) => group.appendChild(b));
  return group;
}

function buildHero() {
  return el(
    'div.lp-pane-body',
    {},
    el('h1.lp-h1', { html: 'Write the task. Let MIK<em>Ō</em> do the filing.' }),
    el('p.lp-lede', { text: 'It reads the date, project and priority as you type.' }),
    el(
      'div.lp-cta',
      {},
      el(
        'button.lp-btn.lp-btn-ghost',
        {
          type: 'button',
          title: 'Open the dashboard with sample data — nothing is saved',
          onclick: openPreview,
        },
        el('span', { html: icon('panel', { size: 15 }) }),
        el('span', { text: 'Go to dashboard' })
      )
    ),
    el('p.lp-cta-note', { text: 'No account needed to look around.' })
  );
}

/** Open the dashboard without an account. Carries the page's theme so it does
 *  not flash, and `preview=1` is what makes the store refuse writes. */
function openPreview() {
  location.href = `index.html?preview=1&theme=${pageTheme()}`;
}

/* Sits above the demo and looks like a sign-in form, because that is the one
   thing the page is asking for. It is only the front of one: the address is
   handed to the real panel, which owns Google, validation and the privacy
   note. Putting those here would rebuild the second section we just removed. */
function buildQuickStart() {
  const email = el('input.lp-quick-input', {
    type: 'email',
    name: 'email',
    placeholder: 'you@company.com',
    autocomplete: 'email',
    'aria-label': 'Email address',
  });

  // Revealed once an address is in, rather than sending people to a dialog to
  // type it again. Hidden until then so the first impression stays one field.
  const password = el('input.lp-quick-input', {
    type: 'password',
    name: 'password',
    placeholder: 'Password',
    autocomplete: 'current-password',
    'aria-label': 'Password',
  });
  const passwordRow = el(
    'div.lp-quick-field.is-secret',
    {},
    el('span.lp-quick-icon', { html: icon('lock', { size: 15 }) }),
    password
  );
  passwordRow.hidden = true;

  const label = el('span', { text: 'Get started' });
  const submit = el(
    'button.lp-btn.lp-btn-primary',
    { type: 'submit' },
    label,
    el('span', { html: icon('arrowRight', { size: 15 }) })
  );

  const error = el('div.lp-quick-error', { role: 'alert' });
  const note = el('div.lp-quick-ok', { role: 'status' });

  const alt = el('div.lp-quick-alt');
  const linkCreate = el('button.lp-link', { type: 'button', text: 'Create an account' });
  const linkMagic = el('button.lp-link', { type: 'button', text: 'Email me a link instead' });
  const linkForgot = el('button.lp-link', { type: 'button', text: 'Forgot password' });

  const form = el(
    'form.lp-quick',
    { novalidate: true },
    el('div.lp-quick-rows', {},
      el('div.lp-quick-field', {},
        el('span.lp-quick-icon', { html: icon('mail', { size: 15 }) }), email),
      passwordRow),
    submit
  );

  const googleHost = el('div.lp-home-google', { id: 'lp-home-google' });

  /* ---- state ---- */
  let mode = 'signin'; // or 'signup'
  const backed = () => auth.isBackendConfigured();

  const say = (msg, isError = true) => {
    error.textContent = isError ? msg : '';
    note.textContent = isError ? '' : msg;
  };
  const busy = (text) => {
    submit.disabled = true;
    label.textContent = text;
  };
  const idle = () => {
    submit.disabled = false;
    label.textContent = !backed() ? 'Get started' : passwordRow.hidden ? 'Continue' : (mode === 'signup' ? 'Create account' : 'Sign in');
  };

  const showPassword = () => {
    passwordRow.hidden = false;
    password.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    password.placeholder = mode === 'signup' ? 'Choose a password — 8+ characters' : 'Password';
    alt.replaceChildren(linkCreate, ...(mode === 'signin' ? [linkMagic, linkForgot] : []));
    idle();
    setTimeout(() => password.focus(), 30);
  };

  /* ---- submit ---- */
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    say('');
    const address = email.value.trim();
    if (!auth.isValidEmail(address)) {
      say('Enter a valid email address.');
      email.focus();
      return;
    }

    // No account server: this is the local identity path, and it is instant.
    if (!backed()) {
      busy('Setting things up…');
      try {
        finish(await auth.signInWithEmail(address), () => {});
      } catch (err) {
        say(err.message);
        idle();
      }
      return;
    }

    // First press reveals the password rather than hopping to a dialog.
    if (passwordRow.hidden) {
      showPassword();
      return;
    }

    const secret = password.value;
    if (!secret) {
      say('Enter your password.');
      password.focus();
      return;
    }

    busy(mode === 'signup' ? 'Creating your account…' : 'Signing you in…');
    try {
      if (mode === 'signup') {
        const out = await auth.signUpWithPassword({ email: address, password: secret });
        if (out.pending) {
          say(`Check ${out.email} for a confirmation link, then sign in.`, false);
          idle();
          return;
        }
        finish(out.session, () => {});
      } else {
        finish(await auth.signInWithPassword({ email: address, password: secret }), () => {});
      }
    } catch (err) {
      say(err.message);
      idle();
    }
  });

  /* ---- the alternatives, inline ---- */
  linkCreate.addEventListener('click', () => {
    mode = mode === 'signup' ? 'signin' : 'signup';
    linkCreate.textContent = mode === 'signup' ? 'I already have an account' : 'Create an account';
    say('');
    showPassword();
  });

  const sendAndSay = async (fn, done) => {
    const address = email.value.trim();
    if (!auth.isValidEmail(address)) {
      say('Enter your email address first.');
      email.focus();
      return;
    }
    busy('Sending…');
    try {
      await fn(address);
      say(done(address), false);
    } catch (err) {
      say(err.message);
    }
    idle();
  };

  linkMagic.addEventListener('click', () =>
    sendAndSay(auth.sendMagicLink, (a) => `Link sent to ${a}. Open it on this device.`)
  );
  linkForgot.addEventListener('click', () =>
    sendAndSay(auth.sendPasswordReset, (a) => `Reset link sent to ${a}.`)
  );

  idle();

  return el(
    'div.lp-quick-wrap',
    { id: 'lp-start' },
    form,
    error,
    note,
    alt,
    el('div.lp-or', {}, el('span', { text: 'or' })),
    googleHost,
    el('p.lp-quick-note', {
      text: backed()
        ? 'Your account is held by Supabase. Tasks sync once you are signed in.'
        : 'Free, and your tasks stay on this device.',
    })
  );
}

/** Mount Google sign-in on the landing page itself. Falls back to a disabled
 *  button that explains why, exactly as the dialog does — an unconfigured
 *  client ID is the expected default, not a failure. */
function wireHomeGoogle(root) {
  const host = $('#lp-home-google', root);
  if (!host) return;

  const dark =
    document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme &&
      matchMedia('(prefers-color-scheme: dark)').matches);

  mountGoogle(host, {
    dark,
    onSuccess: (session) => finish(session, () => {}),
    onError: () => {},
  })
    .catch((err) => {
      const unconfigured = err.message === 'no-client-id';
      googleUnavailable(
        host,
        unconfigured
          ? 'Google needs an account server. Add your Supabase project in Settings → Account, or a Google client ID there. Email sign-in works either way.'
          : err.message
      );
    });
}

/* ================================= AUTH ================================= */

let signInDialog = null;

/** The sign-in panel. Lives in a dialog now, so the hero stays uncluttered. */
export function openSignIn({ email = '' } = {}) {
  // The nav, and the row above the demo, both open this; don't stack two
  // copies. Verify the tracked dialog is still in the document — if it went
  // away without close() running, the guard would otherwise wedge shut
  // permanently.
  if (signInDialog?.overlay?.isConnected) return signInDialog;
  signInDialog = null;

  const dialog = modal({
    title: 'Get started',
    size: 'sm',
    body: buildAuth(),
    onClose: () => {
      signInDialog = null;
    },
  });
  signInDialog = dialog;

  // The panel is only wired once it is in the document — Google's button
  // renders into a live node and measures it.
  wireAuth(dialog.el, () => dialog.close());

  // Carry over whatever was typed above the demo rather than making them type
  // it twice. focus() on a pre-filled field already leaves the caret at the
  // end — setSelectionRange would throw here, since an email input does not
  // support the selection API.
  setTimeout(() => {
    const field = $('#lp-email', dialog.el);
    if (!field) return;
    if (email) field.value = email;
    field.focus();
  }, 120);
  return dialog;
}

/* The panel has two shapes. With a Supabase project configured it is a real
   sign-in: password field, a create-account mode, a reset link. Without one it
   stays the single-field local flow it has always been, and says so. */
function buildAuth({ mode = 'signin' } = {}) {
  const backed = auth.isBackendConfigured();

  const fields = [
    el('input.lp-input', {
      id: 'lp-email',
      type: 'email',
      name: 'email',
      placeholder: 'you@example.com',
      autocomplete: 'email',
      'aria-label': 'Email address',
      required: true,
    }),
  ];

  if (backed) {
    if (mode === 'signup') {
      fields.unshift(
        el('input.lp-input', {
          id: 'lp-name',
          type: 'text',
          name: 'name',
          placeholder: 'Your name',
          autocomplete: 'name',
          'aria-label': 'Your name',
        })
      );
    }
    fields.push(
      el('input.lp-input', {
        id: 'lp-password',
        type: 'password',
        name: 'password',
        placeholder: mode === 'signup' ? 'Password — at least 8 characters' : 'Password',
        autocomplete: mode === 'signup' ? 'new-password' : 'current-password',
        'aria-label': 'Password',
        required: true,
      })
    );
  }

  return el(
    'div.lp-auth',
    { id: 'lp-auth', 'data-mode': mode },
    el('p.lp-auth-sub', {
      text: backed
        ? mode === 'signup'
          ? 'Create an account to keep your work across devices.'
          : 'Sign in to pick up where you left off.'
        : 'Your tasks stay on this device.',
    }),

    el('div', { id: 'google-btn' }),
    el('div.lp-error', { id: 'google-error', role: 'status' }),

    el('div.lp-divider', { text: 'or' }),

    el(
      'form.lp-form',
      { id: 'lp-email-form', novalidate: true },
      ...fields,
      el('button.lp-submit', {
        type: 'submit',
        text: backed ? (mode === 'signup' ? 'Create account' : 'Sign in') : 'Continue with email',
      }),
      el('div.lp-error', { id: 'lp-email-error', role: 'alert' }),
      el('div.lp-note.is-ok', { id: 'lp-email-ok', role: 'status' })
    ),

    backed
      ? el(
          'div.lp-auth-alt',
          {},
          el('button.lp-link', {
            type: 'button',
            id: 'lp-toggle-mode',
            text: mode === 'signup' ? 'I already have an account' : 'Create an account',
          }),
          mode === 'signin'
            ? el('button.lp-link', { type: 'button', id: 'lp-magic', text: 'Email me a link instead' })
            : null,
          mode === 'signin'
            ? el('button.lp-link', { type: 'button', id: 'lp-forgot', text: 'Forgot password' })
            : null
        )
      : null,

    el('p.lp-note', {
      text: backed
        ? 'Your account is held by Supabase. Tasks stay on this device until sync is switched on.'
        : 'Stored in your browser. Nothing is uploaded, and email is not verified.',
    })
  );
}

/** Google, by whichever route is actually available.
 *
 *  With a Supabase project the provider round trip belongs to Supabase: it
 *  owns the account, so letting Google Identity Services mint a separate
 *  client-side identity alongside it would create two notions of "signed in".
 *  Without a project, the GIS button is still the real flow it always was. */
function mountGoogle(host, { onSuccess, onError, dark }) {
  if (auth.isBackendConfigured()) {
    clear(host);
    host.appendChild(
      el(
        'button.lp-google-fallback',
        { type: 'button', onclick: () => auth.startOAuth('google') },
        el('span', { html: googleGlyph() }),
        el('span', { text: 'Continue with Google' })
      )
    );
    return Promise.resolve();
  }

  return auth.mountGoogleButton(host, {
    theme: dark ? 'filled_black' : 'outline',
    onSuccess,
    onError,
  });
}

/** Google with nothing configured.
 *
 *  This used to render a `disabled` button with the reason in a `title`, which
 *  meant clicking it did nothing at all and the explanation only appeared on
 *  hover — invisible on a touchscreen. It stays clickable and says what it
 *  needs, because a dead control is worse than an honest one. */
function googleUnavailable(host, reason) {
  clear(host);
  host.appendChild(
    el(
      'button.lp-google-fallback.is-unavailable',
      {
        type: 'button',
        onclick: () => {
          toast(reason, {
            kind: 'info',
            duration: 7000,
            action: auth.isSignedIn()
              ? { label: 'Settings', onClick: () => (location.hash = '#/settings') }
              : null,
          });
        },
      },
      el('span', { html: googleGlyph() }),
      el('span', { text: 'Continue with Google' })
    )
  );
}

function wireAuth(root, closeDialog) {
  const googleHost = $('#google-btn', root);
  const googleError = $('#google-error', root);
  const form = $('#lp-email-form', root);
  const email = $('#lp-email', root);
  const emailError = $('#lp-email-error', root);

  /* ---- Google ---- */
  const dark =
    document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme &&
      matchMedia('(prefers-color-scheme: dark)').matches);

  mountGoogle(googleHost, {
    dark,
    onSuccess: (session) => finish(session, closeDialog),
    onError: (err) => {
      googleError.textContent = err.message;
    },
  })
    .catch((err) => {
      // No client ID, offline, or the script was blocked. Show a disabled
      // button that explains itself rather than a silent gap.
      const unconfigured = err.message === 'no-client-id';
      const reason = unconfigured
        ? 'Google needs an account server. Add your Supabase project in Settings → Account, or a Google client ID there. Email sign-in works either way.'
        : err.message;

      googleUnavailable(googleHost, reason);

      // Being unconfigured is the expected default, not a failure.
      googleError.classList.toggle('is-note', unconfigured);
      googleError.textContent = reason;
    });

  /* ---- email ---- */
  const panel = $('#lp-auth', root);
  const mode = panel?.dataset.mode || 'signin';
  const backed = auth.isBackendConfigured();
  const okNote = $('#lp-email-ok', root);
  const password = $('#lp-password', root);
  const nameField = $('#lp-name', root);
  const button = form.querySelector('button[type=submit]');
  const defaultLabel = button.textContent;

  const fail = (message, field) => {
    emailError.textContent = message;
    if (field) {
      field.setAttribute('aria-invalid', 'true');
      field.focus();
    }
  };
  const busy = (label) => {
    button.disabled = true;
    button.textContent = label;
  };
  const idle = () => {
    button.disabled = false;
    button.textContent = defaultLabel;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    emailError.textContent = '';
    if (okNote) okNote.textContent = '';
    email.setAttribute('aria-invalid', 'false');
    password?.setAttribute('aria-invalid', 'false');

    const value = email.value.trim();
    if (!auth.isValidEmail(value)) return fail('Enter a valid email address.', email);

    // Without a backend this is the original local path: instant, offline,
    // unverified, and honest about it.
    if (!backed) {
      busy('Setting things up…');
      try {
        finish(await auth.signInWithEmail(value), closeDialog);
      } catch (err) {
        fail(err.message);
        idle();
      }
      return;
    }

    const secret = password?.value || '';
    if (!secret) return fail('Enter your password.', password);

    busy(mode === 'signup' ? 'Creating your account…' : 'Signing you in…');
    try {
      if (mode === 'signup') {
        const out = await auth.signUpWithPassword({
          email: value,
          password: secret,
          name: nameField?.value.trim(),
        });
        if (out.pending) {
          // The project requires confirmation, so there is no session yet.
          // Say that plainly instead of appearing to hang.
          form.querySelectorAll('input').forEach((n) => (n.disabled = true));
          button.remove();
          if (okNote) {
            okNote.textContent = `Check ${out.email} for a confirmation link, then sign in.`;
          }
          return;
        }
        finish(out.session, closeDialog);
      } else {
        finish(await auth.signInWithPassword({ email: value, password: secret }), closeDialog);
      }
    } catch (err) {
      fail(err.message, err.message.toLowerCase().includes('password') ? password : email);
      idle();
    }
  });

  /* ---- the alternatives ---- */
  $('#lp-toggle-mode', root)?.addEventListener('click', () => {
    // Rebuild the panel in the other mode, in place.
    const host = panel.parentElement;
    const next = buildAuth({ mode: mode === 'signup' ? 'signin' : 'signup' });
    host.replaceChild(next, panel);
    wireAuth(host, closeDialog);
    setTimeout(() => $('#lp-email', host)?.focus(), 40);
  });

  $('#lp-magic', root)?.addEventListener('click', async () => {
    emailError.textContent = '';
    const value = email.value.trim();
    if (!auth.isValidEmail(value)) return fail('Enter your email address first.', email);
    busy('Sending…');
    try {
      await auth.sendMagicLink(value);
      if (okNote) okNote.textContent = `Link sent to ${value}. Open it on this device.`;
      idle();
    } catch (err) {
      fail(err.message);
      idle();
    }
  });

  $('#lp-forgot', root)?.addEventListener('click', async () => {
    emailError.textContent = '';
    const value = email.value.trim();
    if (!auth.isValidEmail(value)) return fail('Enter your email address first.', email);
    busy('Sending…');
    try {
      await auth.sendPasswordReset(value);
      if (okNote) okNote.textContent = `Reset link sent to ${value}.`;
      idle();
    } catch (err) {
      fail(err.message);
      idle();
    }
  });

}

function finish(session, closeDialog) {
  closeDialog?.();
  demo?.stop();
  onDone?.(session);
}

/* Google's mark, for the disabled fallback button only — the live button is
   rendered by Google's own script. */
function googleGlyph() {
  return `<svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.7 9.5 24 9.5z"/>
    <path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-2.8-.4-4H24v7.5h12.7c-.3 2.1-1.6 5.3-4.7 7.4l7.6 5.9c4.5-4.2 6.5-10.3 6.5-16.8z"/>
    <path fill="#FBBC05" d="M10.4 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.8-6.1C1 16.3 0 20 0 24s1 7.7 2.6 10.8l7.8-6.1z"/>
    <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2 1.4-4.8 2.4-8.3 2.4-6.3 0-11.7-3.7-13.6-9.8l-7.8 6.1C6.5 42.6 14.6 48 24 48z"/>
  </svg>`;
}

/* ================================= DEMO ================================= */

/**
 * Try the real video first; fall back to the scripted demo when it is missing.
 * Returns a handle with `stop()` so leaving the page kills the timers.
 */
function startDemo(stage) {
  let scripted = null;

  // No recording configured: go straight to the live app. Asking the server
  // for a file we know is absent cost a 404 per load and a 1.2s wait for the
  // guard to fire before falling back.
  if (!DEMO_VIDEO) return runLiveDemo(stage, () => runScriptedDemo(stage));

  const video = el('video', {
    src: DEMO_VIDEO,
    poster: 'icons/icon-512.png',
    autoplay: true,
    muted: true,
    loop: true,
    playsinline: true,
    preload: 'metadata',
    'aria-label': 'A walkthrough of MIKŌ',
  });
  video.muted = true; // Safari ignores the attribute unless set as a property

  const useScripted = () => {
    if (scripted) return;
    video.remove();
    scripted = runLiveDemo(stage, () => runScriptedDemo(stage));
  };

  video.addEventListener('error', useScripted, { once: true });
  video.addEventListener('loadeddata', () => {
    if (video.videoWidth === 0) useScripted();
  });

  stage.appendChild(video);
  // If metadata never arrives (missing file on some servers returns HTML),
  // don't leave a dead frame sitting there.
  const guard = setTimeout(() => {
    if (!video.videoWidth) useScripted();
  }, 1200);

  return {
    stop() {
      clearTimeout(guard);
      scripted?.stop();
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch {
        /* already torn down */
      }
    },
  };
}

/* ---- the live application ----
 *
 * An iframe of the real app, laid out at a desktop width and scaled into the
 * frame, then driven through its own controls — the same buttons a visitor
 * would click. Nothing here reimplements the product: if a view breaks, the
 * landing page shows it broken, which is the point.
 *
 * It is inert to the page: pointer events off, hidden from assistive tech. The
 * surrounding copy carries the meaning; this is a moving screenshot.
 */
function runLiveDemo(stage, onFail) {
  // The width the app is laid out at inside the frame, before scaling. Wide
  // enough to stay on the desktop layout (the rail collapses at 720px), narrow
  // enough to render large. In a small frame there is no scale that keeps a
  // desktop layout readable, so lay it out as a phone instead — the app has a
  // real mobile layout, and showing it is more honest than shrinking the
  // desktop one to five-pixel text.
  const WIDE_BASE = 920;
  const NARROW_BASE = 430;
  const baseFor = (w) => (w < 560 ? NARROW_BASE : WIDE_BASE);

  const frame = el('iframe.demo-live', {
    // Carried on the URL so the app inside applies it before its first paint.
    src: `${APP_SRC}&theme=${pageTheme()}`,
    title: 'MIKŌ running',
    tabindex: '-1',
    'aria-hidden': 'true',
    scrolling: 'no',
  });
  const caption = el('div.demo-caption');
  const progress = el('div.demo-progress', {}, el('i'));
  const cursor = el('div.demo-cursor', {
    'aria-hidden': 'true',
    html:
      '<svg viewBox="0 0 24 24"><path d="M5 2.5 18.5 12 12 12.8 8.8 19z"/></svg>' +
      '<span class="demo-cursor-ring"></span>',
  });
  // Shown before anything moves. The frame is blank for a second or two while
  // the app boots inside it anyway, so that time carries the three lines
  // instead of sitting empty. One line per card: no heading, no paragraph —
  // each gets its own entrance and its own wash so they read as beats rather
  // than a slideshow of the same card.
  const INTRO_CARDS = [
    { text: 'A task manager that files itself.', cls: 'is-rise' },
    { text: 'Boards, calendar, insights.', cls: 'is-split' },
    { text: 'Works offline, start to finish.', cls: 'is-wipe' },
  ];
  // Long enough to read a line and look at it, rather than catch it going
  // past. Three lines at this pace is about seven seconds.
  const CARD_MS = 2400;

  const intro = el(
    'div.demo-intro',
    {},
    ...INTRO_CARDS.map((c, i) =>
      el(`div.demo-card.${c.cls}`, { 'data-i': String(i) }, el('span', { text: c.text }))
    )
  );

  intro.firstElementChild.classList.add('is-on');
  stage.append(frame, caption, progress, cursor, intro);

  let scale = 1;
  const fit = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    // Lay the app out at a real desktop width, then scale the whole frame so
    // it fills the window exactly. The app's own breakpoints never see the
    // scaled size, so it renders its desktop layout at any frame size.
    const base = baseFor(w);
    scale = w / base;
    frame.style.width = `${base}px`;
    frame.style.height = `${h / scale}px`;
    frame.style.transform = `scale(${scale})`;
  };
  fit();
  const ro = new ResizeObserver(fit);
  ro.observe(stage);

  const introStarted = performance.now();

  let timers = [];
  let stopped = false;
  let failed = false;
  let fallback = null;

  const after = (ms, fn) => {
    const t = setTimeout(() => {
      if (!stopped) fn();
    }, ms);
    timers.push(t);
    return t;
  };
  const clearTimers = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };

  const say = (text, iconName = 'sparkle') => {
    caption.innerHTML = '';
    caption.append(el('span', { html: icon(iconName, { size: 12 }) }), el('span', { text }));
  };

  const give_up = (why) => {
    if (failed) return;
    failed = true;
    console.warn('[miko] live demo unavailable, using the scripted one —', why);
    clearTimers();
    ro.disconnect();
    frame.remove();
    caption.remove();
    progress.remove();
    cursor.remove();
    intro.remove();
    fallback = onFail?.();
  };

  frame.addEventListener('error', () => give_up('iframe error'));

  // A same-origin iframe that never reaches a built shell is a dead frame on
  // the landing page. Rather than show one, fall back.
  const guard = setTimeout(() => {
    if (!doc()?.querySelector('.app')) give_up('app did not start in time');
  }, 8000);

  function doc() {
    try {
      return frame.contentDocument;
    } catch {
      return null; // cross-origin, which should be impossible here
    }
  }

  function go(hash) {
    const w = frame.contentWindow;
    if (w) w.location.hash = hash;
  }

  /* -------- the pointer --------
     A drawn cursor that travels to a control, presses it, and lets the app
     respond — so the demo reads as someone using the product rather than
     views changing on their own. The iframe sits at the stage origin and is
     scaled from its top-left, so a point inside it maps to stage coordinates
     by a single multiply. */
  function centreOf(node) {
    const r = node.getBoundingClientRect();
    return { x: (r.left + r.width / 2) * scale, y: (r.top + r.height / 2) * scale };
  }

  function pointAt(node, { hold = 620, then } = {}) {
    if (!node) {
      then?.();
      return;
    }
    const { x, y } = centreOf(node);
    cursor.classList.add('is-on');
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    after(hold, () => {
      cursor.classList.add('is-press');
      after(190, () => cursor.classList.remove('is-press'));
      try {
        node.click();
      } catch (err) {
        console.warn('[miko] demo click failed', err);
      }
      then?.();
    });
  }

  /** Find a real control by its visible label, the way a person would read it. */
  function byLabel(text, sel = 'button, a, [role="tab"], [role="menuitem"]') {
    const d = doc();
    if (!d) return null;
    const want = text.toLowerCase();
    return (
      [...d.querySelectorAll(sel)].find((n) => n.textContent.trim().toLowerCase() === want) || null
    );
  }

  /** Rail entries carry their count in the same node, so match on the start. */
  function byRail(text) {
    const d = doc();
    if (!d) return null;
    const want = text.toLowerCase();
    return (
      [...d.querySelectorAll('#rail button, #rail a')].find((n) =>
        n.textContent.trim().toLowerCase().startsWith(want)
      ) || null
    );
  }

  const clickLabel = (text) => pointAt(byLabel(text));
  const clickRail = (text) => pointAt(byRail(text));

  /* -------- the tour -------- */
  // The demo opens in the visitor's own theme, so the theme steps are relative
  // rather than fixed: switch to the other one, spend a few views there, then
  // come back to theirs. A dark-mode visitor sees dark, light, dark; a
  // light-mode visitor sees the mirror of that. Captions and icons follow.
  const otherTheme = () => (pageTheme() === 'dark' ? 'Light' : 'Dark');
  const ownTheme = () => (pageTheme() === 'dark' ? 'Dark' : 'Light');

  const STEPS = [
    ['Your day, the moment it opens', 'today', () => go('#/today')],
    ['The same tasks, as a board', 'board', () => clickLabel('Board')],
    [
      () => (pageTheme() === 'dark' ? 'Lighter, if you prefer' : 'Darker, if you prefer'),
      () => (pageTheme() === 'dark' ? 'sun' : 'moon'),
      () => setTheme(otherTheme()),
    ],
    ['Against the calendar', 'calendar', () => { go('#/today'); after(500, () => clickLabel('Calendar')); }],
    ['What is coming', 'upcoming', () => { byLabel('List')?.click(); clickRail('Upcoming'); }],
    [
      'Back to the way you have it',
      () => (pageTheme() === 'dark' ? 'moon' : 'sun'),
      () => setTheme(ownTheme()),
    ],
    ['Numbers from your own data', 'insights', () => clickRail('Insights')],
    ['Everything reachable from ⌘K', 'command', openPalette],
  ];
  // Each step needs roughly 1.5s to actually complete its action — travel the
  // pointer, click, let the app respond — so this is about as tight as it goes
  // without steps being cut off mid-gesture. The intro lines keep their own,
  // slower pace; they are read, not watched.
  const STEP_MS = 2800;
  const TOTAL = STEPS.length * STEP_MS;

  /* -------- themes --------
     Driven through the app's own appearance controls, so the demo is showing
     the setting working rather than a stylesheet being swapped underneath it. */
  function setTheme(label) {
    if (doc()?.querySelector('.cmd')) closePalette();
    go('#/settings');

    const press = () =>
      whenPresent(
        () => byLabel(label, '.seg button'),
        (btn) => pointAt(btn, { hold: 420 })
      );

    // Settings is panelled and opens on Account, so Appearance has to be
    // selected first — on the second theme step it is already showing. Waiting
    // for the control to exist rather than guessing a delay: a fixed wait was
    // landing before the panel had rendered, and the step silently did nothing.
    whenPresent(
      () => byLabel('Appearance', '.settings-nav button'),
      (tab) => {
        if (tab.getAttribute('aria-current') === 'true') press();
        else pointAt(tab, { hold: 360, then: () => after(260, press) });
      }
    );
  }

  /** Poll briefly for a control the app has not rendered yet, then give up
   *  quietly — a missing control should cost one step, not the loop. */
  function whenPresent(find, then, tries = 22) {
    const tick = () => {
      if (stopped || failed) return;
      const node = find();
      if (node) return then(node);
      if (--tries > 0) after(120, tick);
    };
    tick();
  }

  function openPalette() {
    const d = doc();
    if (!d) return;
    // The app binds ⌘K on its own document, so this is the real shortcut path.
    d.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true })
    );
    // Then search in it, so the step shows the thing working rather than just
    // a panel appearing.
    after(760, () => {
      const input = doc()?.querySelector('.cmd-input');
      if (!input) return;
      const q = 'invoice';
      let i = 1;
      const type = () => {
        if (stopped || failed) return;
        input.value = q.slice(0, i);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        if (++i <= q.length) after(95, type);
      };
      type();
    });
  }

  function closePalette() {
    const d = doc();
    if (!d || !d.querySelector('.cmd')) return;
    // Escape is bound on the palette's input, not the document — dispatching
    // it anywhere else does nothing.
    d.querySelector('.cmd-input')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    // The backdrop closes it too; use that if the key did not land.
    if (d.querySelector('.cmd')) {
      d.querySelector('.overlay')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    }
  }

  /** Put the demo back in step with the page. The tour deliberately changes
   *  the app's theme to show both, so every cycle starts from whatever the
   *  visitor is actually looking at. */
  function syncTheme() {
    const d = doc();
    if (d) d.documentElement.dataset.theme = pageTheme();
  }

  /** The three lines, then hand over. Part of the cycle rather than a one-off,
   *  so the demo repeats in full rather than looping only the tour. */
  function playIntro(alreadyElapsed, then) {
    const cards = [...intro.children];
    intro.classList.remove('is-out');
    // Nothing from the last pass should still be showing underneath.
    caption.innerHTML = '';
    const bar = progress.firstElementChild;
    bar.style.transition = 'none';
    bar.style.width = '0%';
    cards.forEach((card, i) => {
      after(Math.max(0, i * CARD_MS - alreadyElapsed), () => {
        cards.forEach((c) => c.classList.remove('is-on'));
        card.classList.add('is-on');
      });
    });
    after(Math.max(0, cards.length * CARD_MS - alreadyElapsed), () => {
      intro.classList.add('is-out');
      after(420, then);
    });
  }

  function loop(introElapsed = CARD_MS * 3) {
    if (stopped || failed) return;
    clearTimers();
    syncTheme();
    playIntro(introElapsed, runTour);
  }

  function runTour() {
    if (stopped || failed) return;

    const bar = progress.firstElementChild;
    bar.style.transition = 'none';
    bar.style.width = '0%';
    void bar.offsetWidth;
    bar.style.transition = `width ${TOTAL}ms linear`;
    bar.style.width = '100%';

    STEPS.forEach(([text, iconName, run], i) => {
      after(i * STEP_MS, () => {
        // Caption and icon may depend on the visitor's theme, so resolve them
        // when the step runs rather than when the list was written.
        say(typeof text === 'function' ? text() : text,
            typeof iconName === 'function' ? iconName() : iconName);
        try {
          run();
        } catch (err) {
          console.warn('[miko] demo step failed', text, err);
        }
      });
    });

    after(TOTAL, () => {
      closePalette();
      // Leave the app on Today so the next pass starts where a visitor would,
      // and run the whole thing again — lines included.
      go('#/today');
      after(500, () => loop(0));
    });
  }

  frame.addEventListener('load', () => {
    // The app boots asynchronously inside the frame; wait for the shell rather
    // than guessing at a delay.
    let tries = 0;
    const waitForShell = () => {
      if (stopped || failed) return;
      if (doc()?.querySelector('.app')) {
        clearTimeout(guard);
        // On the first run the cards have already been showing while the app
        // booted, so only serve out whatever time is left of them.
        loop(Math.max(0, performance.now() - introStarted));
        return;
      }
      if (++tries > 80) return give_up('shell never appeared');
      after(100, waitForShell);
    };
    waitForShell();
  });

  /* -------- pause when it cannot be seen -------- */
  let onScreen = true;
  const sync = () => {
    const shouldRun = onScreen && !document.hidden;
    if (shouldRun && stopped) {
      stopped = false;
      fit();
      loop(0);
    } else if (!shouldRun && !stopped) {
      stopped = true;
      clearTimers();
      cursor.classList.remove('is-on', 'is-press');
    }
  };
  // The theme control sets data-theme on the page; the demo follows it, and
  // follows the device directly when no attribute is set.
  const themeWatch = new MutationObserver(syncTheme);
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', syncTheme);

  const io = new IntersectionObserver(([e]) => {
    onScreen = e.isIntersecting;
    sync();
  }, { threshold: 0.15 });
  io.observe(stage);
  document.addEventListener('visibilitychange', sync);

  return {
    stop() {
      stopped = true;
      clearTimeout(guard);
      clearTimers();
      io.disconnect();
      ro.disconnect();
      themeWatch.disconnect();
      mq.removeEventListener('change', syncTheme);
      document.removeEventListener('visibilitychange', sync);
      fallback?.stop();
      frame.remove();
      caption.remove();
      progress.remove();
      cursor.remove();
      intro.remove();
    },
  };
}

/* ---- the scripted fallback ---- */

const TYPED = 'Review Q3 supplier contracts tomorrow 3pm #Work !high';

const SEED_ROWS = [
  { title: 'Reconcile October invoices', p: 'medium', meta: '<span class="late">2d overdue</span>' },
  { title: 'Send the board update deck', p: 'high', meta: '<span class="soon">Today 2:00 PM</span>' },
  { title: 'Approve the design handoff', p: 'medium', meta: 'Today · Design' },
  { title: 'Draft hiring plan for Q4', p: 'high', meta: 'Tomorrow · Work' },
  { title: 'Book the dentist', p: 'low', meta: 'Fri' },
  { title: 'Renew the domain', p: 'none', meta: 'Mon · Personal' },
];

function runScriptedDemo(stage) {
  const introStarted = performance.now();

  let timers = [];
  let stopped = false;

  const after = (ms, fn) => {
    const t = setTimeout(() => {
      if (!stopped) fn();
    }, ms);
    timers.push(t);
    return t;
  };

  const clearTimers = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };

  const root = el('div.demo');
  const caption = el('div.demo-caption');
  const progress = el('div.demo-progress', {}, el('i'));
  stage.append(root, caption, progress);

  // Lay the demo out at a fixed height and whatever width the frame's aspect
  // implies, then scale to fit exactly. Inside a framed window the whole
  // interface should be visible — nothing cropped off an edge.
  //
  // Below NARROW_W there is no scale that keeps the type readable, so the demo
  // stops scaling, renders at its natural size, and folds the rail away — the
  // same thing the real app does on a phone. Shrinking a desktop layout into a
  // 343px frame would land around 7px text, which is a picture of an interface
  // rather than a demonstration of one.
  const BASE_H = 340;
  const NARROW_W = 560;
  // Past this the demo stops magnifying and starts showing more instead — a
  // bigger frame should look like a bigger window onto the app, not the same
  // window zoomed until the type is oversized.
  const MAX_SCALE = 1.3;
  let scale = 1;

  const fit = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    const narrow = w < NARROW_W;
    root.classList.toggle('is-narrow', narrow);
    scale = narrow ? 1 : Math.min(h / BASE_H, MAX_SCALE);
    root.style.width = `${w / scale}px`;
    root.style.height = `${h / scale}px`;
    stage.style.setProperty('--demo-scale', String(scale));
  };

  fit();
  const ro = new ResizeObserver(fit);
  ro.observe(stage);

  const rail = el(
    'div.demo-rail',
    {},
    railItem('today', 'Today', true),
    railItem('upcoming', 'Upcoming'),
    railItem('inbox', 'Inbox'),
    railItem('board', 'Board'),
    railItem('insights', 'Insights')
  );

  const top = el('div.demo-top', { text: 'Today' });
  const body = el('div.demo-body');
  root.append(rail, el('div.demo-main', {}, top, body));

  function railItem(iconName, label, on) {
    return el(
      `div.demo-rail-item${on ? '.on' : ''}`,
      { 'data-k': label },
      el('span', { html: icon(iconName === 'board' ? 'board' : iconName, { size: 11 }) }),
      el('span', { text: label })
    );
  }

  function setRail(label) {
    for (const item of rail.children) item.classList.toggle('on', item.dataset.k === label);
  }

  function say(text, iconName = 'sparkle') {
    caption.innerHTML = '';
    caption.append(el('span', { html: icon(iconName, { size: 12 }) }), el('span', { text }));
  }

  function row({ title, p, meta, fresh, done }) {
    return el(
      `div.demo-row${fresh ? '.fresh' : ''}${done ? '.completed' : ''}`,
      { 'data-p': p },
      el(`div.demo-check${done ? '.done' : ''}`, { html: icon('check', { size: 8 }) }),
      el('div.demo-title', { text: title }),
      el('div.demo-meta', { html: meta || '' })
    );
  }

  /* -------- scene 1: natural-language capture -------- */
  function sceneCapture(done) {
    setRail('Today');
    top.textContent = 'Today';
    clear(body);
    say('Type it like you\u2019d say it', 'command');

    const caret = el('span.demo-caret');
    const text = el('span', { text: '' });
    const input = el(
      'div.demo-input',
      {},
      el('span', { html: icon('plus', { size: 12 }) }),
      text,
      caret
    );
    const chips = el('div.demo-chips');
    const list = el('div');
    body.append(input, chips, list);

    SEED_ROWS.forEach((r, i) => {
      const node = row(r);
      node.style.animationDelay = `${i * 60}ms`;
      list.appendChild(node);
    });

    after(500, () => input.classList.add('active'));

    // Type it out, a little irregularly so it reads as typing.
    let i = 0;
    const step = () => {
      if (stopped) return;
      text.textContent = TYPED.slice(0, i);
      i += 1;
      if (i <= TYPED.length) {
        after(TYPED[i - 1] === ' ' ? 58 : 26 + Math.random() * 34, step);
      } else {
        after(420, revealChips);
      }
    };
    after(700, step);

    function revealChips() {
      say('It reads date, project, priority', 'sparkle');
      const parsed = [
        ['calendar', 'Tomorrow 3:00 PM'],
        ['project', 'Work'],
        ['flag', 'High'],
      ];
      parsed.forEach(([ic, label], n) => {
        const chip = el(
          'span.demo-chip',
          { style: { animationDelay: `${n * 130}ms` } },
          el('span', { html: icon(ic, { size: 10 }) }),
          el('span', { text: label })
        );
        chips.appendChild(chip);
      });
      after(1250, commit);
    }

    function commit() {
      text.textContent = '';
      caret.remove();
      input.classList.remove('active');
      clear(chips);
      const fresh = row({
        title: 'Review Q3 supplier contracts',
        p: 'high',
        meta: '<span class="soon">Tomorrow 3:00 PM</span> · Work',
        fresh: true,
      });
      list.insertBefore(fresh, list.firstChild);
      say('One line in, a full task out', 'circleCheck');
      after(900, () => fresh.classList.remove('fresh'));
      after(1500, () => sceneComplete(done, list));
    }
  }

  /* -------- scene 2: completing work -------- */
  function sceneComplete(done, list) {
    say('Tick it off', 'circleCheck');
    const target = list.children[1];
    if (target) {
      const check = target.querySelector('.demo-check');
      after(600, () => {
        check.classList.add('done');
        target.classList.add('completed');
      });
    }
    after(1900, done);
  }

  /* -------- scene: the command palette -------- */
  function scenePalette(done) {
    setRail('Today');
    top.textContent = 'Today';
    clear(body);
    say('⌘K reaches everything', 'command');

    // The list stays behind the panel so it reads as an overlay on real work
    // rather than a screen of its own.
    const behind = el('div.demo-behind');
    SEED_ROWS.slice(0, 5).forEach((r) => behind.appendChild(row(r)));

    const typed = el('span');
    const field = el(
      'div.demo-pal-field',
      {},
      el('span', { html: icon('search', { size: 12 }) }),
      typed,
      el('span.demo-caret')
    );
    const results = el('div.demo-pal-list');
    const pal = el('div.demo-pal', {}, field, results);
    body.append(behind, pal);

    const ITEMS = [
      ['today', 'Go to Today'],
      ['repeat', 'Recurring: weekly review'],
      ['inbox', 'Reconcile October invoices'],
      ['project', 'Open project · Work'],
      ['board', 'Switch to Board'],
    ];
    const nodes = ITEMS.map(([ic, label]) =>
      el(
        'div.demo-pal-item',
        {},
        el('span', { html: icon(ic, { size: 11 }) }),
        el('span', { text: label })
      )
    );
    nodes.forEach((n) => results.appendChild(n));

    const QUERY = 'rec';
    const filter = (q) => {
      nodes.forEach((n, i) => {
        const hit = !q || ITEMS[i][1].toLowerCase().includes(q);
        n.classList.toggle('is-out', !hit);
      });
      return nodes.filter((n) => !n.classList.contains('is-out'));
    };

    after(260, () => pal.classList.add('is-in'));

    let i = 0;
    const type = () => {
      if (stopped) return;
      typed.textContent = QUERY.slice(0, i);
      filter(typed.textContent.toLowerCase());
      i += 1;
      if (i <= QUERY.length) after(150, type);
      else after(420, pick);
    };
    after(760, type);

    function pick() {
      const hits = filter(QUERY);
      say('Two matches, no menus', 'search');
      hits.forEach((n, k) => after(k * 180, () => {
        hits.forEach((m) => m.classList.remove('is-on'));
        n.classList.add('is-on');
      }));
      after(hits.length * 180 + 520, () => {
        pal.classList.add('is-go');
        after(420, done);
      });
    }
  }

  /* -------- scene: both themes -------- */
  function sceneTheme(done) {
    setRail('Today');
    top.textContent = 'Today';
    clear(body);
    say('Light or dark — same app', 'moon');

    const list = el('div');
    SEED_ROWS.forEach((r) => list.appendChild(row(r)));
    const toggle = el(
      'div.demo-toggle',
      {},
      el('span.demo-toggle-knob', {}, el('span', { html: icon('sun', { size: 10 }) }))
    );
    body.append(toggle, list);

    // The demo carries its own data-theme. The token file scopes both themes
    // with a plain attribute selector, not :root, so a subtree can hold one
    // independently of the page around it.
    const set = (t) => {
      root.dataset.theme = t;
      toggle.classList.toggle('is-dark', t === 'dark');
      clear(toggle.firstElementChild);
      toggle.firstElementChild.appendChild(
        el('span', { html: icon(t === 'dark' ? 'moon' : 'sun', { size: 10 }) })
      );
    };

    after(420, () => set('light'));
    after(2000, () => {
      set('dark');
      say('Dark is not an afterthought', 'moon');
    });
    // Hand the demo back to whatever the page is using.
    after(3700, () => {
      delete root.dataset.theme;
      done();
    });
  }

  /* -------- scene 3: the board -------- */
  function sceneBoard(done) {
    setRail('Board');
    top.textContent = 'Board';
    clear(body);
    say('Drag to change status', 'board');

    const cols = ['To do', 'In progress', 'Done'].map((name) =>
      el('div.demo-col', { 'data-n': name }, el('div.demo-col-head', { text: name }))
    );
    const board = el('div.demo-board', { style: { position: 'relative' } }, ...cols);
    body.appendChild(board);

    cols[0].append(
      el('div.demo-card', { text: 'Draft hiring plan' }),
      el('div.demo-card', { text: 'Renew the domain' }),
      el('div.demo-card', { text: 'Plan the offsite agenda' })
    );
    cols[1].append(
      el('div.demo-card', { text: 'Reconcile invoices' }),
      el('div.demo-card', { text: 'Review pull request #218' }),
      el('div.demo-card', { text: 'Approve design handoff' })
    );
    cols[2].append(
      el('div.demo-card', { text: 'Send board deck' }),
      el('div.demo-card', { text: 'Ship the pricing page' })
    );

    after(700, () => {
      const card = cols[0].children[1]; // "Draft hiring plan"
      // getBoundingClientRect reports post-transform pixels, but left/top are
      // applied in the element's own unscaled space — divide the difference
      // out or the card lands in the wrong place once the demo is scaled.
      const rel = (node) => {
        const a = node.getBoundingClientRect();
        const b = board.getBoundingClientRect();
        return { x: (a.left - b.left) / scale, y: (a.top - b.top) / scale, w: a.width / scale };
      };
      const from = rel(card);

      const flying = el('div.demo-card.flying', {
        text: card.textContent,
        style: {
          left: `${from.x}px`,
          top: `${from.y}px`,
          width: `${from.w}px`,
        },
      });
      card.style.visibility = 'hidden';
      board.appendChild(flying);
      cols[1].classList.add('target');

      after(60, () => {
        const target = rel(cols[1]);
        flying.style.left = `${target.x + 7}px`;
        flying.style.top = `${target.y + 26}px`;
        flying.style.transform = 'rotate(0deg)';
      });

      after(900, () => {
        flying.remove();
        card.remove();
        cols[1].appendChild(el('div.demo-card', { text: 'Draft hiring plan' }));
        cols[1].classList.remove('target');
        say('Updated everywhere', 'circleCheck');
      });
    });

    after(2600, done);
  }

  /* -------- scene 4: insights -------- */
  function sceneInsights(done) {
    setRail('Insights');
    top.textContent = 'Insights';
    clear(body);
    say('Real numbers', 'insights');

    const stat = (n, l) =>
      el('div.demo-stat', {}, el('div.demo-stat-n', { text: n }), el('div.demo-stat-l', { text: l }));

    body.append(
      el('div.demo-stats', {}, stat('86%', 'Completion rate'), stat('2.4d', 'Avg cycle time'), stat('19', 'Done this week'))
    );

    const chart = el('div.demo-chart');
    const heights = [38, 56, 30, 72, 48, 84, 62, 40, 68, 52, 90, 46];
    const bars = heights.map(() => el('div.demo-bar'));
    chart.append(...bars);
    body.appendChild(chart);

    // A breakdown under the chart, so a tall panel reads as a populated screen
    // rather than a chart floating in space.
    const table = el('div', { style: { marginTop: '14px' } });
    for (const [name, open, done_, pct] of [
      ['Work', '12 open', '38 done', 76],
      ['Engineering', '8 open', '24 done', 75],
      ['Personal', '3 open', '11 done', 79],
    ]) {
      table.appendChild(
        el(
          'div.demo-row',
          { style: { animationDelay: '0ms' } },
          el('div.demo-title', { text: name }),
          el(
            'div.demo-meta',
            {},
            el('span', { text: open }),
            el('span', { text: done_ }),
            el('span', { style: { color: 'var(--demo-accent)' }, text: `${pct}%` })
          )
        )
      );
    }
    body.appendChild(table);

    after(120, () => bars.forEach((b, i) => after(i * 55, () => (b.style.height = `${heights[i]}%`))));
    after(3000, done);
  }

  /* -------- timeline -------- */
  const SCENES = [sceneCapture, scenePalette, sceneBoard, sceneTheme, sceneInsights];
  const TOTAL = 26_000;

  function loop() {
    if (stopped) return;
    clearTimers();

    const bar = progress.firstElementChild;
    bar.style.transition = 'none';
    bar.style.width = '0%';
    // force reflow so the reset is not coalesced with the growth below
    void bar.offsetWidth;
    bar.style.transition = `width ${TOTAL}ms linear`;
    bar.style.width = '100%';

    let i = 0;
    const next = () => {
      if (stopped) return;
      if (i >= SCENES.length) {
        after(700, loop);
        return;
      }
      SCENES[i++](next);
    };
    next();
  }

  loop();

  // Pause when it cannot be seen — scrolled away, or the tab is in the
  // background. Both matter: a hidden tab throttles timers to roughly one a
  // second, so an unpaused demo doesn't just waste battery, it also desyncs
  // and resumes mid-sentence.
  let onScreen = true;

  const sync = () => {
    const shouldRun = onScreen && !document.hidden;
    if (shouldRun && stopped) {
      stopped = false;
      // Resize callbacks are delivered on the rendering loop, which does not
      // tick for a hidden tab — so the frame may have changed size since the
      // last fit. Re-measure before drawing anything.
      fit();
      loop();
    } else if (!shouldRun && !stopped) {
      stopped = true;
      clearTimers();
    }
  };

  const io = new IntersectionObserver(
    ([entry]) => {
      onScreen = entry.isIntersecting;
      sync();
    },
    { threshold: 0.15 }
  );
  io.observe(stage);

  document.addEventListener('visibilitychange', sync);

  return {
    stop() {
      stopped = true;
      clearTimers();
      io.disconnect();
      ro.disconnect();
      themeWatch.disconnect();
      mq.removeEventListener('change', syncTheme);
      document.removeEventListener('visibilitychange', sync);
      root.remove();
      caption.remove();
      progress.remove();
    },
  };
}

/* =============================== FEATURES =============================== */

/* Each entry carries a small visual that shows the idea instead of restating
   it. No per-entry colour: the section reads as one piece of typography with
   a diagram in it, not six colour-coded cards. */
const FEATURES = [
  {
    icon: 'command',
    title: 'Keyboard-first',
    variant: 'keys',
    line: '⌘K reaches every view, project and action.',
    detail:
      'The palette is the whole application. Open it anywhere and every view, ' +
      'project and action is one search away — the mouse is optional, not assumed.',
    viz:
      '<div class="lp-viz lp-viz-keys">' +
      '<kbd>⌘</kbd><kbd>K</kbd>' +
      '<span class="lp-viz-arrow">→</span>' +
      '<span class="lp-viz-field">go to project<i></i></span>' +
      '</div>',
    specs: ['⌘K / Ctrl-K from anywhere', 'Matches on prefix as you type', 'Arrow keys, then Enter'],
  },
  {
    icon: 'blocked',
    title: 'Dependencies',
    variant: 'band',
    line: 'Cycles are caught before you can create one.',
    detail:
      'Block one task on another and the link is tested before it is allowed. ' +
      'A chain that would close on itself is refused, with the reason.',
    viz:
      '<div class="lp-viz lp-viz-graph">' +
      '<svg viewBox="0 0 228 58" aria-hidden="true">' +
      '<path d="M46 20h44M108 20h44" class="lp-edge"/>' +
      '<path d="M170 32q-56 30-140 0" class="lp-edge lp-edge-bad"/>' +
      '<circle cx="30" cy="20" r="13" class="lp-node"/>' +
      '<circle cx="114" cy="20" r="13" class="lp-node"/>' +
      '<circle cx="198" cy="20" r="13" class="lp-node"/>' +
      '<path d="M94 46l14 12M108 46l-14 12" class="lp-cross"/>' +
      '</svg>' +
      '<span class="lp-viz-note">cycle refused</span>' +
      '</div>',
    specs: ['Blocker graph walked depth-first', 'Parent tree checked separately', 'Refused with a reason, not a crash'],
  },
  {
    icon: 'repeat',
    title: 'Recurring work',
    variant: 'bleed',
    line: 'The next one appears the moment you finish.',
    detail:
      'Give a task a rule and completing it generates the next instance — landing ' +
      'on dates that actually exist, even at the end of February.',
    viz:
      '<div class="lp-viz lp-viz-cal">' +
      ['4', '5', '6', '7', '8', '9', '10', '11']
        .map((d, i) =>
          `<span class="lp-cal-cell${i === 0 ? ' is-done' : ''}${i === 7 ? ' is-next' : ''}">${d}</span>`)
        .join('') +
      '</div>',
    specs: ['Daily, weekly, monthly, by position', 'Month-end clamped to real days', 'Generated on completion, not a timer'],
  },
  {
    icon: 'automation',
    title: 'Automations',
    variant: 'flow',
    line: 'Done here, follow-up there — without you.',
    detail:
      'When this changes, do that. Rules run against your own writes, in order, ' +
      'on-device — and nothing they do is beyond reach.',
    viz:
      '<div class="lp-viz lp-viz-flow">' +
      '<span class="lp-flow-chip">status → done</span>' +
      '<span class="lp-viz-arrow">→</span>' +
      '<span class="lp-flow-chip is-mark">create follow-up</span>' +
      '</div>',
    specs: ['Trigger, condition, action', 'Runs offline like everything else', 'Every effect is undoable'],
  },
  {
    icon: 'timer',
    title: 'Estimates',
    variant: 'figure',
    figure: { value: '+58%', label: 'over estimate, this project' },
    line: 'Estimate against actual, so you learn your bias.',
    detail:
      'Track time against what you guessed. The gap stops being a feeling and ' +
      'becomes a number you can plan the next one with.',
    viz:
      '<div class="lp-viz lp-viz-bars">' +
      '<div class="lp-bar-row"><span class="lp-bar-l">est</span>' +
      '<span class="lp-bar"><i style="width:54%"></i></span><span class="lp-bar-v">2h</span></div>' +
      '<div class="lp-bar-row"><span class="lp-bar-l">actual</span>' +
      '<span class="lp-bar"><i class="is-mark" style="width:86%"></i></span>' +
      '<span class="lp-bar-v">3h 10m</span></div>' +
      '<span class="lp-viz-note">+58% on this project</span>' +
      '</div>',
    specs: ['Estimate vs actual per task', 'Cycle time across a project', 'Workload against your hours'],
  },
  {
    icon: 'undo',
    title: 'Undo anything',
    variant: 'aside',
    line: 'Every change reversible, and logged with who made it.',
    detail:
      'Every write goes down one pipeline that records what changed and stores ' +
      'the inverse — so a bulk edit walks back in a single step.',
    viz:
      '<div class="lp-viz lp-viz-stack">' +
      '<span class="lp-layer"></span><span class="lp-layer"></span>' +
      '<span class="lp-layer is-mark"></span>' +
      '<span class="lp-viz-note">12 tasks · one step back</span>' +
      '</div>',
    specs: ['Inverse patches, not snapshots', 'Bulk edits undo as one step', 'Full audit trail per task'],
  },
];

/* Not a card grid on a panel. The heading is held on the left while the list
   moves past it, and the rows are separated by hairlines on the page's own
   surface. The panel on the right exists only while a row is under the pointer
   or holds focus — there is no resting state for it to occupy. */
function buildFeatures() {
  const panel = el('aside.lp-more-detail', { id: 'lp-more-detail', 'aria-live': 'polite' });

  const fill = (f, row, rows) => {
    rows.forEach((r) => r.classList.toggle('is-active', r === row));
    clear(panel);
    // Alternating tone down the list: odd cards carry the brand, even ones go
    // black. Two tones, not six — the set still reads as one family.
    panel.dataset.tone = rows.indexOf(row) % 2 === 0 ? 'brand' : 'black';
    // Each card is composed around its own diagram rather than poured into one
    // template — the layout is what distinguishes them, not a colour.
    panel.dataset.variant = f.variant || 'band';
    panel.append(
      el(
        'div.lp-more-detail-main',
        {},
        f.figure
          ? el(
              'div.lp-more-figure',
              {},
              el('span.lp-more-figure-value', { text: f.figure.value }),
              el('span.lp-more-figure-label', { text: f.figure.label })
            )
          : null,
        el('h4.lp-more-detail-title', { text: f.title }),
        el('p.lp-more-detail-body', { text: f.detail }),
        el(
          'ul.lp-more-specs',
          {},
          ...f.specs.map((t) => el('li', {}, el('i'), el('span', { text: t })))
        )
      ),
      el('div.lp-more-viz', { html: f.viz })
    );
    panel.classList.add('is-on');
    // Restart the entrance animation on every swap rather than letting the new
    // content appear fully formed.
    panel.classList.remove('is-in');
    void panel.offsetWidth;
    panel.classList.add('is-in');
  };

  const rows = FEATURES.map((f, i) =>
    el(
      'li.lp-more-item',
      { tabindex: '0' },
      el('span.lp-more-index', { text: String(i + 1).padStart(2, '0') }),
      el('div.lp-more-body', {}, el('h3', { text: f.title }), el('p', { text: f.line })),
      el('span.lp-more-icon', { html: icon(f.icon, { size: 18 }) })
    )
  );

  const list = el('ol.lp-more-list', {}, ...rows);

  const hide = () => {
    panel.classList.remove('is-on', 'is-in');
    rows.forEach((r) => r.classList.remove('is-active'));
  };

  // A short grace period so crossing the gap between the list and the panel
  // does not blink it away, without giving it a resting state.
  let timer = null;
  const hideSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(hide, 110);
  };
  const keep = () => clearTimeout(timer);

  rows.forEach((row, i) => {
    const open = () => {
      keep();
      fill(FEATURES[i], row, rows);
    };
    row.addEventListener('mouseenter', open);
    row.addEventListener('focus', open);
  });

  list.addEventListener('mouseleave', hideSoon);
  panel.addEventListener('mouseenter', keep);
  panel.addEventListener('mouseleave', hideSoon);
  list.addEventListener('focusout', (e) => {
    if (!list.contains(e.relatedTarget)) hide();
  });

  return el(
    'section.lp-more',
    {},
    el(
      'div.lp-more-inner',
      {},
      el(
        'div.lp-more-head',
        {},
        el('span.lp-more-eyebrow', { text: 'Inside' }),
        el('h2.lp-more-title', { text: 'Built for the work after the first task.' }),
        el('p.lp-more-sub', {
          text: 'Everything here runs on your device, and keeps running with the network off.',
        })
      ),
      list,
      panel
    )
  );
}

function buildFoot() {
  return el(
    'footer.lp-foot',
    {},
    el(
      'span.lp-foot-by',
      {},
      el('span.lp-foot-mark', { html: 'MIK<span class="o">O</span>', 'aria-label': 'MIKŌ' }),
      el('span.lp-foot-sep', { text: '·' }),
      el('span', { text: 'by ' }),
      el('span.lp-foot-co', { text: 'Quantamania' })
    ),
    el('div.spacer'),
    el('span', { text: 'Offline. On your device.' })
  );
}
