/* Supabase Auth (GoTrue), spoken over plain `fetch`.
 *
 * No SDK. The project has no bundler and no dependencies, and the auth API is
 * a handful of JSON endpoints — pulling in a client library to call six URLs
 * would cost more than it saves, and would have to be vendored by hand anyway.
 *
 * What this module is responsible for:
 *   • building requests against `/auth/v1/*` with the anon key attached
 *   • normalising GoTrue's several error shapes into one `AuthError`
 *   • nothing else — it holds no state. Session storage, refresh scheduling
 *     and the app's own user record live in core/auth.js, so this stays a thin
 *     transport that is easy to reason about and to test.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY, OAUTH_REDIRECT } from '../config.js';

export class AuthError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

/* Where the project details come from.
 *
 * js/config.js is the deployment answer: baked into the source so that every
 * visitor can sign in. The override below exists for the other case — trying
 * this out on your own machine without editing a file and reloading. It is
 * stored in this browser only, which is exactly why it cannot be the only
 * route: a visitor has no way to type it in. */
let override = null;

export function configure(next) {
  override =
    next && next.url && next.key
      ? { url: String(next.url).trim(), key: String(next.key).trim() }
      : null;
}

export function current() {
  if (SUPABASE_URL && SUPABASE_ANON_KEY) return { url: SUPABASE_URL, key: SUPABASE_ANON_KEY };
  return override || { url: '', key: '' };
}

/** Is a backend configured at all? Everything else degrades to local-only. */
export function isConfigured() {
  const c = current();
  return Boolean(c.url && c.key);
}

export function projectUrl() {
  return current().url.replace(/\/+$/, '');
}

function authUrl(path, params) {
  const url = new URL(`${projectUrl()}/auth/v1/${path}`);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/* GoTrue reports failures as `error_description`, `msg`, `message` or
 * `error`, depending on the endpoint and the version. Collapse them so callers
 * have one thing to show a person. */
function messageFrom(body, status) {
  const raw =
    body?.error_description || body?.msg || body?.message || body?.error || '';
  if (raw) return String(raw);
  if (status === 0) return 'Could not reach the server. Check your connection.';
  return `Sign-in failed (${status}).`;
}

async function call(path, { method = 'POST', body, token, params } = {}) {
  if (!isConfigured()) {
    throw new AuthError('No Supabase project is configured.', { code: 'unconfigured' });
  }

  let res;
  try {
    res = await fetch(authUrl(path, params), {
      method,
      headers: {
        apikey: current().key,
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // Offline, DNS failure, CORS refusal — all land here with no status.
    throw new AuthError('Could not reach the server. Check your connection.', {
      code: 'network',
    });
  }

  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* a proxy or error page returned HTML; fall through to the status */
  }

  if (!res.ok) {
    throw new AuthError(messageFrom(parsed, res.status), {
      status: res.status,
      code: parsed?.error_code || parsed?.code || '',
    });
  }
  return parsed;
}

/* ------------------------------- accounts ------------------------------- */

/** Create an account. Depending on the project's settings this either returns
 *  a session immediately, or returns a user with no session because a
 *  confirmation email has been sent — callers must handle both. */
export function signUp({ email, password, name }) {
  return call('signup', {
    body: {
      email,
      password,
      data: name ? { name } : undefined,
      options: { emailRedirectTo: OAUTH_REDIRECT },
    },
  });
}

export function signInWithPassword({ email, password }) {
  return call('token', { params: { grant_type: 'password' }, body: { email, password } });
}

/** Passwordless sign-in. `create_user` lets a new address through, matching
 *  the "one field, no password" flow the landing page offers. */
export function sendMagicLink({ email, createUser = true }) {
  return call('otp', {
    body: { email, create_user: createUser, options: { emailRedirectTo: OAUTH_REDIRECT } },
  });
}

export function sendPasswordReset({ email }) {
  return call('recover', { body: { email, options: { redirectTo: OAUTH_REDIRECT } } });
}

export function refresh({ refreshToken }) {
  return call('token', {
    params: { grant_type: 'refresh_token' },
    body: { refresh_token: refreshToken },
  });
}

export function getUser({ token }) {
  return call('user', { method: 'GET', token });
}

export async function signOut({ token }) {
  // A failure here is not worth blocking on: the local session is cleared
  // either way, and an unreachable server must not trap someone signed in.
  try {
    await call('logout', { token });
  } catch {
    /* ignored on purpose */
  }
  return true;
}

/* -------------------------------- OAuth -------------------------------- */

/** The URL to send the browser to for a provider round trip. Supabase hands
 *  back to `OAUTH_REDIRECT` with tokens in the URL fragment. */
export function oauthUrl(provider) {
  return authUrl('authorize', { provider, redirect_to: OAUTH_REDIRECT });
}

/** Read the tokens Supabase leaves in the fragment after a redirect.
 *
 *  This has to run before the hash router looks at `location.hash`, or the app
 *  will try to route to `#access_token=...`. Returns null when the fragment is
 *  an ordinary route. */
export function readRedirectFragment(hash = location.hash) {
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.slice(1));

  const error = params.get('error_description') || params.get('error');
  if (error) return { error: String(error).replace(/\+/g, ' ') };

  const accessToken = params.get('access_token');
  if (!accessToken) return null;

  const expiresIn = Number(params.get('expires_in') || 0);
  return {
    accessToken,
    refreshToken: params.get('refresh_token') || '',
    tokenType: params.get('token_type') || 'bearer',
    expiresAt: Date.now() + (expiresIn ? expiresIn * 1000 : 3600_000),
    type: params.get('type') || '',
  };
}
