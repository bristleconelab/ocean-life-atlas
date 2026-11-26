// The globe: NASA Blue Marble imagery with borders and place names on top, plus overlays: records density, the
// clicked square, a species range, its MiCO migration network and satellite-tag tracks.
import * as maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, GeoJSONSource, LayerSpecification, MapMouseEvent, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { bboxRing, cellAreaKm2, frameOf, geohashBounds, type BBox } from './geo';
import { h, fmt, plural } from './dom';
import { L, count } from './i18n';

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg';
/** OpenStreetMap vector tiles (OpenMapTiles schema) for borders and names only; the imagery stays NASA's. */
const OMT = 'https://tiles.openfreemap.org/planet';
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
/** Sentinel-2 cloudless 2016 by EOX (CC BY 4.0; later years are non-commercial), for close-up views where the
 *  Blue Marble (zoom 8, ~600 m a pixel) turns to mush. */
const S2 = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg';
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
/** "Last surveyed" classes: newest records within 10, 10-20, 20-50 years, or older/undated only. */
export const AGE_COLORS = ['#5fc0b0', '#f2c94c', '#e07a5f', '#8e4fa0'];
/** Range squares by period (then and now) or by species (side by side). */
export const RANGE_COLORS = { then: '#b39ddb', now: '#f2c94c', both: '#f4f8f7', a: '#f2c94c', b: '#8ecbff' };
const LOOKED_RECORDS: ExpressionSpecification = ['interpolate', ['linear'], ['log10', ['max', 1, ['get', 'd']]],
  0, COLORS_LOOKED()[0], 1.5, COLORS_LOOKED()[1], 3, COLORS_LOOKED()[2], 4.5, COLORS_LOOKED()[3], 6, COLORS_LOOKED()[4]];
const LOOKED_AGE: ExpressionSpecification = ['match', ['get', 'a'], 0, AGE_COLORS[0], 1, AGE_COLORS[1], 2, AGE_COLORS[2], AGE_COLORS[3]];
function COLORS_LOOKED() { return ['#2a1d5c', '#2f6f99', '#5fc0b0', '#c8ef9c', '#fff7c2']; }

export const COLORS = { abyss: '#0b2233', plankton: '#f2c94c', foam: '#f4f8f7', looked: COLORS_LOOKED() };
/** One colour per tagged animal, cycled; all readable on dark water. The range squares are dimmed while tracks show. */
export const TRACK_COLORS = ['#7fe3c8', '#ff9e7a', '#8ecbff', '#ffd166', '#c39bff', '#ff7aa2', '#b8f27c', '#ffffff'];
/** MiCO site colours by what the animals do there. */
export const ACTIVITY_COLORS = { breeding: '#ff7aa2', feeding: '#7fe3c8', migrating: '#8ecbff', season: '#c39bff', observed: '#f4f8f7' };
export type ActivityKind = keyof typeof ACTIVITY_COLORS;
/** Records per 10,000 km²: geohash squares shrink towards the poles, so raw counts would make polar seas look empty. */
export const DENSITY_AREA_KM2 = 10000;

const name = (lang: string): ExpressionSpecification => ['coalesce', ['get', `name:${lang}`], ['get', 'name:en'], ['get', 'name']];

