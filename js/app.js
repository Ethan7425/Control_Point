import { getCurrentPosition, GeoWatcher, bearing, compassDirection, haversine } from './geo.js';
import { generatePoints, rerollPoint } from './points.js';
import { RunController, COLLECT_RADIUS_M } from './run.js';
import { saveRun, getAllRuns, getRun, deleteRun } from './db.js';
import { renderRunRecap, renderHistoryList, renderHistorySummary, fmtTime } from './render.js';
import { unlockAudio, feedbackCollect, feedbackTimeUp } from './feedback.js';
import { downloadGPX } from './gpx.js';

// ---------- version ----------
// Bump this on every push — it's the quickest way to confirm a device is actually
// running the latest deploy (shown small next to the app name in the header).
const APP_VERSION = '1.0.0';
document.getElementById('app-version').textContent = `v${APP_VERSION}`;
console.log(`Control Point v${APP_VERSION}`);

// ---------- service worker ----------
// Beyond serving network-first, actively self-heal from a stale install: force an
// update check on every load, and if a newer worker takes over a tab that was
// *already being controlled by an older one*, reload once so the tab actually runs
// the new code instead of silently sitting on the old one until the user notices.
//
// `hadControllerAtLoad` must be captured before register() runs. Our SW calls
// clients.claim() on activate, which — by design — takes control of the current
// page immediately, even on the very first-ever install. Checking
// navigator.serviceWorker.controller *after* the fact is true on every visit, first
// one included, which would auto-reload the page right as someone's mid-action
// (e.g. right after tapping Start) — this flag is what tells a real update apart
// from a fresh install.
if ('serviceWorker' in navigator) {
  const hadControllerAtLoad = !!navigator.serviceWorker.controller;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('service-worker.js');
      reg.update();
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker?.addEventListener('statechange', () => {
          if (newWorker.state === 'activated' && hadControllerAtLoad) {
            window.location.reload();
          }
        });
      });
    } catch (e) {
      console.warn('SW registration failed', e);
    }
  });
}

// ---------- install prompt ----------
const installBanner = document.getElementById('install-banner');
const installBannerText = document.getElementById('install-banner-text');
const installBannerAction = document.getElementById('install-banner-action');
const installBannerDismiss = document.getElementById('install-banner-dismiss');
let deferredInstallPrompt = null;

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

function showInstallBanner(kind) {
  if (isStandalone() || localStorage.getItem('cp_install_dismissed') === 'true') return;
  installBannerText.textContent =
    kind === 'ios'
      ? 'Install Control Point: tap Share, then "Add to Home Screen".'
      : 'Install Control Point for the full-screen app experience.';
  installBannerAction.classList.toggle('hidden', kind !== 'android');
  installBanner.classList.remove('hidden');
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallBanner('android');
});
window.addEventListener('appinstalled', () => installBanner.classList.add('hidden'));

installBannerAction.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installBanner.classList.add('hidden');
});
installBannerDismiss.addEventListener('click', () => {
  localStorage.setItem('cp_install_dismissed', 'true');
  installBanner.classList.add('hidden');
});

if (isIOS() && !isStandalone()) showInstallBanner('ios');

// ---------- wake lock (keep the screen on for the duration of a run) ----------
let wakeLock = null;
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) {
    console.warn('Wake lock request failed:', e.message);
  }
}
async function releaseWakeLock() {
  try { await wakeLock?.release(); } catch { /* already released */ }
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && runController && !runController.ended) acquireWakeLock();
});

// ---------- view switching ----------
const views = document.querySelectorAll('.view');
const navBtns = document.querySelectorAll('.navbtn');

function showView(name) {
  views.forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  // loading/run/recap are all part of the "Run" flow — keep that tab highlighted through them.
  const navName = name === 'history' ? 'history' : 'settings';
  navBtns.forEach((b) => b.classList.toggle('active', b.dataset.view === navName));
}

navBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    showView(btn.dataset.view);
    if (btn.dataset.view === 'history') loadHistory();
  });
});

// ---------- settings form ----------
const form = document.getElementById('settings-form');
const fields = { mode: 'explore', layout: 'scatter', style: 'path' };

