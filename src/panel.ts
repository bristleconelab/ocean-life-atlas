// The side panel: "Life here" for a clicked square, and a species page. Data arrives in stages, so each view
// renders a skeleton first and fills in names, photos and credits as they come back. Each view owns an
// AbortController: opening another view cancels the requests of the one before.
import * as api from './api';
import { h, fmt, loadPhoto, plural } from './dom';
import { bboxToWkt, formatLatLon, geohash, geohashBounds, weightedCentre, type BBox } from './geo';
import {
  countByGroup, depthBands, interleaveGroups, depthRange, DEPTH_BANDS, GROUPS, GROUP_LABEL, groupOf, IUCN_LABEL,
  isLandOrFreshwaterOnly, rankSpecies, splitDepth, sstRange, THREATENED, type GroupId, type Taxon,
} from './taxa';
import { articleTitle, commonsThumbs, type WikiInfo } from './wiki';
import { renderJourneys, type JourneyHost } from './journeys';
import { silhouetteFor } from './silhouettes';
import { chao1, cellsOf, cellKey, formatLength, formatMass, overlap, rangeShift, toCsv, type Traits, parseTraits } from './science';
import { commonsAudio } from './wiki';
import { download } from './dom';
import { L, count } from './i18n';

const PAGE = 36;
/** Species whose photos are looked up before the first screen is drawn, so it can lead with ones that have a photo. */
const PREFETCH = 72;
/** Fewer records than this in a square: say plainly that the list is thin because few people have looked. */
export const FEW_RECORDS = 1000;
const ext = { target: '_blank', rel: 'noopener' };

export interface PanelHost {
  showSquare(b: BBox | null): void;
  showRange(fc: GeoJSON.FeatureCollection | null): void;
  flyTo(lon: number, lat: number): void;
  setHash(s: { at?: { lat: number; lon: number }; sp?: number; vs?: number }): void;
  opened(open: boolean): void;
  /** Put the cursor in the search box, for picking a species to compare with. */
  focusSearch(placeholder: string): void;
  /** Put the search box back to normal after a compare was started and then abandoned. */
  resetSearch(): void;
  journeys: JourneyHost;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "lives up to 47 years", or months or days for short lives (never "0 years"). */
export function lifespan(years: number): string {
  if (years >= 1.5) return L(`lives up to ${fmt(Math.round(years))} years`, `${fmt(Math.round(years))} yilgacha yashaydi`);
  if (years >= 1 / 12) { const m = Math.max(1, Math.round(years * 12)); return L(`lives up to ${m} month${m === 1 ? '' : 's'}`, `${m} oygacha yashaydi`); }
  const d = Math.max(1, Math.round(years * 365.25)); return L(`lives up to ${d} day${d === 1 ? '' : 's'}`, `${d} kungacha yashaydi`);
}

export class Panel {
  private token = 0;
  private place: { lat: number; lon: number } | null = null;
  /** The species on screen, so a click on the globe can offer the way back to it. */
  private species: { id: number; name: string } | null = null;
  private cleanups: (() => void)[] = [];
  private ctl = new AbortController();
  private lang = api.readerLanguage();
  /** Wikidata facts already fetched this session, by WoRMS id. */
  private known = new Map<number, WikiInfo>();

  /** Set when a journey overlay framed the globe, so the range does not fly elsewhere afterwards. */
  private framed = false;

  private runCleanups() { for (const c of this.cleanups.splice(0)) c(); this.framed = false; }

  constructor(private root: HTMLElement, private body: HTMLElement, private host: PanelHost) {
    root.querySelector('.panel-close')?.addEventListener('click', () => this.close());
  }

  get isOpen() { return !this.root.hidden; }

  /** Remember a place without opening it, so a deep link to a species can offer "Back to this place". */
  rememberPlace(lat: number, lon: number) { this.place = { lat, lon }; }

  close(writeHash = true) {
    this.cancelCompare();
    this.token++;
    this.ctl.abort();
    this.runCleanups();
    this.place = null;
    this.species = null;
    this.root.hidden = true;
    this.host.showSquare(null);
    this.host.showRange(null);
    if (writeHash) this.host.setHash({});
    this.host.opened(false);
  }

  private open(): { t: number; signal: AbortSignal } {
    // any new view ends a compare the reader started but did not finish (showCompare reads it before this)
    this.cancelCompare();
    this.ctl.abort();
    this.ctl = new AbortController();
    this.runCleanups();
    this.root.hidden = false;
    this.host.opened(true);
    this.body.replaceChildren();
    this.body.scrollTop = 0;
    return { t: ++this.token, signal: this.ctl.signal };
  }

