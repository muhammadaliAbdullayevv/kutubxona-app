// Kutubxona PWA service worker.
// Bump CACHE_VERSION on any shell (HTML/CSS/JS) change so old clients pick up the new
// version instead of serving a stale cached shell forever.
const CACHE_VERSION = 'v192';
const SHELL_CACHE = `kutubxona-shell-${CACHE_VERSION}`;
const DATA_CACHE = `kutubxona-data-${CACHE_VERSION}`;
const COVER_CACHE = `kutubxona-covers-${CACHE_VERSION}`;
// Deliberately NOT tied to CACHE_VERSION — this one holds actual book/audio content, which is
// expensive (megabytes, sometimes hundreds of MB) and slow to re-download. Every other cache gets
// wiped and rebuilt on each deploy; this one has to survive that or "read once, opens instantly
// next time" would reset on every shell update. Only bump it if the STORED FORMAT here changes
// (e.g. the header scheme below), not for ordinary app changes.
const MEDIA_CACHE = 'kutubxona-media-v1';
const MEDIA_CACHE_MAX_BYTES = 400 * 1024 * 1024; // ~a handful of full audiobooks/PDFs, not the whole catalog

const SHELL_FILES = [
  './index.html',
  './quran.html',
  './detail.css',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './ptr-logo.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  const keep = new Set([SHELL_CACHE, DATA_CACHE, COVER_CACHE, MEDIA_CACHE]);
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// The book/audio streaming endpoints live on the API's own origin (not this Pages origin), so
// they need to be checked and handled BEFORE the same-origin bailout below.
function mediaStreamPath(pathname) {
  if (/^\/api\/books\/[^/]+\/read$/.test(pathname)) return true;
  if (/^\/api\/audiobook-parts\/[^/]+\/stream$/.test(pathname)) return true;
  return false;
}
// The real streaming URL carries a short-lived, per-session auth token in the query string —
// caching by the literal URL would mean every new token (a new /api/stream-token call) misses the
// cache entirely, even for a book already downloaded minutes ago. Caching by origin+pathname
// alone (the book/part id) makes the cache reusable across sessions and token refreshes.
function mediaCacheKey(url) {
  return url.origin + url.pathname;
}
// Small in-memory cache of already-materialized {blob,type} for a cached file, keyed by the same
// origin+pathname key the Cache API entry uses. Without this, every single Range sub-request for
// the SAME book re-ran `await cached.blob()` on the whole cached Response — and pdf.js/the
// audio player issue many of those in a row while paging/seeking through one large file, so a
// 50-150MB book was being re-materialized into a Blob dozens of times in quick succession. That's
// real, repeated main-thread/GC work on every page turn, not just on first load — a very plausible
// cause of "the app sometimes gets stuck" specifically while reading. Capped at 2 entries (current
// + previous book) since the SW can be killed and restarted by the browser at any time anyway —
// this is a same-session speed win, not meant to be a durable cache.
const _blobCache = new Map();
const _BLOB_CACHE_MAX = 2;
async function getCachedBlob(cacheKey, cached) {
  const hit = _blobCache.get(cacheKey);
  if (hit) return hit;
  const entry = { blob: await cached.blob(), type: cached.headers.get('Content-Type') || 'application/octet-stream' };
  _blobCache.set(cacheKey, entry);
  if (_blobCache.size > _BLOB_CACHE_MAX) _blobCache.delete(_blobCache.keys().next().value);
  return entry;
}
async function sliceFromCached(cacheKey, cached, rangeHeader) {
  const { blob, type } = await getCachedBlob(cacheKey, cached);
  const total = blob.size;
  if (!rangeHeader) {
    return new Response(blob, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(total), 'Accept-Ranges': 'bytes' } });
  }
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
  if (Number.isNaN(start) || start < 0) start = 0;
  if (Number.isNaN(end) || end >= total) end = total - 1;
  if (end < start) end = start;
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}
// Evicts the oldest cached entries (by when they were stored, tracked via the X-Cached-At header
// below — Cache API has no built-in last-accessed tracking) until there's room for the incoming
// file. A simple "oldest first" policy, not true LRU, but keeps total size bounded without needing
// a separate metadata store.
async function evictForSpace(cache, incomingBytes) {
  const keys = await cache.keys();
  const entries = [];
  let total = 0;
  for (const req of keys) {
    const res = await cache.match(req);
    if (!res) continue;
    const size = parseInt(res.headers.get('Content-Length') || '0', 10) || 0;
    const cachedAt = parseInt(res.headers.get('X-Cached-At') || '0', 10) || 0;
    entries.push({ req, size, cachedAt });
    total += size;
  }
  entries.sort((a, b) => a.cachedAt - b.cachedAt);
  let i = 0;
  while (total + incomingBytes > MEDIA_CACHE_MAX_BYTES && i < entries.length) {
    await cache.delete(entries[i].req);
    // Keep the in-memory blob cache in sync — otherwise an evicted-then-later-re-downloaded file
    // could keep serving its stale in-memory blob instead of the fresh one for the rest of this
    // SW instance's lifetime.
    _blobCache.delete(mediaCacheKey(new URL(entries[i].req.url)));
    total -= entries[i].size;
    i++;
  }
}
// A large PDF/audiobook part isn't fetched by pdf.js/the player in one shot — it's read as a
// sequence of separate Range requests as pages/segments get parsed. Without this guard, EACH of
// those requests would independently see "not cached yet" and kick off its OWN full-file
// background download — for a 100MB+ book, that's several redundant full downloads racing each
// other for bandwidth at once, which is exactly what made a first read feel stuck/slow and (since
// they were racing rather than one clean download) not reliably finish caching before the user
// left the page — hence a reopen re-downloading instead of hitting the cache.
const _inFlightCaching = new Set();
// Downloads the FULL file (no Range header — the backend returns 200 with the complete body for
// a rangeless request) and stores it under the token-independent key, so every future open of
// this same book/part — this session or a later one — is served straight from disk.
async function cacheFullMediaInBackground(reqUrl, cacheKey, cache) {
  if (_inFlightCaching.has(cacheKey)) return; // already downloading this one — don't pile on
  _inFlightCaching.add(cacheKey);
  try {
    const res = await fetch(reqUrl, { headers: {} });
    if (!res.ok) return;
    const blob = await res.blob();
    await evictForSpace(cache, blob.size);
    const stored = new Response(blob, {
      status: 200,
      headers: {
        'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream',
        'Content-Length': String(blob.size),
        'X-Cached-At': String(Date.now()),
      },
    });
    await cache.put(cacheKey, stored);
  } catch (e) {
    // Offline, network hiccup, or the book turned out too big to fit even after eviction —
    // nothing to do but let the next open try again.
  } finally {
    _inFlightCaching.delete(cacheKey);
  }
}
async function handleMediaRequest(event, url) {
  const cache = await caches.open(MEDIA_CACHE);
  const cacheKey = mediaCacheKey(url);
  const cached = await cache.match(cacheKey);
  if (cached) return sliceFromCached(cacheKey, cached, event.request.headers.get('range'));
  // Not cached yet — serve THIS request straight from the network (with whatever Range the
  // player/reader actually asked for, so first playback/read isn't stalled on a full download),
  // and separately populate the cache in the background for next time (deduplicated above, so
  // this is a no-op if another request already started the same background download).
  const netRes = await fetch(event.request);
  event.waitUntil(cacheFullMediaInBackground(url.href, cacheKey, cache));
  return netRes;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (mediaStreamPath(url.pathname)) {
    event.respondWith(handleMediaRequest(event, url));
    return;
  }

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