document.querySelectorAll('.segmented').forEach((group) => {
  const key = group.dataset.field;
  group.querySelectorAll('.seg').forEach((btn) => {
    btn.addEventListener('click', () => {
      group.querySelectorAll('.seg').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      fields[key] = btn.dataset.value;
      onFieldChange(key);
    });
  });
});

const rowRadius = document.getElementById('row-radius');
const rowDistance = document.getElementById('row-distance');
const rowTimeBudget = document.getElementById('row-timeBudget');
const modeHint = document.getElementById('mode-hint');

const MODE_HINTS = {
  explore: 'Wander to generated points at your own pace. No scoring.',
  timeTrial: 'Collect every point as fast as you can. Time is your score.',
  scoreAttack: 'Fixed time budget. Farther points are worth more — decide live what’s reachable before time runs out.',
};

function onFieldChange(key) {
  if (key === 'layout') {
    rowRadius.classList.toggle('hidden', fields.layout !== 'scatter');
    rowDistance.classList.toggle('hidden', fields.layout !== 'loop');
  }
  if (key === 'mode') {
    rowTimeBudget.classList.toggle('hidden', fields.mode !== 'scoreAttack');
    modeHint.textContent = MODE_HINTS[fields.mode];
  }
}
onFieldChange('layout');
onFieldChange('mode');

const sliderIds = ['radius', 'distance', 'numPoints', 'minSpacing', 'maxSpacing', 'timeBudget'];
const sliderUnits = { radius: 'km', distance: 'km', numPoints: '', minSpacing: 'm', maxSpacing: 'm', timeBudget: 'min' };
sliderIds.forEach((id) => {
  const el = document.getElementById(id);
  const label = document.getElementById(`${id}-val`);
  const update = () => {
    const unit = sliderUnits[id];
    label.textContent = unit ? `${el.value} ${unit}` : el.value;
  };
  el.addEventListener('input', update);
  update();
});

// ---------- settings persistence (remembers your last-used setup across visits) ----------
const SETTINGS_STORAGE_KEY = 'cp_last_settings';
const SLIDER_KEY_TO_ID = {
  radiusKm: 'radius', distanceKm: 'distance', numPoints: 'numPoints',
  minSpacing: 'minSpacing', maxSpacing: 'maxSpacing', timeBudgetMin: 'timeBudget',
};

function applySavedSettings(saved) {
  Object.entries(SLIDER_KEY_TO_ID).forEach(([key, id]) => {
    if (saved[key] != null) document.getElementById(id).value = saved[key];
  });
  sliderIds.forEach((id) => document.getElementById(id).dispatchEvent(new Event('input')));

  ['mode', 'layout', 'style'].forEach((key) => {
    if (!saved[key]) return;
    fields[key] = saved[key];
    document.querySelectorAll(`.segmented[data-field="${key}"] .seg`).forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.value === saved[key]);
    });
  });
  onFieldChange('layout');
  onFieldChange('mode');
}

try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || 'null');
  if (saved) applySavedSettings(saved);
} catch {
  // corrupt/unavailable storage — just start from the defaults already in the DOM
}

function readSettings() {
  return {
    mode: fields.mode,
    layout: fields.layout,
    style: fields.style,
    radiusKm: parseFloat(document.getElementById('radius').value),
    distanceKm: parseFloat(document.getElementById('distance').value),
    numPoints: parseInt(document.getElementById('numPoints').value, 10),
    minSpacing: parseInt(document.getElementById('minSpacing').value, 10),
    maxSpacing: parseInt(document.getElementById('maxSpacing').value, 10),
    timeBudgetMin: parseInt(document.getElementById('timeBudget').value, 10),
  };
}

// ---------- permission modal ----------
const permModal = document.getElementById('permission-modal');
const permMsg = document.getElementById('permission-msg');
document.getElementById('permission-cancel').addEventListener('click', () => {
  permModal.classList.add('hidden');
  showView('settings');
});
document.getElementById('permission-retry').addEventListener('click', () => {
  permModal.classList.add('hidden');
  beginRun();
});

// ---------- loading screen ----------
const locStatus = document.getElementById('loc-status');
const loadingStatusEl = document.getElementById('loading-status');
const loadingSubstatusEl = document.getElementById('loading-substatus');
let launchCancelled = false;

