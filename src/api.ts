// Live data clients. Every service here allows browser requests (CORS *), needs no key, and is cached per session.
//   OBIS        https://api.obis.org/v3        species lists, ranges, depth/temperature statistics
//   WoRMS       https://www.marinespecies.org  search by common name, vernacular names
//   Wikidata    https://qlever.dev, query.wikidata.org, www.wikidata.org   photo, names in the reader's language, articles
//   Commons     https://commons.wikimedia.org  photo author and licence
//   Wikipedia   https://<lang>.wikipedia.org   one-paragraph summary
//   Marine Regions https://www.marineregions.org  sea name for a point, places by name
import type { Bin, Taxon } from './taxa';
import { parseWikidata, type WikiInfo } from './wiki';
import type { Completion } from './search-merge';
import type { OccRow } from './tracks';

const OBIS = 'https://api.obis.org/v3';
const WORMS = 'https://www.marinespecies.org/rest';
/** Records OBIS flags as lying on land (museum specimens filed under a city, river and lake records) are left out of
 *  every place and range query: this is an atlas of the sea. */
const SEA_ONLY = 'ON_LAND';

export class HttpError extends Error {
  constructor(public status: number, url: string) { super(`HTTP ${status} for ${url}`); }
}

// ---------- fetch with retry, timeout, cancel and a bounded cache ----------
/** Answers kept per session. Map keeps insertion order, so the oldest entry goes first (LRU on read, see below). */
const CACHE_MAX = 250;
const cache = new Map<string, Promise<unknown>>();

export interface GetOpts { timeoutMs?: number; signal?: AbortSignal; noCache?: boolean; init?: RequestInit }

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';
const isTimeout = (e: unknown) => e instanceof DOMException && e.name === 'TimeoutError';

export function getJSON<T>(url: string, o: GetOpts = {}): Promise<T> {
  const key = url + (o.init?.body ? `|${String(o.init.body)}` : '');
  const hit = o.noCache ? undefined : cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit as Promise<T>; }
  const once = () => {
    const signals = [AbortSignal.timeout(o.timeoutMs ?? 25000)];
    if (o.signal) signals.push(o.signal);
    return fetch(url, { ...o.init, signal: AbortSignal.any(signals) }).then(async (r) => {
      if (r.status === 204) return [] as T; // WoRMS answers "nothing found" with 204
      if (!r.ok) throw new HttpError(r.status, url);
      return (await r.json()) as T;
    });
  };
  // Busy public services (Wikidata, OBIS) sometimes answer 5xx/429 or stall: try twice more with a pause.
  const p = retry(once, [1200, 3500], o.signal);
  if (!o.noCache) {
    cache.set(key, p);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    p.catch(() => cache.delete(key)); // do not keep failures or cancelled requests
  }
  return p;
}

export function isTransient(e: unknown): boolean {
  if (isAbort(e)) return false; // the reader moved on: do not retry
  if (e instanceof HttpError) return e.status >= 500 || e.status === 429;
  return e instanceof TypeError || isTimeout(e);
}

async function retry<T>(fn: () => Promise<T>, waits: number[], signal?: AbortSignal): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (signal?.aborted || !isTransient(e) || i >= waits.length) throw e;
      await new Promise((r) => setTimeout(r, waits[i]));
    }
  }
}

