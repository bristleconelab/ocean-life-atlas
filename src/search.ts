// One search box for sea animals (common name in any language, or scientific name) and for places ("Galapagos",
// "Aral Sea", "Red Sea"). Keyboard friendly (arrows, Enter, Escape).
import * as api from './api';
import { h, loadPhoto } from './dom';
import { mergeHits, rankHits, type Hit } from './search-merge';
import { GROUP_LABEL } from './taxa';
import { commonsThumbs } from './wiki';
import { silhouette } from './silhouettes';
import { L } from './i18n';

type Item = { kind: 'taxon'; hit: Hit } | { kind: 'place'; place: api.Place };

/** Han, kana and Hangul pack a word into one or two characters, so one is enough to search. */
const DENSE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export const minQueryLength = (q: string) => (DENSE.test(q) ? 1 : 2);
/** Anything outside basic Latin, or a reader whose browser is not in English: also ask Wikidata, which has names in
 *  hundreds of languages ("kit akula", "китовая акула", "ジンベエザメ"). */
const wantsWikidata = (q: string, lang: string) => lang !== 'en' || /[^\u0000-ɏ]/.test(q);

const PIN = 'M32 6c-10 0-18 8-18 18 0 13 18 34 18 34s18-21 18-34c0-10-8-18-18-18zm0 11a7 7 0 1 1 0 14 7 7 0 0 1 0-14z';

