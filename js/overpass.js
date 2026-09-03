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
//
// Dead-end tips (a node with only one neighbor in the fetched network — the end of
// a spur, driveway, or cul-de-sac) are filtered out: reaching one of those forces
// walking in and back out the same way, which is exactly the "20m out-and-back"
// pattern we want the point picker to avoid. A through node always has 2+ neighbors.
export async function fetchPathNodes(lat, lon, radiusM) {
  const ql = `
    [out:json][timeout:25];
    way(around:${radiusM},${lat},${lon})[highway][highway!~"^(motorway|motorway_link|construction|proposed)$"];
    (._;>;);
    out skel qt;
  `;
  const data = await runQuery(ql);
  const elements = data.elements || [];

  const nodeById = new Map();
  const ways = [];
  for (const el of elements) {
    if (el.type === 'node' && el.lat != null && el.lon != null) {
      nodeById.set(el.id, { lat: el.lat, lon: el.lon });
    } else if (el.type === 'way' && Array.isArray(el.nodes)) {
      ways.push(el.nodes);
    }
  }

  const neighborCount = new Map(); // nodeId -> Set of distinct adjacent nodeIds
  const addEdge = (a, b) => {
    if (!neighborCount.has(a)) neighborCount.set(a, new Set());
    if (!neighborCount.has(b)) neighborCount.set(b, new Set());
    neighborCount.get(a).add(b);
    neighborCount.get(b).add(a);
  };
  for (const nodes of ways) {
    for (let i = 0; i < nodes.length - 1; i++) addEdge(nodes[i], nodes[i + 1]);
  }

  const out = [];
  for (const [id, coords] of nodeById) {
    const degree = neighborCount.get(id)?.size ?? 0;
    if (degree <= 1) continue; // dead-end spur tip — skip as a target
    out.push(coords);
  }
  return out;
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

// Best-effort ordering + route geometry for a sequential loop course, via the
// public OSRM trip service (foot profile). `start` and `finish` are pinned as
// the fixed first/last waypoints (an *open* trip, not roundtrip — finish is a
// separate point near start, not literally the same coordinate), and OSRM
// optimizes the walking order of everything in between. Falls back silently to
// the caller's own ordering with no geometry if the request fails — the
// suggested path is a nice-to-have, never a requirement to start a run.
export async function planSequentialLoop(middlePoints, start, finish) {
  const allCoords = [start, ...middlePoints, finish];
  const coordsStr = allCoords.map((p) => `${p.lon},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/trip/v1/foot/${coordsStr}?roundtrip=false&source=first&destination=last&geometries=geojson&overview=full`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('OSRM trip failed');
    const data = await res.json();
    if (data.code !== 'Ok') throw new Error('OSRM trip returned error');
    // waypoints[0] is `start`, waypoints[last] is `finish` — drop both, order the rest.
    const order = data.waypoints
      .slice(1, -1)
      .map((w, originalIndex) => ({ originalIndex, tripIndex: w.waypoint_index }))
      .sort((a, b) => a.tripIndex - b.tripIndex)
      .map((w) => w.originalIndex);
    const geometry = data.trips?.[0]?.geometry?.coordinates?.map(([lon, lat]) => [lat, lon]) || null;
    return { order, geometry };
  } catch (e) {
    console.warn('OSRM sequential loop ordering unavailable, using original order:', e.message);
    return { order: middlePoints.map((_, i) => i), geometry: null };
  }
}
