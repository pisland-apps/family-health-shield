// Family Health & Shield - Service Worker
// ------------------------------------------------------------------
// Provides offline support: after the first successful load, the entire
// app (HTML/CSS/JS, manifest, icons, and the JSZip library used by
// "Pack ZIP") keeps working with no network connection at all.
//
// All actual health/insurance data lives in localStorage/IndexedDB on the
// user's own device - this worker only caches the STATIC APP FILES needed
// to run the app; it never touches or transmits user data anywhere.
//
// IMPORTANT: bump CACHE_VERSION any time you change index.html (or any
// other app-shell file) and redeploy, so returning visitors get the new
// version instead of a stale cached copy.
//
// NOTE: this is a separate number from APP_VERSION/APP_VERSION_DATE at the
// top of app.js (the display label shown in the version badge). They don't
// sync automatically since they live in different files - bump both on
// every deploy. CACHE_VERSION controls what the Service Worker actually
// serves; APP_VERSION only controls what the badge displays. If the badge
// ever shows a version that doesn't match what you expect after deploying,
// that's the signal to hard-refresh (Ctrl/Cmd+Shift+R) or clear the site's
// Service Worker/cache in devtools - not a sign the deploy failed.
const CACHE_VERSION = 'v13';
const CACHE_NAME = `family-health-shield-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './lib/jszip.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache each file independently so one failure on first install
      // doesn't abort caching the rest. All app-shell files (including
      // lib/jszip.min.js) are same-origin now, so responses are always
      // inspectable ('basic', not 'opaque').
      await Promise.all(APP_SHELL.map(async (url) => {
        try {
          const req = new Request(url, { cache: 'reload' });
          const res = await fetch(req);
          if (res && res.ok) {
            await cache.put(url, res);
          }
        } catch (err) {
          console.warn('[SW] Could not pre-cache', url, err);
        }
      }));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name.startsWith('family-health-shield-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

// Cache-first for everything (works fully offline, and avoids re-fetching
// the app shell on every load); falls back to network for anything not yet
// cached, and finally falls back to the cached app shell for navigations
// so the app still opens even with zero connectivity.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((res) => {
          // Opportunistically cache same-origin GETs we haven't seen yet.
          if (res && res.ok && event.request.url.startsWith(self.location.origin)) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => {
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('Offline and not cached.', { status: 503, statusText: 'Offline' });
        });
    })
  );
});