  // ---------------- Life here ----------------
  async showPlace(lat: number, lon: number) {
    const from = this.species;
    const { t, signal } = this.open();
    this.species = null;
    this.place = { lat, lon };
    this.host.showRange(null);
    this.host.setHash({ at: { lat, lon } });
    const box = geohashBounds(geohash(lon, lat, 3));
    this.host.showSquare(box);
    const wkt = bboxToWkt(box);

    const nav = from ? h('button', { class: 'back', text: L(`Back to ${from.name}`, `${from.name} sahifasiga qaytish`), on: { click: () => this.showSpecies(from.id) } }) : null;
    const title = h('h2', { class: 'place-title', text: formatLatLon(lat, lon) });
    const kmNS = Math.round((box.north - box.south) * 111.3);
    const kmEW = Math.round((box.east - box.west) * 111.3 * Math.cos((lat * Math.PI) / 180));
    const sub = h('p', { class: 'place-sub', text: formatLatLon(lat, lon) });
    const area = L(`the outlined square, about ${kmEW} by ${kmNS} km`, `belgilangan taxminan ${kmEW} × ${kmNS} km kvadrat`);
    const summary = h('p', { class: 'summary', text: L('Finding life recorded here…', 'Bu yerda qayd etilgan hayot qidirilmoqda…') });
    this.body.append(...[nav, h('header', { class: 'place-head' }, title, sub), summary].filter((x): x is HTMLElement => !!x));

    sub.hidden = true;
    api.seaName(lat, lon, signal).then((n) => {
      if (!n || t !== this.token) return;
      title.textContent = n.name;
      sub.hidden = false;
      if (n.land) sub.textContent = `${formatLatLon(lat, lon)}. This point is on land; the list covers the sea and shore inside the square.`;
    });

    let list: Taxon[], stats: api.ObisStats | null, total: number, fetched: number, landOnly: number;
    try {
      const [cl, st] = await Promise.all([api.obisChecklist(wkt, signal), api.obisStatsArea(wkt, signal).catch(() => null)]);
      list = rankSpecies(cl.results);
      landOnly = cl.results.filter((x) => x.taxonRank === 'Species' && isLandOrFreshwaterOnly(x)).length;
      total = cl.total; fetched = cl.results.length;
      stats = st;
    } catch (e) {
      if (t !== this.token) return;
      summary.textContent = L('The species list did not load. OBIS may be busy; try the same spot again in a moment.', 'Turlar roʻyxati yuklanmadi. OBIS band boʻlishi mumkin; birozdan keyin shu joyni qayta bosing.');
      summary.classList.add('error');
      this.body.append(h('button', { class: 'btn', text: L('Try again', 'Qayta urinish'), on: { click: () => this.showPlace(lat, lon) } }));
      console.warn(e);
      return;
    }
    if (t !== this.token) return;

    if (!list.length) {
      summary.textContent = L('Nobody has recorded a sea animal or plant in this square yet. Try a spot nearer the coast, or switch on "Where scientists have looked" to find well-studied water.', 'Bu kvadratda hali hech kim dengiz hayvoni yoki oʻsimligini qayd etmagan. Qirgʻoqqa yaqinroq joyni bosing yoki yaxshi oʻrganilgan suvni topish uchun "Olimlar qayerni oʻrgangan" qatlamini yoqing.');
      return;
    }
    const records = stats?.records ?? list.reduce((s, x) => s + (x.records ?? 0), 0);
    summary.textContent = L(`${plural(list.length, 'species', 'species')} of sea life recorded in ${area}, from ${fmt(records)} sightings and samples.`, `${area} ichida ${fmt(records)} ta kuzatuv va namunadan ${fmt(list.length)} ta dengiz turi qayd etilgan.`);
    const notes: string[] = [];
    if (fetched < total) notes.push(L(`OBIS lists ${fmt(total)} names here; these are the ${fmt(fetched)} most recorded.`, `OBIS bu yerda ${fmt(total)} ta nomni biladi; bular eng koʻp qayd etilgan ${fmt(fetched)} tasi.`));
    if (landOnly) notes.push(L(`${plural(landOnly, 'land or freshwater species', 'land and freshwater species')} recorded at the shore ${landOnly === 1 ? 'is' : 'are'} left out.`, `Qirgʻoqda qayd etilgan ${fmt(landOnly)} ta quruqlik yoki chuchuk suv turi chiqarib tashlangan.`));
    if (notes.length) this.body.append(h('p', { class: 'fine', text: notes.join(' ') }));
    this.body.append(this.surveyBox(list, fetched >= total, stats));
    if (records < FEW_RECORDS) {
      this.body.append(h('p', { class: 'callout', text: L('Few people have looked here. Most of the life in this water has never been recorded, so this list is only a start.', 'Bu yerni kam odam oʻrgangan. Bu suvdagi hayotning katta qismi hech qachon qayd etilmagan, shuning uchun roʻyxat faqat boshlanishi.') }));
    }

    // group filter; "All" interleaves the kinds so the first screen is not only the most-surveyed group (often birds)
    const counts = countByGroup(list);
    let mixed = interleaveGroups(list);
    let active: GroupId | 'all' = 'all';
    const chips = h('div', { class: 'chips', attrs: { role: 'group', 'aria-label': L('Filter by kind of life', 'Hayot turkumi boʻyicha saralash') } });
    const grid = h('ul', { class: 'mosaic' });
    const more = h('button', { class: 'btn more', text: L('Show more', 'Yana koʻrsatish') });
    const render = () => {
      const shown = active === 'all' ? mixed : list.filter((x) => groupOf(x) === active);
      grid.replaceChildren();
      let n = 0;
      const page = () => {
        const slice = shown.slice(n, n + PAGE);
        n += slice.length;
        this.fillTiles(t, grid, slice, signal);
        more.hidden = n >= shown.length;
        more.textContent = L(`Show more (${fmt(shown.length - n)} left)`, `Yana koʻrsatish (${fmt(shown.length - n)} ta qoldi)`);
      };
      more.onclick = page;
      page();
    };
    const chip = (id: GroupId | 'all', label: string, n: number) => {
      const b = h('button', { class: 'chip', text: `${label} ${fmt(n)}`, attrs: { 'aria-pressed': String(id === active) } });
      b.addEventListener('click', () => {
        active = id;
        chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
        b.setAttribute('aria-pressed', 'true');
        render();
      });
      return b;
    };
    chips.append(chip('all', L('All', 'Hammasi'), list.length));
    for (const g of GROUPS) if (counts.get(g.id)) chips.append(chip(g.id, g.label, counts.get(g.id)!));
    for (let i = 0; i < 6; i++) grid.append(h('li', { class: 'tile-skeleton', attrs: { 'aria-hidden': 'true' } }));
    const csv = h('button', { class: 'btn small quiet', text: L('Download the list (CSV)', 'Roʻyxatni yuklab olish (CSV)') });
    csv.addEventListener('click', () => {
      const rows = [['scientific_name', 'common_name', 'group', 'records_in_square', 'iucn', 'worms_aphia_id', 'obis_url'],
        ...list.map((x) => [x.scientificName, this.known.get(x.taxonID)?.name ?? '', GROUP_LABEL[groupOf(x)], x.records ?? 0, x.category ?? '', x.taxonID, `https://obis.org/taxon/${x.taxonID}`])];
      download(`ocean-life-${lat.toFixed(2)}_${lon.toFixed(2)}.csv`, toCsv(rows), 'text/csv');
    });
    this.body.append(chips, grid, more,
      h('p', { class: 'fine', text: L('The mixed view takes each kind in turn and leads with species that have a photo; within a kind, the most-recorded come first. Record counts reflect where people looked and what they looked for, not only what is common.', 'Aralash koʻrinish turkumlarni navbatma-navbat oladi va rasmi bor turlardan boshlaydi; har turkum ichida eng koʻp qayd etilganlar birinchi. Yozuvlar soni nima keng tarqalganini emas, odamlar qayerda va nimani qidirganini ham koʻrsatadi.') }),
      h('div', { class: 'btn-row export' }, csv),
      h('p', { class: 'fine cite', text: L('Cite: ', 'Iqtibos: ') + `OBIS (${new Date().getUTCFullYear()}) Ocean Biodiversity Information System, Intergovernmental Oceanographic Commission of UNESCO, https://obis.org, checklist for ${wkt}, exclude ON_LAND, accessed ${new Date().toISOString().slice(0, 10)}.` }));
    more.hidden = true;

    // first screen: look up photos for the leading species, then put the ones with a photo first
    const head = mixed.slice(0, PREFETCH);
    // at most a few seconds: a busy Wikidata must not hold the whole list back (tiles fill in when it answers)
    await Promise.race([this.lookup(head, signal), new Promise((r) => setTimeout(r, 4000))]);
    if (t !== this.token) return;
    const withPhoto = head.filter((x) => this.known.get(x.taxonID)?.image), without = head.filter((x) => !this.known.get(x.taxonID)?.image);
    mixed = [...withPhoto, ...without, ...mixed.slice(PREFETCH)];
    render();
  }