function setLoadingStatus(text, subtext = '') {
  loadingStatusEl.textContent = text;
  loadingSubstatusEl.textContent = subtext;
}

document.getElementById('loading-cancel').addEventListener('click', () => {
  launchCancelled = true;
  showView('settings');
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  beginRun();
});

const MIN_LOADING_MS = 400; // avoids a jarring flash-and-gone on fast connections

async function beginRun() {
  unlockAudio(); // must happen synchronously within this user-gesture handler
  launchCancelled = false;
  showView('loading');
  setLoadingStatus('Getting your location…');
  const loadStart = Date.now();

  let pos;
  try {
    pos = await getCurrentPosition();
  } catch (err) {
    if (launchCancelled) return;
    showView('settings');
    permMsg.textContent = 'Couldn’t get your location. Please allow location access in your browser settings and try again.';
    permModal.classList.remove('hidden');
    return;
  }
  if (launchCancelled) return;

  const center = { lat: pos.coords.latitude, lon: pos.coords.longitude };
  const settings = readSettings();
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // storage unavailable (private browsing, quota) — not worth failing the run over
  }

  const isLive = settings.style !== 'random';
  setLoadingStatus(
    isLive ? 'Finding points on OpenStreetMap…' : 'Placing points…',
    isLive ? 'This can take up to ~20s if OpenStreetMap is busy' : ''
  );

  // generatePoints() already falls back to random placement internally if OSM data
  // is unreachable, so this should rarely throw — but retry a couple of times on a
  // genuine failure before giving up, since a transient blip shouldn't dead-end the run.
  const MAX_ATTEMPTS = 3;
  let points, usedFallback, loopGeometry, rerollContext, lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      ({ points, usedFallback, loopGeometry, rerollContext } = await generatePoints(center, settings));
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (launchCancelled) return;
      if (attempt < MAX_ATTEMPTS) {
        setLoadingStatus('Having trouble generating points…', `Retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})…`);
        await new Promise((r) => setTimeout(r, 1200));
        if (launchCancelled) return;
      }
    }
  }
  if (lastErr) {
    console.error(lastErr);
    locStatus.textContent = 'Point generation kept failing. Please check your connection and try again.';
    showView('settings');
    return;
  }
  if (launchCancelled) return;

  if (!points.length) {
    locStatus.textContent = 'No usable points found nearby — try a larger radius or a different point style.';
    showView('settings');
    return;
  }

  const elapsed = Date.now() - loadStart;
  if (elapsed < MIN_LOADING_MS) await new Promise((r) => setTimeout(r, MIN_LOADING_MS - elapsed));
  if (launchCancelled) return;

  locStatus.textContent = 'Location permission will be requested when you start.';
  startRunSession(center, settings, points, usedFallback && settings.style !== 'random', loopGeometry, rerollContext);
}

