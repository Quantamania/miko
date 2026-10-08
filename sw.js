/* Service worker.
 *
 * Strategy per asset class:
 *   app shell (HTML)  — network first, cache fallback. A new deploy is picked
 *                       up immediately when online; offline still works.
 *   CSS / JS / icons  — stale-while-revalidate. Instant paint, quiet update.
 *   fonts             — cache first, they never change under a given URL.
 *   API calls         — never cached. The app's own data lives in IndexedDB.
 *
 * Nothing here touches task data. IndexedDB is the source of truth and the
 * page owns it; the worker only makes the shell available offline.
 */

const VERSION = 'v64';
const SHELL_CACHE = `miko-shell-${VERSION}`;
const ASSET_CACHE = `miko-assets-${VERSION}`;
const FONT_CACHE = `miko-fonts-${VERSION}`;

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/tokens.css',
  'css/app.css',
  'css/views.css',
  'css/landing.css',
  // The standalone documents, so Privacy and Terms still open offline — a
  // policy you cannot read without a connection is not much of a policy.
  'css/page.css',
  'privacy.html',
  'terms.html',
  '404.html',
  'css/fonts.css',
  'assets/fonts/Locanita.ttf',
  /* Only the Latin subsets are precached. They are what almost every visitor
     needs, and together they are about 160 KB; the Cyrillic, Greek and
     Vietnamese ranges are fetched on demand by the font cache if someone
     actually types in them. Precaching all thirteen would make every install
     pay 300 KB for coverage most people never use. */
  'assets/fonts/inter-latin.woff2',
  'assets/fonts/inter-latin-ext.woff2',
  'assets/fonts/jetbrains-mono-latin.woff2',
  'js/main.js',
  'js/core/util.js',
  'js/core/db.js',
  'js/core/store.js',
  'js/core/search.js',
  'js/core/history.js',
  'js/core/sync.js',
  'js/core/auth.js',
  'js/core/supabase.js',
  'js/core/postgrest.js',
  'js/core/remote.js',
  'js/core/storage.js',
  'js/config.js',
  'js/domain/recurrence.js',
  'js/domain/nlp.js',
  'js/domain/rules.js',
  'js/domain/analytics.js',
  'js/domain/io.js',
  'js/domain/ai.js',
  'js/ui/icons.js',
  'js/ui/kit.js',
  'js/ui/task.js',
  'js/ui/shell.js',
  'js/ui/palette.js',
  'js/ui/landing.js',
  'js/views/tasks.js',
  'js/views/insights.js',
  'js/views/settings.js',
  'icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      // addAll fails the whole install if any single request 404s, which makes
      // a typo in the list break offline support entirely. Add individually.
      await Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch((err) => {
            console.warn('[sw] could not precache', url, err);
          })
        )
      );
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE, FONT_CACHE]);
      for (const key of await caches.keys()) {
        if (key.startsWith('miko-') && !keep.has(key)) await caches.delete(key);
      }
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

/* Fonts are now ours, served from this origin. The old test matched
   fonts.gstatic.com and fonts.googleapis.com, which no longer appear anywhere
   — leaving it would have quietly sent every local woff2 down the generic
   asset path instead of the cache-first one below. Font files never change
   without changing name, so cache-first is exactly right for them. */
function isFont(url) {
  return url.origin === self.location.origin && /\.(?:woff2?|ttf|otf)$/i.test(url.pathname);
}

function isAsset(url) {
  return /\.(?:css|js|svg|png|jpg|jpeg|webp|woff2?|ttf|otf)$/i.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never intercept the Anthropic API — a cached auth response would be both
  // wrong and a small security problem.
  if (url.hostname.endsWith('anthropic.com')) return;

  // Google Identity Services must never be served stale or from cache.
  if (url.hostname.endsWith('google.com') || url.hostname.endsWith('gstatic.com')) {
    if (url.pathname.includes('/gsi/')) return;
  }

  /* Navigations: network first so deploys land, cache as the offline floor.
   *
   * Every document is stored under its own path. This used to write every
   * navigation to the key `index.html` — which was harmless while index.html
   * was the only document, and became cache poisoning the moment it was not:
   * one visit to /privacy.html would overwrite the app shell with the privacy
   * page, and the next offline launch would open the app and find a legal
   * document sitting where the application should be. */
  if (request.mode === 'navigate') {
    const isShell = url.pathname === '/' || url.pathname.endsWith('/index.html');
    const key = isShell ? 'index.html' : url.pathname.replace(/^\//, '');
    event.respondWith(
      (async () => {
        try {
          const preload = await event.preloadResponse;
          if (preload) {
            void cachePut(SHELL_CACHE, key, preload.clone());
            return preload;
          }
          const fresh = await fetch(request);
          void cachePut(SHELL_CACHE, key, fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          // Fall back to the document that was asked for, never to a different
          // one. Only the shell may fall back to './'.
          return (
            (await cache.match(key)) ||
            (isShell ? await cache.match('./') : null) ||
            new Response('<h1>Offline</h1><p>MIKŌ is not cached yet.</p>', {
              headers: { 'content-type': 'text/html' },
              status: 503,
            })
          );
        }
      })()
    );
    return;
  }

  /* Fonts: cache first — the URL is content-addressed. */
  if (isFont(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(FONT_CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          const res = await fetch(request);
          if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
          return res;
        } catch {
          // No font is better than a hung request; the stack falls back.
          return new Response('', { status: 504 });
        }
      })()
    );
    return;
  }

  /* Same-origin assets: stale-while-revalidate. */
  if (url.origin === location.origin && isAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const hit = await cache.match(request);
        const network = fetch(request)
          .then((res) => {
            if (res.ok) cache.put(request, res.clone());
            return res;
          })
          .catch(() => null);
        return hit || (await network) || new Response('', { status: 504 });
      })()
    );
  }
});

async function cachePut(cacheName, key, response) {
  try {
    if (!response.ok) return;
    const cache = await caches.open(cacheName);
    await cache.put(key, response);
  } catch {
    /* quota or opaque response — not worth failing the request over */
  }
}

/* ------------------------------ notifications ------------------------------ */

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const taskId = event.notification.data?.taskId;

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      for (const client of clientList) {
        if (client.url.includes(self.registration.scope)) {
          await client.focus();
          if (taskId) client.postMessage({ type: 'OPEN_TASK', taskId });
          return;
        }
      }
      await self.clients.openWindow(taskId ? `./#/task/${taskId}` : './');
    })()
  );
});

/* Web push needs a server to hold the subscription and sign the messages.
   The handler is here so that wiring one up is a server-side task only. */
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'MIKŌ', body: event.data.text() };
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'MIKŌ', {
      body: payload.body,
      icon: 'icons/icon-192.png',
      badge: 'icons/badge.svg',
      tag: payload.tag || 'miko',
      data: payload.data || {},
    })
  );
});
