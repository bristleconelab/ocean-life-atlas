// Tag tracks (satellite and acoustic) and seasonality from OBIS occurrence rows. Pure (test/tracks.test.ts).
//
// OBIS publishes animal telemetry (e.g. the US Animal Telemetry Network) as ordinary occurrence rows with
// basisOfRecord "MachineObservation" and the tagged animal in organismID. The API ignores a basisofrecord filter,
// so rows are filtered here.
import type { GroupId } from './taxa';

export interface OccRow {
  id?: string;
  organismID?: string;
  eventDate?: string;
  decimalLongitude?: number;
  decimalLatitude?: number;
  dataset_id?: string;
  basisOfRecord?: string;
  month?: string | number;
}

export interface Track {
  key: string;            // dataset_id|organismID
  dataset: string;
  animal: string;
  start: number;          // ms since epoch
  end: number;
  km: number;
  /** One or more continuous pieces; a long silence or an impossible jump starts a new piece. */
  segments: [number, number, number][][]; // [lon, lat, t] with lon unwrapped across the antimeridian
  /** Fixes dropped as location errors. */
  dropped: number;
}

const DAY = 86400000;
/** Gap that starts a new piece of line: a tag silent for this long tells us nothing about the path in between. */
export const MAX_GAP_DAYS = 20;
/** Typical error of one fix. Moves smaller than this are noise, both for the speed test and for the distance. */
export const FIX_ERROR_KM = 5;
/** Shortest time used to turn a jump into a speed: two fixes a second apart are still two fixes. */
const MIN_DT_DAYS = 1 / 1440;

/** Fastest believable travel per day, by kind of animal. Albatrosses manage ~1,000 km a day; whale sharks, tuna and
 *  whales rarely sustain 200; turtles about 100; manatees and dugongs far less. Faster is a location error. */
export const MAX_KM_PER_DAY: Record<GroupId | 'default', number> = {
  birds: 1200, fish: 300, sharks: 300, mammals: 300, turtles: 200, default: 400,
  corals: 50, molluscs: 300, crustaceans: 50, echinoderms: 20, algae: 50, plankton: 50, other: 100,
};
/** Sea cows (manatees, dugongs) are much slower than whales and seals. */
export const SEACOW_KM_PER_DAY = 100;

export function parseDate(s: string | undefined): number | null {
  if (!s) return null;
  const first = s.split('/')[0].trim().replace(' ', 'T');
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(first) || first.length <= 10 ? first : `${first}Z`);
  return Number.isFinite(t) ? t : null;
}

export function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function isTelemetry(r: OccRow): boolean {
  return r.basisOfRecord === 'MachineObservation' && !!r.organismID && !!r.dataset_id
    && Number.isFinite(r.decimalLongitude) && Number.isFinite(r.decimalLatitude);
}

interface Fix { t: number; lon: number; lat: number }

/** Speed between two fixes in km/day, forgiving the error of the fixes themselves. */
function speed(a: Fix, b: Fix): number {
  const d = Math.max(0, haversineKm(a.lon, a.lat, b.lon, b.lat) - FIX_ERROR_KM);
  return d / Math.max(Math.abs(b.t - a.t) / DAY, MIN_DT_DAYS);
}

/** Drop location errors from time-ordered fixes:
 *  1. lone spikes: a fix that is too fast to reach and to leave while its neighbours agree with each other;
 *  2. a bad start: of the first five fixes, the track starts at the one that lets the most fixes follow (a tag
 *     switched on in a lab, or a 0,0 position, would otherwise make every true fix after it look impossible);
 *  3. anything still too fast to reach from the last good fix. */
export function cleanFixes(pts: Fix[], cap: number): { kept: Fix[]; dropped: number } {
  let p = pts.slice();
  const n0 = p.length;
  for (let pass = 0; pass < 3; pass++) {
    const out: Fix[] = [];
    let changed = false;
    for (let i = 0; i < p.length; i++) {
      const prev = out.length ? out[out.length - 1] : null, next = p[i + 1], next2 = p[i + 2];
      const inBad = prev ? speed(prev, p[i]) > cap : false;
      const outBad = next ? speed(p[i], next) > cap : false;
      // the ends have one neighbour only: drop them when they disagree with both of the next two fixes
      const prev2 = out.length > 1 ? out[out.length - 2] : null;
      const spike = prev && next ? inBad && outBad && speed(prev, next) <= cap
        : !prev && next && next2 ? outBad && speed(next, next2) <= cap && speed(p[i], next2) > cap
        : !next && prev && prev2 ? inBad && speed(prev2, prev) <= cap && speed(prev2, p[i]) > cap
        : false;
      if (spike) { changed = true; continue; }
      out.push(p[i]);
    }
    p = out;
    if (!changed) break;
  }
  // start from whichever of the first few fixes lets the most fixes follow (ties: the earliest)
  const chain = (s: number) => {
    const kept: Fix[] = [];
    for (const f of p.slice(s)) {
      const prev = kept[kept.length - 1];
      if (prev && speed(prev, f) > cap) continue;
      kept.push(f);
    }
    return kept;
  };
  let kept = chain(0);
  for (let s = 1; s < Math.min(5, p.length); s++) { const c = chain(s); if (c.length > kept.length) kept = c; }
  return { kept, dropped: n0 - kept.length };
}