// ---------- run session ----------
let map, userMarker, userAccuracyCircle, routeLine, loopRouteLine, pointMarkers = [], pointCircles = [];
let runController, geoWatcher, statsTimer, lastKnownLatLng = null, timeUpAnnounced = false;
let currentCenter = null, currentRerollContext = null;

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pointIcon(p) {
  return L.divIcon({
    className: '',
    html: `<div class="cp-dot ${p.collected ? 'collected' : 'uncollected'}" style="width:22px;height:22px;display:flex;align-items:center;justify-content:center;color:#06210f;font-weight:700;font-size:11px;">${p.index}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function userIcon() {
  return L.divIcon({
    className: '',
    html: `<div class="cp-user-dot" style="width:16px;height:16px;"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

// Visual reminder of exactly how close a point needs to be to collect it —
// glows amber while uncollected, settles to a dim green ring once collected.
function circleStyle(collected) {
  return collected
    ? { color: '#22c55e', weight: 2, fillColor: '#22c55e', fillOpacity: 0.06, opacity: 0.35 }
    : { color: '#f59e0b', weight: 3, fillColor: '#f59e0b', fillOpacity: 0.16, opacity: 0.85 };
}

// Custom Leaflet control: large, thumb-friendly "recenter on me" button for mobile.
const RecenterControl = L.Control.extend({
  options: { position: 'bottomleft' },
  onAdd() {
    const btn = L.DomUtil.create('button', 'cp-recenter-btn');
    btn.type = 'button';
    btn.innerHTML = '⌖';
    btn.setAttribute('aria-label', 'Center map on my location');
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.on(btn, 'click', () => {
      if (lastKnownLatLng) map.setView(lastKnownLatLng, Math.max(map.getZoom(), 16));
    });
    return btn;
  },
});

// Tapping a point shows its name and, if it's still uncollected, a "Reroll this
// point" button — for when the generator drops one somewhere genuinely awkward.
function bindPointPopup(marker, point) {
  const html = point.collected
    ? `<div class="cp-popup"><strong>${escapeHtml(point.name)}</strong><br><span class="cp-popup-status">Collected ✓</span></div>`
    : `<div class="cp-popup"><strong>${escapeHtml(point.name)}</strong><br><button type="button" class="cp-popup-reroll" data-id="${point.id}">Reroll this point</button></div>`;
  marker.unbindPopup();
  marker.bindPopup(html);
  marker.off('popupopen');
  marker.on('popupopen', () => {
    marker.getPopup()?.getElement()?.querySelector('.cp-popup-reroll')?.addEventListener('click', () => handleReroll(point.id));
  });
}

function handleReroll(pointId) {
  const idx = runController?.points.findIndex((p) => p.id === pointId);
  if (idx == null || idx === -1 || !currentRerollContext) return;
  const target = runController.points[idx];
  if (target.collected) return;

  const newPoint = rerollPoint(target, runController.points, currentCenter, runController.settings, currentRerollContext);
  runController.replacePoint(target.id, newPoint);

  map.closePopup();
  map.removeLayer(pointMarkers[idx]);
  map.removeLayer(pointCircles[idx]);
  pointMarkers[idx] = L.marker([newPoint.lat, newPoint.lon], { icon: pointIcon(newPoint) }).addTo(map);
  bindPointPopup(pointMarkers[idx], newPoint);
  pointCircles[idx] = L.circle([newPoint.lat, newPoint.lon], {
    radius: COLLECT_RADIUS_M, className: 'cp-radius-glow', ...circleStyle(false),
  }).addTo(map);

  showToast(`Point ${newPoint.index} re-rolled`);
  updateNextPointIndicator();
}

function startRunSession(center, settings, points, usedFallback, loopGeometry, rerollContext) {
  showView('run');
  document.getElementById('stat-score-wrap').classList.toggle('hidden', settings.mode !== 'scoreAttack');
  document.getElementById('stat-countdown-wrap').classList.toggle('hidden', settings.mode !== 'scoreAttack');

  runController = new RunController(settings, points, center, loopGeometry);
  currentCenter = center;
  currentRerollContext = rerollContext;
  lastKnownLatLng = [center.lat, center.lon];
  timeUpAnnounced = false;
  acquireWakeLock();

  if (usedFallback) {
    setTimeout(() => showToast('OpenStreetMap data unavailable — points placed randomly instead'), 400);
  }

  if (map) { map.remove(); map = null; }
  userAccuracyCircle = null;
  map = L.map('map', {
    zoomControl: false,
    attributionControl: false,
    tap: true,
    touchZoom: 'center',
  }).setView([center.lat, center.lon], 17);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  L.control.attribution({ position: 'bottomleft', prefix: false }).addAttribution('&copy; OpenStreetMap contributors').addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.addControl(new RecenterControl());

  loopRouteLine = null;
  if (loopGeometry?.length) {
    // A suggestion, not a mandate — dashed and muted so it doesn't compete with the live route.
    loopRouteLine = L.polyline(loopGeometry, {
      color: '#f59e0b', weight: 3, opacity: 0.5, dashArray: '6,10', interactive: false,
    }).addTo(map);
  }

  pointMarkers = points.map((p) => {
    const marker = L.marker([p.lat, p.lon], { icon: pointIcon(p) }).addTo(map);
    bindPointPopup(marker, p);
    return marker;
  });
  pointCircles = points.map((p) =>
    L.circle([p.lat, p.lon], { radius: COLLECT_RADIUS_M, className: 'cp-radius-glow', ...circleStyle(false) }).addTo(map)
  );
  routeLine = L.polyline([[center.lat, center.lon]], { color: '#3b82f6', weight: 4, opacity: 0.85 }).addTo(map);
  userMarker = L.marker([center.lat, center.lon], { icon: userIcon(), zIndexOffset: 1000 }).addTo(map);

  geoWatcher = new GeoWatcher(onPositionUpdate, onPositionError);
  geoWatcher.start();

  statsTimer = setInterval(updateStatBar, 1000);
  updateStatBar();
}

function showToast(text) {
  const toast = document.getElementById('collect-toast');
  toast.textContent = text;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), 2200);
}

function onPositionUpdate(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  const collected = runController.tick(lat, lon);

  lastKnownLatLng = [lat, lon];
  userMarker.setLatLng([lat, lon]);
  routeLine.addLatLng([lat, lon]);

  if (userAccuracyCircle) {
    userAccuracyCircle.setLatLng([lat, lon]).setRadius(accuracy || 0);
  } else if (accuracy) {
    userAccuracyCircle = L.circle([lat, lon], {
      radius: accuracy,
      color: '#3b82f6', weight: 1, fillColor: '#3b82f6', fillOpacity: 0.08, opacity: 0.35, interactive: false,
    }).addTo(map);
  }

  if (collected) {
    const idx = runController.points.findIndex((p) => p.id === collected.id);
    pointMarkers[idx]?.setIcon(pointIcon(collected));
    if (pointMarkers[idx]) bindPointPopup(pointMarkers[idx], collected); // drop the reroll option once collected
    pointCircles[idx]?.setStyle(circleStyle(true));
    pointCircles[idx]?.getElement()?.classList.remove('cp-radius-glow');
    showToast(`Collected: ${collected.name} (+${collected.weight})`);
    feedbackCollect();
  }

  updateStatBar();
}

function onPositionError(err) {
  console.warn('Geolocation error during run:', err);
  showToast('GPS signal lost — keep moving to reconnect.');
}

function updateStatBar() {
  if (!runController) return;
  document.getElementById('stat-time').textContent = fmtTime(runController.elapsedMs());
  document.getElementById('stat-distance').textContent = `${(runController.distanceM / 1000).toFixed(2)} km`;
  document.getElementById('stat-points').textContent = `${runController.pointsCollected()} / ${runController.points.length}`;

  if (runController.settings.mode === 'scoreAttack') {
    document.getElementById('stat-score').textContent = runController.score();
    const rem = runController.timeBudgetRemainingMs();
    document.getElementById('stat-countdown').textContent = fmtTime(rem);
    if (rem <= 0) {
      document.getElementById('stat-countdown').style.color = 'var(--danger)';
      if (!timeUpAnnounced) {
        timeUpAnnounced = true;
        feedbackTimeUp();
        showToast("Time's up! Score locked — press End Run when ready.");
      }
    }
  }

  updateNextPointIndicator();
}

function updateNextPointIndicator() {
  const el = document.getElementById('next-point-indicator');
  if (!runController || !lastKnownLatLng) { el.classList.add('hidden'); return; }

  const uncollected = runController.points.filter((p) => !p.collected);
  if (!uncollected.length) {
    el.textContent = '🏁 All points collected — head home whenever you’re ready';
    el.classList.remove('hidden');
    return;
  }

  const [lat, lon] = lastKnownLatLng;
  let nearest = uncollected[0];
  let nearestDist = haversine(lat, lon, nearest.lat, nearest.lon);
  for (const p of uncollected.slice(1)) {
    const d = haversine(lat, lon, p.lat, p.lon);
    if (d < nearestDist) { nearest = p; nearestDist = d; }
  }

  const dir = compassDirection(bearing(lat, lon, nearest.lat, nearest.lon));
  const distText = nearestDist >= 1000 ? `${(nearestDist / 1000).toFixed(2)} km` : `${Math.round(nearestDist)} m`;
  el.textContent = `→ Point ${nearest.index}: ${distText} ${dir}`;
  el.classList.remove('hidden');
}

const MODE_LABEL_FOR_SHARE = { explore: 'Free Explore', timeTrial: 'Time Trial', scoreAttack: 'Score Attack' };

async function shareRun(run) {
  const text =
    `Control Point — ${MODE_LABEL_FOR_SHARE[run.mode] || run.mode}\n` +
    `${(run.distanceM / 1000).toFixed(2)} km in ${fmtTime(run.totalMs)} · ${run.pointsCollected}/${run.pointsTotal} points` +
    (run.mode === 'scoreAttack' ? ` · score ${run.score}` : '');
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Control Point run', text });
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      showToast('Recap copied to clipboard');
    }
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('Share failed:', e.message); // AbortError = user just cancelled the share sheet
  }
}

