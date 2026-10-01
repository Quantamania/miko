/* Identity.
 *
 * READ THIS BEFORE TRUSTING IT.
 *
 * MIKŌ is a static site. There is no server, so there is nothing that can
 * *verify* an identity or *withhold* data from someone who has not proved one.
 * Task data lives in IndexedDB on this device and is reachable from devtools
 * regardless of what this module says.
 *
 * So what is this for? Three real things:
 *   1. Naming the person — their name, email and avatar on tasks, comments
 *      and the activity feed, instead of a generic "You".
 *   2. A deliberate entry point — the landing page and sign-in give the app a
 *      front door rather than dropping people straight into an empty list.
 *   3. The seam for a real backend — `verify()` is where a server check goes.
 *      Google already returns a genuine, signed ID token; today we decode it
 *      for display, and a server would validate its signature and issue a
 *      session. Nothing else in the app changes.
 *
 * Google Sign-In is real: it is the official Google Identity Services flow and
 * returns a signed JWT. Email sign-in is *not* verified — no server means no
 * email can be sent — and the UI says so rather than implying otherwise.
 */

import * as db from './db.js';
import * as store from './store.js';
import { id, nowISO, emitter, localZone } from './util.js';

export const bus = emitter();

const SESSION_KEY = 'auth:session';
const CLIENT_ID_KEY = 'auth:googleClientId';
const GSI_SRC = 'https://accounts.google.com/gsi/client';

let session = null;

/* ------------------------------- session ------------------------------- */

export async function loadSession() {
  session = (await db.get('meta', SESSION_KEY))?.value || null;
  return session;
}

export function currentSession() {
  return session;
}

export function isSignedIn() {
  return Boolean(session);
}

async function persist(next) {
  session = next;
  if (next) await db.put('meta', { key: SESSION_KEY, value: next });
  else await db.del('meta', SESSION_KEY);
  bus.emit('session', next);
  return next;
}

/** Point the local user record at whoever just signed in, so their name shows
 *  on everything they do from here on. */
async function linkProfile({ name, email, picture }) {
  const user = store.state.user;
  if (!user) return null;

  const next = {
    ...user,
    name: name || user.name,
    email: email || user.email,
    avatar: picture || user.avatar,
    handle: (email ? email.split('@')[0] : user.handle) || 'you',
    timezone: user.timezone || localZone(),
  };

  await db.put('users', next);
  store.state.user = next;
  store.state.members = store.state.members.map((m) =>
    m.user_id === next.id ? { ...m, user: next } : m
  );
  store.bus.emit('profile:changed', next);
  return next;
}

/* -------------------------------- email -------------------------------- */

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());
}

/**
 * Continue with an email address.
 * Unverified by design — sending a magic link needs a mail server. This
 * records who is using the app on this device; it does not prove anything.
 */
export async function signInWithEmail(email, name) {
  const clean = String(email || '').trim().toLowerCase();
  if (!isValidEmail(clean)) {
    throw new Error('That does not look like an email address.');
  }

  const display =
    (name || '').trim() ||
    clean
      .split('@')[0]
      .replace(/[._-]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());

  await linkProfile({ name: display, email: clean, picture: null });

  const next = await persist({
    provider: 'email',
    verified: false,
    email: clean,
    name: display,
    picture: null,
    subject: `email:${clean}`,
    created_at: nowISO(),
  });

  await store.audit('auth.signed_in', { payload: { provider: 'email' } });
  return next;
}

/* -------------------------------- google -------------------------------- */

export async function getClientId() {
  return (await db.get('meta', CLIENT_ID_KEY))?.value || '';
}

export async function setClientId(value) {
  const clean = String(value || '').trim();
  if (clean) await db.put('meta', { key: CLIENT_ID_KEY, value: clean });
  else await db.del('meta', CLIENT_ID_KEY);
  bus.emit('clientId', clean);
  return clean;
}

let gsiPromise = null;

