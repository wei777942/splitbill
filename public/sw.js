/* Pass-through service worker for installability.
   Never caches API or SSE; does not intercept /api at all. */
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.headers.get('accept') && event.request.headers.get('accept').includes('text/event-stream')) return;
  event.respondWith(fetch(event.request));
});
