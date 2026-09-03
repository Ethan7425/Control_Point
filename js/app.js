import { getCurrentPosition, GeoWatcher, bearing, compassDirection, haversine } from './geo.js';
import { generatePoints, rerollPoint } from './points.js';
import { RunController, COLLECT_RADIUS_M } from './run.js';
import { saveRun, getAllRuns, getRun, deleteRun } from './db.js';
import { renderRunRecap, renderHistoryList, renderHistorySummary, fmtTime } from './render.js';
import { unlockAudio, feedbackCollect, feedbackTimeUp } from './feedback.js';
import { downloadGPX } from './gpx.js';
import { isOrientationSupported, requestOrientationPermission, watchHeading } from './heading.js';
import {
  isAuthAvailable, getSession, onAuthStateChange, signUp, signIn, signOut, sendPasswordReset, updatePin,
  updateDisplayName,
} from './auth-client.js';
import { pushRun, deleteRemoteRun, pullAndMergeRuns, pushAllLocalRuns } from './sync.js';

// ---------- version ----------
// Bump this on every push — it's the quickest way to confirm a device is actually
// running the latest deploy (shown small next to the app name in the header).
const APP_VERSION = '1.1.2';
document.getElementById('app-version').textContent = `v${APP_VERSION}`;
console.log(`Control Point v${APP_VERSION}`);

// ---------- active-run persistence ----------
// Mobile browsers (iOS Safari especially) routinely kill a backgrounded PWA's page
// outright to reclaim memory — reopening it is a genuine fresh load with zero JS
// state left. Without this, a run in progress just silently vanishes. Snapshotting
// to localStorage on every meaningful change lets a fresh load offer to resume it.
const ACTIVE_RUN_KEY = 'cp_active_run';

function saveActiveRun() {
  if (!runController || runController.ended) return;
  try {
    localStorage.setItem(ACTIVE_RUN_KEY, JSON.stringify({
      startedAt: runController.startedAt,
      settings: runController.settings,
      points: runController.points,
      route: runController.route,
      distanceM: runController.distanceM,
      elevationGainM: runController.elevationGainM,
      elevationLossM: runController.elevationLossM,
      loopGeometry: runController.loopGeometry,
      rerollContext: currentRerollContext,
    }));
  } catch {
    // storage full/unavailable — resume just won't be offered next time, not fatal
  }
}

function loadActiveRun() {
  try {
    const saved = JSON.parse(localStorage.getItem(ACTIVE_RUN_KEY) || 'null');
    return saved?.points?.length ? saved : null;
  } catch {
    return null;
  }
}

function clearActiveRun() {
  try { localStorage.removeItem(ACTIVE_RUN_KEY); } catch { /* nothing to clean up */ }
}

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

const modeInfoModal = document.getElementById('mode-info-modal');
document.getElementById('mode-info-btn').addEventListener('click', () => modeInfoModal.classList.remove('hidden'));
document.getElementById('mode-info-close').addEventListener('click', () => modeInfoModal.classList.add('hidden'));

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

// Rebuilds a run that was interrupted by the OS killing the backgrounded page.
// Gets a fresh GPS fix (time has passed, you may have moved) rather than trusting
// a possibly-stale last-known point, then hands off to the normal run-session setup.
async function resumeRun(saved) {
  showView('loading');
  setLoadingStatus('Resuming your run…', 'Getting your current location…');
  const loadStart = Date.now();

  let center, freshAltitude = null;
  try {
    const pos = await getCurrentPosition();
    center = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    freshAltitude = pos.coords.altitude;
  } catch {
    const last = saved.route[saved.route.length - 1];
    center = { lat: last.lat, lon: last.lon };
  }

  const elapsed = Date.now() - loadStart;
  if (elapsed < MIN_LOADING_MS) await new Promise((r) => setTimeout(r, MIN_LOADING_MS - elapsed));

  startRunSession(center, saved.settings, saved.points, false, saved.loopGeometry, saved.rerollContext, {
    route: saved.route,
    distanceM: saved.distanceM,
    elevationGainM: saved.elevationGainM,
    elevationLossM: saved.elevationLossM,
    startedAt: saved.startedAt,
    freshAltitude,
  });
}

