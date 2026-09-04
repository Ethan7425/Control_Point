// Point generation: turns a center location + settings into a set of real,
// walkable target points, respecting spacing constraints without forcing a
// perfectly efficient layout — some randomness/dead-ends are intentional.

import { haversine, destinationPoint } from './geo.js';
import { fetchPathNodes, fetchPOINodes, planFixedOrderRoute } from './overpass.js';

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

// Arranges `count` points in an actual geometric ring around `center` — evenly
// spaced by angle, walked in one consistent rotational direction, with some
// per-slot angle/radius jitter so it isn't a perfectly robotic circle — then
// snaps each ring slot to the nearest real candidate from `pool` (or just uses
// the ideal ring position when there's no real data, e.g. 'random' style).
//
// Points come back already in loop order, angularly adjacent by construction.
// That's the actual fix for backtracking: previously, points were picked from
// the pool with no regard for their spatial arrangement, then handed to a
// shortest-path solver to find a visiting order — which can legitimately need
// to double back if the points themselves aren't laid out in a loop shape to
// begin with. Deciding the loop's shape first and only asking a router for the
// walking geometry between already-ordered points (see planFixedOrderRoute)
// means the route can't crisscross the middle of the loop chasing a shortcut.
function buildRingPoints(center, radiusM, count, pool, minSpacing) {
  const points = [];
  const idealSlots = [];
  if (count <= 0) return { points, idealSlots };

  const startAngle = Math.random() * 360;
  const direction = Math.random() < 0.5 ? 1 : -1; // clockwise or counter-clockwise, picked once for the whole loop
  const angleStep = 360 / count;
  const usedKeys = new Set();

  for (let i = 0; i < count; i++) {
    const jitter = (Math.random() - 0.5) * angleStep * 0.6;
    const angle = (startAngle + direction * i * angleStep + jitter + 360) % 360;
    const radiusForSlot = radiusM * (0.7 + Math.random() * 0.35); // organic, not a perfect circle
    const ideal = destinationPoint(center.lat, center.lon, angle, radiusForSlot);
    idealSlots.push(ideal);

    let cand = null;
    if (pool?.length) {
      let best = null, bestDist = Infinity;
      for (const p of pool) {
        const key = `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
        if (usedKeys.has(key)) continue;
        if (points.some((c) => haversine(c.lat, c.lon, p.lat, p.lon) < minSpacing)) continue;
        const d = haversine(ideal.lat, ideal.lon, p.lat, p.lon);
        if (d < bestDist) { bestDist = d; best = p; }
      }
      cand = best;
    }
    if (!cand) cand = ideal;

    usedKeys.add(`${cand.lat.toFixed(6)},${cand.lon.toFixed(6)}`);
    points.push(cand);
  }
  return { points, idealSlots };
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

// The radius a loop of `distanceKm` would naturally trace if it were a plain
// circle (circumference = 2*pi*r) — exported so the settings-screen preview map
// can show the same number the generator will actually aim for.
export function distanceDerivedRadiusM(distanceKm) {
  return (distanceKm * 1000) / (2 * Math.PI);
}

// A structured course, not a free scatter: point 1 is where you start (collected
// automatically — you're already there), the last point sits a short, deliberate
// distance from start (so it isn't trivially the same spot as point 1), and the
// points in between are visited strictly in order. Collection order is enforced
// by RunController, not here — this just decides *what* that order is.
//
// Radius and distance are two distinct dials, not one derived from the other:
// `radiusKm` is a hard boundary on how far the loop is allowed to reach (the same
// "search area" control Scatter uses, and the same circle you drag on the settings
// map), while `distanceKm` is the length you're aiming for. The ring's actual
// radius is whichever is smaller — so widening the search area lets a longer loop
// happen, but never forces one past a boundary you set on purpose.
async function generateSequentialLoop(center, settings, areaCenter = center) {
  const { distanceKm, radiusKm, numPoints, minSpacing, style } = settings;
  const organicDistanceRadiusM = distanceDerivedRadiusM(distanceKm) * (0.85 + Math.random() * 0.3); // organic, not a perfect circle
  const effectiveRadiusM = Math.min(organicDistanceRadiusM, radiusKm * 1000);
  const middleCount = Math.max(0, numPoints - 2);

  const { pool, usedFallback } = await buildSource(areaCenter, effectiveRadiusM, style);
  const { points: orderedMiddle, idealSlots } = buildRingPoints(areaCenter, effectiveRadiusM, middleCount, pool, minSpacing);
  const finishCandidate = randomInDisk(center, FINISH_MAX_DIST, FINISH_MIN_DIST);

  const loopGeometry = await planFixedOrderRoute([center, ...orderedMiddle, finishCandidate]).catch(() => null);

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
      idealSlots, // this middle point's spot in the ring, by index — see rerollPoint
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
  const { pool, effectiveRadiusM, sequential, idealSlots, finishAnchor, finishMinDist, finishMaxDist, areaCenter } = rerollContext;
  const others = allPoints.filter((p) => p.id !== target.id);
  const usedKeys = new Set(others.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`));
  const respectsSpacing = (cand) => others.every((p) => haversine(p.lat, p.lon, cand.lat, cand.lon) >= settings.minSpacing);

  // The loop's finish point has its own tight "near start" placement rule — reroll
  // must respect that too, or it could end up anywhere in the full loop radius.
  const isFinishPoint = sequential && target.index === allPoints.length;
  // A middle point's spot in the ring (see buildRingPoints) — reroll biases back
  // toward it instead of anywhere in the whole search area, or it could land
  // clear across the loop and force the same crisscrossing this was built to avoid.
  const ringSlot = sequential && !isFinishPoint ? idealSlots?.[target.index - 1] : null;

  let chosen = null;
  if (!isFinishPoint && settings.style !== 'random' && pool?.length) {
    const available = pool.filter((c) => !usedKeys.has(`${c.lat.toFixed(6)},${c.lon.toFixed(6)}`));
    const spaced = available.filter(respectsSpacing);
    const candidates = spaced.length ? spaced : available;
    if (ringSlot && candidates.length) {
      chosen = candidates.reduce((best, c) => (
        !best || haversine(ringSlot.lat, ringSlot.lon, c.lat, c.lon) < haversine(ringSlot.lat, ringSlot.lon, best.lat, best.lon)
          ? c : best
      ), null);
    } else {
      chosen = shuffle(candidates)[0] || null;
    }
  }
  if (!chosen) {
    const anchor = isFinishPoint ? finishAnchor : (ringSlot || areaCenter || center);
    const maxDist = isFinishPoint ? finishMaxDist : (ringSlot ? Math.min(settings.maxSpacing, effectiveRadiusM * 0.4) : effectiveRadiusM);
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