export function buildTracks(rows: OccRow[], minFixes = 5, cap = MAX_KM_PER_DAY.default): Track[] {
  const groups = new Map<string, Fix[]>();
  for (const r of rows) {
    if (!isTelemetry(r)) continue;
    const t = parseDate(r.eventDate);
    if (t == null) continue;
    const key = `${r.dataset_id}|${r.organismID}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ t, lon: r.decimalLongitude!, lat: r.decimalLatitude! });
  }
  const out: Track[] = [];
  for (const [key, raw] of groups) {
    if (raw.length < minFixes) continue;
    raw.sort((a, b) => a.t - b.t);
    const pts = raw.filter((p, i) => i === 0 || !(p.t === raw[i - 1].t && haversineKm(p.lon, p.lat, raw[i - 1].lon, raw[i - 1].lat) < 0.01));
    const { kept, dropped } = cleanFixes(pts, cap);
    if (kept.length < 2) continue;
    const segments: [number, number, number][][] = [];
    let seg: [number, number, number][] = [], km = 0, lonU = 0;
    let prev: Fix | null = null, anchor: Fix | null = null;
    for (const p of kept) {
      if (prev) {
        const days = (p.t - prev.t) / DAY;
        if (days > MAX_GAP_DAYS) { if (seg.length > 1) segments.push(seg); seg = []; anchor = p; }
        else if (anchor) {
          // distance counts only moves larger than a fix's error, so jitter around one spot adds nothing
          const d = haversineKm(anchor.lon, anchor.lat, p.lon, p.lat);
          if (d > FIX_ERROR_KM) { km += d; anchor = p; }
        }
        let dl = p.lon - prev.lon; // unwrap so a path across 180° does not jump round the globe
        if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
        lonU += dl;
      } else { lonU = p.lon; anchor = p; }
      seg.push([+lonU.toFixed(4), +p.lat.toFixed(4), p.t]);
      prev = p;
    }
    if (seg.length > 1) segments.push(seg);
    if (!segments.length) continue;
    const [dataset, animal] = key.split('|');
    out.push({ key, dataset, animal, start: segments[0][0][2], end: segments.at(-1)!.at(-1)![2], km: Math.round(km), segments, dropped });
  }
  return out.sort((a, b) => b.km - a.km);
}

/** Where a track is at time tNow (ms since epoch): the drawn part so far and the moving head. */
function positionAt(tr: Track, tNow: number): { upto: [number, number][][]; head: [number, number] | null } {
  const upto: [number, number][][] = [];
  let head: [number, number] | null = null;
  for (const seg of tr.segments) {
    if (seg[0][2] > tNow) break;
    const part: [number, number][] = [];
    for (let i = 0; i < seg.length; i++) {
      const [x, y, t] = seg[i];
      if (t <= tNow) { part.push([x, y]); head = [x, y]; continue; }
      const [px, py, pt] = seg[i - 1];
      const f = (tNow - pt) / (t - pt);
      head = [px + (x - px) * f, py + (y - py) * f];
      part.push(head);
      break;
    }
    if (part.length > 1) upto.push(part);
  }
  return { upto, head };
}

/** Position of a track at a fraction of its own duration (0 = tagging, 1 = last fix). */
export function trackAt(tr: Track, frac: number) {
  return positionAt(tr, tr.start + Math.max(0, Math.min(1, frac)) * (tr.end - tr.start));
}

/** Position a given time after this animal was tagged. All animals share one clock in the animation: on "day 100"
 *  every animal is 100 days past its own tagging, and a short track simply ends early. */
export function trackAtElapsed(tr: Track, ms: number) {
  return positionAt(tr, tr.start + Math.max(0, ms));
}

function monthOf(r: OccRow): number | null {
  let k = Number(r.month);
  if (!(k >= 1 && k <= 12)) {
    const t = parseDate(r.eventDate);
    k = t == null ? NaN : new Date(t).getUTCMonth() + 1;
  }
  return k >= 1 && k <= 12 ? k - 1 : null;
}

/** A tagged animal sends many fixes a day; it counts once per day, like one sighting. */
function dayKey(r: OccRow): string | null {
  if (!isTelemetry(r)) return null;
  const t = parseDate(r.eventDate);
  return t == null ? null : `${r.dataset_id}|${r.organismID}|${Math.floor(t / DAY)}`;
}

/** Records per calendar month (index 0 = January), tagged animals counted once per animal and day. */
export function monthCounts(rows: OccRow[]): number[] {
  return seasonCounts(rows).all;
}

/** Months north and south of the equator separately: their seasons are opposite, so adding them hides both. */
export function seasonCounts(rows: OccRow[]): { all: number[]; north: number[]; south: number[] } {
  const all = new Array(12).fill(0), north = new Array(12).fill(0), south = new Array(12).fill(0);
  const seen = new Set<string>();
  for (const r of rows) {
    const k = monthOf(r);
    if (k == null) continue;
    const dk = dayKey(r);
    if (dk) { if (seen.has(dk)) continue; seen.add(dk); }
    all[k]++;
    if (Number.isFinite(r.decimalLatitude)) (r.decimalLatitude! >= 0 ? north : south)[k]++;
  }
  return { all, north, south };
}

/** Records per decade from OBIS statistics/years, starting at the first decade with data (or 1900 at the latest). */
export function decadeCounts(years: { year: number; records: number }[]): { decade: number; records: number }[] {
  const by = new Map<number, number>();
  for (const y of years) if (y.year >= 1800 && y.year <= 2100) by.set(Math.floor(y.year / 10) * 10, (by.get(Math.floor(y.year / 10) * 10) ?? 0) + y.records);
  if (!by.size) return [];
  let first = Infinity, last = -Infinity;
  for (const k of by.keys()) { if (k < first) first = k; if (k > last) last = k; }
  const out: { decade: number; records: number }[] = [];
  for (let d = Math.min(first, 1900); d <= last; d += 10) out.push({ decade: d, records: by.get(d) ?? 0 });
  return out;
}
