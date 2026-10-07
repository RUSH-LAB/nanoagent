/**
 * Keeps Mochi Lab's application on this computer, so the site still opens when
 * the network is gone and the documents kept in the browser stay reachable.
 *
 * Only the application is stored here: HTML, scripts, styles, fonts, images.
 * API responses never pass through this cache; documents are kept by
 * src/utils/documentCache.js, per account, and signing out clears them.
 *
 * Pages are fetched from the network first so a deploy is picked up at once,
 * and the stored copy is used only when the network fails. Every client route
 * is served by the same application shell, exactly as the server does
 * (src/server/static-site.js), so a route never opened before still starts.
 * Hashed files under /assets/ never change and are served from the store.
 */
const CACHE = 'mochi-app-v1';
const SHELL = '/';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// The page that registered this worker loaded its files before the worker
// existed, so it sends their addresses to be stored now.
self.addEventListener('message', event => {
  if (event.data?.type !== 'keep') return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const url of [SHELL, ...event.data.urls]) {
      if (await cache.match(url)) continue;
      const response = await fetch(url).catch(() => null);
      if (response?.ok) await cache.put(url, response);
    }
  })());
});

async function fromNetwork(request, cacheKey) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(cacheKey, response.clone());
    return response;
  } catch (error) {
    const kept = await cache.match(cacheKey) ?? (request.mode === 'navigate' ? await cache.match(SHELL) : undefined);
    if (kept) return kept;
    throw error;
  }
}

async function fromStore(request) {
  const cache = await caches.open(CACHE);
  const kept = await cache.match(request);
  if (kept) return kept;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', event => {
  const {request} = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(fromStore(request));
  } else {
    event.respondWith(fromNetwork(request, request.mode === 'navigate' ? url.pathname : request));
  }
});
