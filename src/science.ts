// Small pieces of science the panel shows: how complete a species list is likely to be, body size and lifespan from
// Wikidata, whether a range has moved, and how two ranges overlap. Pure (test/science.test.ts).
import { cellAreaKm2, type BBox } from './geo';

/** Bias-corrected Chao1 richness estimate from records per species (Chao 1987; Chao et al. 2005):
 *  S_obs + f1 (f1 - 1) / (2 (f2 + 1)), f1 = species seen once, f2 = twice. Records stand in for individuals, so this is
 *  an inventory-completeness index (how many more species more looking would probably turn up), not a census. */
export function chao1(records: number[]): { observed: number; estimate: number; completeness: number; f1: number; f2: number } | null {
  const counts = records.filter((n) => n > 0);
  const observed = counts.length;
  if (observed < 20) return null;
  let f1 = 0, f2 = 0;
  for (const n of counts) { if (n === 1) f1++; else if (n === 2) f2++; }
  const estimate = observed + (f1 * (f1 - 1)) / (2 * (f2 + 1));
  return { observed, estimate, completeness: observed / estimate, f1, f2 };
}

// ---------- body size and lifespan from Wikidata quantities ----------
const Q = (id: string) => `http://www.wikidata.org/entity/${id}`;
const MASS_KG: Record<string, number> = { [Q('Q11570')]: 1, [Q('Q191118')]: 1000, [Q('Q41803')]: 0.001, [Q('Q100995')]: 0.45359237 };
const LENGTH_M: Record<string, number> = { [Q('Q11573')]: 1, [Q('Q174728')]: 0.01, [Q('Q174789')]: 0.001, [Q('Q3710')]: 0.3048, [Q('Q218593')]: 0.0254, [Q('Q828224')]: 1000 };
const TIME_YEARS: Record<string, number> = { [Q('Q577')]: 1, [Q('Q573')]: 1 / 365.25, [Q('Q5151')]: 1 / 12, [Q('Q23387')]: 7 / 365.25 };

export interface Traits { massKg?: number; lengthM?: number; lifeYears?: number }

/** Largest value of each quantity, in SI units. Wikidata often holds several values (adult, record, average); the
 *  largest is what "up to" means, and unknown units are skipped rather than guessed. */
export function parseTraits(rows: Record<string, { value: string } | undefined>[]): Traits {
  const best = (amt: string, unit: string, table: Record<string, number>) =>
    rows.reduce<number | undefined>((m, r) => {
      const a = Number(r[amt]?.value), f = table[r[unit]?.value ?? ''];
      if (!Number.isFinite(a) || !Number.isFinite(f) || a <= 0) return m;
      const v = a * f;
      return m == null || v > m ? v : m;
    }, undefined);
  const out: Traits = {};
  const m = best('massAmt', 'massUnit', MASS_KG), l = best('lenAmt', 'lenUnit', LENGTH_M), y = best('lifeAmt', 'lifeUnit', TIME_YEARS);
  if (m != null) out.massKg = m;
  if (l != null) out.lengthM = l;
  if (y != null) out.lifeYears = y;
  return out;
}

const round2 = (v: number) => (v >= 100 ? Math.round(v) : v >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100);
export function formatMass(kg: number): string {
  if (kg >= 1000) return `${round2(kg / 1000).toLocaleString('en-US')} t`;
  if (kg >= 1) return `${round2(kg).toLocaleString('en-US')} kg`;
  return `${round2(kg * 1000).toLocaleString('en-US')} g`;
}
export function formatLength(m: number): string {
  if (m >= 1) return `${round2(m).toLocaleString('en-US')} m`;
  if (m >= 0.01) return `${round2(m * 100).toLocaleString('en-US')} cm`;
  return `${round2(m * 1000).toLocaleString('en-US')} mm`;
}

// ---------- range then and now ----------
export interface Cell { bbox: BBox; n: number }

/** Average distance from the equator of the squares where a species was recorded in two periods. Squares, not
 *  records, so a period with more surveys does not pull the answer towards where the surveys were. */
export function rangeShift(then: Cell[], now: Cell[], minCells = 15): { thenLat: number; nowLat: number; shiftKm: number; thenCells: number; nowCells: number } | null {
  if (then.length < minCells || now.length < minCells) return null;
  const meanAbsLat = (cs: Cell[]) => cs.reduce((s, c) => s + Math.abs((c.bbox.south + c.bbox.north) / 2), 0) / cs.length;
  const t = meanAbsLat(then), n = meanAbsLat(now);
  return { thenLat: t, nowLat: n, shiftKm: Math.round((n - t) * 111.2), thenCells: then.length, nowCells: now.length };
}

// ---------- two ranges ----------
const key = (b: BBox) => `${b.west.toFixed(3)},${b.south.toFixed(3)}`;

/** Squares and area shared by two ranges on the same grid. */
export function overlap(a: Cell[], b: Cell[]): { shared: number; onlyA: number; onlyB: number; sharedKm2: number; sharedKeys: Set<string> } {
  const kb = new Map(b.map((c) => [key(c.bbox), c]));
  const sharedKeys = new Set<string>();
  let sharedKm2 = 0;
  for (const c of a) { const k = key(c.bbox); if (kb.has(k)) { sharedKeys.add(k); sharedKm2 += cellAreaKm2(c.bbox); } }
  return { shared: sharedKeys.size, onlyA: a.length - sharedKeys.size, onlyB: b.length - sharedKeys.size, sharedKm2: Math.round(sharedKm2), sharedKeys };
}
export const cellKey = key;

/** Cells from an OBIS/GBIF grid answer. */
export function cellsOf(fc: GeoJSON.FeatureCollection<GeoJSON.Polygon, { n: number }>): Cell[] {
  return fc.features.map((f) => {
    let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    for (const [x, y] of f.geometry.coordinates[0]) { west = Math.min(west, x); east = Math.max(east, x); south = Math.min(south, y); north = Math.max(north, y); }
    return { bbox: { west, east, south, north }, n: f.properties.n };
  });
}

// ---------- export ----------
/** RFC 4180 CSV: quote fields with commas, quotes or line breaks. */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const f = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(f).join(',')).join('\r\n') + '\r\n';
}