const q = (o: Record<string, string | number>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();

// ---------- OBIS ----------
/** Taxa recorded inside a polygon, most-recorded first. 5,000 covers every taxon in nearly all 1.4° squares
 *  (the Great Barrier Reef square holds ~3,950); when it does not, `total` says how many there are. */
export async function obisChecklist(wkt: string, signal?: AbortSignal, size = 5000): Promise<{ total: number; results: Taxon[] }> {
  return getJSON(`${OBIS}/checklist?${q({ geometry: wkt, size, exclude: SEA_ONLY })}`, { signal, timeoutMs: 40000 });
}
export interface ObisStats { records: number; species: number; taxa?: number; datasets: number; yearrange?: [number, number] }
export function obisStatsArea(wkt: string, signal?: AbortSignal): Promise<ObisStats> {
  return getJSON(`${OBIS}/statistics?${q({ geometry: wkt, exclude: SEA_ONLY })}`, { signal });
}
export function obisStatsTaxon(id: number): Promise<ObisStats> {
  return getJSON(`${OBIS}/statistics?${q({ taxonid: id })}`);
}
export async function obisTaxon(id: number): Promise<Taxon | null> {
  const r = await getJSON<{ results: Taxon[] }>(`${OBIS}/taxon/${id}`);
  return r.results?.[0] ?? null;
}
export async function obisRange(id: number, signal?: AbortSignal, precision = 3): Promise<GeoJSON.FeatureCollection<GeoJSON.Polygon, { n: number }>> {
  return getJSON(`${OBIS}/occurrence/grid/${precision}?${q({ taxonid: id, exclude: SEA_ONLY })}`, { signal, timeoutMs: 40000 });
}
export interface EnvStats { depth: Bin[]; sst: { sst: number; records: number }[] }
export function obisEnv(id: number): Promise<EnvStats> {
  return getJSON(`${OBIS}/statistics/env?${q({ taxonid: id })}`);
}
/** OBIS record counts for many taxa in one request. */
export async function obisRecordCounts(ids: number[], signal?: AbortSignal): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!ids.length) return out;
  const r = await getJSON<{ results: Taxon[] }>(`${OBIS}/checklist?${q({ taxonid: ids.join(','), size: ids.length * 4 })}`, { signal }).catch(() => null);
  for (const t of r?.results ?? []) if (ids.includes(t.taxonID)) out.set(t.taxonID, t.records ?? 0);
  return out;
}
export function obisComplete(text: string, signal?: AbortSignal): Promise<Completion[]> {
  return getJSON(`${OBIS}/taxon/complete/verbose/${encodeURIComponent(text)}`, { signal });
}

const OCC_FIELDS = 'id,organismID,eventDate,decimalLongitude,decimalLatitude,dataset_id,basisOfRecord,month';
/** Up to 5,000 occurrence rows. OBIS orders rows by their random UUID, so the first page is a fair random sample. */
export function obisSample(id: number, signal?: AbortSignal): Promise<{ total: number; results: OccRow[] }> {
  return getJSON(`${OBIS}/occurrence?${q({ taxonid: id, size: 5000, fields: OCC_FIELDS })}`, { signal, timeoutMs: 45000 });
}
/** Every row of a taxon in one dataset, page by page (cursor = last id), unless it has more than maxRows. */
async function rowsInDataset(id: number, dataset: string, maxRows: number, signal: AbortSignal | undefined, progress: (got: number) => void): Promise<{ rows: OccRow[]; total: number; complete: boolean }> {
  const rows: OccRow[] = [];
  let after: string | undefined, total = 0;
  for (;;) {
    const params: Record<string, string | number> = { taxonid: id, datasetid: dataset, size: 5000, fields: OCC_FIELDS };
    if (after) params.after = after;
    const r = await getJSON<{ total: number; results: OccRow[] }>(`${OBIS}/occurrence?${q(params)}`, { signal, timeoutMs: 45000, noCache: true });
    total = r.total;
    if (!after && total > maxRows) return { rows: [], total, complete: false }; // too big for what is left: skip it whole
    rows.push(...r.results);
    progress(rows.length);
    if (r.results.length < 5000) break;
    after = r.results.at(-1)!.id;
  }
  return { rows, total, complete: true };
}
/** Tag rows from several studies, whole studies only: OBIS pages rows in random (UUID) order, so cutting a study
 *  short would drop random fixes from every animal and leave false gaps. Studies that do not fit are skipped. */
export async function obisTrackRows(id: number, datasets: string[], maxRows: number, signal?: AbortSignal,
  progress?: (got: number) => void): Promise<{ rows: OccRow[]; used: string[]; skipped: string[] }> {
  const rows: OccRow[] = [], used: string[] = [], skipped: string[] = [];
  for (const d of datasets) {
    const left = maxRows - rows.length;
    if (left < 50) { skipped.push(d); continue; }
    const before = rows.length;
    const r = await rowsInDataset(id, d, left, signal, (got) => progress?.(before + got));
    if (r.complete) { rows.push(...r.rows); used.push(d); } else skipped.push(d);
  }
  return { rows, used, skipped };
}
export function obisYears(id: number): Promise<{ year: number; records: number }[]> {
  return getJSON(`${OBIS}/statistics/years?${q({ taxonid: id })}`);
}