// ---------- resume an interrupted run ----------
const resumeRunModal = document.getElementById('resume-run-modal');
const resumeRunMsg = document.getElementById('resume-run-msg');
let pendingResume = null;

function offerToResumeIfNeeded() {
  // If the app is currently gated behind login (Supabase configured, no valid
  // session — e.g. it expired while a run was active), don't let "resume" become
  // a backdoor around the login screen; they'll see this prompt once signed in.
  if (isAuthAvailable() && authMode !== 'signedIn') return;
  const saved = loadActiveRun();
  if (!saved) return;
  pendingResume = saved;
  const minsAgo = Math.max(0, Math.round((Date.now() - saved.startedAt) / 60000));
  const collectedCount = saved.points.filter((p) => p.collected).length;
  resumeRunMsg.textContent = `Started ${minsAgo} min ago · ${collectedCount}/${saved.points.length} points collected. Pick up where you left off?`;
  resumeRunModal.classList.remove('hidden');
}

document.getElementById('resume-run-discard').addEventListener('click', () => {
  clearActiveRun();
  pendingResume = null;
  resumeRunModal.classList.add('hidden');
});
document.getElementById('resume-run-confirm').addEventListener('click', () => {
  resumeRunModal.classList.add('hidden');
  if (!pendingResume) return;
  const saved = pendingResume;
  pendingResume = null;
  resumeRun(saved);
});

// Resume-run check runs only after auth resolves (see initAuth() at the bottom of
// this file) — otherwise a gated app could flash Settings, or offer to resume a
// run, before the login screen has had a chance to take over.

// ---------- run session ----------
let map, userMarker, userRadar, userAccuracyCircle, routeLine, loopRouteLine, pointMarkers = [], pointCircles = [];
let runController, geoWatcher, statsTimer, lastKnownLatLng = null, timeUpAnnounced = false;
let currentCenter = null, currentRerollContext = null;

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Sequential (Loop) runs have three point states, not two: collected (green),
// active — the one point you can actually reach right now (amber, pulsing),
// and locked — later in the sequence, not reachable yet (muted, static). Free
// (Scatter) runs only ever have collected/active, exactly like before.
function pointStateAt(idx) {
  const p = runController.points[idx];
  if (p.collected) return 'collected';
  if (!runController.sequential) return 'active';
  const nextIdx = runController.points.findIndex((pt) => !pt.collected);
  return idx === nextIdx ? 'active' : 'locked';
}

