// Turning OBIS taxonomy into groups a non-specialist recognises, plus small summaries. Pure (test/taxa.test.ts).

export interface Taxon {
  taxonID: number;
  scientificName: string;
  taxonRank?: string;
  kingdom?: string;
  phylum?: string;
  subphylum?: string;
  superclass?: string;
  class?: string;
  order?: string;
  family?: string;
  category?: string; // IUCN Red List category when OBIS knows it
  records?: number;
  // WoRMS environment flags as OBIS passes them on (true, false or null = not recorded)
  is_marine?: boolean | null;
  is_brackish?: boolean | null;
  is_freshwater?: boolean | null;
  is_terrestrial?: boolean | null;
}

export type GroupId =
  | 'fish' | 'sharks' | 'mammals' | 'turtles' | 'birds' | 'corals' | 'molluscs' | 'crustaceans' | 'echinoderms'
  | 'algae' | 'plankton' | 'other';

/** In this order on the chips and in the mixed "All" view: big, familiar animals first, single cells last. */
export const GROUPS: { id: GroupId; label: string }[] = [
  { id: 'fish', label: 'Fish' },
  { id: 'sharks', label: 'Sharks and rays' },
  { id: 'turtles', label: 'Sea turtles and other reptiles' },
  { id: 'mammals', label: 'Sea mammals' },
  { id: 'birds', label: 'Seabirds and shorebirds' },
  { id: 'corals', label: 'Corals, anemones and jellyfish' },
  { id: 'molluscs', label: 'Shells, squid and octopus' },
  { id: 'crustaceans', label: 'Crabs, shrimp and krill' },
  { id: 'echinoderms', label: 'Starfish and urchins' },
  { id: 'algae', label: 'Seaweed and seagrass' },
  { id: 'plankton', label: 'Plankton and single cells' },
  { id: 'other', label: 'Sponges, worms and others' },
];
export const GROUP_LABEL: Record<GroupId, string> = Object.fromEntries(GROUPS.map((g) => [g.id, g.label])) as Record<GroupId, string>;

const FISH_CLASSES = new Set(['Actinopteri', 'Actinopterygii', 'Teleostei', 'Myxini', 'Petromyzonti', 'Sarcopterygii', 'Coelacanthi']);
/** Brown seaweeds sit in Chromista with the diatoms; they are seaweed to a reader. */
const SEAWEED_CLASSES = new Set(['Phaeophyceae']);

export function groupOf(t: Taxon): GroupId {
  if (t.class === 'Elasmobranchii' || t.class === 'Holocephali') return 'sharks';
  if (t.class && FISH_CLASSES.has(t.class)) return 'fish';
  if (t.class === 'Mammalia') return 'mammals';
  if (t.class === 'Aves') return 'birds'; // OBIS gives birds superclass Reptilia: class must win
  if (t.superclass === 'Reptilia' || t.class === 'Reptilia' || t.order === 'Testudines' || t.order === 'Squamata' || t.order === 'Crocodylia') return 'turtles';
  if (t.phylum === 'Cnidaria' || t.phylum === 'Ctenophora') return 'corals';
  if (t.phylum === 'Mollusca') return 'molluscs';
  // only true crustaceans: sea spiders, horseshoe crabs and insects are arthropods too, but not "crabs and shrimp"
  if (t.phylum === 'Arthropoda') return t.subphylum === 'Crustacea' ? 'crustaceans' : 'other';
  if (t.phylum === 'Echinodermata') return 'echinoderms';
  if (t.kingdom === 'Plantae' || (t.class && SEAWEED_CLASSES.has(t.class))) return 'algae';
  if (t.kingdom === 'Chromista' || t.kingdom === 'Protozoa') return 'plankton';
  return 'other';
}

/** Which mammal silhouette fits: whales and dolphins, seals and other carnivores, or sea cows. */
export function mammalKind(t: Taxon): 'whale' | 'seal' | 'seacow' {
  if (t.order === 'Carnivora') return 'seal';
  if (t.order === 'Sirenia') return 'seacow';
  return 'whale';
}