/** Short licence name from a dataset's free-text rights statement. Order matters: the most specific terms first. */
export function licenceShort(text: string): string {
  const t = text.replace(/\s+/g, ' ');
  if (/CC0|public domain|creativecommons\.org\/publicdomain/i.test(t)) return 'CC0';
  const url = /creativecommons\.org\/licenses\/([a-z-]+)/i.exec(t)?.[1]?.toLowerCase();
  const parts = url ? url.split('-') : null;
  const has = (k: 'nc' | 'nd' | 'sa', words: RegExp) => (parts ? parts.includes(k) : words.test(t));
  const by = parts ? parts.includes('by') : /CC[- ]?BY|Attribution/i.test(t);
  if (!by) return 'see dataset';
  const nc = has('nc', /\bNC\b|non-?commercial/i), nd = has('nd', /\bND\b|no ?deriv/i), sa = has('sa', /\bSA\b|share ?alike/i);
  return ['CC BY', nc && 'NC', nd ? 'ND' : sa && 'SA'].filter(Boolean).join('-');
}

export interface DatasetMeta { id: string; title: string; licence: string; url: string }
export async function obisDataset(id: string): Promise<DatasetMeta | null> {
  const r = await getJSON<{ results: { id: string; title: string; intellectualrights?: string; url?: string }[] }>(`${OBIS}/dataset/${id}`).catch(() => null);
  const d = r?.results?.[0];
  if (!d) return null;
  return { id: d.id, title: d.title, licence: licenceShort(d.intellectualrights ?? ''), url: `https://obis.org/dataset/${d.id}` };
}

// ---------- MiCO (stored, see scripts/build_mico.mjs) ----------
export interface MicoMeta { common: string; scientific: string; group: string; sites: number; routes: number; tracked: number }
export interface MicoIndex { source: string; species: Record<string, MicoMeta> }
/** routes: [lon1, lat1, lon2, lat2, tracked 1/0, both directions 1/0] */
export interface MicoSpecies { common: string; scientific: string; group: string; sites: [number, number, number, string][]; routes: [number, number, number, number, number, number][] }
export function micoIndex(base: string): Promise<MicoIndex> { return getJSON(`${base}data/mico/index.json`); }
export function micoSpecies(base: string, id: number): Promise<MicoSpecies> { return getJSON(`${base}data/mico/${id}.json`); }

// ---------- WoRMS ----------
export interface AphiaRecord {
  AphiaID: number; scientificname: string; status: string; rank: string; valid_AphiaID: number | null; valid_name: string | null;
  kingdom: string | null; phylum: string | null; class: string | null; order: string | null; family: string | null;
  isMarine?: number | null;
}
export function wormsByVernacular(name: string, like = true, offset = 1, signal?: AbortSignal): Promise<AphiaRecord[]> {
  return getJSON(`${WORMS}/AphiaRecordsByVernacular/${encodeURIComponent(name)}?like=${like}&offset=${offset}`, { signal });
}
export function wormsRecords(ids: number[], signal?: AbortSignal): Promise<AphiaRecord[]> {
  if (!ids.length) return Promise.resolve([]);
  return getJSON(`${WORMS}/AphiaRecordsByAphiaIDs?${ids.map((id) => `aphiaids[]=${id}`).join('&')}`, { signal });
}
export async function wormsEnglishName(id: number): Promise<string | null> {
  const v = await getJSON<{ vernacular: string; language_code: string }[]>(`${WORMS}/AphiaVernacularsByAphiaID/${id}`).catch(() => []);
  return v.find((x) => x.language_code === 'eng')?.vernacular ?? null;
}

// ---------- Wikidata / Commons / Wikipedia ----------
export function readerLanguage(): string {
  const l = (typeof navigator !== 'undefined' ? navigator.language : 'en').toLowerCase().split('-')[0];
  return /^[a-z]{2,3}$/.test(l) ? l : 'en';
}

/** Primary endpoint: QLever (a fast public mirror of Wikidata, CORS *); fallback: the Wikidata Query Service, which
 *  is often rate-limited (seen on 2026-11-25: "1 req / min" during an outage). */
