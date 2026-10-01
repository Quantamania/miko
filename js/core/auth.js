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
import * as sb from './supabase.js';
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

/* ------------------------------- Supabase -------------------------------
 *
 * When js/config.js carries a project URL and anon key, sign-in becomes real:
 * accounts live in Supabase, passwords are verified server-side, and the
 * session here holds genuine tokens. With no project configured every one of
 * these refuses politely and the local-identity path below still works, so a
 * copy of the app with no backend is not a broken app.
 */

/** Read the local override (if any) and hand it to the transport. Called once
 *  at boot, before anything asks whether a backend exists. */
export async function loadBackendConfig() {
  const url = store.getSetting('supabaseUrl', '');
  const key = store.getSetting('supabaseAnonKey', '');
  sb.configure(url && key ? { url, key } : null);
  return sb.isConfigured();
}

/** Point this browser at a project without editing js/config.js. Stored
 *  locally, so it is a development convenience, not a deployment mechanism —
 *  a visitor cannot type a key they do not have. */
export async function setBackendConfig({ url, key }) {
  await store.setSetting('supabaseUrl', String(url || '').trim());
  await store.setSetting('supabaseAnonKey', String(key || '').trim());
  return loadBackendConfig();
}

export function backendConfig() {
  const c = sb.current();
  return { url: c.url, hasKey: Boolean(c.key), fromSource: Boolean(c.url && !store.getSetting('supabaseUrl', '')) };
}

export function isBackendConfigured() {
  return sb.isConfigured();
}

function requireBackend() {
  if (!sb.isConfigured()) {
    throw new Error(
      'No account server is configured yet. Add your Supabase URL and anon key to js/config.js.'
    );
  }
}

/** Shape a GoTrue session into the record this app stores. */
function toSession(payload, provider) {
  const user = payload.user || {};
  const meta = user.user_metadata || {};
  const expiresAt =
    payload.expires_at != null
      ? payload.expires_at * 1000
      : Date.now() + (payload.expires_in ?? 3600) * 1000;

  return {
    provider: provider || user.app_metadata?.provider || 'password',
    verified: true,
    userId: user.id || null,
    email: user.email || '',
    name: meta.name || meta.full_name || (user.email ? user.email.split('@')[0] : 'You'),
    picture: meta.avatar_url || meta.picture || null,
    accessToken: payload.access_token || '',
    refreshToken: payload.refresh_token || '',
    expiresAt,
    signedInAt: nowISO(),
  };
}

async function adopt(payload, provider) {
  const next = toSession(payload, provider);
  await linkProfile({ name: next.name, email: next.email, picture: next.picture });
  await persist(next);
  scheduleRefresh();
  await store.audit('auth.signed_in', { payload: { provider: next.provider, verified: true } });
  return next;
}

/** Create an account. Returns `{ session }` when the project signs people in
 *  straight away, or `{ pending: true }` when it wants the address confirmed
 *  first — both are normal, and the caller has to say which happened. */
export async function signUpWithPassword({ email, password, name }) {
  requireBackend();
  const clean = String(email || '').trim().toLowerCase();
  if (!isValidEmail(clean)) throw new Error('That does not look like an email address.');
  if (!password || password.length < 8) {
    throw new Error('Use at least 8 characters for the password.');
  }

  const out = await sb.signUp({ email: clean, password, name });
  if (out?.access_token) return { session: await adopt(out, 'password') };
  return { pending: true, email: clean };
}

export async function signInWithPassword({ email, password }) {
  requireBackend();
  const clean = String(email || '').trim().toLowerCase();
  if (!isValidEmail(clean)) throw new Error('That does not look like an email address.');
  if (!password) throw new Error('Enter your password.');

  const out = await sb.signInWithPassword({ email: clean, password });
  return adopt(out, 'password');
}

export async function sendMagicLink(email) {
  requireBackend();
  const clean = String(email || '').trim().toLowerCase();
  if (!isValidEmail(clean)) throw new Error('That does not look like an email address.');
  await sb.sendMagicLink({ email: clean });
  return { sent: true, email: clean };
}

