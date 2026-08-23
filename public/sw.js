/// <reference lib="webworker" />

const CACHE_NAME = 'xerifeswitch-v1';

const STATIC_ASSETS = [
  '/',
  '/manifest.json',
  '/pwa/icon-192.png',
  '/pwa/icon-512.png',
];

const CACHEABLE_EXT = [
  '.js', '.css', '.png', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.json', '.webp', '.avif',
];

function isCacheable(url) {
  try {
    const u = new URL(url, self.location.origin);
    if (u.origin !== self.location.origin) return false;
    if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/__')) return false;
    return CACHEABLE_EXT.some((ext) => u.pathname.endsWith(ext)) || STATIC_ASSETS.includes(u.pathname);
  } catch {
    return false;
  }
}

// Install: pre-cache shell assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch: stale-while-revalidate for cacheable, network-first for API
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = request.url;

  // Skip non-GET
  if (request.method !== 'GET') return;

  // Server functions / API calls: network only
  if (url.includes('/__') || url.includes('/api/')) return;

  // Cacheable static asset: stale-while-revalidate
  if (isCacheable(url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        const fetchPromise = fetch(request)
          .then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => cached);

        return cached || fetchPromise;
      })
    );
    return;
  }

  // HTML / navigation: network-first, fallback to cache
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match('/')))
    );
    return;
  }
});
