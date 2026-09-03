// Pre-fetches OSM raster map tiles covering a circular area into the browser's Cache
// Storage, under the exact cache name/URL scheme the service worker's tile handler
// reads from at runtime — so the map can keep rendering mid-run even if you lose
// signal somewhere along the way, instead of just going blank.

import { destinationPoint } from './geo.js';

// Must stay in sync with TILE_CACHE in service-worker.js — the SW reads from this
// same Cache Storage entry, it just doesn't (and can't) import this module.
const TILE_CACHE = 'control-point-tiles-v1';

const SUBDOMAINS = ['a', 'b', 'c'];
const ZOOM_LEVELS = [16, 17, 18]; // brackets the run map's default start zoom (17)
const MAX_TILES = 450; // keeps a big radius/loop distance from downloading forever
const BUFFER_M = 250; // covers incidental wandering off the exact search circle
const CONCURRENCY = 6; // roughly matches a browser's per-host connection limit

// Leaflet's default subdomain pick for a TileLayer using `{s}` with subdomains 'abc' —
// this must match exactly, or a prefetched tile lands under a URL the live map never
// actually requests, and the cache-first fetch handler in the service worker misses it.
function subdomainFor(x, y) {
  return SUBDOMAINS[Math.abs(x + y) % SUBDOMAINS.length];
}
function tileUrl(z, x, y) {
  return `https://${subdomainFor(x, y)}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
}
function lon2x(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function lat2y(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
}

function tilesForZoom(center, radiusM, z) {
  const north = destinationPoint(center.lat, center.lon, 0, radiusM);
  const south = destinationPoint(center.lat, center.lon, 180, radiusM);
  const east = destinationPoint(center.lat, center.lon, 90, radiusM);
  const west = destinationPoint(center.lat, center.lon, 270, radiusM);
  const xMin = lon2x(west.lon, z), xMax = lon2x(east.lon, z);
  const yMin = lat2y(north.lat, z), yMax = lat2y(south.lat, z);
  const tiles = [];
  for (let x = xMin; x <= xMax; x++) {
    for (let y = yMin; y <= yMax; y++) tiles.push({ z, x, y });
  }
  return tiles;
}

export function planTiles(center, radiusM) {
  const withBuffer = radiusM + BUFFER_M;
  let zoomLevels = ZOOM_LEVELS;
  let tiles = zoomLevels.flatMap((z) => tilesForZoom(center, withBuffer, z));

  // Drop the highest (most tile-dense) zoom level first when a large radius would
  // otherwise blow the budget — keep the default run-start zoom (17) until last.
  while (tiles.length > MAX_TILES && zoomLevels.length > 1) {
    zoomLevels = zoomLevels.filter((z) => z !== Math.max(...zoomLevels));
    tiles = zoomLevels.flatMap((z) => tilesForZoom(center, withBuffer, z));
  }
  return tiles;
}

// Best-effort: a failed tile is just counted, never thrown — a partial offline cache
// is still far better than none. `onProgress` fires after every tile (done/failed/total).
export async function prefetchTiles(center, radiusM, { onProgress, signal } = {}) {
  if (!('caches' in window)) throw new Error('Offline caching isn’t supported on this device.');

  const tiles = planTiles(center, radiusM);
  const cache = await caches.open(TILE_CACHE);
  const total = tiles.length;
  let done = 0, failed = 0;
  onProgress?.({ done, failed, total });

  let nextIndex = 0;
  async function worker() {
    while (nextIndex < tiles.length) {
      if (signal?.aborted) return;
      const { z, x, y } = tiles[nextIndex++];
      const url = tileUrl(z, x, y);
      try {
        const already = await cache.match(url);
        if (!already) {
          const res = await fetch(url);
          if (res.ok) await cache.put(url, res);
          else failed++;
        }
      } catch {
        failed++;
      }
      done++;
      onProgress?.({ done, failed, total });
    }
  }

  const workerCount = Math.min(CONCURRENCY, tiles.length) || 1;
  await Promise.all(Array.from({ length: workerCount }, worker));
  return { done, failed, total, aborted: !!signal?.aborted };
}
