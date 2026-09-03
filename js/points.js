// Point generation: turns a center location + settings into a set of real,
// walkable target points, respecting spacing constraints without forcing a
// perfectly efficient layout — some randomness/dead-ends are intentional.

import { haversine, destinationPoint } from './geo.js';
import { fetchPathNodes, fetchPOINodes, planSequentialLoop } from './overpass.js';

const MIN_DIST_FROM_START = 25; // don't drop a point right on top of the user
const FINISH_MIN_DIST = 40; // the loop's last point sits this far from start...
const FINISH_MAX_DIST = 90; // ...to this far — close enough to read as "back home",
                             // far enough that it isn't trivially the same spot as point 1

function randomInDisk(center, radiusM, minDist = MIN_DIST_FROM_START) {
  const bearing = Math.random() * 360;
  // sqrt() keeps the distribution uniform over area, not biased toward the center
  const dist = minDist + Math.sqrt(Math.random()) * Math.max(radiusM - minDist, 0);
  return destinationPoint(center.lat, center.lon, bearing, Math.max(dist, minDist));
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
  if (numPoints <= 0) return accepted;

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

// Fetches the style-appropriate candidate pool/source for a given area — shared
// by both the scatter layout and the sequential loop's "middle" points.
async function buildSource(center, effectiveRadiusM, style) {
  if (style === 'random') {
    return { source: makeSyntheticSource(center, effectiveRadiusM), pool: null, usedFallback: false };
  }
  const fetchNodes = style === 'path' ? fetchPathNodes : fetchPOINodes;
  let fetchedPool = [];
  let usedFallback = false;
  try {
    const nodes = await fetchNodes(center.lat, center.lon, effectiveRadiusM);
    fetchedPool = nodes.filter((n) => haversine(center.lat, center.lon, n.lat, n.lon) >= MIN_DIST_FROM_START);
  } catch (e) {
    console.warn('OSM data unavailable, falling back to random placement:', e.message);
    usedFallback = true;
  }
  const source = fetchedPool.length ? makePoolSource(fetchedPool) : makeSyntheticSource(center, effectiveRadiusM);
  if (!fetchedPool.length) usedFallback = true;
  return { source, pool: fetchedPool, usedFallback };
}

function toPoint(candidate, index, center) {
  const distFromStart = haversine(center.lat, center.lon, candidate.lat, candidate.lon);
  return {
    id: `p${index}_${Date.now()}_${Math.round(candidate.lat * 1e6)}_${Math.round(candidate.lon * 1e6)}`,
    lat: candidate.lat,
    lon: candidate.lon,
    name: candidate.name || `Point ${index}`,
    index,
    collected: false,
    collectedAt: null,
    distFromStart: Math.round(distFromStart),
    weight: Math.max(10, Math.round(10 + distFromStart / 50)), // farther = worth more, for Score Attack
  };
}

// `areaCenter` (defaults to `center`) is where the point *search disc* is anchored —
// it can be dragged away from `center` (your actual GPS start) on the settings map so
// you can steer the whole generated area away from somewhere you don't want to go.
// `center` itself always stays your true start position (used for distFromStart/weight
// and, in Loop mode, as point 1 — see generateSequentialLoop).
export async function generatePoints(center, settings, areaCenter = center) {
  const { layout, radiusKm, distanceKm, numPoints, minSpacing, maxSpacing, style } = settings;

  if (layout === 'loop') return generateSequentialLoop(center, settings, areaCenter);

  const effectiveRadiusM = radiusKm * 1000;
  const { source, pool, usedFallback } = await buildSource(areaCenter, effectiveRadiusM, style);
  const picked = selectSpaced(source, numPoints, minSpacing, maxSpacing);
  const points = picked.map((p, i) => toPoint(p, i + 1, center));

  return { points, usedFallback, loopGeometry: null, rerollContext: { pool, effectiveRadiusM, areaCenter } };
}

// A structured course, not a free scatter: point 1 is where you start (collected
// automatically — you're already there), the last point sits a short, deliberate
// distance from start (so it isn't trivially the same spot as point 1), and the
// points in between are visited strictly in order. Collection order is enforced
// by RunController, not here — this just decides *what* that order is.
async function generateSequentialLoop(center, settings, areaCenter = center) {
  const { distanceKm, numPoints, minSpacing, maxSpacing, style } = settings;
  const effectiveRadiusM = (distanceKm * 1000) / (2 * Math.PI) * (0.85 + Math.random() * 0.3); // organic, not a perfect circle
  const middleCount = Math.max(0, numPoints - 2);

  const { source, pool, usedFallback } = await buildSource(areaCenter, effectiveRadiusM, style);
  const middleCandidates = selectSpaced(source, middleCount, minSpacing, maxSpacing);
  const finishCandidate = randomInDisk(center, FINISH_MAX_DIST, FINISH_MIN_DIST);

  let orderedMiddle = middleCandidates;
  let loopGeometry = null;
  try {
    const { order, geometry } = await planSequentialLoop(middleCandidates, center, finishCandidate);
    orderedMiddle = order.map((i) => middleCandidates[i]);
    loopGeometry = geometry;
  } catch (e) {
    console.warn('Sequential loop planning failed, using unordered middle points:', e.message);
  }

  const allCandidates = [{ ...center, name: 'Start' }, ...orderedMiddle, { ...finishCandidate, name: 'Finish' }];
  const points = allCandidates.map((p, i) => toPoint(p, i + 1, center));
  points[0].collected = true; // you're standing on it by definition
  points[0].collectedAt = Date.now();

  return {
    points,
    usedFallback,
    loopGeometry,
    rerollContext: {
      pool, effectiveRadiusM, areaCenter,
      sequential: true,
      finishAnchor: center,
      finishMinDist: FINISH_MIN_DIST,
      finishMaxDist: FINISH_MAX_DIST,
    },
  };
}

// Swaps one point for a freshly chosen one nearby, respecting spacing against the
// *other* current points. Reuses the leftover OSM candidate pool from the original
// generation pass when available (no extra network round-trip); falls back to a
// synthetic random point otherwise — always succeeds, never blocks on a network call.
export function rerollPoint(target, allPoints, center, settings, rerollContext) {
  const { pool, effectiveRadiusM, sequential, finishAnchor, finishMinDist, finishMaxDist, areaCenter } = rerollContext;
  const others = allPoints.filter((p) => p.id !== target.id);
  const usedKeys = new Set(others.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`));
  const respectsSpacing = (cand) => others.every((p) => haversine(p.lat, p.lon, cand.lat, cand.lon) >= settings.minSpacing);

  // The loop's finish point has its own tight "near start" placement rule — reroll
  // must respect that too, or it could end up anywhere in the full loop radius.
  const isFinishPoint = sequential && target.index === allPoints.length;

  let chosen = null;
  if (!isFinishPoint && settings.style !== 'random' && pool?.length) {
    const available = shuffle(pool.filter((c) => !usedKeys.has(`${c.lat.toFixed(6)},${c.lon.toFixed(6)}`)));
    chosen = available.find(respectsSpacing) || available[0] || null;
  }
  if (!chosen) {
    const anchor = isFinishPoint ? finishAnchor : (areaCenter || center);
    const maxDist = isFinishPoint ? finishMaxDist : effectiveRadiusM;
    const minDist = isFinishPoint ? finishMinDist : undefined;
    for (let i = 0; i < 40; i++) {
      const cand = randomInDisk(anchor, maxDist, minDist);
      chosen = cand;
      if (respectsSpacing(cand)) break;
    }
  }

  const point = toPoint(chosen, target.index, center);
  if (isFinishPoint) point.name = 'Finish';
  return point;
}
