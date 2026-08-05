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
const CACHE_VERSION = 'v3';
const CACHE_NAME = `family-health-shield-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './vendor/jszip.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache each file independently so one failure (offline on first
      // install, or a CDN hiccup) doesn't abort caching the rest.
      await Promise.all(APP_SHELL.map(async (url) => {
        try {
          const req = new Request(url, { cache: 'reload' });
          const res = await fetch(req);
          // Cross-origin requests (the CDN script) come back as opaque
          // responses - still cacheable, just not inspectable.
          if (res && (res.ok || res.type === 'opaque')) {
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