  /** Wikidata facts for taxa not looked up yet (one query per 60 ids, then a name-based retry for those without a photo). */
  private async lookup(taxa: Taxon[], signal: AbortSignal) {
    const need = taxa.filter((x) => !this.known.has(x.taxonID));
    if (!need.length) return;
    const sci = new Map(need.map((s) => [s.taxonID, s.scientificName]));
    const info = await api.wikidataByAphia(need.map((s) => s.taxonID), sci, this.lang, signal).catch(() => new Map<number, WikiInfo>());
    if (signal.aborted) return;
    for (const s of need) this.known.set(s.taxonID, info.get(s.taxonID) ?? {});
  }

  private fillTiles(t: number, grid: HTMLElement, slice: Taxon[], signal: AbortSignal) {
    const tiles = new Map<number, HTMLElement>();
    for (const sp of slice) {
      const name = h('span', { class: 'tile-name', text: '' });
      const latin = h('span', { class: 'latin', text: sp.scientificName });
      const photo = h('div', { class: `tile-photo g-${groupOf(sp)}`, attrs: { 'data-photo': 'loading' } },
        silhouetteFor(sp), h('span', { class: 'tile-group', text: GROUP_LABEL[groupOf(sp)] }));
      const badge = sp.category && THREATENED.has(sp.category)
        ? h('span', { class: `iucn iucn-${sp.category}`, text: IUCN_LABEL[sp.category] }) : null;
      const btn = h('button', { class: 'tile', attrs: { 'aria-label': sp.scientificName } }, photo, badge, name, latin,
        h('span', { class: 'tile-n', text: count(sp.records ?? 0, 'record', 'records', 'yozuv') }));
      btn.addEventListener('click', () => this.showSpecies(sp.taxonID, true));
      const li = h('li', {}, btn);
      tiles.set(sp.taxonID, li);
      grid.append(li);
    }
    const sci = new Map(slice.map((s) => [s.taxonID, s.scientificName]));
    const setName = (id: number, nm: string) => {
      tiles.get(id)!.querySelector('.tile-name')!.textContent = nm;
      tiles.get(id)!.querySelector('.tile')!.setAttribute('aria-label', `${nm}, ${sci.get(id)}`);
    };
    this.lookup(slice, signal).then(() => {
      if (t !== this.token) return;
      const files: string[] = [];
      for (const [id, li] of tiles) {
        const w = this.known.get(id);
        if (w?.name) setName(id, w.name);
        if (w?.image) {
          files.push(w.image);
          const img = loadPhoto(li.querySelector('.tile-photo')!, commonsThumbs(w.image, 330), '', files.length <= 6);
          img.dataset.file = w.image;
        }
      }
      // whatever Wikidata had no photo for: stop the shimmer and say so
      for (const li of tiles.values()) {
        const f = li.querySelector<HTMLElement>('.tile-photo')!;
        if (f.dataset.photo === 'loading' && !f.querySelector('img')) f.dataset.photo = 'none';
      }
      // photo credits and the missing names load side by side
      api.commonsCredits(files).then((credits) => {
        if (t !== this.token) return;
        grid.querySelectorAll<HTMLImageElement>('img[data-file]').forEach((img) => {
          const c = credits.get(img.dataset.file!);
          if (c) img.title = L(`Photo: ${c.artist}, ${c.licence}, Wikimedia Commons`, `Surat: ${c.artist}, ${c.licence}, Wikimedia Commons`);
        });
      });
      // species Wikidata has no common name for: English vernacular from WoRMS, a few at a time
      const missing = [...tiles.keys()].filter((id) => !this.known.get(id)?.name);
      (async () => {
        for (let i = 0; i < missing.length && t === this.token; i += 6) {
          await Promise.all(missing.slice(i, i + 6).map(async (id) => {
            const en = await api.wormsEnglishName(id);
            if (en && t === this.token) setName(id, capital(en));
          }));
        }
      })();
    });
  }