/** WoRMS says it lives on land or in fresh water and not in the sea: a kingfisher or a river shrimp near the coast. */
export function isLandOrFreshwaterOnly(t: Taxon): boolean {
  if (t.is_marine === true || t.is_brackish === true) return false;
  return t.is_terrestrial === true || t.is_freshwater === true;
}

/** Species-level sea animals, plants and algae only: bacteria, fungi, higher ranks and land or river species are not
 *  what people look for in a sea atlas. Species with no environment flags are kept (unknown is not "not marine"). */
export function isShowable(t: Taxon): boolean {
  if (t.taxonRank !== 'Species') return false;
  if (!(t.kingdom === 'Animalia' || t.kingdom === 'Plantae' || t.kingdom === 'Chromista')) return false;
  return !isLandOrFreshwaterOnly(t);
}

export const IUCN_LABEL: Record<string, string> = {
  EX: 'Extinct', EW: 'Extinct in the wild', CR: 'Critically endangered', EN: 'Endangered', VU: 'Vulnerable',
  NT: 'Near threatened', LC: 'Least concern', DD: 'Data deficient',
};
export const THREATENED = new Set(['CR', 'EN', 'VU']);

/** Keep showable species, most-recorded first, ties by name (stable output for the same input). */
export function rankSpecies<T extends Taxon>(list: T[]): T[] {
  return list.filter(isShowable).sort((a, b) => (b.records ?? 0) - (a.records ?? 0) || a.scientificName.localeCompare(b.scientificName));
}

export function countByGroup(list: Taxon[]): Map<GroupId, number> {
  const m = new Map<GroupId, number>();
  for (const t of list) m.set(groupOf(t), (m.get(groupOf(t)) ?? 0) + 1);
  return m;
}

/** A histogram bin: records whose value lies in [from, to). OBIS gives only `from`; `to` is optional. */
export interface Bin { from: number; to?: number; records: number }

/** Bin width on the OBIS statistics/env depth ladder: 10 m bins to 200 m, 100 m to 1,000 m, 1,000 m below. */
export function obisDepthWidth(from: number): number {
  return from < 200 ? 10 : from < 1000 ? 100 : 1000;
}

/** Record-weighted quantile of binned values, interpolated inside the bin.
 *  The width of a bin is its own `to` when given, else the ladder width capped by the next bin's start, so a bin is
 *  never stretched over a stretch of values the answer skipped (e.g. bins 80 and 1,000 alone: 80 is 10 m wide). */
export function binnedQuantile(bins: Bin[], q: number, widthOf: (from: number) => number): number | null {
  const s = bins.filter((b) => Number.isFinite(b.from) && b.records > 0).sort((a, b) => a.from - b.from);
  const total = s.reduce((t, b) => t + b.records, 0);
  if (total === 0) return null;
  const target = Math.min(1, Math.max(0, q)) * total;
  let acc = 0;
  for (let i = 0; i < s.length; i++) {
    const b = s[i];
    const w = b.to != null && b.to > b.from ? b.to - b.from
      : Math.min(widthOf(b.from), i + 1 < s.length ? s[i + 1].from - b.from : Infinity);
    if (acc + b.records >= target) return b.from + ((target - acc) / b.records) * w;
    acc += b.records;
  }
  const last = s[s.length - 1];
  return last.from + widthOf(last.from);
}

/** Depth bins at or below the sea surface; records above it (negative depth: a sign error or a height) are counted
 *  apart, so the "how deep" text and the zone chart use the same records. */
export function splitDepth(bins: Bin[]): { below: Bin[]; above: number } {
  let above = 0;
  const below: Bin[] = [];
  for (const b of bins) {
    if (!Number.isFinite(b.from) || b.records <= 0) continue;
    if (b.from < 0) above += b.records; else below.push(b);
  }
  return { below, above };
}