export function initSearch(input: HTMLInputElement, list: HTMLUListElement, status: HTMLElement,
  pick: (id: number) => void, pickPlace: (p: api.Place) => void) {
  // itemsFor: the query the current items answer; Enter must not open a result left over from an earlier query (#1)
  let timer = 0, seq = 0, items: Item[] = [], itemsFor = '', cursor = -1, ctl: AbortController | null = null;
  const lang = api.readerLanguage();

  const close = () => { list.hidden = true; cursor = -1; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    close();
    input.blur();
    if (it.kind === 'taxon') pick(it.hit.id); else pickPlace(it.place);
  };
  const highlight = (i: number) => {
    cursor = i;
    list.querySelectorAll('li[role=option]').forEach((li, k) => li.setAttribute('aria-selected', String(k === i)));
    if (i >= 0) input.setAttribute('aria-activedescendant', `hit-${i}`);
  };

  const run = async (q: string) => {
    const my = ++seq;
    ctl?.abort();
    ctl = new AbortController();
    const signal = ctl.signal;
    status.textContent = L('Searching…', 'Qidirilmoqda…');
    const val = <T,>(r: PromiseSettledResult<T[]>) => (r.status === 'fulfilled' ? r.value : []);
    const latin = q.length >= 3 && !/[^\u0000-ɏ]/.test(q); // WoRMS names are Latin-script
    const none = Promise.resolve([] as never[]);
    const [ex, exCommon, like, o, wd, places] = await Promise.allSettled([
      latin ? api.wormsByVernacular(q, false, 1, signal) : none,
      latin ? api.wormsByVernacular(`common ${q}`, false, 1, signal) : none,
      latin ? api.wormsByVernacular(q, true, 1, signal) : none,
      !/[^\u0000-\u024f]/.test(q) ? api.obisComplete(q, signal) : none,
      wantsWikidata(q, lang) || q.length < 3 ? api.wikidataSearchAphia(q, lang, signal).then((ids) => api.wormsRecords(ids.slice(0, 8), signal)) : none,
      q.length >= 3 && !/[^\u0000-\u024f]/.test(q) ? api.searchPlaces(q, signal) : none, // gazetteer names are Latin-script
    ]);
    if (my !== seq) return;
    const wdRecs = val(wd).filter(Boolean);
    const exact = [...val(ex), ...val(exCommon), ...wdRecs];
    const exactIds = new Set(exact.map((r) => r.valid_AphiaID ?? r.AphiaID));
    const all = mergeHits([...wdRecs, ...val(ex), ...val(exCommon), ...val(like)], val(o), q, 80, exactIds);
    const counts = await api.obisRecordCounts(all.filter((x) => x.rank === 'Species').map((x) => x.id), signal);
    if (my !== seq) return;
    const hits = rankHits(all, counts, q);
    const pl = val(places).slice(0, hits.length ? 3 : 5);
    // "Galapagos", "Red Sea": the place comes first when its name starts with the query and no animal is called that
    const placesFirst = pl.length > 0 && pl[0].name.toLowerCase().startsWith(q.toLowerCase()) && !hits.some((x) => x.exact);
    const taxa = hits.map((hit) => ({ kind: 'taxon' as const, hit })), spots = pl.map((place) => ({ kind: 'place' as const, place }));
    items = placesFirst ? [...spots, ...taxa] : [...taxa, ...spots];
    itemsFor = q;
    const failed = [ex, like, o, wd].every((r) => r.status === 'rejected');
    list.replaceChildren();
    cursor = -1;
    if (!items.length) {
      status.textContent = failed
        ? L('Search is not answering right now. Check the connection and try again.', 'Qidiruv hozir javob bermayapti. Internetni tekshirib, qayta urinib koʻring.')
        : L(`Nothing called "${q}" in the sea records or the gazetteer. Try another name, or the scientific name.`, `Dengiz yozuvlarida yoki joy nomlarida "${q}" topilmadi. Boshqa nom yoki ilmiy nomni sinab koʻring.`);
      list.append(h('li', { class: 'empty', text: status.textContent }));
    } else status.textContent = L(`${items.length} results`, `${items.length} ta natija`);
    items.forEach((it, i) => {
      if (it.kind === 'place' && (i === 0 || items[i - 1].kind !== 'place')) list.append(h('li', { class: 'hits-head', text: L('Places', 'Joylar'), attrs: { role: 'presentation' } }));
      if (it.kind === 'taxon' && pl.length && (i === 0 || items[i - 1].kind !== 'taxon')) list.append(h('li', { class: 'hits-head', text: L('Sea life', 'Dengiz hayoti'), attrs: { role: 'presentation' } }));
      const li = it.kind === 'taxon' ? taxonRow(it.hit) : placeRow(it.place);
      if (it.kind === 'taxon') li.dataset.taxon = String(it.hit.id);
      li.id = `hit-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
      list.append(li);
    });
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (!hits.length) return;
    const sci = new Map(hits.map((x) => [x.id, x.scientificName]));
    const info = (await api.wikidataByAphia(hits.map((x) => x.id), sci, lang, signal).catch(() => null)) ?? new Map();
    if (my !== seq) return;
    // names Wikidata did not give: English vernacular from WoRMS
    await Promise.all(hits.filter((x) => !info.get(x.id)?.name).map(async (x) => {
      const en = await api.wormsEnglishName(x.id);
      if (en) info.set(x.id, { ...info.get(x.id), name: en.charAt(0).toUpperCase() + en.slice(1) });
    }));
    if (my !== seq) return;
    hits.forEach((hit) => {
      const w = info.get(hit.id), li = list.querySelector<HTMLElement>(`li[data-taxon="${hit.id}"]`);
      if (!w || !li) return;
      if (w.name) {
        li.querySelector('.hit-name')!.textContent = w.name;
        li.querySelector('.latin')!.textContent = hit.scientificName;
      }
      if (w.image) loadPhoto(li.querySelector('.hit-thumb')!, commonsThumbs(w.image, 120), '', true);
    });
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < minQueryLength(q)) { seq++; ctl?.abort(); close(); status.textContent = ''; return; }
    timer = window.setTimeout(() => run(q), 280);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); highlight(Math.min(cursor + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); highlight(Math.max(cursor - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (itemsFor === input.value.trim()) choose(cursor >= 0 ? cursor : 0); }
    else if (e.key === 'Escape') { close(); input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('focus', () => { if (items.length && input.value.trim().length >= minQueryLength(input.value.trim())) { list.hidden = false; input.setAttribute('aria-expanded', 'true'); } });
}

function taxonRow(hit: Hit): HTMLLIElement {
  const name = h('span', { class: 'hit-name', text: hit.scientificName });
  const latin = h('span', { class: 'latin', text: '' });
  const thumb = h('span', { class: `hit-thumb g-${hit.group}` }, silhouette(hit.group));
  return h('li', {}, thumb, h('span', { class: 'hit-text' }, name, latin,
    h('span', { class: 'hit-group', text: hit.rank === 'Species' ? GROUP_LABEL[hit.group] : `${L(hit.rank, hit.rank === 'Genus' ? 'Urugʻ' : 'Oila')}, ${GROUP_LABEL[hit.group].toLowerCase()}` })));
}

function placeRow(p: api.Place): HTMLLIElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('silhouette');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', PIN);
  path.setAttribute('fill-rule', 'evenodd');
  svg.append(path);
  const UZ: Record<string, string> = { Sea: 'Dengiz', Ocean: 'Okean', Lake: 'Koʻl', Gulf: 'Qoʻltiq', Bay: 'Koʻrfaz', Strait: 'Boʻgʻoz', Island: 'Orol',
    'Island Group': 'Orollar guruhi', Archipelago: 'Arxipelag', Atoll: 'Atoll', Reef: 'Rif', Lagoon: 'Laguna', Fjord: 'Fyord', Estuary: 'Estuariy',
    Sound: 'Boʻgʻoz', Channel: 'Kanal', Bight: 'Qoʻltiq', Nation: 'Davlat' };
  const type = p.type === 'Marine Ecoregion of the World (MEOW)' ? L('Marine ecoregion', 'Dengiz ekoregioni') : p.type === 'IHO Sea Area' ? L('Sea area', 'Dengiz hududi') : L(p.type, UZ[p.type] ?? p.type);
  return h('li', { class: 'place-hit' }, h('span', { class: 'hit-thumb place' }, svg),
    h('span', { class: 'hit-text' }, h('span', { class: 'hit-name', text: p.name }), h('span', { class: 'hit-group', text: type })));
}