  // ---------------- Species page ----------------
  async showSpecies(id: number, fromPlace = false) {
    const back = fromPlace && this.place ? { ...this.place } : null;
    const { t, signal } = this.open();
    this.species = { id, name: 'this species' };
    this.host.setHash({ at: back ?? undefined, sp: id });
    if (!back) { this.place = null; this.host.showSquare(null); }
    else this.host.showSquare(geohashBounds(geohash(back.lon, back.lat, 3)));

    const nav = back ? h('button', { class: 'back', text: L('Back to this place', 'Shu joyga qaytish'), on: { click: () => this.showPlace(back.lat, back.lon) } }) : null;
    const figure = h('figure', { class: 'hero' });
    const name = h('h2', { class: 'sp-name', text: '' });
    const latin = h('p', { class: 'latin big', text: '' });
    const lineage = h('p', { class: 'lineage', text: '' });
    const status = h('p', { class: 'status', text: '' });
    const about = h('div', { class: 'about-sp' });
    const facts = h('dl', { class: 'facts' });
    const depth = h('section', { class: 'depth' });
    const bodyBox = h('section', { class: 'body-box', attrs: { hidden: true } });
    const tools = h('section', { class: 'tools' });
    const journeys = h('div', { class: 'journeys-mount' });
    const links = h('p', { class: 'links' });
    const rangeNote = h('p', { class: 'fine', text: L('Loading where it has been recorded…', 'Qayerda qayd etilgani yuklanmoqda…') });
    this.body.append(...[nav, figure, name, latin, lineage, status, about, rangeNote, facts, bodyBox, depth, tools, journeys, links].filter((x): x is HTMLElement => !!x));

    const [taxon, stats, env, info] = await Promise.all([
      api.obisTaxon(id).catch(() => null),
      api.obisStatsTaxon(id).catch(() => null),
      api.obisEnv(id).catch(() => null),
      this.known.get(id)?.article !== undefined || this.known.get(id)?.image
        ? Promise.resolve(this.known.get(id)!)
        : api.wikidataByAphia([id], undefined, this.lang, signal).then((m) => m.get(id) ?? null).catch(() => null),
    ]);
    if (t !== this.token) return;
    if (!taxon) {
      name.textContent = L('This species did not load', 'Bu tur yuklanmadi');
      rangeNote.textContent = L('OBIS did not answer. Check the connection and open the species again.', 'OBIS javob bermadi. Internetni tekshirib, turni qayta oching.');
      return;
    }
    // no photo by WoRMS id: try the scientific name (many birds lack a WoRMS id on Wikidata)
    let wiki: WikiInfo = { ...(info ?? {}) };
    if (!wiki.image) {
      const byName = await api.wikidataByAphia([id], new Map([[id, taxon.scientificName]]), this.lang, signal).then((m) => m.get(id)).catch(() => undefined);
      if (t !== this.token) return;
      if (byName) wiki = { ...byName, ...Object.fromEntries(Object.entries(wiki).filter(([, v]) => v != null)) };
    }
    if (wiki.name && wiki.name.toLowerCase() === taxon.scientificName.toLowerCase()) delete wiki.name;
    name.textContent = wiki.name ?? taxon.scientificName;
    latin.textContent = taxon.scientificName;
    this.species = { id, name: wiki.name ?? taxon.scientificName };
    if (!wiki.name) {
      latin.hidden = true;
      name.classList.add('latin');
      api.wormsEnglishName(id).then((en) => {
        if (!en || t !== this.token) return;
        name.textContent = capital(en); name.classList.remove('latin'); latin.hidden = false;
        this.species = { id, name: capital(en) };
      });
    }
    lineage.textContent = [GROUP_LABEL[groupOf(taxon)], taxon.family && L(`family ${taxon.family}`, `${taxon.family} oilasi`), taxon.order && L(`order ${taxon.order}`, `${taxon.order} turkumi`)]
      .filter(Boolean).join(', ');
    if (taxon.category && IUCN_LABEL[taxon.category]) {
      status.append(h('span', { class: `iucn iucn-${taxon.category}`, text: IUCN_LABEL[taxon.category] }), L(' on the IUCN Red List', ' — IUCN Qizil roʻyxatida'));
    } else status.hidden = true;

    if (wiki.image) {
      const frame = h('div', { class: 'hero-frame' });
      const cap = h('figcaption', { text: L('Photo: Wikimedia Commons', 'Surat: Wikimedia Commons') });
      figure.append(frame, cap);
      loadPhoto(frame, commonsThumbs(wiki.image, 960), L(`Photo of ${name.textContent}`, `${name.textContent} surati`), true);
      api.commonsCredits([wiki.image]).then((c) => {
        const cr = c.get(wiki.image!);
        if (!cr || t !== this.token) return;
        cap.replaceChildren(L('Photo: ', 'Surat: '), h('a', { text: `${cr.artist}, ${cr.licence}`, attrs: { href: cr.page, ...ext } }));
      });
    } else { figure.hidden = true; this.root.classList.add('no-hero'); }
    if (wiki.image) this.root.classList.remove('no-hero');

    const title = wiki.article ? articleTitle(wiki.article) : null;
    if (title) {
      api.wikipediaSummary(title, wiki.articleLang ?? 'en').then((s) => {
        if (!s || t !== this.token) return;
        const text = h('p', { class: 'extract clamped', text: s.extract, attrs: { lang: s.lang } });
        const toggle = h('button', { class: 'link-btn', text: L('Read more', 'Batafsil') });
        toggle.addEventListener('click', () => { const c = text.classList.toggle('clamped'); toggle.textContent = c ? L('Read more', 'Batafsil') : L('Show less', 'Qisqaroq'); });
        about.append(text, h('p', { class: 'fine' }, toggle, L(' From ', ' Manba: '), h('a', { text: s.lang === 'en' ? 'Wikipedia' : `Wikipedia (${s.lang})`, attrs: { href: s.url, ...ext } }), ', CC BY-SA 4.0'));
        requestAnimationFrame(() => { if (text.scrollHeight <= text.clientHeight + 2) toggle.remove(); });
      });
    }

    if (stats) {
      const yr = stats.yearrange;
      const row = (k: string, v: string) => facts.append(h('dt', { text: k }), h('dd', { text: v }));
      row(L('Records', 'Yozuvlar'), fmt(stats.records));
      if (yr) row(L('Recorded', 'Qayd etilgan'), `${yr[0]}–${yr[1]}`);
      row(L('Datasets', 'Maʼlumotlar toʻplami'), fmt(stats.datasets));
    }

    this.renderDepth(depth, env);
    api.wikidataExtras(id, signal).then((x) => { if (t === this.token) this.renderBody(bodyBox, parseTraits(x.rows), x.audio, name.textContent ?? ''); }).catch(() => {});

    const jh: JourneyHost = { ...this.host.journeys, fitTo: (p) => { this.framed = true; this.host.journeys.fitTo(p); } };
    this.cleanups.push(renderJourneys({ id, commonName: name.textContent || taxon.scientificName, taxon, frame: !back, signal }, journeys, jh, () => t === this.token));

    links.append(
      h('a', { text: 'OBIS', attrs: { href: `https://obis.org/taxon/${id}`, ...ext } }), ' ',
      h('a', { text: 'WoRMS', attrs: { href: `https://www.marinespecies.org/aphia.php?p=taxdetails&id=${id}`, ...ext } }),
    );

    try {
      const fc = await api.obisRange(id, signal);
      if (t !== this.token) return;
      this.host.showRange(fc);
      this.renderTools(tools, id, taxon.scientificName, name.textContent || taxon.scientificName, fc, signal, t);
      const cells = fc.features.map((f) => {
        let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
        for (const [x, y] of f.geometry.coordinates[0]) { west = Math.min(west, x); east = Math.max(east, x); south = Math.min(south, y); north = Math.max(north, y); }
        return { bbox: { west, east, south, north }, n: f.properties.n };
      });
      rangeNote.textContent = cells.length
        ? L(`Yellow squares on the globe: the ${fmt(cells.length)} places at sea where it has been recorded.`, `Globusdagi sariq kvadratlar: u qayd etilgan ${fmt(cells.length)} ta dengiz joyi.`)
        : L('No mapped records at sea for this species yet.', 'Bu tur uchun dengizdagi joylashuvli yozuvlar hali yoʻq.');
      const c = weightedCentre(cells);
      // from a place, the camera stays on that place; otherwise go to the heart of the range (unless a journey framed it)
      if (c && !back && !this.framed) this.host.flyTo(c.lon, c.lat);
    } catch {
      if (t === this.token) rangeNote.textContent = L('The map of where it lives did not load. Open the species again to retry.', 'Yashash xaritasi yuklanmadi. Turni qayta oching.');
    }
  }

