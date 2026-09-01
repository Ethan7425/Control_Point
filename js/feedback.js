// Non-visual feedback for a hands-free run: vibration where supported, plus a
// synthesized tone everywhere (iOS PWAs have no Vibration API at all, so sound
// is the only reliable cue there).

let audioCtx = null;

// Must be called from within a user-gesture handler (e.g. the start-run tap) —
// browsers block AudioContext creation/resume outside of one.
export function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {
    // Web Audio unavailable; tone() calls below will just no-op.
  }
}

function vibrate(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Vibration API unsupported (all of iOS Safari) — ignore.
  }
}

function tone(freq, durationMs, delayMs = 0) {
  if (!audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const start = audioCtx.currentTime + delayMs / 1000;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.22, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + durationMs / 1000);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(start);
    osc.stop(start + durationMs / 1000 + 0.03);
  } catch {
    // Ignore — feedback is a nice-to-have, never worth crashing a run over.
  }
}

export function feedbackCollect() {
  vibrate([70, 40, 70]);
  tone(880, 110);
  tone(1320, 130, 120);
}

export function feedbackTimeUp() {
  vibrate([200, 100, 200, 100, 200]);
  tone(440, 220);
  tone(330, 260, 240);
}
