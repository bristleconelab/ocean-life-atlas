// Geohash cells and small geometry helpers. Pure, no DOM (test/geo.test.ts).
// A geohash-3 cell is 1.40625 deg on each side: the square the atlas uses for "life here".

const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/** Standard geohash (longitude bit first). Longitude is wrapped to [-180, 180), latitude clamped. */
export function geohash(lon: number, lat: number, precision: number): string {
  const wlon = ((((lon + 180) % 360) + 360) % 360) - 180;
  const clat = Math.max(-90, Math.min(90, lat));
  const lo = [-180, 180], la = [-90, 90];
  let even = true, bit = 0, ch = 0, out = '';
  while (out.length < precision) {
    const r = even ? lo : la, v = even ? wlon : clat, mid = (r[0] + r[1]) / 2;
    if (v >= mid) { ch = (ch << 1) | 1; r[0] = mid; } else { ch <<= 1; r[1] = mid; }
    even = !even;
    if (++bit === 5) { out += B32[ch]; bit = 0; ch = 0; }
  }
  return out;
}

export interface BBox { west: number; south: number; east: number; north: number }

/** Bounds of a geohash cell. Throws on characters outside the geohash alphabet. */
export function geohashBounds(hash: string): BBox {
  const lo = [-180, 180], la = [-90, 90];
  let even = true;
  for (const c of hash) {
    const v = B32.indexOf(c);
    if (v < 0) throw new Error(`not a geohash: ${hash}`);
    for (let b = 4; b >= 0; b--) {
      const r = even ? lo : la, mid = (r[0] + r[1]) / 2;
      if ((v >> b) & 1) r[0] = mid; else r[1] = mid;
      even = !even;
    }
  }
  return { west: lo[0], south: la[0], east: lo[1], north: la[1] };
}

/** WKT polygon for the OBIS API geometry parameter (counter-clockwise ring, closed). */
export function bboxToWkt(b: BBox): string {
  const f = (n: number) => +n.toFixed(5);
  const ring = [[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]];
  return `POLYGON((${ring.map(([x, y]) => `${f(x)} ${f(y)}`).join(',')}))`;
}

export function bboxRing(b: BBox): [number, number][] {
  return [[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]];
}

/** "22.5° N, 69.6° E" */
export function formatLatLon(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S', ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(1)}° ${ns}, ${Math.abs(lon).toFixed(1)}° ${ew}`;
}

/** Record-weighted centre of a set of cells, with longitudes averaged on the circle (ranges that cross 180°). */
export function weightedCentre(cells: { bbox: BBox; n: number }[]): { lon: number; lat: number } | null {
  let sx = 0, sy = 0, sl = 0, w = 0;
  for (const c of cells) {
    const lon = ((c.bbox.west + c.bbox.east) / 2) * (Math.PI / 180);
    const lat = (c.bbox.south + c.bbox.north) / 2;
    const k = Math.log10(1 + c.n);
    sx += Math.cos(lon) * k; sy += Math.sin(lon) * k; sl += lat * k; w += k;
  }
  if (w === 0) return null;
  return { lon: Math.atan2(sy, sx) * (180 / Math.PI), lat: sl / w };
}

/** Points along the great circle from a to b (lon/lat degrees), longitudes unwrapped so the line never jumps 360°. */
export function greatCircle(a: [number, number], b: [number, number], steps = 32): [number, number][] {
  const r = Math.PI / 180;
  const [l1, p1] = [a[0] * r, a[1] * r], [l2, p2] = [b[0] * r, b[1] * r];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (d < 1e-9) return [a, b];
  const out: [number, number][] = [];
  let prev = a[0];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    let lon = Math.atan2(y, x) / r;
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    prev = lon;
    out.push([lon, Math.atan2(z, Math.sqrt(x * x + y * y)) / r]);
  }
  return out;
}

/** Area of a lon/lat box on a sphere of the Earth's mean radius, km². A geohash-3 square is ~24,600 km² at the
 *  equator and ~8,400 km² at 70°, which is why the "looked" layer shows records per area, not per square. */
export function cellAreaKm2(b: BBox): number {
  const R = 6371.0088, r = Math.PI / 180;
  return R * R * Math.abs((b.east - b.west) * r) * Math.abs(Math.sin(b.north * r) - Math.sin(b.south * r));
}

/** Bounds of points around their circular mean longitude, so a set across 180° gives one tight box
 *  (west may be below -180 or east above 180; MapLibre accepts that). */
export function frameOf(points: [number, number][]): { west: number; east: number; south: number; north: number; lon: number; lat: number; wide: boolean } | null {
  if (!points.length) return null;
  let sx = 0, sy = 0;
  for (const [x] of points) { sx += Math.cos((x * Math.PI) / 180); sy += Math.sin((x * Math.PI) / 180); }
  const c = (Math.atan2(sy, sx) * 180) / Math.PI;
  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
  for (const [x, y] of points) {
    const rel = ((((x - c + 540) % 360) + 360) % 360) - 180;
    if (rel < w) w = rel; if (rel > e) e = rel;
    if (y < s) s = y; if (y > n) n = y;
  }
  s = Math.max(-80, s); n = Math.min(80, n);
  return { west: c + w, east: c + e, south: s, north: n, lon: c + (w + e) / 2, lat: (s + n) / 2, wide: e - w > 100 || n - s > 70 };
}
