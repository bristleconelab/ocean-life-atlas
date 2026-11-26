import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/source-serif-4/wght-italic.css';
import './styles.css';
import * as api from './api';
import { fmt, h, plural } from './dom';
import { Globe } from './map';
import { Panel } from './panel';
import { initSearch } from './search';
import { initSheet } from './sheet';
import { formatHash, parseHash, type ViewState } from './state';
import { L, lang, setLang } from './i18n';
import { initTour } from './tour';
import { initQuiz } from './quiz';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const base = import.meta.env.BASE_URL;
// static text in index.html carries its Uzbek in data-uz (text), data-uz-placeholder and data-uz-label (aria-label)
if (lang === 'uz') {
  document.documentElement.lang = 'uz';
  document.querySelectorAll<HTMLElement>('[data-uz]').forEach((el) => { el.textContent = el.dataset.uz!; });
  document.querySelectorAll<HTMLInputElement>('[data-uz-placeholder]').forEach((el) => { el.placeholder = el.dataset.uzPlaceholder!; });
  document.querySelectorAll<HTMLElement>('[data-uz-label]').forEach((el) => el.setAttribute('aria-label', el.dataset.uzLabel!));
}
document.querySelectorAll<HTMLButtonElement>('.lang-switch button').forEach((b) => {
  b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  b.addEventListener('click', () => { if (b.dataset.lang !== lang) setLang(b.dataset.lang as 'en' | 'uz'); });
});

const globe = new Globe($('#map'), base, api.readerLanguage());
const hint = $('#hint');
const wide = () => window.matchMedia('(min-width: 760px)').matches;
let looked: boolean | 'age' | 'complete' = false;
let tourStep: number | null = null;
/** True while the view is being rebuilt from the URL (first load, Back/Forward): the URL is already right. */
let restoring = false;

/** Every new place or species is a step in the browser history, so Back returns to the one before.
 *  Switching the records layer only rewrites the current step. */
