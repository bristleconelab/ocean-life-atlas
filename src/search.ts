// "Find a sea animal": common or scientific name, keyboard friendly (arrows, Enter, Escape).
import * as api from './api';
import { h, loadPhoto } from './dom';
import { mergeHits, rankHits, type Hit } from './search-merge';
import { GROUP_LABEL } from './taxa';
import { commonsThumbs } from './wiki';
import { silhouette } from './silhouettes';

export function initSearch(input: HTMLInputElement, list: HTMLUListElement, status: HTMLElement, pick: (id: number) => void) {
  // hitsFor: the query the current hits answer; Enter must not open a result left over from an earlier query
  let timer = 0, seq = 0, hits: Hit[] = [], hitsFor = '', cursor = -1;

  const close = () => { list.hidden = true; cursor = -1; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
  const choose = (i: number) => {
    const hit = hits[i];
    if (!hit) return;
    close();
    input.blur();
    pick(hit.id);
  };
  const highlight = (i: number) => {
    cursor = i;
    list.querySelectorAll('li').forEach((li, k) => li.setAttribute('aria-selected', String(k === i)));
    if (i >= 0) input.setAttribute('aria-activedescendant', `hit-${i}`);
  };

  const run = async (q: string) => {
    const my = ++seq;
    status.textContent = 'Searching…';
    const val = <T,>(r: PromiseSettledResult<T[]>) => (r.status === 'fulfilled' ? r.value : []);
    const [ex, exCommon, p1, p2, o] = await Promise.allSettled([
      api.wormsByVernacular(q, false), api.wormsByVernacular(`common ${q}`, false),
      api.wormsByVernacular(q, true, 1), api.wormsByVernacular(q, true, 51), api.obisComplete(q),
    ]);
    if (my !== seq) return;
    const exact = [...val(ex), ...val(exCommon)];
    const exactIds = new Set(exact.map((r) => r.valid_AphiaID ?? r.AphiaID));
    const all = mergeHits([...exact, ...val(p1), ...val(p2)], val(o), q, 80, exactIds);
    const counts = await api.obisRecordCounts(all.filter((x) => x.rank === 'Species').map((x) => x.id));
    if (my !== seq) return;
    hits = rankHits(all, counts, q);
    hitsFor = q;
    const w = { status: [ex, p1, o].every((r) => r.status === 'rejected') ? 'rejected' : 'fulfilled' };
    list.replaceChildren();
    if (!hits.length) {
      status.textContent = w.status === 'rejected'
        ? 'Search is not answering right now. Check the connection and try again.'
        : `No sea animal or plant called "${q}". Try another name, in English or Latin.`;
      list.append(h('li', { class: 'empty', text: status.textContent }));
    } else status.textContent = `${hits.length} results`;
    hits.forEach((hit, i) => {
      const name = h('span', { class: 'hit-name', text: hit.scientificName });
      const latin = h('span', { class: 'latin', text: '' });
      const thumb = h('span', { class: `hit-thumb g-${hit.group}` }, silhouette(hit.group));
      const li = h('li', { attrs: { id: `hit-${i}`, role: 'option', 'aria-selected': 'false' } }, thumb,
        h('span', { class: 'hit-text' }, name, latin, h('span', { class: 'hit-group', text: hit.rank === 'Species' ? GROUP_LABEL[hit.group] : `${hit.rank}, ${GROUP_LABEL[hit.group].toLowerCase()}` })));
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
      list.append(li);
    });
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    const sci = new Map(hits.map((x) => [x.id, x.scientificName]));
    const info = (await api.wikidataByAphia(hits.map((x) => x.id), sci).catch(() => null)) ?? new Map();
    if (my !== seq) return;
    // names Wikidata did not give: English vernacular from WoRMS
    await Promise.all(hits.filter((x) => !info.get(x.id)?.name).map(async (x) => {
      const en = await api.wormsEnglishName(x.id);
      if (en) info.set(x.id, { ...info.get(x.id), name: en.charAt(0).toUpperCase() + en.slice(1) });
    }));
    if (my !== seq) return;
    hits.forEach((hit, i) => {
      const w = info.get(hit.id), li = list.children[i] as HTMLElement | undefined;
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
    if (q.length < 3) { seq++; close(); status.textContent = ''; return; }
    timer = window.setTimeout(() => run(q), 280);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && hits.length) { e.preventDefault(); highlight(Math.min(cursor + 1, hits.length - 1)); }
    else if (e.key === 'ArrowUp' && hits.length) { e.preventDefault(); highlight(Math.max(cursor - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (hitsFor === input.value.trim()) choose(cursor >= 0 ? cursor : 0); }
    else if (e.key === 'Escape') { close(); input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('focus', () => { if (hits.length && input.value.trim().length >= 3) { list.hidden = false; input.setAttribute('aria-expanded', 'true'); } });
}