const SPARQL_ENDPOINTS = ['https://qlever.dev/api/wikidata', 'https://query.wikidata.org/sparql'];
const PREFIXES = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX schema: <http://schema.org/>
`;
type Bindings = { results: { bindings: Record<string, { value: string }>[] } };
const safe = (lang: string) => (/^[a-z]{2,3}$/.test(lang) ? lang : 'en');
const literal = (s: string) => `"${s.replace(/[\\"]/g, '').replace(/[\r\n]/g, ' ')}"`;

/** Facts for taxa found either by WoRMS id (P850, key ?aphia) or by scientific name (P225, key ?name). */
export function speciesQuery(ids: number[], lang: string, by: 'aphia' | 'name' = 'aphia', names: string[] = []): string {
  const l = safe(lang);
  const values = by === 'aphia' ? ids.filter(Number.isInteger).map((id) => `"${id}"`).join(' ') : names.map(literal).join(' ');
  // an old name's item (Sterna bergii) often has no photo; P12765 points to the accepted taxon's item, which does
  const match = `${by === 'aphia' ? '?item0 wdt:P850 ?aphia .' : '?item0 wdt:P225 ?name .'}
  OPTIONAL { ?item0 wdt:P12765 ?acc } BIND(COALESCE(?acc, ?item0) AS ?item)`;
  return `${PREFIXES}SELECT ?${by} (SAMPLE(?img) AS ?image) (SAMPLE(?cn) AS ?common) (SAMPLE(?lab) AS ?label)
  (SAMPLE(?cnEn) AS ?commonEn) (SAMPLE(?labEn) AS ?labelEn) (SAMPLE(?art) AS ?article) (SAMPLE(?artEn) AS ?articleEn) WHERE {
  VALUES ?${by} { ${values} }
  ${match}
  OPTIONAL { ?item wdt:P18 ?img }
  OPTIONAL { ?item wdt:P1843 ?cn FILTER(LANG(?cn) = "${l}") }
  OPTIONAL { ?item rdfs:label ?lab FILTER(LANG(?lab) = "${l}") }
  OPTIONAL { ?item wdt:P1843 ?cnEn FILTER(LANG(?cnEn) = "en") }
  OPTIONAL { ?item rdfs:label ?labEn FILTER(LANG(?labEn) = "en") }
  OPTIONAL { ?art schema:about ?item ; schema:isPartOf <https://${l}.wikipedia.org/> }
  OPTIONAL { ?artEn schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
} GROUP BY ?${by}`;
}

async function sparql(query: string, signal?: AbortSignal): Promise<Bindings['results']['bindings'] | null> {
  for (const ep of SPARQL_ENDPOINTS) {
    const r = await getJSON<Bindings>(`${ep}?${q({ query })}`, { init: { headers: { Accept: 'application/sparql-results+json' } }, timeoutMs: 15000, signal }).catch(() => null);
    if (r?.results?.bindings) return r.results.bindings;
    if (signal?.aborted) return null;
  }
  return null;
}

/** Wikidata facts for WoRMS ids. Items that lack a WoRMS id (common for birds) are looked up again by scientific name,
 *  which is how a little pied cormorant gets its photo. */
export async function wikidataByAphia(ids: number[], sciById?: Map<number, string>, lang = readerLanguage(), signal?: AbortSignal): Promise<Map<number, WikiInfo>> {
  const out = new Map<number, WikiInfo>();
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += 60) chunks.push(ids.slice(i, i + 60));
  await Promise.all(chunks.map(async (chunk) => {
    const b = await sparql(speciesQuery(chunk, lang), signal);
    if (b) for (const [k, v] of parseWikidata(b, sciById, lang)) out.set(k, v);
  }));
  if (!sciById) return out;
  const missing = ids.filter((id) => !out.get(id)?.image && sciById.get(id));
  if (!missing.length) return out;
  const idByName = new Map(missing.map((id) => [sciById.get(id)!, id]));
  const names = [...idByName.keys()];
  for (let i = 0; i < names.length; i += 60) {
    const b = await sparql(speciesQuery([], lang, 'name', names.slice(i, i + 60)), signal);
    if (!b) continue;
    const keyed = b.map((x) => ({ ...x, aphia: { value: String(idByName.get(x.name?.value ?? '') ?? '') } }));
    for (const [k, v] of parseWikidata(keyed, sciById, lang)) {
      const had = out.get(k) ?? {};
      out.set(k, { ...v, ...Object.fromEntries(Object.entries(had).filter(([, x]) => x != null)) });
    }
  }
  return out;
}