function labelLayers(lang: string): LayerSpecification[] {
  const halo = { 'text-halo-color': 'rgba(11,34,51,0.85)', 'text-halo-width': 1.2, 'text-halo-blur': 0.4 };
  return [
    {
      id: 'borders', type: 'line', source: 'omt', 'source-layer': 'boundary',
      filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1], ['!=', ['get', 'disputed'], 1]],
      paint: { 'line-color': '#f4f8f7', 'line-opacity': ['interpolate', ['linear'], ['zoom'], 1, 0.22, 5, 0.4], 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 6, 1] },
    },
    {
      id: 'water-names', type: 'symbol', source: 'omt', 'source-layer': 'water_name',
      filter: ['in', ['get', 'class'], ['literal', ['ocean', 'sea', 'bay', 'lake', 'strait']]],
      layout: {
        'text-field': name(lang), 'text-font': ['Noto Sans Italic'], 'text-letter-spacing': 0.08, 'text-max-width': 8,
        'text-size': ['match', ['get', 'class'], 'ocean', 14, 'sea', 12, 11],
      },
      paint: { 'text-color': '#bfe3ee', ...halo },
    },
    {
      id: 'place-names', type: 'symbol', source: 'omt', 'source-layer': 'place',
      // no continent points: OSM has "Eurasia" and "Afro-Eurasia" ones that only add noise to a globe
      filter: ['any',
        ['all', ['==', ['get', 'class'], 'country'], ['>=', ['zoom'], 2.2]],
        ['all', ['in', ['get', 'class'], ['literal', ['island', 'archipelago']]], ['>=', ['zoom'], 4]],
        ['all', ['==', ['get', 'class'], 'city'], ['<=', ['coalesce', ['get', 'rank'], 99], 4], ['>=', ['zoom'], 4.5]]],
      layout: {
        'text-field': name(lang), 'text-font': ['Noto Sans Regular'], 'text-max-width': 7,
        'text-size': ['match', ['get', 'class'], 'country', 11.5, 11],
      },
      paint: { 'text-color': '#f4f8f7', 'text-opacity': 0.82, ...halo },
    },
  ];
}

function style(lang: string): StyleSpecification {
  return {
    version: 8,
    projection: { type: 'globe' },
    glyphs: GLYPHS,
    sky: {
      'sky-color': COLORS.abyss,
      'horizon-color': '#2b6274',
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.9, 5, 0.6, 7, 0],
    },
    sources: {
      earth: {
        type: 'raster', tiles: [GIBS], tileSize: 256, maxzoom: 8,
        attribution: 'Imagery: NASA Blue Marble via <a href="https://earthdata.nasa.gov/gibs">GIBS</a>',
      },
      s2: {
        type: 'raster', tiles: [S2], tileSize: 256, minzoom: 6, maxzoom: 14,
        attribution: '<a href="https://s2maps.eu">Sentinel-2 cloudless 2016</a> by EOX, CC BY 4.0 (contains modified Copernicus Sentinel data 2016)',
      },
      omt: { type: 'vector', url: OMT, attribution: '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
      looked: { type: 'geojson', data: EMPTY },
      range: { type: 'geojson', data: EMPTY },
      square: { type: 'geojson', data: EMPTY },
      micoRoutes: { type: 'geojson', data: EMPTY },
      micoSites: { type: 'geojson', data: EMPTY },
      tracks: { type: 'geojson', data: EMPTY },
      heads: { type: 'geojson', data: EMPTY },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': COLORS.abyss } },
      { id: 'earth', type: 'raster', source: 'earth', paint: { 'raster-saturation': -0.15, 'raster-contrast': 0.05 } },
      { id: 's2', type: 'raster', source: 's2', minzoom: 6, paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0, 7.5, 1], 'raster-saturation': -0.1 } },
      {
        id: 'looked', type: 'fill', source: 'looked', layout: { visibility: 'none' },
        paint: {
          'fill-color': LOOKED_RECORDS,
          'fill-opacity': 0.82,
          'fill-antialias': false,
        },
      },
      {
        id: 'range', type: 'fill', source: 'range',
        paint: {
          'fill-color': ['match', ['coalesce', ['get', 'k'], ''], 'then', RANGE_COLORS.then, 'now', RANGE_COLORS.now, 'both', RANGE_COLORS.both,
            'a', RANGE_COLORS.a, 'b', RANGE_COLORS.b, COLORS.plankton],
          'fill-opacity': ['interpolate', ['linear'], ['log10', ['max', 1, ['get', 'n']]], 0, 0.45, 3, 0.85],
        },
      },
      { id: 'range-edge', type: 'line', source: 'range', paint: { 'line-color': '#7a5d00', 'line-width': 0.4, 'line-opacity': 0.6 } },
      ...labelLayers(lang),
      {
        id: 'mico-routes', type: 'line', source: 'micoRoutes', layout: { 'line-cap': 'round' }, filter: ['==', ['get', 'tracked'], 1],
        paint: { 'line-color': '#ffb3c7', 'line-width': 1.6, 'line-opacity': 0.7 },
      },
      {
        id: 'mico-links', type: 'line', source: 'micoRoutes', filter: ['==', ['get', 'tracked'], 0],
        paint: { 'line-color': '#ffb3c7', 'line-width': 1.3, 'line-opacity': 0.6, 'line-dasharray': [2, 2] },
      },
      {
        id: 'mico-sites', type: 'circle', source: 'micoSites',
        paint: {
          'circle-color': ['match', ['get', 'kind'], 'breeding', ACTIVITY_COLORS.breeding, 'feeding', ACTIVITY_COLORS.feeding,
            'migrating', ACTIVITY_COLORS.migrating, 'season', ACTIVITY_COLORS.season, ACTIVITY_COLORS.observed],
          'circle-radius': ['interpolate', ['linear'], ['sqrt', ['max', 1, ['get', 'n']]], 1, 3.5, 30, 10],
          'circle-stroke-color': COLORS.abyss, 'circle-stroke-width': 1.2, 'circle-opacity': 0.92,
        },
      },
      {
        id: 'tracks', type: 'line', source: 'tracks', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['to-color', ['at', ['%', ['get', 'c'], TRACK_COLORS.length], ['literal', TRACK_COLORS]]], 'line-width': 1.8, 'line-opacity': 0.9 },
      },
      {
        id: 'heads', type: 'circle', source: 'heads',
        paint: {
          'circle-color': ['to-color', ['at', ['%', ['get', 'c'], TRACK_COLORS.length], ['literal', TRACK_COLORS]]],
          'circle-radius': 4.5, 'circle-stroke-color': COLORS.abyss, 'circle-stroke-width': 1.5,
        },
      },
      { id: 'square', type: 'line', source: 'square', paint: { 'line-color': COLORS.foam, 'line-width': 2.5 } },
    ],
  };
}