  /** How complete the list probably is, and how recent the records are. */
  private surveyBox(list: Taxon[], complete: boolean, stats: api.ObisStats | null): HTMLElement {
    const box = h('div', { class: 'survey' });
    const ch = complete ? chao1(list.map((x) => x.records ?? 0)) : null;
    if (ch) {
      const pct = Math.round(ch.completeness * 100);
      box.append(
        h('div', { class: 'meter', attrs: { role: 'img', 'aria-label': L(`About ${pct} % of the likely species recorded`, `Ehtimoliy turlarning taxminan ${pct} % qayd etilgan`) } }, h('span', { attrs: { style: `--w:${pct}%` } })),
        h('p', { text: L(`Recorded so far: about ${pct} % of the ${fmt(Math.round(ch.estimate))} species that more looking would probably find here.`, `Hozircha qayd etilgan: koʻproq izlansa bu yerda topilishi mumkin boʻlgan ${fmt(Math.round(ch.estimate))} ta turning taxminan ${pct} %.`) }),
        h('p', { class: 'fine', text: L(`Chao1 estimate from ${plural(ch.observed, 'species', 'species')}, ${fmt(ch.f1)} of them recorded only once and ${fmt(ch.f2)} twice. Many species seen once means many still unseen. Records stand in for individuals, so read it as a guide to how well this water is known, not a count.`, `Chao1 bahosi: ${fmt(ch.observed)} ta tur, ulardan ${fmt(ch.f1)} tasi faqat bir marta va ${fmt(ch.f2)} tasi ikki marta qayd etilgan. Bir marta koʻrilgan turlar koʻp boʻlsa, hali koʻrilmaganlar ham koʻp. Yozuvlar individlar oʻrnida, shuning uchun buni sanoq emas, suv qanchalik yaxshi oʻrganilgani haqidagi yoʻl-yoʻriq deb oʻqing.`) }));
    }
    const yr = stats?.yearrange;
    if (yr) {
      const age = new Date().getUTCFullYear() - yr[1];
      box.append(h('p', { class: 'fine', text: age > 10 ? L(`Records from ${yr[0]} to ${yr[1]}: nobody has recorded anything here for ${age} years.`, `Yozuvlar ${yr[0]}–${yr[1]} yillar: bu yerda ${age} yildan beri hech kim hech narsa qayd etmagan.`) : L(`Records from ${yr[0]} to ${yr[1]}.`, `Yozuvlar ${yr[0]}–${yr[1]} yillar.`) }));
    }
    return box;
  }

