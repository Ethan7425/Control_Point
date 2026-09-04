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

// Iteratively strips dead-end branches from a walkable-node graph — a spur,
// driveway, or cul-de-sac, however long — down to the "core" network everyone
// can actually loop through. Checking a node's own degree only ever catches the
// very tip of a dead end; a point placed further up the *same* branch still
// forces the identical out-and-back walk, so the whole branch has to go, not
// just its endpoint. This is the standard leaf-peeling way to find a graph's
// 2-core: repeatedly remove degree<=1 nodes and re-check their neighbors, same
// as peeling an onion from the outside in.
function findDeadEndNodes(neighborCount) {
  const degree = new Map();
  for (const [id, neighbors] of neighborCount) degree.set(id, neighbors.size);

  const queue = [...degree].filter(([, d]) => d <= 1).map(([id]) => id);
  const removed = new Set();
  while (queue.length) {
    const id = queue.pop();
    if (removed.has(id)) continue;
    removed.add(id);
    for (const n of neighborCount.get(id) || []) {
      if (removed.has(n)) continue;
      const d = degree.get(n) - 1;
      degree.set(n, d);
      if (d <= 1) queue.push(n);
    }
  }
  return removed;
}

// All walkable-way nodes within `radiusM` of center. One query covers the whole run
// instead of one query per point, which is both faster and kinder to the public API.
//
// Every node on a dead-end branch (not just its tip — see findDeadEndNodes) is
// filtered out as a target: reaching one forces walking in and back out the same
// way, exactly the "20m out-and-back" pattern the point picker should avoid.
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

  const deadEnds = findDeadEndNodes(neighborCount);
  const out = [];
  for (const [id, coords] of nodeById) {
    if (deadEnds.has(id)) continue; // anywhere on a dead-end branch — skip as a target
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

// Walking-route geometry for a sequential loop course, via the public OSRM route
// service (foot profile), visiting `orderedCoords` in EXACTLY the order given —
// unlike the `trip` service, `route` never reorders waypoints looking for a
// shorter tour. The order is decided beforehand by points.js's ring construction
// (points are placed angularly around the loop, so they're already visit-order),
// which is what keeps this from ever routing a "shortest path" that crosses back
// through the middle of the loop to save a few meters. Falls back to no geometry
// (a straight-line loop is still runnable, just without the dashed suggested
// path) if the request fails — this is a nice-to-have, never a requirement.
export async function planFixedOrderRoute(orderedCoords) {
  const coordsStr = orderedCoords.map((p) => `${p.lon},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/foot/${coordsStr}?geometries=geojson&overview=full`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('OSRM route failed');
    const data = await res.json();
    if (data.code !== 'Ok') throw new Error('OSRM route returned error');
    return data.routes?.[0]?.geometry?.coordinates?.map(([lon, lat]) => [lat, lon]) || null;
  } catch (e) {
    console.warn('OSRM fixed-order route unavailable:', e.message);
    return null;
  }
}