// A native confirm() is used nowhere here on purpose: window.confirm()/alert()/prompt()
// silently no-op in an iOS home-screen-installed (standalone) PWA — the call just
// returns without ever showing anything, which reads as "the button does nothing".
const endRunModal = document.getElementById('end-run-modal');
document.getElementById('end-run-btn').addEventListener('click', () => {
  if (!runController) return;
  endRunModal.classList.remove('hidden');
});
document.getElementById('end-run-keep-going').addEventListener('click', () => {
  endRunModal.classList.add('hidden');
});
document.getElementById('end-run-confirm').addEventListener('click', () => {
  endRunModal.classList.add('hidden');
  endRun();
});

async function endRun() {
  geoWatcher?.stop();
  clearInterval(statsTimer);
  releaseWakeLock();
  runController.end();
  const summary = runController.summary();
  const run = { id: `run_${summary.startedAt}`, ...summary };

  try {
    await saveRun(run);
  } catch (e) {
    console.warn('Failed to save run to history:', e);
  }

  showView('recap');
  const container = document.getElementById('recap-content');
  renderRunRecap(container, run, 'recap-map');
  document.getElementById('share-run-btn')?.addEventListener('click', () => shareRun(run));
  document.getElementById('export-gpx-btn')?.addEventListener('click', () => downloadGPX(run));

  const actions = document.createElement('div');
  actions.innerHTML = `
    <button id="recap-new" class="primary-btn">New run</button>
    <button id="recap-history" class="secondary-btn">View history</button>
  `;
  container.appendChild(actions);
  document.getElementById('recap-new').addEventListener('click', () => showView('settings'));
  document.getElementById('recap-history').addEventListener('click', () => {
    showView('history');
    loadHistory();
  });
}