export async function sendPasswordReset(email) {
  requireBackend();
  const clean = String(email || '').trim().toLowerCase();
  if (!isValidEmail(clean)) throw new Error('That does not look like an email address.');
  await sb.sendPasswordReset({ email: clean });
  return { sent: true, email: clean };
}

/** Hand the browser to a provider. This navigates away; the app picks the
 *  session back up in completeRedirect() on the way in. */
export function startOAuth(provider = 'google') {
  requireBackend();
  location.href = sb.oauthUrl(provider);
}

/**
 * Finish an OAuth or magic-link round trip.
 *
 * Supabase returns tokens in the URL fragment. This has to run before the hash
 * router reads location.hash, or the app tries to navigate to a route called
 * `access_token=...`. The fragment is cleared either way so the tokens do not
 * sit in the address bar or in history.
 */
export async function completeRedirect() {
  if (!sb.isConfigured()) return null;

  const frag = sb.readRedirectFragment();
  if (!frag) return null;

  history.replaceState(null, '', location.pathname + location.search);

  if (frag.error) throw new Error(frag.error);

  // The fragment carries tokens but not the profile, so fetch the user.
  const user = await sb.getUser({ token: frag.accessToken });
  return adopt(
    {
      access_token: frag.accessToken,
      refresh_token: frag.refreshToken,
      expires_at: Math.floor(frag.expiresAt / 1000),
      user,
    },
    user?.app_metadata?.provider
  );
}

/* ---- keeping the session alive ---- */

let refreshTimer = null;

/** Refresh a minute before expiry. Tokens are short-lived by design, so
 *  without this a tab left open overnight wakes up signed out. */
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (!session?.refreshToken || !session?.expiresAt) return;

  const lead = 60_000;
  const wait = Math.max(5_000, session.expiresAt - Date.now() - lead);
  refreshTimer = setTimeout(() => {
    refreshSession().catch((err) => console.warn('[miko] token refresh failed', err));
  }, wait);
}

export async function refreshSession() {
  if (!sb.isConfigured() || !session?.refreshToken) return null;
  try {
    const out = await sb.refresh({ refreshToken: session.refreshToken });
    return adopt(out, session.provider);
  } catch (err) {
    // A rejected refresh token means the session is genuinely over — say so
    // rather than leaving a dead session that fails on every write.
    if (err?.status === 400 || err?.status === 401) {
      await persist(null);
      bus.emit('expired', true);
    }
    throw err;
  }
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

  clearTimeout(refreshTimer);
  if (sb.isConfigured() && session?.accessToken) {
    await sb.signOut({ token: session.accessToken });
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

/**
 * Ask the server whether this session is real.
 *
 * With a project configured this is a genuine check: the token goes to
 * Supabase and either names a user or does not. Without one it reports
 * honestly that nothing was verified, which is what the UI says too.
 */
export async function verify() {
  if (!session) return { ok: false, serverVerified: false };
  if (!sb.isConfigured() || !session.accessToken) {
    return { ok: true, serverVerified: false };
  }
  try {
    const user = await sb.getUser({ token: session.accessToken });
    return { ok: Boolean(user?.id), serverVerified: true, user };
  } catch (err) {
    if (err?.status === 401) return { ok: false, serverVerified: true, expired: true };
    // A network failure is not proof of anything — do not sign anyone out
    // because their train went into a tunnel.
    return { ok: true, serverVerified: false, offline: true };
  }
}

/**
 * Called once on boot. Restores the session, and when a backend is configured
 * refreshes an expired token rather than dropping someone at the front door
 * with a perfectly good refresh token in hand.
 */
export async function resume() {
  await loadSession();
  if (!session || !sb.isConfigured() || !session.refreshToken) return session;

  if (session.expiresAt && session.expiresAt - Date.now() < 60_000) {
    try {
      await refreshSession();
    } catch {
      /* refreshSession clears the session when the token is genuinely dead */
    }
  } else {
    scheduleRefresh();
  }
  return session;
}