  /** Body size, lifespan and a sound, from Wikidata. */
  private renderBody(box: HTMLElement, tr: Traits, audio: string | undefined, who: string) {
    const parts: string[] = [];
    if (tr.lengthM) parts.push(L(`up to ${formatLength(tr.lengthM)} long`, `uzunligi ${formatLength(tr.lengthM)} gacha`));
    if (tr.massKg) parts.push(L(`up to ${formatMass(tr.massKg)}`, `vazni ${formatMass(tr.massKg)} gacha`));
    if (tr.lifeYears) parts.push(lifespan(tr.lifeYears));
    if (!parts.length && !audio) return;
    box.hidden = false;
    box.append(h('h3', { text: L('Size and voice', 'Oʻlchami va ovozi') }));
    if (parts.length) box.append(h('p', { text: `${capital(parts.join(', '))}.` }));
    if (tr.lengthM && tr.lengthM >= 0.05 && tr.lengthM <= 40) {
      // a person is 1.7 m: draw both to one scale, the longer one full width
      const human = 1.7, max = Math.max(human, tr.lengthM);
      box.append(h('div', { class: 'scale', attrs: { 'aria-hidden': 'true' } },
        h('div', { class: 'scale-row' }, h('span', { class: 'scale-bar animal', attrs: { style: `--w:${(tr.lengthM / max) * 100}%` } }), h('span', { class: 'scale-label', text: who })),
        h('div', { class: 'scale-row' }, h('span', { class: 'scale-bar human', attrs: { style: `--w:${(human / max) * 100}%` } }), h('span', { class: 'scale-label', text: L('a person, 1.7 m', 'odam, 1,7 m') }))));
    }
    if (audio) {
      const el = h('audio', { attrs: { controls: true, preload: 'none' } });
      for (const s of commonsAudio(audio)) el.append(h('source', { attrs: { src: s.src, type: s.type } }));
      const cap = h('p', { class: 'fine', text: L('Recording: Wikimedia Commons', 'Yozuv: Wikimedia Commons') });
      box.append(h('div', { class: 'listen' }, el), cap);
      api.commonsCredits([audio]).then((c) => {
        const cr = c.get(audio);
        if (cr) cap.replaceChildren(L('Recording: ', 'Yozuv: '), h('a', { text: `${cr.artist}, ${cr.licence}`, attrs: { href: cr.page, ...ext } }));
      });
    }
    box.append(h('p', { class: 'fine', text: L('Size and lifespan: the largest values on Wikidata, which may be records rather than typical adults.', 'Oʻlcham va umr: Wikidata dagi eng katta qiymatlar; ular odatiy katta yoshli emas, rekord boʻlishi mumkin.') }));
  }

  /** Then and now, compare, download and cite, under the species summary. */
  private renderTools(box: HTMLElement, id: number, sci: string, who: string, fc: GeoJSON.FeatureCollection<GeoJSON.Polygon, { n: number }>, signal: AbortSignal, t: number) {
    const shiftBtn = h('button', { class: 'btn small quiet', text: L('Then and now', 'Oldin va hozir'), attrs: { 'aria-pressed': 'false' } });
    const cmpBtn = h('button', { class: 'btn small quiet', text: L('Compare with another species', 'Boshqa tur bilan solishtirish') });
    const geo = h('button', { class: 'btn small quiet', text: L('Download range (GeoJSON)', 'Tarqalishni yuklab olish (GeoJSON)') });
    const out = h('div', { class: 'shift-out' });
    box.append(h('div', { class: 'btn-row' }, shiftBtn, cmpBtn, geo), out,
      h('p', { class: 'fine cite', text: L('Cite: ', 'Iqtibos: ') + `OBIS (${new Date().getUTCFullYear()}) Ocean Biodiversity Information System, Intergovernmental Oceanographic Commission of UNESCO, https://obis.org/taxon/${id} (${sci}), accessed ${new Date().toISOString().slice(0, 10)}; WoRMS Editorial Board, World Register of Marine Species, AphiaID ${id}.` }));
    geo.addEventListener('click', () => download(`range-${sci.replace(/\W+/g, '_')}.geojson`, JSON.stringify(fc), 'application/geo+json'));
    cmpBtn.addEventListener('click', () => { this.comparingFrom = id; this.host.focusSearch(L(`Compare ${who} with…`, `${who} ni qaysi tur bilan solishtirish…`)); });
    let on = false;
    shiftBtn.addEventListener('click', async () => {
      on = !on;
      shiftBtn.setAttribute('aria-pressed', String(on));
      if (!on) { this.host.showRange(fc); out.replaceChildren(); return; }
      shiftBtn.disabled = true;
      out.replaceChildren(h('p', { class: 'fine', text: L('Loading records from before 1990 and since 2010…', '1990 yilgacha va 2010 yildan keyingi yozuvlar yuklanmoqda…') }));
      try {
        const [a, b] = await Promise.all([api.obisRangePeriod(id, { enddate: '1989-12-31' }, signal), api.obisRangePeriod(id, { startdate: '2010-01-01' }, signal)]);
        if (t !== this.token) return;
        const then = cellsOf(a), now = cellsOf(b);
        const nowKeys = new Set(now.map((c) => cellKey(c.bbox))), thenKeys = new Set(then.map((c) => cellKey(c.bbox)));
        const feats = [...a.features.map((f, i) => ({ ...f, properties: { ...f.properties, k: nowKeys.has(cellKey(then[i].bbox)) ? 'both' : 'then' } })),
          ...b.features.filter((_, i) => !thenKeys.has(cellKey(now[i].bbox))).map((f) => ({ ...f, properties: { ...f.properties, k: 'now' } }))];
        this.host.showRange({ type: 'FeatureCollection', features: feats });
        const sh = rangeShift(then, now);
        out.replaceChildren(
          h('ul', { class: 'legend-dots' }, h('li', {}, h('span', { class: 'dot', attrs: { style: 'background:#b39ddb' } }), L(`before 1990 only (${fmt(then.length - [...thenKeys].filter((k) => nowKeys.has(k)).length)})`, `faqat 1990 gacha (${fmt(then.length - [...thenKeys].filter((k) => nowKeys.has(k)).length)})`)),
            h('li', {}, h('span', { class: 'dot', attrs: { style: 'background:#f2c94c' } }), L('since 2010 only', 'faqat 2010 dan keyin')), h('li', {}, h('span', { class: 'dot', attrs: { style: 'background:#f4f8f7' } }), L('both', 'ikkalasida'))),
          h('p', { text: sh
            ? L(`Average distance from the equator: ${sh.thenLat.toFixed(1)}° before 1990, ${sh.nowLat.toFixed(1)}° since 2010 (${sh.shiftKm >= 0 ? `${fmt(sh.shiftKm)} km further from` : `${fmt(-sh.shiftKm)} km closer to`} the equator).`,
              `Ekvatordan oʻrtacha uzoqlik: 1990 gacha ${sh.thenLat.toFixed(1)}°, 2010 dan keyin ${sh.nowLat.toFixed(1)}° (ekvatordan ${fmt(Math.abs(sh.shiftKm))} km ${sh.shiftKm >= 0 ? 'uzoqroq' : 'yaqinroq'}).`)
            : L(`Too few squares in one of the periods to compare (${fmt(then.length)} before 1990, ${fmt(now.length)} since 2010).`, `Davrlardan birida solishtirish uchun kvadratlar juda kam (1990 gacha ${fmt(then.length)}, 2010 dan keyin ${fmt(now.length)}).`) }),
          h('p', { class: 'fine', text: L('Where people looked changed too: far more of the ocean was surveyed after 2000, so a wider or shifted range can mean more looking, not a move. Treat a shift as a question, not an answer.', 'Odamlar qaragan joylar ham oʻzgargan: 2000 yildan keyin okean ancha koʻp oʻrganildi, shuning uchun kengaygan yoki siljigan tarqalish koʻchishni emas, koʻproq izlanishni bildirishi mumkin. Siljishni javob emas, savol deb qabul qiling.') }));
      } catch {
        out.replaceChildren(h('p', { class: 'fine', text: L('The records by period did not load. Try again in a moment.', 'Davrlar boʻyicha yozuvlar yuklanmadi. Birozdan keyin qayta urinib koʻring.') }));
        on = false; shiftBtn.setAttribute('aria-pressed', 'false');
      } finally { shiftBtn.disabled = false; }
    });
  }

