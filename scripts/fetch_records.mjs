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

async function grid(extra = '') {
  const res = await fetch(URL + extra, { headers: { 'User-Agent': 'ocean-life-atlas data build' } });
  if (!res.ok) throw new Error(`OBIS grid${extra}: HTTP ${res.status}`);
  const fc = await res.json();
  const cells = new Map();
  for (const f of fc.features) {
    const ring = f.geometry.coordinates[0];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const id = geohash((x0 + x1) / 2, (y0 + y1) / 2, 3);
    cells.set(id, (cells.get(id) ?? 0) + f.properties.n);
  }
  return cells;
}

const cells = await grid();
// "Last surveyed": the most recent period with any record in the cell. Each period is one more grid request.
const YEAR = new Date().getUTCFullYear();
const PERIODS = [YEAR - 10, YEAR - 20, YEAR - 50]; // since: 2016, 2006, 1976 when built in 2026
const recent = [];
for (const y of PERIODS) recent.push(await grid(`&startdate=${y}-01-01`));
/** 0: recorded in the last 10 years, 1: 10-20 years ago at the latest, 2: 20-50, 3: only longer ago (or undated) */
const ageOf = (id) => { const i = recent.findIndex((m) => m.has(id)); return i < 0 ? 3 : i; };

const ids = [...cells.keys()].sort();
const out = {
  source: 'OBIS (2026) Ocean Biodiversity Information System, https://obis.org, API v3 occurrence/grid/3?exclude=ON_LAND',
  filter: 'exclude=ON_LAND',
  fetched: new Date().toISOString().slice(0, 10),
  cellDeg: 1.40625,
  total: ids.reduce((s, id) => s + cells.get(id), 0),
  gh: ids.join(''),
  n: ids.map((id) => cells.get(id)),
  agePeriods: PERIODS.map((y) => `since ${y}`).concat('older or undated'),
  age: ids.map(ageOf).join(''),
};
if (ids.length < 18000) throw new Error(`only ${ids.length} cells, expected about 21,700`);
mkdirSync('public/data', { recursive: true });
writeFileSync('public/data/records-gh3.json', JSON.stringify(out));
const by = [0, 1, 2, 3].map((k) => [...out.age].filter((c) => +c === k).length);
console.log(`${ids.length} cells, ${out.total.toLocaleString('en-US')} records, last surveyed ${by.join('/')} -> public/data/records-gh3.json`);