// ---------- history ----------
const deleteRunModal = document.getElementById('delete-run-modal');
let pendingDeleteId = null;

document.getElementById('delete-run-cancel').addEventListener('click', () => {
  pendingDeleteId = null;
  deleteRunModal.classList.add('hidden');
});
document.getElementById('delete-run-confirm').addEventListener('click', async () => {
  deleteRunModal.classList.add('hidden');
  if (!pendingDeleteId) return;
  await deleteRun(pendingDeleteId);
  pendingDeleteId = null;
  loadHistory();
});

async function loadHistory() {
  document.getElementById('history-detail').classList.add('hidden');
  document.getElementById('history-detail').innerHTML = '';
  document.getElementById('history-list').classList.remove('hidden');
  document.getElementById('history-summary').classList.remove('hidden');
  const runs = await getAllRuns();
  renderHistorySummary(document.getElementById('history-summary'), runs);
  renderHistoryList(
    document.getElementById('history-list'),
    runs,
    async (id) => {
      const run = await getRun(id);
      if (!run) return;
      document.getElementById('history-list').classList.add('hidden');
      document.getElementById('history-summary').classList.add('hidden');
      const detail = document.getElementById('history-detail');
      detail.classList.remove('hidden');
      detail.innerHTML = `<button class="back-btn" id="history-back">&larr; Back to history</button><div id="history-detail-body"></div>`;
      renderRunRecap(document.getElementById('history-detail-body'), run, 'history-map');
      document.getElementById('share-run-btn')?.addEventListener('click', () => shareRun(run));
      document.getElementById('export-gpx-btn')?.addEventListener('click', () => downloadGPX(run));
      document.getElementById('history-back').addEventListener('click', () => {
        detail.classList.add('hidden');
        document.getElementById('history-list').classList.remove('hidden');
        document.getElementById('history-summary').classList.remove('hidden');
      });
    },
    (id) => {
      pendingDeleteId = id;
      deleteRunModal.classList.remove('hidden');
    }
  );
}