maplibregl.setWorkerUrl(workerUrl);

/** Layers a click asks about before it falls through to "life here". */
const PICKABLE = ['heads', 'tracks', 'mico-sites', 'mico-routes', 'mico-links'];

function popupContent(layer: string, p: Record<string, unknown>): HTMLElement | null {
  const s = (k: string) => (p[k] == null ? '' : String(p[k]));
  if (layer === 'heads' || layer === 'tracks') {
    return h('div', { class: 'pop' }, h('strong', { text: s('name') }), h('span', { text: `${s('species')}, ${fmt(Number(p.km) || 0)} km, ${s('years')}` }));
  }
  if (layer === 'mico-sites') {
    const n = Number(p.n) || 0;
    return h('div', { class: 'pop' }, h('strong', { text: s('act').replace(/;/g, ', ') || L('Seen here', 'Shu yerda koʻrilgan') }),
      h('span', { text: `${s('species')}${n ? L(`, ${plural(n, 'animal')} in the studies behind this place`, `, bu joy ortidagi tadqiqotlarda ${fmt(n)} ta hayvon`) : ''}` }));
  }
  if (layer === 'mico-routes' || layer === 'mico-links') {
    return h('div', { class: 'pop' }, h('strong', { text: Number(p.tracked) ? L('Followed by tagged animals', 'Belgilangan hayvonlar bosib oʻtgan') : L('Linked by other studies', 'Boshqa tadqiqotlar bogʻlagan') }),
      h('span', { text: `${s('species')}${Number(p.both) ? L(', both ways', ', ikki tomonga') : ''}. ${L('The line joins the two places, not the path taken.', 'Chiziq yoʻlni emas, ikki joyni bogʻlaydi.')}` }));
  }
  return null;
}

