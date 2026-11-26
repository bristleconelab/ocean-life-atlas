// Build public/data/records-gh3.json: how many OBIS records fall in each geohash-3 cell (1.40625 deg square).
// This is the "where scientists have looked" layer. The live API takes ~9 s and 5 MB for the whole globe,
// so it is fetched once here and stored compactly: parallel arrays of cell ids and counts.
// exclude=ON_LAND drops records OBIS flags as lying on land (museum specimens with a city's coordinates, river and
// lake records, inland bird counts): without it Moscow, central Germany and Kansas look like the best-studied "sea".
//
// usage: node scripts/fetch_records.mjs
import { writeFileSync, mkdirSync } from 'node:fs';

const URL = 'https://api.obis.org/v3/occurrence/grid/3?exclude=ON_LAND';
const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function geohash(lon, lat, precision) {
  const lo = [-180, 180], la = [-90, 90];
  let even = true, bit = 0, ch = 0, out = '';
  while (out.length < precision) {
    const r = even ? lo : la, v = even ? lon : lat, mid = (r[0] + r[1]) / 2;
    if (v >= mid) { ch = (ch << 1) | 1; r[0] = mid; } else { ch <<= 1; r[1] = mid; }
    even = !even;
    if (++bit === 5) { out += B32[ch]; bit = 0; ch = 0; }
  }
  return out;
}

const res = await fetch(URL, { headers: { 'User-Agent': 'ocean-life-atlas data build' } });
if (!res.ok) throw new Error(`OBIS grid: HTTP ${res.status}`);
const fc = await res.json();

const cells = new Map();
for (const f of fc.features) {
  const ring = f.geometry.coordinates[0];
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const id = geohash(cx, cy, 3);
  cells.set(id, (cells.get(id) ?? 0) + f.properties.n);
}

const ids = [...cells.keys()].sort();
const out = {
  source: 'OBIS (2026) Ocean Biodiversity Information System, https://obis.org, API v3 occurrence/grid/3?exclude=ON_LAND',
  filter: 'exclude=ON_LAND',
  fetched: new Date().toISOString().slice(0, 10),
  cellDeg: 1.40625,
  total: ids.reduce((s, id) => s + cells.get(id), 0),
  gh: ids.join(''),
  n: ids.map((id) => cells.get(id)),
};
if (ids.length < 18000) throw new Error(`only ${ids.length} cells, expected about 21,700`);
mkdirSync('public/data', { recursive: true });
writeFileSync('public/data/records-gh3.json', JSON.stringify(out));
console.log(`${ids.length} cells, ${out.total.toLocaleString('en-US')} records -> public/data/records-gh3.json`);
