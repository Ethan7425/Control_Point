// App-shell cache so the PWA installs and opens offline. Live data (Overpass,
// OSRM, GPS) is always network-only — only the shell and map tiles are cached.

const SHELL_CACHE = 'control-point-shell-v27';
const TILE_CACHE = 'control-point-tiles-v1';

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/feedback.js',
  './js/geo.js',
  './js/gpx.js',
  './js/heading.js',
  './js/overpass.js',
  './js/points.js',
  './js/render.js',
  './js/run.js',
  './js/supabase-client.js',
  './js/auth-client.js',
  './js/sync.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.113.0/dist/umd/supabase.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== TILE_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

function isTileRequest(url) {
  return /tile\.openstreetmap\.org/.test(url);
}

function isLiveDataRequest(url) {
  return /overpass-api\.de|overpass\.openstreetmap\.fr|overpass\.kumi\.systems|router\.project-osrm\.org|\.supabase\.co/.test(url);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = request.url;

  // Always hit the network for point generation / routing — never serve stale data.
  if (isLiveDataRequest(url)) {
    event.respondWith(fetch(request).catch(() => new Response(null, { status: 503 })));
    return;
  }

  // Map tiles: cache-first so previously seen areas render offline.
  if (isTileRequest(url)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const res = await fetch(request);
          if (res.ok) cache.put(request, res.clone());
          return res;
        } catch {
          return cached || new Response(null, { status: 503 });
        }
      })
    );
    return;
  }

  // App shell: network-first. This app is under active development, so a fresh
  // deploy must be picked up on the very next load — cache-first was leaving
  // people stuck on stale JS until they thought to hard-refresh. Cache is only
  // a fallback for when there's genuinely no network (true offline support).
  //
  // `cache: 'no-store'` matters here: fetch() inside a service worker still goes
  // through the browser's ordinary HTTP cache underneath it, so without this a
  // "network-first" fetch could still silently return a heuristically-cached
  // stale response instead of actually hitting the network.
  event.respondWith(
    fetch(request.url, { cache: 'no-store' })
      .then((res) => {
        if (res.ok && request.url.startsWith(self.location.origin)) {
          const clone = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, clone));
        }
        return res;
      })
      .catch(() => caches.match(request))
  );
});
