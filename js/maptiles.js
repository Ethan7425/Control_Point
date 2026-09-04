// Switchable base-map styles — all free, no-API-key raster tile providers so this
// stays a static/no-build PWA. Three deliberately different jobs:
//  - standard: the default OSM carto style, familiar and balanced.
//  - dark: CartoDB Dark Matter — low-glare basemap for night runs.
//  - outdoor: OpenTopoMap — strong color/weight differentiation between big roads,
//    tracks, and footpaths (plus contours), so the walkable network actually reads
//    at a glance instead of everything being the same gray line.
export const MAP_STYLES = {
  standard: {
    key: 'standard',
    label: 'Standard',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c'],
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  },
  dark: {
    key: 'dark',
    label: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c', 'd'],
    maxZoom: 20,
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  },
  outdoor: {
    key: 'outdoor',
    label: 'Outdoor',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c'],
    maxZoom: 17,
    attribution: '&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap (CC-BY-SA)',
  },
};

export const MAP_STYLE_ORDER = ['standard', 'dark', 'outdoor'];

const STORAGE_KEY = 'cp_map_style';

export function getMapStyleKey() {
  const saved = localStorage.getItem(STORAGE_KEY);
  return MAP_STYLES[saved] ? saved : 'standard';
}

export function setMapStyleKey(key) {
  localStorage.setItem(STORAGE_KEY, MAP_STYLES[key] ? key : 'standard');
}

export function cycleMapStyleKey(key) {
  const i = MAP_STYLE_ORDER.indexOf(key);
  return MAP_STYLE_ORDER[(i + 1) % MAP_STYLE_ORDER.length];
}

// Leaflet picks a `{s}` subdomain the same way for any provider: an index derived
// from the tile's x+y, so requests spread evenly across the provider's subdomains
// instead of hammering just one. Tile prefetching (tilecache.js) has to compute
// the exact same URL Leaflet will request at runtime, or a cached tile just misses.
export function subdomainFor(subdomains, x, y) {
  return subdomains[Math.abs(x + y) % subdomains.length];
}

export function buildTileUrl(styleKey, z, x, y) {
  const style = MAP_STYLES[styleKey] || MAP_STYLES.standard;
  const s = subdomainFor(style.subdomains, x, y);
  return style.url.replace('{s}', s).replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

export function addTileLayer(map, styleKey) {
  const style = MAP_STYLES[styleKey] || MAP_STYLES.standard;
  return L.tileLayer(style.url, {
    maxZoom: style.maxZoom,
    subdomains: style.subdomains,
    attribution: style.attribution,
  }).addTo(map);
}
