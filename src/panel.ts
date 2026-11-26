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
  setHash(s: { at?: { lat: number; lon: number }; sp?: number }): void;
  opened(open: boolean): void;
  journeys: JourneyHost;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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

    const nav = from ? h('button', { class: 'back', text: `Back to ${from.name}`, on: { click: () => this.showSpecies(from.id) } }) : null;
    const title = h('h2', { class: 'place-title', text: formatLatLon(lat, lon) });
    const kmNS = Math.round((box.north - box.south) * 111.3);
    const kmEW = Math.round((box.east - box.west) * 111.3 * Math.cos((lat * Math.PI) / 180));
    const sub = h('p', { class: 'place-sub', text: formatLatLon(lat, lon) });
    const area = `the outlined square, about ${kmEW} by ${kmNS} km`;
    const summary = h('p', { class: 'summary', text: 'Finding life recorded here…' });
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
      summary.textContent = 'The species list did not load. OBIS may be busy; try the same spot again in a moment.';
      summary.classList.add('error');
      this.body.append(h('button', { class: 'btn', text: 'Try again', on: { click: () => this.showPlace(lat, lon) } }));
      console.warn(e);
      return;
    }
    if (t !== this.token) return;

    if (!list.length) {
      summary.textContent = 'Nobody has recorded a sea animal or plant in this square yet. Try a spot nearer the coast, or switch on "Where scientists have looked" to find well-studied water.';
      return;
    }
    const records = stats?.records ?? list.reduce((s, x) => s + (x.records ?? 0), 0);
    summary.textContent = `${plural(list.length, 'species', 'species')} of sea life recorded in ${area}, from ${fmt(records)} sightings and samples.`;
    const notes: string[] = [];
    if (fetched < total) notes.push(`OBIS lists ${fmt(total)} names here; these are the ${fmt(fetched)} most recorded.`);
    if (landOnly) notes.push(`${plural(landOnly, 'land or freshwater species', 'land and freshwater species')} recorded at the shore ${landOnly === 1 ? 'is' : 'are'} left out.`);
    if (notes.length) this.body.append(h('p', { class: 'fine', text: notes.join(' ') }));
    if (records < FEW_RECORDS) {
      this.body.append(h('p', { class: 'callout', text: 'Few people have looked here. Most of the life in this water has never been recorded, so this list is only a start.' }));
    }

    // group filter; "All" interleaves the kinds so the first screen is not only the most-surveyed group (often birds)
    const counts = countByGroup(list);
    let mixed = interleaveGroups(list);
    let active: GroupId | 'all' = 'all';
    const chips = h('div', { class: 'chips', attrs: { role: 'group', 'aria-label': 'Filter by kind of life' } });
    const grid = h('ul', { class: 'mosaic' });
    const more = h('button', { class: 'btn more', text: 'Show more' });
    const render = () => {
      const shown = active === 'all' ? mixed : list.filter((x) => groupOf(x) === active);
      grid.replaceChildren();
      let n = 0;
      const page = () => {
        const slice = shown.slice(n, n + PAGE);
        n += slice.length;
        this.fillTiles(t, grid, slice, signal);
        more.hidden = n >= shown.length;
        more.textContent = `Show more (${fmt(shown.length - n)} left)`;
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
    chips.append(chip('all', 'All', list.length));
    for (const g of GROUPS) if (counts.get(g.id)) chips.append(chip(g.id, g.label, counts.get(g.id)!));
    for (let i = 0; i < 6; i++) grid.append(h('li', { class: 'tile-skeleton', attrs: { 'aria-hidden': 'true' } }));
    this.body.append(chips, grid, more,
      h('p', { class: 'fine', text: 'The mixed view takes each kind in turn and leads with species that have a photo; within a kind, the most-recorded come first. Record counts reflect where people looked and what they looked for, not only what is common.' }));
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
        h('span', { class: 'tile-n', text: plural(sp.records ?? 0, 'record') }));
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
          if (c) img.title = `Photo: ${c.artist}, ${c.licence}, Wikimedia Commons`;
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

    const nav = back ? h('button', { class: 'back', text: 'Back to this place', on: { click: () => this.showPlace(back.lat, back.lon) } }) : null;
    const figure = h('figure', { class: 'hero' });
    const name = h('h2', { class: 'sp-name', text: '' });
    const latin = h('p', { class: 'latin big', text: '' });
    const lineage = h('p', { class: 'lineage', text: '' });
    const status = h('p', { class: 'status', text: '' });
    const about = h('div', { class: 'about-sp' });
    const facts = h('dl', { class: 'facts' });
    const depth = h('section', { class: 'depth' });
    const journeys = h('div', { class: 'journeys-mount' });
    const links = h('p', { class: 'links' });
    const rangeNote = h('p', { class: 'fine', text: 'Loading where it has been recorded…' });
    this.body.append(...[nav, figure, name, latin, lineage, status, about, rangeNote, facts, depth, journeys, links].filter((x): x is HTMLElement => !!x));

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
      name.textContent = 'This species did not load';
      rangeNote.textContent = 'OBIS did not answer. Check the connection and open the species again.';
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
    lineage.textContent = [GROUP_LABEL[groupOf(taxon)], taxon.family && `family ${taxon.family}`, taxon.order && `order ${taxon.order}`]
      .filter(Boolean).join(', ');
    if (taxon.category && IUCN_LABEL[taxon.category]) {
      status.append(h('span', { class: `iucn iucn-${taxon.category}`, text: IUCN_LABEL[taxon.category] }), ' on the IUCN Red List');
    } else status.hidden = true;

    if (wiki.image) {
      const frame = h('div', { class: 'hero-frame' });
      const cap = h('figcaption', { text: 'Photo: Wikimedia Commons' });
      figure.append(frame, cap);
      loadPhoto(frame, commonsThumbs(wiki.image, 960), `Photo of ${name.textContent}`, true);
      api.commonsCredits([wiki.image]).then((c) => {
        const cr = c.get(wiki.image!);
        if (!cr || t !== this.token) return;
        cap.replaceChildren('Photo: ', h('a', { text: `${cr.artist}, ${cr.licence}`, attrs: { href: cr.page, ...ext } }));
      });
    } else { figure.hidden = true; this.root.classList.add('no-hero'); }
    if (wiki.image) this.root.classList.remove('no-hero');

    const title = wiki.article ? articleTitle(wiki.article) : null;
    if (title) {
      api.wikipediaSummary(title, wiki.articleLang ?? 'en').then((s) => {
        if (!s || t !== this.token) return;
        const text = h('p', { class: 'extract clamped', text: s.extract, attrs: { lang: s.lang } });
        const toggle = h('button', { class: 'link-btn', text: 'Read more' });
        toggle.addEventListener('click', () => { const c = text.classList.toggle('clamped'); toggle.textContent = c ? 'Read more' : 'Show less'; });
        about.append(text, h('p', { class: 'fine' }, toggle, ' From ', h('a', { text: s.lang === 'en' ? 'Wikipedia' : `Wikipedia (${s.lang})`, attrs: { href: s.url, ...ext } }), ', CC BY-SA 4.0'));
        requestAnimationFrame(() => { if (text.scrollHeight <= text.clientHeight + 2) toggle.remove(); });
      });
    }

    if (stats) {
      const yr = stats.yearrange;
      const row = (k: string, v: string) => facts.append(h('dt', { text: k }), h('dd', { text: v }));
      row('Records', fmt(stats.records));
      if (yr) row('Recorded', `${yr[0]} to ${yr[1]}`);
      row('Datasets', fmt(stats.datasets));
    }

    this.renderDepth(depth, env);

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
      const cells = fc.features.map((f) => {
        let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
        for (const [x, y] of f.geometry.coordinates[0]) { west = Math.min(west, x); east = Math.max(east, x); south = Math.min(south, y); north = Math.max(north, y); }
        return { bbox: { west, east, south, north }, n: f.properties.n };
      });
      rangeNote.textContent = cells.length
        ? `Yellow squares on the globe: the ${fmt(cells.length)} places at sea where it has been recorded.`
        : 'No mapped records at sea for this species yet.';
      const c = weightedCentre(cells);
      // from a place, the camera stays on that place; otherwise go to the heart of the range (unless a journey framed it)
      if (c && !back && !this.framed) this.host.flyTo(c.lon, c.lat);
    } catch {
      if (t === this.token) rangeNote.textContent = 'The map of where it lives did not load. Open the species again to retry.';
    }
  }

  private renderDepth(depth: HTMLElement, env: api.EnvStats | null) {
    const { below, above } = splitDepth(env?.depth ?? []);
    const r = depthRange(env?.depth ?? []);
    const sst = sstRange(env?.sst ?? []);
    if (!below.length && !sst) return;
    depth.append(h('h3', { text: 'How deep it lives' }));
    if (r) {
      depth.append(h('p', { text: `Usually between ${fmt(r.from)} and ${fmt(r.to)} m deep: the middle half of ${plural(r.records, 'record')} with a depth.` }));
      const bands = depthBands(env!.depth);
      const max = Math.max(...bands, 1);
      const col = h('ol', { class: 'column', attrs: { 'aria-label': 'Records by depth zone' } });
      DEPTH_BANDS.forEach((b, i) => {
        const usual = r.from < b.to && r.to > b.from;
        col.append(h('li', { class: usual ? 'usual' : '' },
          h('span', { class: 'band', text: b.label }),
          h('span', { class: 'bar', attrs: { style: `--w:${(bands[i] / max) * 100}%` } }),
          h('span', { class: 'band-n', text: fmt(bands[i]) })));
      });
      depth.append(col);
      if (above) depth.append(h('p', { class: 'fine', text: `${plural(above, 'record gives', 'records give')} a depth above the sea surface (usually a sign error) and ${above === 1 ? 'is' : 'are'} left out.` }));
    } else {
      depth.append(h('p', { class: 'fine', text: 'No records with a depth yet.' }));
    }
    if (sst) {
      const deep = r && r.median > 200;
      depth.append(h('p', { class: 'fine', text: `Sea surface temperature where it was recorded: usually ${sst.from} to ${sst.to} °C (middle 80 % of ${plural(sst.records, 'record')}).${deep ? ' It lives far below the surface, where the water is much colder than this.' : ''}` }));
    }
  }
}
