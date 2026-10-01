/* Deployment configuration.
 *
 * Fill these in with your Supabase project's values, from
 * Supabase dashboard → Project Settings → API.
 *
 * Both values are safe to commit and to ship to a browser. The anon key is
 * designed to be public — it only lets a client talk to the API, and what it
 * may actually read or write is decided by Row Level Security policies on the
 * server. Never put the `service_role` key here: that one bypasses RLS and
 * would hand every visitor full access to the database.
 *
 * Leave them empty and the app runs exactly as it does today: local identity,
 * IndexedDB only, no network. Nothing breaks; sign-in simply stays unverified.
 */

export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';

/** Where Supabase sends people back after an OAuth round trip. Must be listed
 *  under Authentication → URL Configuration → Redirect URLs in the dashboard,
 *  or the provider will refuse the hand-back. */
export const OAUTH_REDIRECT = `${location.origin}${location.pathname}`;

/** Optional screen recording for the landing page demo.
 *
 * Empty by default, and deliberately so: the demo is the live application in
 * an iframe, which is better than a recording and never goes out of date.
 * Probing for a file that is not there cost a 404 on every single page load
 * and stalled the demo for over a second waiting for it to fail.
 *
 * Set this to 'assets/demo.mp4' (H.264, muted, ~16:9) only if you actually
 * drop a recording in, and add it to the SHELL list in sw.js to cache it.
 */
export const DEMO_VIDEO = '';
