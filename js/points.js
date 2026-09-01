// Point generation: turns a center location + settings into a set of real,
// walkable target points, respecting spacing constraints without forcing a
// perfectly efficient layout — some randomness/dead-ends are intentional.

import { haversine, destinationPoint } from './geo.js';
import { fetchPathNodes, fetchPOINodes, orderAsLoop } from './overpass.js';

const MIN_DIST_FROM_START = 25; // don't drop a point right on top of the user

function randomInDisk(center, radiusM) {
  const bearing = Math.random() * 360;
  // sqrt() keeps the distribution uniform over area, not biased toward the center
  const dist = MIN_DIST_FROM_START + Math.sqrt(Math.random()) * (radiusM - MIN_DIST_FROM_START);
  return destinationPoint(center.lat, center.lon, bearing, Math.max(dist, MIN_DIST_FROM_START));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Greedily selects up to numPoints candidates that respect min/max spacing where
// possible, relaxing the constraints if the candidate source runs dry.
function selectSpaced(candidateSource, numPoints, minSpacing, maxSpacing) {
  const accepted = [];

  const nearestDist = (pt) =>
    accepted.length === 0 ? Infinity : Math.min(...accepted.map((p) => haversine(p.lat, p.lon, pt.lat, pt.lon)));

  // Pass 1: strict — respect both min and max spacing.
  let cand;
  let guard = 0;
  while (accepted.length < numPoints && guard < 4000) {
    guard++;
    cand = candidateSource();
    if (cand === null) break;
    const d = nearestDist(cand);
    if (d >= minSpacing && d <= maxSpacing) accepted.push(cand);
  }

  // Pass 2: pool exhausted (real OSM data) but still short — relax max spacing only.
  candidateSource.reset?.();
  guard = 0;
  while (accepted.length < numPoints && guard < 4000) {
    guard++;
    cand = candidateSource();
    if (cand === null) break;
    const d = nearestDist(cand);
    if (d >= minSpacing) accepted.push(cand);
  }

  // Pass 3: still short — take whatever's left, ignoring spacing, so we don't
  // silently hand back fewer points than the user asked for when we don't have to.
  candidateSource.reset?.();
  guard = 0;
  while (accepted.length < numPoints && guard < 4000) {
    guard++;
    cand = candidateSource();
    if (cand === null) break;
    accepted.push(cand);
  }

  return accepted;
}

function makeSyntheticSource(center, radiusM) {
  const source = () => randomInDisk(center, radiusM);
  source.reset = () => {}; // infinite source, nothing to reset
  return source;
}

function makePoolSource(pool) {
  let shuffled = shuffle(pool);
  let i = 0;
  const source = () => {
    if (i >= shuffled.length) return null;
    return shuffled[i++];
  };
  source.reset = () => {
    shuffled = shuffle(pool);
    i = 0;
  };
  return source;
}

export async function generatePoints(center, settings) {
  const { layout, radiusKm, distanceKm, numPoints, minSpacing, maxSpacing, style } = settings;

  const effectiveRadiusM =
    layout === 'loop'
      ? (distanceKm * 1000) / (2 * Math.PI) * (0.85 + Math.random() * 0.3) // organic, not a perfect circle
      : radiusKm * 1000;

  // If OSM data can't be reached at all (the public Overpass mirrors are down/rate-limited),
  // fall back to synthetic random placement rather than failing the run outright — the
  // caller is told via `usedFallback` so it can let the user know why.
  let source;
  let usedFallback = false;
  if (style === 'random') {
    source = makeSyntheticSource(center, effectiveRadiusM);
  } else {
    const fetchNodes = style === 'path' ? fetchPathNodes : fetchPOINodes;
    let pool = [];
    try {
      const nodes = await fetchNodes(center.lat, center.lon, effectiveRadiusM);
      pool = nodes.filter((n) => haversine(center.lat, center.lon, n.lat, n.lon) >= MIN_DIST_FROM_START);
    } catch (e) {
      console.warn('OSM data unavailable, falling back to random placement:', e.message);
      usedFallback = true;
    }
    source = pool.length ? makePoolSource(pool) : makeSyntheticSource(center, effectiveRadiusM);
    if (!pool.length) usedFallback = true;
  }

  let picked = selectSpaced(source, numPoints, minSpacing, maxSpacing);

  if (layout === 'loop' && picked.length >= 3) {
    const order = await orderAsLoop(picked);
    picked = order.map((i) => picked[i]);
  }

  const points = picked.map((p, i) => {
    const distFromStart = haversine(center.lat, center.lon, p.lat, p.lon);
    return {
      id: `p${i}_${Math.round(p.lat * 1e6)}_${Math.round(p.lon * 1e6)}`,
      lat: p.lat,
      lon: p.lon,
      name: p.name || `Point ${i + 1}`,
      index: i + 1,
      collected: false,
      collectedAt: null,
      distFromStart: Math.round(distFromStart),
      weight: Math.max(10, Math.round(10 + distFromStart / 50)), // farther = worth more, for Score Attack
    };
  });

  return { points, usedFallback };
}