/** "Usually 0–80 m deep": the middle half of depth records (25th to 75th percentile), rounded to a readable step.
 *  The middle half, not 80 %: some datasets file the sea-floor depth under the animal's depth (leatherback turtles
 *  "at" 2,000 m), and quartiles shrug those off. The zone chart still shows the full spread. */
export function depthRange(bins: Bin[]): { from: number; to: number; median: number; records: number } | null {
  const { below } = splitDepth(bins);
  const records = below.reduce((t, b) => t + b.records, 0);
  const lo = binnedQuantile(below, 0.25, obisDepthWidth), hi = binnedQuantile(below, 0.75, obisDepthWidth);
  const mid = binnedQuantile(below, 0.5, obisDepthWidth);
  if (lo == null || hi == null || mid == null) return null;
  const step = (v: number) => (v < 100 ? 5 : v < 1000 ? 10 : 100);
  return { from: Math.floor(lo / step(lo)) * step(lo), to: Math.max(Math.ceil(hi / step(hi)) * step(hi), 5), median: mid, records };
}

/** Sea surface temperature where it was recorded: the middle 80 % of records (OBIS bins are 5 °C wide), so a few
 *  misplaced records (a tropical fish logged in Antarctic water) do not stretch the range. */
export function sstRange(sst: { sst: number; records: number }[]): { from: number; to: number; records: number } | null {
  const bins: Bin[] = sst.filter((s) => Number.isFinite(s.sst) && s.records > 0).map((s) => ({ from: s.sst, records: s.records }));
  const records = bins.reduce((t, b) => t + b.records, 0);
  if (records < 10) return null;
  const lo = binnedQuantile(bins, 0.1, () => 5), hi = binnedQuantile(bins, 0.9, () => 5);
  if (lo == null || hi == null) return null;
  return { from: Math.round(lo), to: Math.round(hi), records };
}

/** Merge OBIS env depth bins into display bands (0-10, 10-50, 50-200, 200-1000, 1000-4000, 4000+ m). */
export const DEPTH_BANDS: { from: number; to: number; label: string }[] = [
  { from: 0, to: 10, label: 'Surface, 0–10 m' },
  { from: 10, to: 50, label: '10–50 m' },
  { from: 50, to: 200, label: '50–200 m, sunlit sea' },
  { from: 200, to: 1000, label: '200–1,000 m, twilight zone' },
  { from: 1000, to: 4000, label: '1–4 km, midnight zone' },
  { from: 4000, to: Infinity, label: 'Below 4 km, abyss' },
];
export function depthBands(bins: Bin[]): number[] {
  const out = DEPTH_BANDS.map(() => 0);
  for (const b of splitDepth(bins).below) {
    const i = DEPTH_BANDS.findIndex((d) => b.from >= d.from && b.from < d.to);
    if (i >= 0) out[i] += b.records;
  }
  return out;
}

/** Groups that fill a first screen with names nobody knows: they still come in turn, but only every third round. */
const QUIET = new Set<GroupId>(['plankton', 'other']);

/** Round-robin across groups in the GROUPS order, each group most-recorded first. Plankton and "others" take a turn
 *  only every third round, so a reef's first screen shows fish, corals and turtles before diatoms. */
export function interleaveGroups<T extends Taxon>(ranked: T[]): T[] {
  const by = new Map<GroupId, T[]>();
  for (const t of ranked) { const g = groupOf(t); if (!by.has(g)) by.set(g, []); by.get(g)!.push(t); }
  const queues = GROUPS.map((g) => ({ id: g.id, q: by.get(g.id) ?? [], i: 0 })).filter((x) => x.q.length);
  const out: T[] = [];
  for (let round = 0; out.length < ranked.length; round++) {
    const loud = queues.some((x) => !QUIET.has(x.id) && x.i < x.q.length);
    for (const x of queues) {
      if (x.i >= x.q.length) continue;
      if (QUIET.has(x.id) && loud && round % 3 !== 0) continue;
      out.push(x.q[x.i++]);
    }
  }
  return out;
}
