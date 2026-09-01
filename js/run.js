// Run state machine: tracks live position, route, elapsed time and point
// collection. Ending a run is always a separate, manual action from collecting
// every point — the route home still counts toward stats.

import { haversine } from './geo.js';

export const COLLECT_RADIUS_M = 20; // GPS in cities is often ±10m; 15-25m avoids false negatives

export class RunController {
  constructor(settings, points, startPosition) {
    this.settings = settings;
    this.points = points; // array from points.js, mutated in place as collected
    this.route = []; // [{lat, lon, t}]
    this.distanceM = 0;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.ended = false;
    this._lastCollected = null;

    if (startPosition) this._pushRoutePoint(startPosition.lat, startPosition.lon);
  }

  _pushRoutePoint(lat, lon) {
    const prev = this.route[this.route.length - 1];
    if (prev) {
      this.distanceM += haversine(prev.lat, prev.lon, lat, lon);
    }
    this.route.push({ lat, lon, t: Date.now() });
  }

  // Called on every geolocation update. Returns the point just collected, if any.
  tick(lat, lon) {
    if (this.ended) return null;
    this._pushRoutePoint(lat, lon);

    let justCollected = null;
    const scoreLocked = this.settings.mode === 'scoreAttack' && this.isTimeUp();
    if (!scoreLocked) {
      for (const p of this.points) {
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
      paceMinPerKm,
      pointsTotal: this.points.length,
      pointsCollected: this.pointsCollected(),
      score: this.score(),
      route: this.route,
      points: this.points,
      settings: this.settings,
    };
  }
}