/** Load Google Identity Services once. Rejects quickly when offline so the UI
 *  can fall back to email rather than hanging on a dead script tag. */
export function loadGoogleScript() {
  if (window.google?.accounts?.id) return Promise.resolve(window.google);
  if (gsiPromise) return gsiPromise;

  gsiPromise = new Promise((resolve, reject) => {
    if (!navigator.onLine) {
      reject(new Error('Google sign-in needs a connection.'));
      return;
    }
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    const timer = setTimeout(() => {
      reject(new Error('Google sign-in did not load. Check your connection or an ad blocker.'));
    }, 8000);
    script.onload = () => {
      clearTimeout(timer);
      window.google?.accounts?.id
        ? resolve(window.google)
        : reject(new Error('Google sign-in loaded but is unavailable.'));
    };
    script.onerror = () => {
      clearTimeout(timer);
      gsiPromise = null;
      reject(new Error('Google sign-in could not be reached.'));
    };
    document.head.appendChild(script);
  });

  return gsiPromise;
}

/** Decode a JWT payload for display.
 *  This is NOT verification — it reads an unvalidated claim set. A server must
 *  check the signature, `aud`, `iss` and `exp` before trusting any of it. */
export function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(
      decodeURIComponent(
        json
          .split('')
          .map((c) => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`)
          .join('')
      )
    );
  } catch {
    return null;
  }
}

/**
 * Render Google's official button into `container`.
 * Resolves with the session once the user completes the flow.
 */
export async function mountGoogleButton(container, { onSuccess, onError, theme = 'outline' } = {}) {
  const clientId = await getClientId();
  if (!clientId) {
    throw new Error('no-client-id');
  }

  const google = await loadGoogleScript();

  google.accounts.id.initialize({
    client_id: clientId,
    callback: async (response) => {
      try {
        const claims = decodeJwt(response.credential);
        if (!claims?.email) throw new Error('Google did not return an email address.');

        await linkProfile({
          name: claims.name,
          email: claims.email,
          picture: claims.picture,
        });

        const next = await persist({
          provider: 'google',
          // Signed by Google and genuine — but unverified *by us*, because
          // verifying a signature is a server's job.
          verified: false,
          serverVerified: false,
          email: claims.email,
          name: claims.name || claims.email,
          picture: claims.picture || null,
          subject: claims.sub ? `google:${claims.sub}` : `email:${claims.email}`,
          issued_at: claims.iat ? new Date(claims.iat * 1000).toISOString() : null,
          created_at: nowISO(),
        });

        await store.audit('auth.signed_in', { payload: { provider: 'google' } });
        onSuccess?.(next);
      } catch (err) {
        onError?.(err);
      }
    },
  });

  google.accounts.id.renderButton(container, {
    theme: theme === 'dark' ? 'filled_black' : 'outline',
    size: 'large',
    shape: 'rectangular',
    text: 'continue_with',
    logo_alignment: 'left',
    width: Math.min(360, Math.max(240, container.clientWidth || 320)),
  });

  return true;
}

/* -------------------------------- sign out -------------------------------- */

export async function signOut({ forget = false } = {}) {
  try {
    window.google?.accounts?.id?.disableAutoSelect?.();
  } catch {
    /* the script may never have loaded */
  }

  await store.audit('auth.signed_out', { payload: { provider: session?.provider } });
  await persist(null);

  if (forget) {
    // "Forget me" resets the profile to anonymous but leaves the work intact —
    // deleting data is a separate, explicit action in Settings.
    const user = store.state.user;
    if (user) {
      const next = { ...user, name: 'You', email: '', avatar: null, handle: 'you' };
      await db.put('users', next);
      store.state.user = next;
      store.bus.emit('profile:changed', next);
    }
  }
  return true;
}

/** Where a backend would check the token and issue a real session. */
export async function verify() {
  return { ok: Boolean(session), serverVerified: false };
}
