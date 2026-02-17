const CACHE_NAME = 'edgescore-shell-v1';
const SHELL_URLS = [
  '/',
  '/manifest.json',
];

// Install: cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: cache-first for shell, network-only for API
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API calls — always network
  if (url.pathname.startsWith('/predictions') ||
      url.pathname.startsWith('/sources') ||
      url.pathname.startsWith('/health') ||
      url.pathname.startsWith('/ws') ||
      url.pathname.startsWith('/admin')) {
    return;
  }

  // Shell assets — cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    }).catch(() => caches.match('/'))
  );
});