  /** Set by "Compare with another species": the next species picked in search is compared with this one. */
  comparingFrom: number | null = null;
  private cancelCompare() { if (this.comparingFrom != null) { this.comparingFrom = null; this.host.resetSearch(); } }

  /** Two species side by side: names, photos, depth, temperature, records, and where their ranges meet. */
  async showCompare(a: number, b: number) {
    this.comparingFrom = null;
    const { t, signal } = this.open();
    this.species = null;
    this.place = null;
    this.host.setHash({ sp: a, vs: b });
    this.host.showSquare(null);
    const head = h('h2', { class: 'place-title', text: L('Side by side', 'Yonma-yon') });
    const table = h('div', { class: 'compare' }, h('p', { class: 'fine', text: L('Loading both species…', 'Ikkala tur yuklanmoqda…') }));
    const note = h('div', {});
    this.body.append(h('button', { class: 'back', text: L('Back to the first species', 'Birinchi turga qaytish'), on: { click: () => this.showSpecies(a) } }), head, table, note);
    const load = async (id: number) => {
      const [taxon, stats, env, info, fc] = await Promise.all([
        api.obisTaxon(id).catch(() => null), api.obisStatsTaxon(id).catch(() => null), api.obisEnv(id).catch(() => null),
        api.wikidataByAphia([id], undefined, this.lang, signal).then((m) => m.get(id) ?? {}).catch(() => ({} as WikiInfo)),
        api.obisRange(id, signal).catch(() => null),
      ]);
      return { id, taxon, stats, env, info, fc };
    };
    const [A, B] = await Promise.all([load(a), load(b)]);
    if (t !== this.token) return;
    // no common name from Wikidata (or it was busy): the English one from WoRMS
    await Promise.all([A, B].filter((x) => x.taxon && !x.info.name).map(async (x) => {
      const en = await api.wormsEnglishName(x.id);
      if (en) x.info = { ...x.info, name: capital(en) };
    }));
    if (t !== this.token) return;
    if (!A.taxon || !B.taxon) { table.replaceChildren(h('p', { class: 'fine', text: L('One of the species did not load. Try again in a moment.', 'Turlardan biri yuklanmadi. Birozdan keyin qayta urinib koʻring.') })); return; }
    const nm = (x: typeof A) => (x.info.name && x.info.name.toLowerCase() !== x.taxon!.scientificName.toLowerCase() ? x.info.name : x.taxon!.scientificName);
    const ca = A.fc ? cellsOf(A.fc) : [], cb = B.fc ? cellsOf(B.fc) : [];
    const ov = overlap(ca, cb);
    const ka = new Set(ca.map((c) => cellKey(c.bbox)));
    const feats = [...(A.fc?.features ?? []).map((f, i) => ({ ...f, properties: { ...f.properties, k: ov.sharedKeys.has(cellKey(ca[i].bbox)) ? 'both' : 'a' } })),
      ...(B.fc?.features ?? []).filter((_, i) => !ka.has(cellKey(cb[i].bbox))).map((f) => ({ ...f, properties: { ...f.properties, k: 'b' } }))];
    this.host.showRange({ type: 'FeatureCollection', features: feats });
    const dr = (x: typeof A) => { const r = depthRange(x.env?.depth ?? []); return r ? `${fmt(r.from)}–${fmt(r.to)} m` : '—'; };
    const st = (x: typeof A) => { const r = sstRange(x.env?.sst ?? []); return r ? `${r.from}–${r.to} °C` : '—'; };
    const photo = (x: typeof A) => {
      const f = h('div', { class: `tile-photo g-${groupOf(x.taxon!)}` }, silhouetteFor(x.taxon!));
      if (x.info.image) loadPhoto(f, commonsThumbs(x.info.image, 330), '', true);
      return f;
    };
    const row = (k: string, va: string, vb: string) => [h('div', { class: 'ck', text: k }), h('div', { text: va }), h('div', { text: vb })];
    table.replaceChildren(
      h('div', { class: 'ck' }), h('button', { class: 'cmp-head a', on: { click: () => this.showSpecies(a) } }, photo(A), h('strong', { text: nm(A) }), h('span', { class: 'latin', text: A.taxon.scientificName })),
      h('button', { class: 'cmp-head b', on: { click: () => this.showSpecies(b) } }, photo(B), h('strong', { text: nm(B) }), h('span', { class: 'latin', text: B.taxon.scientificName })),
      ...row(L('Kind', 'Turkum'), GROUP_LABEL[groupOf(A.taxon)], GROUP_LABEL[groupOf(B.taxon)]),
      ...row(L('Red List', 'Qizil kitob'), A.taxon.category ? IUCN_LABEL[A.taxon.category] ?? '—' : '—', B.taxon.category ? IUCN_LABEL[B.taxon.category] ?? '—' : '—'),
      ...row(L('Records', 'Yozuvlar'), fmt(A.stats?.records ?? 0), fmt(B.stats?.records ?? 0)),
      ...row(L('Usually lives', 'Odatda yashaydi'), dr(A), dr(B)),
      ...row(L('Surface water', 'Sirt suvi'), st(A), st(B)),
      ...row(L('Squares recorded', 'Qayd etilgan kvadratlar'), fmt(ca.length), fmt(cb.length)));
    note.append(
      h('ul', { class: 'legend-dots' }, h('li', {}, h('span', { class: 'dot', attrs: { style: 'background:#f2c94c' } }), nm(A)),
        h('li', {}, h('span', { class: 'dot', attrs: { style: 'background:#8ecbff' } }), nm(B)), h('li', {}, h('span', { class: 'dot', attrs: { style: 'background:#f4f8f7' } }), L('both', 'ikkalasi'))),
      h('p', { text: ov.shared ? L(`Their ranges meet in ${plural(ov.shared, 'square')}, about ${fmt(ov.sharedKm2)} km² of sea.`, `Ularning tarqalishi ${fmt(ov.shared)} ta kvadratda, taxminan ${fmt(ov.sharedKm2)} km² dengizda kesishadi.`) : L('Their recorded ranges do not meet anywhere.', 'Ularning qayd etilgan tarqalishi hech qayerda kesishmaydi.') }),
      h('p', { class: 'fine', text: L('Squares are 1.4° on a side; two species in one square were recorded in the same stretch of sea, not necessarily together.', 'Kvadratlar 1,4° kenglikda; bitta kvadratdagi ikki tur dengizning bir qismida qayd etilgan, albatta birga emas.') }));
    const all: [number, number][] = feats.flatMap((f) => f.geometry.coordinates[0].slice(0, 1) as [number, number][]);
    this.host.journeys.fitTo(all);
  }