const setHash = (s: ViewState, replace = false) => {
  const next = formatHash({ ...s, looked, tour: tourStep ?? undefined });
  const url = next || location.pathname + location.search;
  if (next === location.hash || (!next && !location.hash)) return;
  if (restoring || replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
};

const panelEl = $('#panel');
const sheet = initSheet(panelEl, $<HTMLButtonElement>('#panel .sheet-handle'), () => !wide(), () => pad());
const pad = () => {
  const open = !panelEl.hidden;
  globe.setPadding(open ? (wide() ? { right: 460 } : { bottom: sheet.height() * 0.95 }) : {});
};

const panel = new Panel(panelEl, $('#panel .panel-body'), {
  showSquare: (b) => globe.showSquare(b),
  showRange: (fc) => globe.showRange(fc),
  flyTo: (lon, lat) => globe.flyTo(lon, lat),
  setHash: (s) => setHash(s),
  journeys: {
    setOverlay: (src, fc) => globe.setOverlay(src, fc),
    dimRange: (d) => globe.dimRange(d),
    fitTo: (p) => globe.fitTo(p),
    base,
  },
  focusSearch: (placeholder) => {
    const input = $<HTMLInputElement>('#search');
    input.placeholder = placeholder;
    input.value = '';
    input.focus();
  },
  opened: (open) => {
    const was = document.body.classList.contains('panel-open');
    document.body.classList.toggle('panel-open', open);
    if (open && !was) sheet.reset();
    pad();
  },
});

window.addEventListener('resize', () => { sheet.refresh(); pad(); });

globe.onClick((lon, lat) => {
  hint.hidden = true;
  panel.showPlace(lat, lon);
});

initSearch($('#search'), $('#hits'), $('#search-status'),
  (id) => {
    hint.hidden = true;
    const from = panel.comparingFrom;
    const input = $<HTMLInputElement>('#search');
    input.placeholder = input.dataset[lang === 'uz' ? 'uzPlaceholder' : 'placeholder'] ?? input.placeholder;
    if (from && from !== id) panel.showCompare(from, id); else panel.showSpecies(id);
  },
  (p) => {
    hint.hidden = true;
    if (p.bbox) globe.fitBox(p.bbox); else globe.flyTo(p.lon, p.lat, 4);
    panel.showPlace(p.lat, p.lon);
  });

// Near me: the reader's own coast. The position stays in the browser; only the square's outline goes to OBIS.
const nearBtn = $<HTMLButtonElement>('#near-me');
if (!('geolocation' in navigator)) nearBtn.hidden = true;
nearBtn.addEventListener('click', () => {
  nearBtn.disabled = true;
  nearBtn.textContent = L('Finding you…', 'Joylashuv aniqlanmoqda…');
  navigator.geolocation.getCurrentPosition((pos) => {
    nearBtn.disabled = false; nearBtn.textContent = L('Near me', 'Yonimda');
    const { latitude: lat, longitude: lon } = pos.coords;
    hint.hidden = true;
    globe.flyTo(lon, lat, 4);
    panel.showPlace(lat, lon);
  }, (err) => {
    nearBtn.disabled = false; nearBtn.textContent = L('Near me', 'Yonimda');
    hint.hidden = false;
    hint.textContent = err.code === err.PERMISSION_DENIED
      ? L('Location is switched off for this site. Allow it in the browser, or click the sea near you.', 'Bu sayt uchun joylashuv oʻchirilgan. Brauzerda ruxsat bering yoki yaqiningizdagi dengizni bosing.')
      : L('Your location did not come through. Click the sea near you instead.', 'Joylashuvingiz aniqlanmadi. Oʻrniga yaqiningizdagi dengizni bosing.');
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
});

// "Where scientists have looked"
const lookedBtn = $<HTMLButtonElement>('#looked');
const legend = $('#legend');
type Looked = boolean | 'age' | 'complete';
const modeOf = (on: Looked) => (on === 'age' ? 'age' : on === 'complete' ? 'complete' : 'records');
let recordsNote = '';
const setLooked = async (on: Looked) => {
  looked = on;
  lookedBtn.setAttribute('aria-pressed', String(!!on));
  legend.hidden = !on;
  const mode = modeOf(on);
  legend.dataset.mode = mode;
  legend.querySelectorAll<HTMLButtonElement>('.mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  const note = $('#legend-note');
  try {
    const meta = await globe.setLooked(!!on);
    if (meta) recordsNote = L(`${fmt(meta.total)} OBIS records at sea in ${fmt(meta.cells)} squares, counted ${meta.fetched}; records on land are left out. Where you see the plain globe, nobody has recorded anything.`,
      `${fmt(meta.cells)} ta kvadratda dengizdagi ${fmt(meta.total)} ta OBIS yozuvi, ${meta.fetched} da sanalgan; quruqlikdagi yozuvlar chiqarilgan. Oddiy globus koʻringan joyda hech kim hech narsa qayd etmagan.`);
    if (on) await globe.setLookedMode(mode);
    const cm = globe.completeInfo;
    note.textContent = mode === 'complete' && cm
      ? L(`Share of the likely species already recorded (Chao1), in ${fmt(cm.cells)} hexagons of about 12,400 km²; grey: fewer than 20 species, too few to estimate. Built from the whole OBIS store (${cm.source.replace(/^.*read /, '')}).`,
        `Ehtimoliy turlarning qayd etilgan ulushi (Chao1), taxminan 12 400 km² lik ${fmt(cm.cells)} ta oltiburchakda; kulrang — 20 tadan kam tur, baholab boʻlmaydi. Butun OBIS maʼlumotidan hisoblangan (${cm.source.replace(/^.*read /, '')}).`)
      : recordsNote || note.textContent;
  } catch (e) {
    note.textContent = L('This layer did not load. Reload the page to try again.', 'Bu qatlam yuklanmadi. Sahifani qayta yuklang.');
    console.warn(e);
  }
  setHash(parseHash(location.hash), true);
};
lookedBtn.addEventListener('click', () => setLooked(looked ? false : true));
legend.querySelectorAll<HTMLButtonElement>('.mode button').forEach((b) => b.addEventListener('click', () => setLooked(b.dataset.mode === 'age' ? 'age' : b.dataset.mode === 'complete' ? 'complete' : true)));

// Guided tour
const tour = initTour($('#tour'), {
  place: (lat, lon, zoom) => { hint.hidden = true; globe.flyTo(lon, lat, zoom); panel.showPlace(lat, lon); },
  species: (id) => { hint.hidden = true; panel.showSpecies(id); },
  layer: (mode) => { setLooked(mode === 'age' ? 'age' : mode ? true : false); },
  globe: (lon, lat, zoom) => globe.flyTo(lon, lat, zoom),
  closePanel: () => { if (panel.isOpen) panel.close(); },
  setStep: (n) => { tourStep = n; setHash(parseHash(location.hash), true); },
});
$('#tour-open').addEventListener('click', () => { hint.hidden = true; tour.start(1); });

// Quiz
const quiz = initQuiz($<HTMLDialogElement>('#quiz'), {
  flyTo: (lon, lat, zoom) => globe.flyTo(lon, lat, zoom),
  showSquare: (b) => globe.showSquare(b),
  closePanel: () => { if (panel.isOpen) panel.close(); if (tour.open) tour.end(); },
});
$('#quiz-open').addEventListener('click', () => { hint.hidden = true; quiz.open(); });

// Migrations: the species with a MiCO network, by kind of animal, most connected first
const GROUP_NAME: Record<string, string> = lang === 'uz'
  ? { seaturtle: 'Dengiz toshbaqalari', mammal: 'Dengiz sutemizuvchilari', bird: 'Dengiz qushlari', fish: 'Baliqlar va akulalar' }
  : { seaturtle: 'Sea turtles', mammal: 'Sea mammals', bird: 'Seabirds', fish: 'Fish and sharks' };
const migrations = $<HTMLDialogElement>('#migrations');
const migFilter = $<HTMLInputElement>('#mig-filter');
$('#migrations-open').addEventListener('click', async () => {
  migrations.showModal();
  const list = migrations.querySelector<HTMLElement>('.mig-list')!;
  if (list.childElementCount) return;
  try {
    const idx = await api.micoIndex(base);
    const items = Object.entries(idx.species).sort((a, b) => b[1].routes - a[1].routes || b[1].sites - a[1].sites);
    for (const g of Object.keys(GROUP_NAME)) {
      const mine = items.filter(([, sp]) => sp.group === g);
      if (!mine.length) continue;
      const ul = h('ul', {});
      for (const [id, sp] of mine) {
        const b = h('button', { class: 'mig', attrs: { 'data-q': `${sp.common} ${sp.scientific}`.toLowerCase() } },
          h('span', { class: 'mig-name', text: sp.common }), h('span', { class: 'latin', text: sp.scientific }),
          h('span', { class: 'mig-n', text: sp.routes ? L(`${plural(sp.sites, 'place')}, ${plural(sp.routes, 'link')}`, `${fmt(sp.sites)} ta joy, ${fmt(sp.routes)} ta bogʻlanish`) : L(plural(sp.sites, 'place'), `${fmt(sp.sites)} ta joy`) }));
        b.addEventListener('click', () => { migrations.close(); hint.hidden = true; panel.showSpecies(Number(id)); });
        ul.append(h('li', {}, b));
      }
      list.append(h('section', { class: 'mig-group' }, h('h3', { text: `${GROUP_NAME[g]} (${mine.length})` }), ul));
    }
  } catch {
    list.append(h('p', { class: 'fine', text: L('The list did not load. Reload the page to try again.', 'Roʻyxat yuklanmadi. Sahifani qayta yuklang.') }));
  }
});
migFilter.addEventListener('input', () => {
  const qv = migFilter.value.trim().toLowerCase();
  migrations.querySelectorAll<HTMLElement>('.mig-group').forEach((sec) => {
    let any = false;
    sec.querySelectorAll<HTMLElement>('.mig').forEach((b) => { const ok = !qv || b.dataset.q!.includes(qv); b.parentElement!.hidden = !ok; any ||= ok; });
    sec.hidden = !any;
  });
});
migrations.querySelector('.about-close')?.addEventListener('click', () => migrations.close());
migrations.addEventListener('click', (e) => { if (e.target === migrations) migrations.close(); });

// About
const about = $<HTMLDialogElement>('#about');
$('#about-open').addEventListener('click', () => about.showModal());
about.querySelector('.about-close')?.addEventListener('click', () => about.close());
about.addEventListener('click', (e) => { if (e.target === about) about.close(); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !about.open && !migrations.open && panel.isOpen && document.activeElement !== $('#search')) panel.close();
  if (e.key === '/' && document.activeElement !== $('#search') && !(document.activeElement instanceof HTMLInputElement)) { e.preventDefault(); $('#search').focus(); }
});

// Deep links and Back/Forward
const apply = (s: ViewState) => {
  restoring = true;
  try {
    if ((s.looked ?? false) !== looked) setLooked(s.looked ?? false);
    if (s.tour && !tour.open) tour.start(s.tour);
    if (s.sp && s.vs) { hint.hidden = true; panel.showCompare(s.sp, s.vs); }
    else if (s.sp) {
      hint.hidden = true;
      if (s.at) { panel.rememberPlace(s.at.lat, s.at.lon); globe.flyTo(s.at.lon, s.at.lat, 3.2); }
      panel.showSpecies(s.sp, !!s.at);
    } else if (s.at) { hint.hidden = true; globe.flyTo(s.at.lon, s.at.lat, 4); panel.showPlace(s.at.lat, s.at.lon); }
    else if (panel.isOpen) panel.close(false);
  } finally { restoring = false; }
};
window.addEventListener('popstate', () => apply(parseHash(location.hash)));
apply(parseHash(location.hash));

// test hook for scripts/screenshots.mjs
(window as unknown as { __atlas: unknown }).__atlas = { globe, panel };