/** WoRMS ids for a name typed in any language ("kit akula", "китовая акула"), through Wikidata's own label search. */
export async function wikidataSearchAphia(text: string, lang = readerLanguage(), signal?: AbortSignal): Promise<number[]> {
  const r = await getJSON<{ search?: { id: string }[] }>(`https://www.wikidata.org/w/api.php?${q({
    action: 'wbsearchentities', search: text, language: safe(lang), uselang: safe(lang), type: 'item', limit: 12, format: 'json', origin: '*',
  })}`, { signal, timeoutMs: 10000 }).catch(() => null);
  const qids = (r?.search ?? []).map((s) => s.id).filter((id) => /^Q\d+$/.test(id));
  if (!qids.length) return [];
  const b = await sparql(`${PREFIXES}SELECT ?item ?aphia WHERE { VALUES ?item { ${qids.map((x) => `wd:${x}`).join(' ')} } ?item wdt:P850 ?aphia . }`, signal);
  const byQ = new Map((b ?? []).map((x) => [x.item.value.split('/').pop()!, Number(x.aphia.value)]));
  return qids.map((x) => byQ.get(x)).filter((n): n is number => Number.isInteger(n));
}

export interface Credit { artist: string; licence: string; page: string }
export async function commonsCredits(files: string[]): Promise<Map<string, Credit>> {
  const out = new Map<string, Credit>();
  const strip = (s?: string) => (s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  const chunks: string[][] = [];
  for (let i = 0; i < files.length; i += 40) chunks.push(files.slice(i, i + 40));
  await Promise.all(chunks.map(async (chunk) => {
    const titles = chunk.map((f) => `File:${f}`).join('|');
    const r = await getJSON<{ query?: { normalized?: { from: string; to: string }[]; pages: Record<string, { title: string; imageinfo?: { extmetadata?: Record<string, { value: string }>; descriptionurl?: string }[] }> } }>(
      `https://commons.wikimedia.org/w/api.php?${q({ action: 'query', titles, prop: 'imageinfo', iiprop: 'extmetadata|url', format: 'json', origin: '*' })}`,
    ).catch(() => null);
    if (!r?.query) return;
    const back = new Map((r.query.normalized ?? []).map((n) => [n.to, n.from]));
    for (const p of Object.values(r.query.pages)) {
      const ii = p.imageinfo?.[0];
      if (!ii) continue;
      const title = back.get(p.title) ?? p.title;
      out.set(title.replace(/^File:/, ''), {
        artist: strip(ii.extmetadata?.Artist?.value) || 'Unknown author',
        licence: strip(ii.extmetadata?.LicenseShortName?.value) || 'see file page',
        page: ii.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}`,
      });
    }
  }));
  return out;
}

export async function wikipediaSummary(title: string, lang = 'en'): Promise<{ extract: string; url: string; lang: string } | null> {
  const l = safe(lang);
  const r = await getJSON<{ extract?: string; content_urls?: { desktop?: { page?: string } }; type?: string }>(
    `https://${l}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
  ).catch(() => null);
  if (!r?.extract || r.type === 'disambiguation') return null;
  return { extract: r.extract, url: r.content_urls?.desktop?.page ?? `https://${l}.wikipedia.org/wiki/${encodeURIComponent(title)}`, lang: l };
}

// ---------- Marine Regions ----------
type Gaz = { preferredGazetteerName: string; placeType: string; latitude?: number; longitude?: number; MRGID?: number;
  minLatitude?: number | null; maxLatitude?: number | null; minLongitude?: number | null; maxLongitude?: number | null };
const LOCAL = ['Reef', 'Bay', 'Gulf', 'Strait', 'Sound', 'Lagoon', 'Fjord', 'Estuary', 'Sea', 'Lake'];
const WATER = new Set(['IHO Sea Area', 'EEZ', 'Territorial Sea', 'Internal waters', 'High Seas', 'Ocean', 'Sea']);

export interface PlaceName { name: string; land: boolean }

export async function seaName(lat: number, lon: number, signal?: AbortSignal): Promise<PlaceName | null> {
  const r = await getJSON<Gaz[]>(
    `https://www.marineregions.org/rest/getGazetteerRecordsByLatLong.json/${lat.toFixed(3)}/${lon.toFixed(3)}/`, { timeoutMs: 12000, signal },
  ).catch(() => []);
  return pickSeaName(r);
}

/** Most specific water body plus its sea ("Great Barrier Reef, Coral Sea"); a country name when the point is on land. */
export function pickSeaName(r: Gaz[]): PlaceName | null {
  if (!r.length) return null;
  if (!r.some((x) => WATER.has(x.placeType) || x.placeType === 'Lake')) {
    const nation = r.find((x) => x.placeType === 'Nation') ?? r.find((x) => x.placeType === 'Continent');
    return nation ? { name: nation.preferredGazetteerName, land: true } : null;
  }
  const iho = r.filter((x) => x.placeType === 'IHO Sea Area').map((x) => x.preferredGazetteerName);
  // a named sea ("Coral Sea") is more useful than the ocean around it ("South Pacific Ocean")
  const sea = iho.find((n) => !/Ocean/.test(n)) ?? iho[0] ?? r.find((x) => x.placeType === 'Ocean')?.preferredGazetteerName;
  const local = LOCAL.map((t) => r.find((x) => x.placeType === t)).find(Boolean)?.preferredGazetteerName;
  if (local && sea && local !== sea) return { name: `${local}, ${sea}`, land: false };
  const name = local ?? sea;
  return name ? { name, land: false } : null;
}

/** Kinds of named places worth offering in search, best first. EEZ pieces, protected-area codes and survey grids
 *  share names with them and would crowd them out. */
const PLACE_TYPES = ['Sea', 'Ocean', 'IHO Sea Area', 'Lake', 'Gulf', 'Bay', 'Strait', 'Island', 'Island Group', 'Archipelago',
  'Atoll', 'Reef', 'Lagoon', 'Fjord', 'Estuary', 'Sound', 'Channel', 'Bight', 'Marine Ecoregion of the World (MEOW)', 'Nation'];

export interface Place { name: string; type: string; lat: number; lon: number; bbox?: [number, number, number, number] }

export function pickPlaces(r: Gaz[], query: string, limit = 4): Place[] {
  const ql = query.trim().toLowerCase();
  const seen = new Set<string>();
  const ok = r.filter((x) => PLACE_TYPES.includes(x.placeType) && Number.isFinite(x.latitude) && Number.isFinite(x.longitude));
  const score = (x: Gaz) => {
    const n = x.preferredGazetteerName.toLowerCase();
    // a word starting with the query; Unicode-aware, so "Chañaral" does not count as a word "aral"
    const m = n === ql ? 0 : n.startsWith(ql) ? 1 : new RegExp(`(?<![\\p{L}\\p{N}])${ql.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(n) ? 2 : 3;
    return m * 100 + PLACE_TYPES.indexOf(x.placeType);
  };
  const out: Place[] = [];
  for (const x of ok.sort((a, b) => score(a) - score(b))) {
    if (score(x) >= 300) break; // only names that start a word with the query
    const key = x.preferredGazetteerName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const b = [x.minLongitude, x.minLatitude, x.maxLongitude, x.maxLatitude];
    out.push({
      name: x.preferredGazetteerName, type: x.placeType, lat: x.latitude!, lon: x.longitude!,
      bbox: b.every((v) => typeof v === 'number' && Number.isFinite(v)) && b[0] !== b[2] ? (b as [number, number, number, number]) : undefined,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export async function searchPlaces(text: string, signal?: AbortSignal): Promise<Place[]> {
  const r = await getJSON<Gaz[]>(`https://www.marineregions.org/rest/getGazetteerRecordsByName.json/${encodeURIComponent(text)}/?like=true&fuzzy=false&count=100`,
    { timeoutMs: 10000, signal }).catch(() => []);
  return pickPlaces(Array.isArray(r) ? r : [], text);
}
