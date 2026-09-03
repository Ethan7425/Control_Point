// Shared rendering for the end-of-run recap, reused by both the live recap
// screen and the history detail view.

import { COLLECT_RADIUS_M } from './run.js';

function fmtTime(ms) {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

const MODE_LABEL = { explore: 'Free Explore', timeTrial: 'Time Trial', scoreAttack: 'Score Attack' };

function heroFor(run) {
  if (run.mode === 'timeTrial') {
    return { value: fmtTime(run.totalMs), label: run.pointsCollected >= run.pointsTotal ? 'All points collected' : 'Time (run ended early)' };
  }
  if (run.mode === 'scoreAttack') {
    return { value: String(run.score), label: 'Final score' };
  }
  return { value: `${(run.distanceM / 1000).toFixed(2)} km`, label: 'Distance covered' };
}

export function renderRunRecap(container, run, mapDivId) {
  const hero = heroFor(run);
  // Derived at display time rather than trusting a stored field — keeps this correct
  // even for a run pulled down from another device, where a duplicated derived value
  // like this could otherwise go missing/stale independently of distance and time.
  const distanceKm = run.distanceM / 1000;
  const paceMinPerKm = distanceKm > 0 ? run.totalMs / 60000 / distanceKm : null;
  const pace = paceMinPerKm ? `${paceMinPerKm.toFixed(1)} /km` : '—';

  container.innerHTML = `
    <div class="recap-hero">
      <div class="big-stat">${hero.value}</div>
      <div class="big-label">${hero.label}</div>
      <p class="hint">${MODE_LABEL[run.mode] || run.mode} &middot; ${fmtDate(run.startedAt)}</p>
    </div>
    <div id="${mapDivId}"></div>
    <div class="recap-grid">
      <div class="recap-card"><div class="v">${fmtTime(run.totalMs)}</div><div class="l">Time</div></div>
      <div class="recap-card"><div class="v">${(run.distanceM / 1000).toFixed(2)} km</div><div class="l">Distance</div></div>
      <div class="recap-card"><div class="v">${pace}</div><div class="l">Pace</div></div>
      <div class="recap-card"><div class="v">${run.pointsCollected}/${run.pointsTotal}</div><div class="l">Points</div></div>
      <div class="recap-card"><div class="v">${run.score}</div><div class="l">Score</div></div>
      <div class="recap-card"><div class="v">${MODE_LABEL[run.mode] || run.mode}</div><div class="l">Mode</div></div>
      ${typeof run.elevationGainM === 'number' ? `<div class="recap-card"><div class="v">↗ ${run.elevationGainM} m</div><div class="l">Elev gain</div></div>` : ''}
      ${typeof run.elevationLossM === 'number' ? `<div class="recap-card"><div class="v">↘ ${run.elevationLossM} m</div><div class="l">Elev loss</div></div>` : ''}
    </div>
    <details class="points-details">
      <summary>Points &middot; ${run.pointsCollected}/${run.pointsTotal} collected</summary>
    <ul class="points-list">
      ${run.points.map((p) => `
        <li>
          <span>${p.index}. ${p.name}</span>
          <span class="tag ${p.collected ? 'got' : 'missed'}">${p.collected ? 'Collected' : 'Missed'}</span>
        </li>
      `).join('')}
    </ul>
    </details>
    <button id="share-run-btn" class="secondary-btn">Share Recap</button>
    <button id="export-gpx-btn" class="secondary-btn">Export GPX</button>
  `;

  requestAnimationFrame(() => {
    const mapEl = document.getElementById(mapDivId);
    if (!mapEl || !run.route?.length) return;
    const map = L.map(mapDivId, { zoomControl: false, attributionControl: false, tap: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

    const bounds = L.latLngBounds([]);

    // The suggested loop path (if any) drawn first/underneath, so the actual GPS
    // route stays visually on top — this is a suggestion, not a mandate to follow.
    if (run.loopGeometry?.length) {
      const suggested = L.polyline(run.loopGeometry, {
        color: '#f59e0b', weight: 3, opacity: 0.5, dashArray: '6,10', interactive: false,
      }).addTo(map);
      bounds.extend(suggested.getBounds());
    }

    const latlngs = run.route.map((r) => [r.lat, r.lon]);
    const routeLine = L.polyline(latlngs, { color: '#3b82f6', weight: 4, opacity: 0.85 }).addTo(map);
    bounds.extend(routeLine.getBounds());

    run.points.forEach((p) => {
      // Faint collection-radius ring so a near-miss is visible, not just a red dot.
      L.circle([p.lat, p.lon], {
        radius: COLLECT_RADIUS_M,
        color: p.collected ? '#22c55e' : '#ef4444',
        weight: 1,
        fillColor: p.collected ? '#22c55e' : '#ef4444',
        fillOpacity: 0.06,
        opacity: 0.25,
        interactive: false,
      }).addTo(map);
      L.circleMarker([p.lat, p.lon], {
        radius: 8,
        color: '#06210f',
        weight: 2,
        fillColor: p.collected ? '#22c55e' : '#ef4444',
        fillOpacity: 0.9,
      }).addTo(map).bindTooltip(`${p.index}. ${p.name}`);
    });

    run.points.forEach((p) => bounds.extend([p.lat, p.lon]));
    map.fitBounds(bounds, { padding: [24, 24] });
  });
}

function computeStreak(runs) {
  const days = new Set(runs.map((r) => new Date(r.startedAt).toDateString()));
  const cursor = new Date();
  if (!days.has(cursor.toDateString())) {
    cursor.setDate(cursor.getDate() - 1);
    if (!days.has(cursor.toDateString())) return 0; // most recent run wasn't today or yesterday
  }
  let streak = 0;
  while (days.has(cursor.toDateString())) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export function renderHistorySummary(container, runs) {
  if (!runs.length) {
    container.innerHTML = '';
    return;
  }
  const totalDistanceKm = runs.reduce((sum, r) => sum + r.distanceM, 0) / 1000;
  const totalPoints = runs.reduce((sum, r) => sum + r.pointsCollected, 0);
  const streak = computeStreak(runs);

  container.innerHTML = `
    <div class="recap-grid trends-grid">
      <div class="recap-card"><div class="v">${runs.length}</div><div class="l">Runs</div></div>
      <div class="recap-card"><div class="v">${totalDistanceKm.toFixed(1)} km</div><div class="l">Total dist.</div></div>
      <div class="recap-card"><div class="v">${totalPoints}</div><div class="l">Points</div></div>
      <div class="recap-card"><div class="v">${streak}${streak > 0 ? ' \u{1F525}' : ''}</div><div class="l">Day streak</div></div>
    </div>
  `;
}

export function renderHistoryList(container, runs, onSelect, onDelete) {
  if (!runs.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">◎</div>
        <div class="title">No runs yet</div>
        <div class="sub">Finish a run and it'll show up here.</div>
      </div>
    `;
    return;
  }
  container.innerHTML = runs.map((r) => `
    <div class="history-item" data-id="${r.id}">
      <span class="hi-mode-dot"></span>
      <div class="hi-body">
        <div class="hi-main">
          <span class="hi-mode">${MODE_LABEL[r.mode] || r.mode}</span>
          <span class="hi-date">${fmtDate(r.startedAt)}</span>
        </div>
        <div class="hi-stats">
          ${(r.distanceM / 1000).toFixed(2)} km &middot; ${fmtTime(r.totalMs)}<br>
          ${r.pointsCollected}/${r.pointsTotal} pts
        </div>
      </div>
      <button class="hi-delete" data-id="${r.id}" aria-label="Delete run">&#128465;</button>
    </div>
  `).join('');

  container.querySelectorAll('.history-item').forEach((el) => {
    el.addEventListener('click', () => onSelect(el.dataset.id));
  });
  container.querySelectorAll('.hi-delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't also trigger the row's onSelect
      onDelete(btn.dataset.id);
    });
  });
}

export { fmtTime, fmtDate };