export class Globe {
  map: maplibregl.Map;
  private ready: Promise<void>;
  private lookedLoaded = false;
  private popup = new maplibregl.Popup({ closeButton: true, maxWidth: '260px', className: 'atlas-pop' });
  private hoverPop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: '240px', className: 'atlas-pop hover' });

  constructor(container: HTMLElement, private dataBase: string, lang = 'en') {
    this.map = new maplibregl.Map({
      container, style: style(lang), center: [60, 8], zoom: 2.1, minZoom: 0.8, maxZoom: 12,
      attributionControl: { compact: true }, renderWorldCopies: false,
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    this.ready = new Promise((res) => this.map.once('load', () => res()));
    this.map.on('mousemove', (e) => this.hover(e));
    this.map.on('mouseout', () => this.hoverPop.remove());
  }

  /** A click on a journey (a track, a tagged animal, a MiCO place or link) opens a note about it; anywhere else
   *  calls fn, which opens "life here". */
  onClick(fn: (lon: number, lat: number) => void) {
    this.map.on('click', (e: MapMouseEvent) => {
      const f = this.pick(e);
      if (f) {
        const el = popupContent(f.layer.id, f.properties ?? {});
        if (el) { this.popup.setLngLat(e.lngLat).setDOMContent(el).addTo(this.map); return; }
      }
      fn(e.lngLat.lng, e.lngLat.lat);
    });
  }

  private pick(e: MapMouseEvent) {
    const layers = PICKABLE.filter((id) => this.map.getLayer(id));
    const r = 6;
    const hits = this.map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers });
    return hits[0] ?? null;
  }

  private hover(e: MapMouseEvent) {
    const f = this.pick(e);
    this.map.getCanvas().style.cursor = f ? 'pointer' : '';
    if (!f && this.map.getLayoutProperty('looked', 'visibility') === 'visible') {
      const cell = this.map.queryRenderedFeatures(e.point, { layers: ['looked'] })[0];
      if (cell) {
        const n = Number(cell.properties?.n) || 0, d = Number(cell.properties?.d) || 0, a = Number(cell.properties?.a);
        const when = (L('in the last 10 years|10 to 20 years ago|20 to 50 years ago|more than 50 years ago, or undated', 'oxirgi 10 yil ichida|10–20 yil oldin|20–50 yil oldin|50 yildan oldin yoki sanasiz').split('|'))[a] ?? '';
        this.hoverPop.setLngLat(e.lngLat).setDOMContent(h('div', { class: 'pop' },
          h('strong', { text: count(n, 'record', 'records', 'yozuv') }),
          h('span', { text: this.lookedMode === 'age' ? L(`Latest record ${when}. Click to see the species.`, `Eng soʻnggi yozuv ${when}. Turlarni koʻrish uchun bosing.`) : L(`${fmt(Math.round(d))} per 10,000 km². Click to see the species.`, `10 000 km² ga ${fmt(Math.round(d))} ta. Turlarni koʻrish uchun bosing.`) }))).addTo(this.map);
        return;
      }
    }
    this.hoverPop.remove();
  }

  async showSquare(b: BBox | null) {
    await this.ready;
    const data: GeoJSON.FeatureCollection = b
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: bboxRing(b) } }] }
      : EMPTY;
    (this.map.getSource('square') as GeoJSONSource).setData(data);
  }

  async showRange(fc: GeoJSON.FeatureCollection | null) {
    await this.ready;
    (this.map.getSource('range') as GeoJSONSource).setData(fc ?? EMPTY);
  }

  /** Set one of the journey overlays (micoRoutes, micoSites, tracks, heads); null clears it. */
  async setOverlay(source: 'micoRoutes' | 'micoSites' | 'tracks' | 'heads', fc: GeoJSON.FeatureCollection | null) {
    await this.ready;
    (this.map.getSource(source) as GeoJSONSource).setData(fc ?? EMPTY);
    if (!fc) this.popup.remove();
  }

  /** Fade the yellow range squares so journeys drawn on top stay readable. */
  async dimRange(dim: boolean) {
    await this.ready;
    this.map.setPaintProperty('range', 'fill-opacity', dim ? 0.22
      : ['interpolate', ['linear'], ['log10', ['max', 1, ['get', 'n']]], 0, 0.45, 3, 0.85]);
  }

  /** Frame a set of points. Wide sets (an ocean basin or more) get a centred globe view: fitBounds on a globe would
   *  zoom into the middle of the box instead. Loops, not Math.min(...xs): tracks can hold 40,000 points. */
  async fitTo(points: [number, number][]) {
    await this.ready;
    const b = frameOf(points);
    if (!b) return;
    if (b.wide) { this.flyTo(b.lon, b.lat, 1.7); return; }
    this.map.fitBounds([[b.west, b.south], [b.east, b.north]], { padding: 60, maxZoom: 5, duration: 1400 });
  }

  /** Records per 1.4° square (land records left out), loaded the first time the layer is switched on. */
  async setLooked(on: boolean): Promise<{ total: number; fetched: string; cells: number } | null> {
    await this.ready;
    let meta: { total: number; fetched: string; cells: number } | null = null;
    if (on && !this.lookedLoaded) {
      const r = await fetch(`${this.dataBase}data/records-gh3.json`);
      if (!r.ok) throw new Error(`records layer: HTTP ${r.status}`);
      const d = (await r.json()) as { gh: string; n: number[]; total: number; fetched: string; age?: string };
      const features: GeoJSON.Feature[] = [];
      for (let i = 0; i < d.n.length; i++) {
        const b = geohashBounds(d.gh.slice(i * 3, i * 3 + 3));
        features.push({ type: 'Feature', properties: { n: d.n[i], d: (d.n[i] / cellAreaKm2(b)) * DENSITY_AREA_KM2, a: d.age ? Number(d.age[i]) : 3 }, geometry: { type: 'Polygon', coordinates: [bboxRing(b)] } });
      }
      (this.map.getSource('looked') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
      this.lookedLoaded = true;
      meta = { total: d.total, fetched: d.fetched, cells: d.n.length };
    }
    this.map.setLayoutProperty('looked', 'visibility', on ? 'visible' : 'none');
    if (!on) this.hoverPop.remove();
    return meta;
  }

  /** Colour the "looked" squares by how many records (density) or by how long ago the last one was made. */
  async setLookedMode(mode: 'records' | 'age') {
    await this.ready;
    this.lookedMode = mode;
    this.map.setPaintProperty('looked', 'fill-color', mode === 'age' ? LOOKED_AGE : LOOKED_RECORDS);
  }
  private lookedMode: 'records' | 'age' = 'records';

  async flyTo(lon: number, lat: number, zoom?: number) {
    await this.ready;
    this.map.flyTo({ center: [lon, lat], zoom: zoom ?? Math.max(this.map.getZoom(), 3), duration: 1400, essential: false });
  }

  async fitBox(b: [number, number, number, number]) {
    await this.ready;
    const [w, s, e, n] = b;
    if (e - w > 100 || n - s > 70) { this.flyTo((w + e) / 2, (s + n) / 2, 1.8); return; }
    this.map.fitBounds([[w, s], [e, n]], { padding: 60, maxZoom: 6, duration: 1400 });
  }

  /** Keep the clicked square visible beside the panel (panel on the right on wide screens, at the bottom on phones). */
  setPadding(p: { right?: number; bottom?: number }) {
    this.map.setPadding({ top: 0, left: 0, right: p.right ?? 0, bottom: p.bottom ?? 0 });
  }
}
