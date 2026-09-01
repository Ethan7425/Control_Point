// Overpass API access — pulls real OSM street/path nodes or POIs so generated
// points can be snapped to walkable ground instead of landing in a wall or a lake.
//
// The main public instance (overpass-api.de) is shared, free, and frequently
// overloaded — it commonly returns 504 ("server too busy") or 429 (rate limited)
// under normal use, not just heavy load. So every query tries a short list of
// independent public mirrors in turn before giving up.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const FETCH_TIMEOUT_MS = 9000; // keep the worst-case (all mirrors down) wait bounded

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function runQuery(ql) {
  let lastError = new Error('No Overpass endpoints configured');
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetchWithTimeout(
        endpoint,
        { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: ql },
        FETCH_TIMEOUT_MS
      );
      if (!res.ok) {
        lastError = new Error(`Overpass request failed (${res.status}) at ${endpoint}`);
        continue; // busy/rate-limited mirror — try the next one
      }
      return await res.json();
    } catch (e) {
      lastError = e.name === 'AbortError' ? new Error(`Overpass timed out at ${endpoint}`) : e;
      // network error or timeout — try the next mirror
    }
  }
  throw lastError;
}

// All walkable-way nodes within `radiusM` of center. One query covers the whole run
// instead of one query per point, which is both faster and kinder to the public API.
export async function fetchPathNodes(lat, lon, radiusM) {
  const ql = `
    [out:json][timeout:25];
    way(around:${radiusM},${lat},${lon})[highway][highway!~"^(motorway|motorway_link|construction|proposed)$"];
    (._;>;);
    out skel qt;
  `;
  const data = await runQuery(ql);
  return (data.elements || [])
    .filter((el) => el.type === 'node' && el.lat != null && el.lon != null)
    .map((n) => ({ lat: n.lat, lon: n.lon }));
}

// POI nodes (amenity/shop/tourism/leisure) within radiusM of center.
export async function fetchPOINodes(lat, lon, radiusM) {
  const ql = `
    [out:json][timeout:25];
    (
      node(around:${radiusM},${lat},${lon})[amenity];
      node(around:${radiusM},${lat},${lon})[shop];
      node(around:${radiusM},${lat},${lon})[tourism];
      node(around:${radiusM},${lat},${lon})[leisure];
    );
    out body qt;
  `;
  const data = await runQuery(ql);
  return (data.elements || [])
    .filter((el) => el.type === 'node' && el.lat != null && el.lon != null)
    .map((n) => ({
      lat: n.lat,
      lon: n.lon,
      name: n.tags?.name || n.tags?.amenity || n.tags?.shop || n.tags?.tourism || n.tags?.leisure || 'Point of interest',
    }));
}

// Best-effort loop ordering via the public OSRM trip service (round trip, foot profile).
// Falls back silently to the caller's own ordering if the request fails.
export async function orderAsLoop(points) {
  if (points.length < 3) return points.map((_, i) => i);
  const coords = points.map((p) => `${p.lon},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/trip/v1/foot/${coords}?roundtrip=true&source=first`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('OSRM trip failed');
    const data = await res.json();
    if (data.code !== 'Ok') throw new Error('OSRM trip returned error');
    const order = data.waypoints
      .map((w, originalIndex) => ({ originalIndex, tripIndex: w.waypoint_index }))
      .sort((a, b) => a.tripIndex - b.tripIndex)
      .map((w) => w.originalIndex);
    return order;
  } catch (e) {
    console.warn('OSRM loop ordering unavailable, using original order:', e.message);
    return points.map((_, i) => i);
  }
}