  private renderDepth(depth: HTMLElement, env: api.EnvStats | null) {
    const { below, above } = splitDepth(env?.depth ?? []);
    const r = depthRange(env?.depth ?? []);
    const sst = sstRange(env?.sst ?? []);
    if (!below.length && !sst) return;
    depth.append(h('h3', { text: L('How deep it lives', 'Qanchalik chuqurda yashaydi') }));
    if (r) {
      depth.append(h('p', { text: L(`Usually between ${fmt(r.from)} and ${fmt(r.to)} m deep: the middle half of ${plural(r.records, 'record')} with a depth.`, `Odatda ${fmt(r.from)}–${fmt(r.to)} m chuqurlikda: chuqurligi yozilgan ${fmt(r.records)} ta yozuvning oʻrta yarmi.`) }));
      const bands = depthBands(env!.depth);
      const max = Math.max(...bands, 1);
      const col = h('ol', { class: 'column', attrs: { 'aria-label': L('Records by depth zone', 'Chuqurlik zonalari boʻyicha yozuvlar') } });
      DEPTH_BANDS.forEach((b, i) => {
        const usual = r.from < b.to && r.to > b.from;
        col.append(h('li', { class: usual ? 'usual' : '' },
          h('span', { class: 'band', text: b.label }),
          h('span', { class: 'bar', attrs: { style: `--w:${(bands[i] / max) * 100}%` } }),
          h('span', { class: 'band-n', text: fmt(bands[i]) })));
      });
      depth.append(col);
      if (above) depth.append(h('p', { class: 'fine', text: L(`${plural(above, 'record gives', 'records give')} a depth above the sea surface (usually a sign error) and ${above === 1 ? 'is' : 'are'} left out.`, `${fmt(above)} ta yozuvda chuqurlik dengiz sathidan yuqori (odatda ishora xatosi), ular hisobga olinmagan.`) }));
    } else {
      depth.append(h('p', { class: 'fine', text: L('No records with a depth yet.', 'Chuqurligi yozilgan yozuvlar hali yoʻq.') }));
    }
    if (sst) {
      const deep = r && r.median > 200;
      depth.append(h('p', { class: 'fine', text: L(`Sea surface temperature where it was recorded: usually ${sst.from} to ${sst.to} °C (middle 80 % of ${plural(sst.records, 'record')}).${deep ? ' It lives far below the surface, where the water is much colder than this.' : ''}`, `Qayd etilgan joydagi dengiz sirti harorati: odatda ${sst.from}–${sst.to} °C (${fmt(sst.records)} ta yozuvning oʻrta 80 %).${deep ? ' U sirtdan ancha pastda, suv bundan ancha sovuq joyda yashaydi.' : ''}`) }));
    }
  }
}
