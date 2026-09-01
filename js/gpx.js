// GPX export — lets a run be pulled into Strava, Garmin Connect, etc. Pure
// client-side: builds the XML and triggers a blob download, no backend needed.

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildGPX(run) {
  const trkpts = run.route
    .map((r) => `      <trkpt lat="${r.lat}" lon="${r.lon}"><time>${new Date(r.t).toISOString()}</time></trkpt>`)
    .join('\n');

  const wpts = run.points
    .map(
      (p) =>
        `  <wpt lat="${p.lat}" lon="${p.lon}"><name>${esc(p.name)}</name><desc>${p.collected ? 'Collected' : 'Missed'}</desc></wpt>`
    )
    .join('\n');

  const startedIso = new Date(run.startedAt).toISOString();

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Control Point" xmlns="http://www.topografix.com/GPX/1/1">
${wpts}
  <trk>
    <name>Control Point run ${esc(startedIso)}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

export function downloadGPX(run) {
  const xml = buildGPX(run);
  const blob = new Blob([xml], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date(run.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `control-point-${stamp}.gpx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
