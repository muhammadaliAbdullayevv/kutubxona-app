// Kutubxona PWA service worker.
// Bump CACHE_VERSION on any shell (HTML/CSS/JS) change so old clients pick up the new
// version instead of serving a stale cached shell forever.
const CACHE_VERSION = 'v54';
const SHELL_CACHE = `kutubxona-shell-${CACHE_VERSION}`;
const DATA_CACHE = `kutubxona-data-${CACHE_VERSION}`;
const COVER_CACHE = `kutubxona-covers-${CACHE_VERSION}`;

const SHELL_FILES = [
  './index.html',
  './quran.html',
  './detail.css',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  const keep = new Set([SHELL_CACHE, DATA_CACHE, COVER_CACHE]);
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // don't touch telegram.org's script etc.

  // books.json / quran data: stale-while-revalidate — instant from cache, refreshed in the
  // background so the NEXT visit has up-to-date books, without blocking this one on network.
  if (url.pathname.endsWith('.json') && !url.pathname.endsWith('manifest.json')) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req).then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Covers: effectively immutable once rendered — cache-first, no re-fetch.
  if (url.pathname.includes('/covers/')) {
    event.respondWith(
      caches.open(COVER_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(req, res.clone());
          return res;
        } catch (e) {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // Shell (HTML/CSS/icons): cache-first with a background refresh for next time.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res.ok) caches.open(SHELL_CACHE).then((cache) => cache.put(req, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
