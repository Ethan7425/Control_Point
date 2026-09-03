// Run state machine: tracks live position, route, elapsed time and point
// collection. Ending a run is always a separate, manual action from collecting
// every point — the route home still counts toward stats.

import { haversine } from './geo.js';

export const COLLECT_RADIUS_M = 20; // GPS in cities is often ±10m; 15-25m avoids false negatives
const MIN_ELEV_DELTA_M = 3; // GPS altitude is noisy (often ±10-30m); ignore jitter below this

export class RunController {
  constructor(settings, points, startPosition, loopGeometry = null) {
    this.settings = settings;
    this.points = points; // array from points.js, mutated in place as collected/rerolled
    this.loopGeometry = loopGeometry; // suggested route line for Loop layout, or null
    // Loop layout is a structured course: points must be collected in order (index
    // 1, 2, 3...), not whichever uncollected point you happen to reach first.
    this.sequential = settings.layout === 'loop';
    this.route = []; // [{lat, lon, t, alt}]
    this.distanceM = 0;
    this.elevationGainM = 0;
    this.elevationLossM = 0;
    this._lastStableAlt = null;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.ended = false;
    this._lastCollected = null;

    if (startPosition) this._pushRoutePoint(startPosition.lat, startPosition.lon);
  }

  // Swaps out an uncollected point for a replacement (same index/slot), returning
  // true if it found something to replace. No-op on an already-collected point.
  replacePoint(oldId, newPoint) {
    const idx = this.points.findIndex((p) => p.id === oldId);
    if (idx === -1 || this.points[idx].collected) return false;
    this.points[idx] = newPoint;
    return true;
  }

  // Rebuilds state after the page was reloaded mid-run — e.g. the OS fully killed a
  // backgrounded tab, wiping all JS memory. Restores the saved route/distance/start
  // time, then appends a fresh GPS fix so the route continues seamlessly from here
  // instead of drawing a straight line across however long the app was closed.
  resumeFrom(saved, freshLat, freshLon, freshAlt) {
    this.route = saved.route;
    this.distanceM = saved.distanceM;
    this.elevationGainM = saved.elevationGainM || 0;
    this.elevationLossM = saved.elevationLossM || 0;
    this._lastStableAlt = saved.route[saved.route.length - 1]?.alt ?? null;
    this.startedAt = saved.startedAt;
    if (freshLat != null && freshLon != null) this._pushRoutePoint(freshLat, freshLon, freshAlt);
  }

  _pushRoutePoint(lat, lon, alt) {
    const prev = this.route[this.route.length - 1];
    if (prev) {
      this.distanceM += haversine(prev.lat, prev.lon, lat, lon);
    }
    this.route.push({ lat, lon, t: Date.now(), alt: alt ?? null });

    // A simple noise gate: only bank a gain/loss once altitude has actually moved
    // past the jitter floor, so GPS wobble doesn't inflate elevation gain to
    // absurd totals over a long run (a very common real-world GPS-elevation bug).
    if (typeof alt === 'number' && !Number.isNaN(alt)) {
      if (this._lastStableAlt == null) {
        this._lastStableAlt = alt;
      } else {
        const delta = alt - this._lastStableAlt;
        if (Math.abs(delta) >= MIN_ELEV_DELTA_M) {
          if (delta > 0) this.elevationGainM += delta;
          else this.elevationLossM += -delta;
          this._lastStableAlt = alt;
        }
      }
    } else {
      // Altitude unavailable this tick (common under tree cover / urban canyons) —
      // clear the reference so the next valid reading starts a fresh baseline
      // instead of diffing against a now-stale altitude from before the gap.
      this._lastStableAlt = null;
    }
  }

  // Called on every geolocation update. Returns the point just collected, if any.
  tick(lat, lon, alt) {
    if (this.ended) return null;
    this._pushRoutePoint(lat, lon, alt);

    let justCollected = null;
    const scoreLocked = this.settings.mode === 'scoreAttack' && this.isTimeUp();
    if (!scoreLocked) {
      // Sequential (Loop): only the next point in order can ever be collected —
      // being physically near a later point does nothing until you've reached
      // everything before it. Free-form (Scatter): any uncollected point works,
      // same as always.
      const candidates = this.sequential
        ? this.points.filter((p) => !p.collected).slice(0, 1)
        : this.points;
      for (const p of candidates) {
        if (p.collected) continue;
        const d = haversine(lat, lon, p.lat, p.lon);
        if (d <= COLLECT_RADIUS_M) {
          p.collected = true;
          p.collectedAt = Date.now();
          justCollected = p;
          break; // one collection per tick keeps toast messaging simple
        }
      }
    }
    this._lastCollected = justCollected;
    return justCollected;
  }

  elapsedMs() {
    return (this.ended ? this.endedAt : Date.now()) - this.startedAt;
  }

  timeBudgetRemainingMs() {
    if (this.settings.mode !== 'scoreAttack') return null;
    const budgetMs = this.settings.timeBudgetMin * 60 * 1000;
    return Math.max(0, budgetMs - this.elapsedMs());
  }

  isTimeUp() {
    const rem = this.timeBudgetRemainingMs();
    return rem !== null && rem <= 0;
  }

  pointsCollected() {
    return this.points.filter((p) => p.collected).length;
  }

  score() {
    return this.points.filter((p) => p.collected).reduce((sum, p) => sum + p.weight, 0);
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.endedAt = Date.now();
  }

  summary() {
    const totalMs = (this.endedAt || Date.now()) - this.startedAt;
    const distanceKm = this.distanceM / 1000;
    const paceMinPerKm = distanceKm > 0 ? totalMs / 60000 / distanceKm : null;
    return {
      mode: this.settings.mode,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      totalMs,
      distanceM: Math.round(this.distanceM),
      elevationGainM: Math.round(this.elevationGainM),
      elevationLossM: Math.round(this.elevationLossM),
      paceMinPerKm,
      pointsTotal: this.points.length,
      pointsCollected: this.pointsCollected(),
      score: this.score(),
      route: this.route,
      points: this.points,
      settings: this.settings,
      loopGeometry: this.loopGeometry,
    };
  }
}
