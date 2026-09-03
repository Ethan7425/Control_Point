// Device compass heading (0° = north), best-effort across browsers. Used to rotate
// the map so "up" matches the direction you're actually facing.

export function isOrientationSupported() {
  return typeof DeviceOrientationEvent !== 'undefined';
}

// iOS 13+ requires an explicit permission prompt, and it must be triggered from
// within a user-gesture handler (a button tap) — calling this outside one silently
// fails. Other browsers need no such prompt, so this resolves true immediately there.
export async function requestOrientationPermission() {
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      return (await DeviceOrientationEvent.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }
  return true;
}

// Starts listening for compass heading; calls onHeading(degrees, 0-360, 0=north)
// on each update. Returns a stop() function.
export function watchHeading(onHeading) {
  const handler = (e) => {
    let heading = null;
    if (typeof e.webkitCompassHeading === 'number') {
      heading = e.webkitCompassHeading; // iOS Safari: already a compass heading, no inversion needed
    } else if (typeof e.alpha === 'number') {
      heading = 360 - e.alpha; // alpha increases counter-clockwise from north; flip to a clockwise compass heading
    }
    if (heading != null && !Number.isNaN(heading)) onHeading((heading + 360) % 360);
  };
  const eventName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
  window.addEventListener(eventName, handler);
  return () => window.removeEventListener(eventName, handler);
}