function pointIcon(p, state) {
  const cls = state === 'collected' ? 'collected' : state === 'locked' ? 'locked' : 'uncollected';
  return L.divIcon({
    className: '',
    html: `<div class="cp-dot ${cls}" style="width:22px;height:22px;display:flex;align-items:center;justify-content:center;color:#06170f;font-weight:700;font-size:11px;">${p.index}</div>`,
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

// Purely decorative radar sweep centered on the user — reinforces the
// "hunting for points" feel. Pointer-events disabled so it never blocks taps.
function radarIcon() {
  return L.divIcon({
    className: '',
    html: `<div class="cp-radar-sweep"></div>`,
    iconSize: [150, 150],
    iconAnchor: [75, 75],
  });
}

// Visual reminder of exactly how close a point needs to be to collect it —
// glows amber while it's the one you can actually reach, dims to a muted ring
// while locked (sequential runs only), settles to a dim green ring once collected.
function circleStyle(state) {
  if (state === 'collected') return { color: '#33c48d', weight: 2, fillColor: '#33c48d', fillOpacity: 0.06, opacity: 0.35 };
  if (state === 'locked') return { color: '#5c6975', weight: 1, fillColor: '#5c6975', fillOpacity: 0.03, opacity: 0.2 };
  return { color: '#e0a64b', weight: 3, fillColor: '#e0a64b', fillOpacity: 0.16, opacity: 0.85 };
}

// Plain HTML buttons (not Leaflet controls) sitting OUTSIDE the map's rotating
// element, so they stay upright and fixed in place regardless of compass rotation —
// a Leaflet control would rotate along with everything else inside the map.
document.getElementById('zoom-in-btn').addEventListener('click', () => map?.zoomIn());
document.getElementById('zoom-out-btn').addEventListener('click', () => map?.zoomOut());
document.getElementById('recenter-btn').addEventListener('click', () => {
  if (map && lastKnownLatLng) map.setView(lastKnownLatLng, Math.max(map.getZoom(), 16));
});

// ---------- map rotation (heading-lock compass mode + free manual rotate) ----------
// Leaflet has no native rotation support, and naively CSS-rotating its own root
// container would rotate the zoom/recenter controls with it and desync touch-drag
// math (Leaflet computes pan deltas assuming an unrotated container). Instead: #map
// is oversized (to the viewport's diagonal, so rotating it never reveals empty
// corners) and rotated on its own, while the controls live outside it entirely as
// plain siblings.
//
// Two independent ways to rotate, like a real map app:
//  - compassMode: continuously follows device heading, dragging disabled (a
//    "follow me" lock, same as before).
//  - manualRotationDeg: a plain two-finger twist gesture, free to rotate however
//    you like, dragging stays enabled. The compass button doubles as "reset to
//    north" whenever you've manually rotated away from it.
let compassMode = false;
let stopHeadingWatch = null;
let manualRotationDeg = 0;
let rotateGesture = null; // { startAngle, startRotation } while a 2-finger twist is active

function sizeMapForRotation(rotating) {
  const viewport = document.getElementById('map-viewport');
  const mapEl = document.getElementById('map');
  if (!rotating) {
    mapEl.style.width = '';
    mapEl.style.height = '';
    mapEl.style.left = '';
    mapEl.style.top = '';
  } else {
    const vw = viewport.clientWidth, vh = viewport.clientHeight;
    const diag = Math.ceil(Math.sqrt(vw * vw + vh * vh));
    mapEl.style.width = `${diag}px`;
    mapEl.style.height = `${diag}px`;
    mapEl.style.left = `${(vw - diag) / 2}px`;
    mapEl.style.top = `${(vh - diag) / 2}px`;
  }
  map?.invalidateSize();
}

// Single setter for the actual rotation, used by both compass-follow and manual
// twist — also spins the compass button's own icon to match, so it always shows
// "this is where north actually is" at a glance, the way real map apps do.
function setMapRotation(deg) {
  const rounded = Math.round(deg * 10) / 10;
  document.getElementById('map').style.transform = rounded ? `rotate(${rounded}deg)` : '';
  document.getElementById('compass-toggle-btn').style.transform = rounded ? `rotate(${rounded}deg)` : '';
}

function applyMapHeading(headingDeg) {
  setMapRotation(-headingDeg);
}

function resetMapRotation() {
  manualRotationDeg = 0;
  setMapRotation(0);
  if (!compassMode) sizeMapForRotation(false);
}

function touchAngleDeg(touches) {
  const dx = touches[1].clientX - touches[0].clientX;
  const dy = touches[1].clientY - touches[0].clientY;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

const mapViewportEl = document.getElementById('map-viewport');
// passive: true throughout — never call preventDefault, so Leaflet's own pinch-zoom
// and single-finger pan keep working exactly as before; this just additionally
// tracks the angle between the same two touches to rotate on top of that.
mapViewportEl.addEventListener('touchstart', (e) => {
  if (compassMode || e.touches.length !== 2) return;
  rotateGesture = { startAngle: touchAngleDeg(e.touches), startRotation: manualRotationDeg };
  sizeMapForRotation(true);
}, { passive: true });
mapViewportEl.addEventListener('touchmove', (e) => {
  if (!rotateGesture || e.touches.length !== 2) return;
  const delta = touchAngleDeg(e.touches) - rotateGesture.startAngle;
  manualRotationDeg = rotateGesture.startRotation + delta;
  setMapRotation(manualRotationDeg);
}, { passive: true });
mapViewportEl.addEventListener('touchend', (e) => {
  if (e.touches.length < 2) rotateGesture = null;
}, { passive: true });

async function enableCompassMode() {
  if (!isOrientationSupported()) {
    showToast('Compass rotation isn’t supported on this device');
    return;
  }
  const granted = await requestOrientationPermission();
  if (!granted) {
    showToast('Compass permission was denied');
    return;
  }
  compassMode = true;
  manualRotationDeg = 0;
  document.getElementById('compass-toggle-btn').classList.add('active');
  map.dragging.disable();
  map.doubleClickZoom.disable();
  sizeMapForRotation(true);
  if (lastKnownLatLng) map.setView(lastKnownLatLng, Math.max(map.getZoom(), 17), { animate: false });
  stopHeadingWatch = watchHeading(applyMapHeading);
}

function disableCompassMode() {
  compassMode = false;
  document.getElementById('compass-toggle-btn').classList.remove('active');
  stopHeadingWatch?.();
  stopHeadingWatch = null;
  if (map) {
    map.dragging.enable();
    map.doubleClickZoom.enable();
  }
  resetMapRotation();
}

document.getElementById('compass-toggle-btn').addEventListener('click', () => {
  if (!map) return;
  if (compassMode) disableCompassMode();
  else if (Math.abs(manualRotationDeg) > 0.5) resetMapRotation();
  else enableCompassMode();
});

// Tapping a point shows its name and, if it's still uncollected, a "Reroll this
// point" button — for when the generator drops one somewhere genuinely awkward.
// Locked (sequential, not-yet-reachable) points get a status line explaining why,
// but rerolling is still allowed — it doesn't affect turn order, just location.
function bindPointPopup(marker, point, state) {
  let statusHtml;
  if (state === 'collected') statusHtml = `<span class="cp-popup-status">Collected ✓</span>`;
  else if (state === 'locked') statusHtml = `<span class="cp-popup-status cp-popup-locked">Reach the earlier points first</span>`;
  else statusHtml = '';

  const rerollHtml = state === 'collected'
    ? ''
    : `<button type="button" class="cp-popup-reroll" data-id="${point.id}">Reroll this point</button>`;

  marker.unbindPopup();
  marker.bindPopup(`<div class="cp-popup"><strong>${escapeHtml(point.name)}</strong><br>${statusHtml}${rerollHtml}</div>`);
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

  const state = pointStateAt(idx); // location changed, but sequence position/state didn't
  map.closePopup();
  map.removeLayer(pointMarkers[idx]);
  map.removeLayer(pointCircles[idx]);
  pointMarkers[idx] = L.marker([newPoint.lat, newPoint.lon], { icon: pointIcon(newPoint, state) }).addTo(map);
  bindPointPopup(pointMarkers[idx], newPoint, state);
  pointCircles[idx] = L.circle([newPoint.lat, newPoint.lon], {
    radius: COLLECT_RADIUS_M, className: state === 'active' ? 'cp-radius-glow' : '', ...circleStyle(state),
  }).addTo(map);
  map.panTo([newPoint.lat, newPoint.lon], { animate: true }); // bring the new spot into view instead of leaving it off-screen

  showToast(`Point ${newPoint.index} re-rolled`);
  updateNextPointIndicator();
  saveActiveRun();
}

function startRunSession(center, settings, points, usedFallback, loopGeometry, rerollContext, resumeState) {
  showView('run');
  document.getElementById('stat-score-wrap').classList.toggle('hidden', settings.mode !== 'scoreAttack');
  document.getElementById('stat-countdown-wrap').classList.toggle('hidden', settings.mode !== 'scoreAttack');

  // On a resume, the RunController shouldn't push a fresh single-point route (that
  // would draw a straight line across however long the app was closed) — restore
  // the saved route/distance/start time instead, then append where we are now.
  runController = new RunController(settings, points, resumeState ? null : center, loopGeometry);
  if (resumeState) runController.resumeFrom(resumeState, center.lat, center.lon, resumeState.freshAltitude);
  currentCenter = center;
  currentRerollContext = rerollContext;
  lastKnownLatLng = [center.lat, center.lon];
  timeUpAnnounced = false;
  acquireWakeLock();

  if (usedFallback) {
    setTimeout(() => showToast('OpenStreetMap data unavailable — points placed randomly instead'), 400);
  }
  if (resumeState) {
    setTimeout(() => showToast('Run resumed — picking up where you left off'), 400);
  }

  if (map) { map.remove(); map = null; }
  userAccuracyCircle = null;
  // Compass mode doesn't carry over between runs — start each one flat/north-up,
  // and make sure #map has no leftover oversized/rotated inline styles from before.
  disableCompassMode();
  map = L.map('map', {
    zoomControl: false,
    attributionControl: false,
    tap: true,
    touchZoom: 'center',
  }).setView([center.lat, center.lon], 17);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

  loopRouteLine = null;
  if (loopGeometry?.length) {
    // A suggestion, not a mandate — dashed and muted so it doesn't compete with the live route.
    loopRouteLine = L.polyline(loopGeometry, {
      color: '#f59e0b', weight: 3, opacity: 0.5, dashArray: '6,10', interactive: false,
    }).addTo(map);
  }

  pointMarkers = points.map((p, idx) => {
    const marker = L.marker([p.lat, p.lon], { icon: pointIcon(p, pointStateAt(idx)) }).addTo(map);
    bindPointPopup(marker, p, pointStateAt(idx));
    return marker;
  });
  pointCircles = points.map((p, idx) => {
    const state = pointStateAt(idx);
    return L.circle([p.lat, p.lon], {
      radius: COLLECT_RADIUS_M,
      className: state === 'active' ? 'cp-radius-glow' : '',
      ...circleStyle(state),
    }).addTo(map);
  });
  const initialRoute = resumeState ? runController.route.map((r) => [r.lat, r.lon]) : [[center.lat, center.lon]];
  routeLine = L.polyline(initialRoute, { color: '#3b82f6', weight: 4, opacity: 0.85 }).addTo(map);
  userRadar = L.marker([center.lat, center.lon], { icon: radarIcon(), interactive: false, zIndexOffset: 900 }).addTo(map);
  userMarker = L.marker([center.lat, center.lon], { icon: userIcon(), zIndexOffset: 1000 }).addTo(map);

  geoWatcher = new GeoWatcher(onPositionUpdate, onPositionError);
  geoWatcher.start();

  statsTimer = setInterval(updateStatBar, 1000);
  updateStatBar();
  saveActiveRun();
}

function showToast(text) {
  const toast = document.getElementById('collect-toast');
  toast.textContent = text;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), 2200);
}

function onPositionUpdate(pos) {
  const { latitude: lat, longitude: lon, accuracy, altitude } = pos.coords;
  const collected = runController.tick(lat, lon, altitude);

  lastKnownLatLng = [lat, lon];
  userMarker.setLatLng([lat, lon]);
  userRadar.setLatLng([lat, lon]);
  routeLine.addLatLng([lat, lon]);
  if (compassMode) map.setView([lat, lon], map.getZoom(), { animate: false });

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
    pointMarkers[idx]?.setIcon(pointIcon(collected, 'collected'));
    if (pointMarkers[idx]) bindPointPopup(pointMarkers[idx], collected, 'collected'); // drop the reroll option once collected
    pointCircles[idx]?.setStyle(circleStyle('collected'));
    pointCircles[idx]?.getElement()?.classList.remove('cp-radius-glow');
    showToast(`Collected: ${collected.name} (+${collected.weight})`);
    feedbackCollect();

    // Sequential runs: whichever point just became next-in-line needs to switch
    // from locked to active — glowing ring, popup no longer says "reach earlier
    // points first".
    if (runController.sequential) {
      const nextIdx = runController.points.findIndex((p) => !p.collected);
      if (nextIdx !== -1) {
        const nextPoint = runController.points[nextIdx];
        pointMarkers[nextIdx]?.setIcon(pointIcon(nextPoint, 'active'));
        bindPointPopup(pointMarkers[nextIdx], nextPoint, 'active');
        pointCircles[nextIdx]?.setStyle(circleStyle('active'));
        pointCircles[nextIdx]?.getElement()?.classList.add('cp-radius-glow');
      }
    }
  }

  updateStatBar();
  saveActiveRun();
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
  let target;
  if (runController.sequential) {
    target = uncollected[0]; // must go here next, regardless of what's physically closer
  } else {
    target = uncollected[0];
    let nearestDist = haversine(lat, lon, target.lat, target.lon);
    for (const p of uncollected.slice(1)) {
      const d = haversine(lat, lon, p.lat, p.lon);
      if (d < nearestDist) { target = p; nearestDist = d; }
    }
  }

  const dist = haversine(lat, lon, target.lat, target.lon);
  const dir = compassDirection(bearing(lat, lon, target.lat, target.lon));
  const distText = dist >= 1000 ? `${(dist / 1000).toFixed(2)} km` : `${Math.round(dist)} m`;
  el.textContent = `→ Point ${target.index}: ${distText} ${dir}`;
  el.classList.remove('hidden');
}

const MODE_LABEL_FOR_SHARE = { explore: 'Free Explore', timeTrial: 'Time Trial', scoreAttack: 'Score Attack' };

async function shareRun(run) {
  const text =
    `Control Point — ${MODE_LABEL_FOR_SHARE[run.mode] || run.mode}\n` +
    `${(run.distanceM / 1000).toFixed(2)} km in ${fmtTime(run.totalMs)} · ${run.pointsCollected}/${run.pointsTotal} points` +
    (run.mode === 'scoreAttack' ? ` · score ${run.score}` : '') +
    (run.elevationGainM > 0 ? ` · ↗ ${run.elevationGainM} m` : '');
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
  clearActiveRun();
  const summary = runController.summary();
  const run = { id: `run_${summary.startedAt}`, ...summary };

  try {
    await saveRun(run);
  } catch (e) {
    console.warn('Failed to save run to history:', e);
  }
  if (currentUser) pushRun(run, currentUser.id); // fire-and-forget, local save already succeeded

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
  if (currentUser) deleteRemoteRun(pendingDeleteId, currentUser.id); // fire-and-forget, local delete already done
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

// ---------- account / cross-device sync (optional — no-op unless Supabase is configured) ----------
let currentUser = null;
let authMode = 'signedOut'; // 'signedOut' | 'recovery' | 'signedIn'

function showAccountError(msg) {
  const el = document.getElementById('account-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function readAccountFields() {
  return {
    email: document.getElementById('account-email')?.value.trim() || '',
    pin: document.getElementById('account-pin')?.value.trim() || '',
  };
}

// The whole app is gated behind sign-in, but ONLY when Supabase is actually
// configured — a fork/clone of this project with no Supabase project set up
// still works exactly as a local-only app, no dead-end login wall.
function applyAuthGate(gated) {
  const topnav = document.querySelector('.topnav');
  if (gated) {
    topnav.classList.add('hidden');
    showView('onboarding');
  } else {
    topnav.classList.remove('hidden');
    if (document.getElementById('view-onboarding').classList.contains('active')) {
      showView('settings');
    }
  }
}

function displayNameOf(user) {
  return user?.user_metadata?.display_name?.trim() || '';
}
function avatarInitialOf(user) {
  return escapeHtml((displayNameOf(user) || user?.email || '?').charAt(0).toUpperCase());
}

// Settings just shows a compact, tappable summary — full profile management
// (display name, PIN change) lives on its own page, reached by tapping this.
function renderSignedInBox(container) {
  const name = displayNameOf(currentUser);
  container.innerHTML = `
    <div class="account-box account-box-link" id="account-manage-link" role="button" tabindex="0">
      <div class="account-signedin">
        <div class="who">
          <div class="avatar">${avatarInitialOf(currentUser)}</div>
          <div>
            <h4>${name ? escapeHtml(name) : 'Synced'}</h4>
            <div class="email">${escapeHtml(currentUser.email)}</div>
          </div>
        </div>
        <span class="account-chevron" aria-hidden="true">&rsaquo;</span>
      </div>
    </div>
  `;
  document.getElementById('account-manage-link').addEventListener('click', () => {
    renderAccountPage();
    showView('account');
  });
}

function renderAccountPage() {
  if (!currentUser) return;
  const name = displayNameOf(currentUser);
  document.getElementById('account-page-avatar').textContent = avatarInitialOf(currentUser);
  document.getElementById('account-page-name').textContent = name || 'Your account';
  document.getElementById('account-page-email').textContent = currentUser.email;
  document.getElementById('account-display-name').value = name;
  document.getElementById('account-change-pin').value = '';
  document.getElementById('account-name-error').classList.add('hidden');
  document.getElementById('account-pin-error').classList.add('hidden');
}

async function handleSaveDisplayName() {
  const name = document.getElementById('account-display-name').value.trim();
  const errEl = document.getElementById('account-name-error');
  errEl.classList.add('hidden');
  const { user, error } = await updateDisplayName(name);
  if (error) {
    errEl.textContent = error.message;
    errEl.classList.remove('hidden');
    return;
  }
  currentUser = user;
  document.getElementById('account-page-name').textContent = name || 'Your account';
  document.getElementById('account-page-avatar').textContent = avatarInitialOf(currentUser);
  renderSignedInBox(document.getElementById('account-section'));
  showToast('Display name saved');
}

async function handleChangePinFromAccount() {
  const pin = document.getElementById('account-change-pin').value.trim();
  const errEl = document.getElementById('account-pin-error');
  errEl.classList.add('hidden');
  if (!/^\d{6}$/.test(pin)) {
    errEl.textContent = 'Enter a 6-digit PIN.';
    errEl.classList.remove('hidden');
    return;
  }
  const { error } = await updatePin(pin);
  if (error) {
    errEl.textContent = error.message;
    errEl.classList.remove('hidden');
    return;
  }
  document.getElementById('account-change-pin').value = '';
  showToast('PIN updated');
}

document.getElementById('account-page-back').addEventListener('click', () => showView('settings'));
document.getElementById('account-save-name-btn').addEventListener('click', handleSaveDisplayName);
document.getElementById('account-save-pin-btn').addEventListener('click', handleChangePinFromAccount);
document.getElementById('account-page-signout-btn').addEventListener('click', handleSignOut);

function renderRecoveryForm(container) {
  container.innerHTML = `
    <div class="account-box">
      <h4>Set a new PIN</h4>
      <p class="hint">You followed a reset link — enter a new 6-digit PIN for your account.</p>
      <div class="account-field">
        <label for="account-new-pin">New PIN</label>
        <input type="password" id="account-new-pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="new-password">
      </div>
      <button id="account-set-pin-btn" class="primary-btn">Set PIN</button>
      <div class="account-error hidden" id="account-error"></div>
    </div>
  `;
  document.getElementById('account-set-pin-btn').addEventListener('click', handleSetNewPin);
}

function renderSignInForm(container) {
  container.innerHTML = `
    <div class="account-box">
      <div class="account-field">
        <label for="account-email">Email</label>
        <input type="email" id="account-email" autocomplete="email" placeholder="you@example.com">
      </div>
      <div class="account-field">
        <label for="account-pin">6-digit PIN</label>
        <input type="password" id="account-pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="current-password" placeholder="••••••">
      </div>
      <div class="account-row">
        <button id="account-signin-btn" class="primary-btn">Sign In</button>
        <button id="account-signup-btn" class="secondary-btn">Create Account</button>
      </div>
      <button id="account-forgot-btn" class="account-link" type="button">Forgot PIN?</button>
      <div class="account-error hidden" id="account-error"></div>
    </div>
  `;
  document.getElementById('account-signin-btn').addEventListener('click', handleSignIn);
  document.getElementById('account-signup-btn').addEventListener('click', handleSignUp);
  document.getElementById('account-forgot-btn').addEventListener('click', handleForgotPin);
}

function renderAccountSection() {
  if (!isAuthAvailable()) {
    document.getElementById('account-settings-section').classList.add('hidden');
    return;
  }
  document.getElementById('account-settings-section').classList.remove('hidden');

  if (authMode === 'signedIn' && currentUser) {
    renderSignedInBox(document.getElementById('account-section'));
    applyAuthGate(false);
    return;
  }

  // Not signed in (or mid password-reset) — the app is gated behind the
  // onboarding/login screen, so that's where the form belongs, not Settings.
  const target = document.getElementById('onboarding-account');
  if (authMode === 'recovery') {
    renderRecoveryForm(target);
  } else {
    renderSignInForm(target);
  }
  applyAuthGate(true);
}

async function onSignedIn(user) {
  currentUser = user;
  authMode = 'signedIn';
  renderAccountSection();
  offerToResumeIfNeeded(); // in case a run was interrupted while the session had expired
  showToast('Syncing your run history…');
  const { pulled, error } = await pullAndMergeRuns(user.id);
  if (error) {
    showToast('Sync failed — your local history is safe, will retry next time');
    return;
  }
  loadHistory();
  showToast(pulled ? `Synced ${pulled} run${pulled === 1 ? '' : 's'} from your account` : 'Synced — up to date');
}

async function handleSignIn() {
  const { email, pin } = readAccountFields();
  if (!email || !/^\d{6}$/.test(pin)) {
    showAccountError('Enter your email and 6-digit PIN.');
    return;
  }
  const { user, error } = await signIn(email, pin);
  if (error) {
    showAccountError(error.message);
    return;
  }
  await onSignedIn(user);
}

async function handleSignUp() {
  const { email, pin } = readAccountFields();
  if (!email || !/^\d{6}$/.test(pin)) {
    showAccountError('Enter your email and a 6-digit PIN.');
    return;
  }
  const { user, session, error } = await signUp(email, pin);
  if (error) {
    showAccountError(error.message);
    return;
  }
  if (!session) {
    // A user record was created, but Supabase's "Confirm email" setting is on —
    // no session exists until they click the link, so there's nothing to sync yet.
    showToast('Check your email to confirm your account, then sign in');
    return;
  }
  await onSignedIn(user);
  await pushAllLocalRuns(user.id); // carry over history recorded before this account existed
  loadHistory();
}

async function handleForgotPin() {
  const { email } = readAccountFields();
  if (!email) {
    showAccountError('Enter your email above first, then tap "Forgot PIN?".');
    return;
  }
  const { error } = await sendPasswordReset(email);
  if (error) {
    showAccountError(error.message);
    return;
  }
  showToast('Check your email for a reset link');
}

async function handleSetNewPin() {
  const pin = document.getElementById('account-new-pin')?.value.trim() || '';
  if (!/^\d{6}$/.test(pin)) {
    showAccountError('Enter a 6-digit PIN.');
    return;
  }
  const { error } = await updatePin(pin);
  if (error) {
    showAccountError(error.message);
    return;
  }
  showToast('PIN updated');
  const session = await getSession();
  if (session?.user) await onSignedIn(session.user);
}

async function handleSignOut() {
  await signOut();
  currentUser = null;
  authMode = 'signedOut';
  renderAccountSection();
}

async function initAuth() {
  if (!isAuthAvailable()) return;
  onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') {
      authMode = 'recovery';
      renderAccountSection();
    } else if (event === 'SIGNED_OUT') {
      currentUser = null;
      authMode = 'signedOut';
      renderAccountSection();
    }
  });
  const session = await getSession();
  if (session?.user) {
    currentUser = session.user;
    authMode = 'signedIn';
  }
  renderAccountSection();
}
initAuth().then(() => {
  document.getElementById('app-boot')?.classList.add('hidden');
  offerToResumeIfNeeded();
});
