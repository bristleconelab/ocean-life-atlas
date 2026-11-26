// Quiz: "Who lives here?" The globe flies to a well-known stretch of sea; one of four photographed animals has been
// recorded in that square, the other three come from the other quiz places and have never been recorded in it.
// Every answer is checked against the real OBIS lists, so the quiz can never be wrong about what is recorded.
import * as api from './api';
import { h, fmt, loadPhoto } from './dom';
import { bboxToWkt, geohash, geohashBounds, type BBox } from './geo';
import { L } from './i18n';
import { GROUP_LABEL, groupOf, rankSpecies, type GroupId, type Taxon } from './taxa';
import { commonsThumbs, type WikiInfo } from './wiki';

/** Places people have heard of, spread over the oceans and climates, so the four choices look different. */
export const QUIZ_PLACES: { name: string; uz: string; lat: number; lon: number }[] = [
  { name: 'Great Barrier Reef', uz: 'Katta toʻsiq rifi', lat: -16.5, lon: 146.2 },
  { name: 'Red Sea, Egypt', uz: 'Qizil dengiz, Misr', lat: 27.5, lon: 34.2 },
  { name: 'Galápagos Islands', uz: 'Galapagos orollari', lat: -0.6, lon: -90.4 },
  { name: 'Antarctic Peninsula', uz: 'Antarktida yarim oroli', lat: -64.8, lon: -63.5 },
  { name: 'Monterey Bay, California', uz: 'Monterey qoʻltigʻi, Kaliforniya', lat: 36.8, lon: -122.0 },
  { name: 'North Sea off Norway', uz: 'Norvegiya yaqinidagi Shimoliy dengiz', lat: 60.4, lon: 4.8 },
  { name: 'Hawaiian Islands', uz: 'Gavayi orollari', lat: 21.3, lon: -157.9 },
  { name: 'Florida Keys', uz: 'Florida Kis', lat: 24.7, lon: -81.0 },
  { name: 'Cape Town', uz: 'Keyptaun', lat: -34.2, lon: 18.4 },
  { name: 'Mediterranean, Balearic Islands', uz: 'Oʻrta yer dengizi, Balear orollari', lat: 39.6, lon: 2.9 },
];
const ROUNDS = 8;
/** Kinds a quiz player can picture: no plankton, worms or sponges. */
const FAMILIAR = new Set<GroupId>(['fish', 'sharks', 'turtles', 'mammals', 'birds', 'corals', 'molluscs', 'crustaceans', 'echinoderms']);

export interface QuizHost { flyTo(lon: number, lat: number, zoom: number): void; showSquare(b: BBox | null): void; closePanel(): void }

interface Candidate { id: number; sci: string; name: string; image: string; group: GroupId; records: number }
interface PlaceData { place: (typeof QUIZ_PLACES)[number]; box: BBox; ids: Set<number>; photo: Candidate[] }

/** Pick k distinct items at random. */
export function sample<T>(list: T[], k: number, rnd = Math.random): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, k);
}

/** One round: the answer from the place, decoys from other places that were never recorded here. */
export function buildRound(here: PlaceData, others: PlaceData[], rnd = Math.random): { answer: Candidate; choices: Candidate[] } | null {
  if (!here.photo.length) return null;
  const answer = sample(here.photo.slice(0, 25), 1, rnd)[0];
  const pool = others.flatMap((o) => o.photo.slice(0, 25)).filter((c) => !here.ids.has(c.id) && c.id !== answer.id);
  const uniq = [...new Map(pool.map((c) => [c.id, c])).values()];
  if (uniq.length < 3) return null;
  return { answer, choices: sample([answer, ...sample(uniq, 3, rnd)], 4, rnd) };
}

export function initQuiz(dialog: HTMLDialogElement, host: QuizHost) {
  const cache = new Map<string, Promise<PlaceData>>();
  const lang = api.readerLanguage();

  const load = (p: (typeof QUIZ_PLACES)[number]) => {
    const key = p.name;
    if (!cache.has(key)) cache.set(key, (async () => {
      const box = geohashBounds(geohash(p.lon, p.lat, 3));
      const cl = await api.obisChecklist(bboxToWkt(box));
      const list: Taxon[] = rankSpecies(cl.results);
      const top = list.filter((t) => FAMILIAR.has(groupOf(t))).slice(0, 60);
      const info = await api.wikidataByAphia(top.map((t) => t.taxonID), new Map(top.map((t) => [t.taxonID, t.scientificName])), lang).catch(() => new Map<number, WikiInfo>());
      const photo: Candidate[] = top.flatMap((t) => {
        const w = info.get(t.taxonID);
        return w?.image && w.name ? [{ id: t.taxonID, sci: t.scientificName, name: w.name, image: w.image, group: groupOf(t), records: t.records ?? 0 }] : [];
      });
      return { place: p, box, ids: new Set(cl.results.map((t) => t.taxonID)), photo };
    })());
    return cache.get(key)!;
  };

  const body = h('div', { class: 'quiz-body' });
  dialog.append(h('button', { class: 'about-close', text: '×', attrs: { 'aria-label': L('Close the quiz', 'Viktorinani yopish') }, on: { click: () => dialog.close() } }), body);
  let score = 0, round = 0, order: (typeof QUIZ_PLACES)[number][] = [];

  const finish = () => {
    host.showSquare(null);
    body.replaceChildren(
      h('h2', { text: L('Quiz finished', 'Viktorina tugadi') }),
      h('p', { class: 'quiz-score', text: L(`${score} of ${ROUNDS} right`, `${ROUNDS} tadan ${score} ta toʻgʻri`) }),
      h('p', { text: L('Every answer came from real records in OBIS. Click any square of sea to see its whole list.', 'Har bir javob OBIS dagi haqiqiy yozuvlardan olingan. Butun roʻyxatni koʻrish uchun dengizning istalgan kvadratini bosing.') }),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn small', text: L('Play again', 'Yana oʻynash'), on: { click: start } })));
  };

  const ask = async () => {
    if (round >= ROUNDS) { finish(); return; }
    const p = order[round % order.length];
    body.replaceChildren(h('p', { class: 'fine', text: L(`Question ${round + 1} of ${ROUNDS}: loading…`, `${ROUNDS} tadan ${round + 1}-savol: yuklanmoqda…`) }));
    host.flyTo(p.lon, p.lat, 4);
    try {
      const others = QUIZ_PLACES.filter((x) => x !== p);
      const [here, ...rest] = await Promise.all([load(p), ...sample(others, 3).map(load)]);
      if (!dialog.open) return;
      host.showSquare(here.box);
      const r = buildRound(here, rest);
      if (!r) { round++; ask(); return; }
      const grid = h('ul', { class: 'quiz-grid' });
      const note = h('p', { class: 'quiz-note', attrs: { 'aria-live': 'polite' } });
      const next = h('button', { class: 'btn small', text: round + 1 >= ROUNDS ? L('See the score', 'Natijani koʻrish') : L('Next question', 'Keyingi savol'), attrs: { hidden: true } });
      next.addEventListener('click', () => { round++; ask(); });
      for (const c of r.choices) {
        const frame = h('div', { class: `tile-photo g-${c.group}` });
        loadPhoto(frame, commonsThumbs(c.image, 330), '', true);
        const b = h('button', { class: 'quiz-choice' }, frame, h('span', { class: 'tile-name', text: c.name }), h('span', { class: 'latin', text: c.sci }));
        b.addEventListener('click', () => {
          if (grid.dataset.done) return;
          grid.dataset.done = '1';
          const right = c.id === r.answer.id;
          if (right) score++;
          grid.querySelectorAll<HTMLButtonElement>('.quiz-choice').forEach((x, i) => {
            x.disabled = true;
            x.classList.add(r.choices[i].id === r.answer.id ? 'right' : x === b ? 'wrong' : 'other');
          });
          note.textContent = right
            ? L(`Yes. ${r.answer.name} has ${fmt(r.answer.records)} records in this square (${GROUP_LABEL[r.answer.group].toLowerCase()}). The other three have never been recorded here.`,
              `Toʻgʻri. ${r.answer.name} bu kvadratda ${fmt(r.answer.records)} marta qayd etilgan. Qolgan uchtasi bu yerda hech qachon qayd etilmagan.`)
            : L(`Not this one: it has never been recorded here. The answer is ${r.answer.name}, with ${fmt(r.answer.records)} records in this square.`,
              `Bu emas: u bu yerda hech qachon qayd etilmagan. Javob: ${r.answer.name}, bu kvadratda ${fmt(r.answer.records)} marta qayd etilgan.`);
          next.hidden = false;
          next.focus();
        });
        grid.append(h('li', {}, b));
      }
      body.replaceChildren(
        h('p', { class: 'fine', text: L(`Question ${round + 1} of ${ROUNDS}, score ${score}`, `${ROUNDS} tadan ${round + 1}-savol, hisob ${score}`) }),
        h('h2', { text: L(`Who has been recorded here, ${p.name}?`, `Bu yerda kim qayd etilgan: ${p.uz}?`) }),
        grid, note, h('div', { class: 'btn-row' }, next));
    } catch {
      body.replaceChildren(h('p', { text: L('The species lists did not load. Check the connection and try again.', 'Turlar roʻyxati yuklanmadi. Internetni tekshirib, qayta urinib koʻring.') }),
        h('button', { class: 'btn small', text: L('Try again', 'Qayta urinish'), on: { click: ask } }));
    }
  };

  function start() { score = 0; round = 0; order = sample(QUIZ_PLACES, QUIZ_PLACES.length); ask(); }

  return {
    open: () => {
      host.closePanel();
      if (!dialog.open) dialog.show(); // not modal: the globe behind it moves with the questions
      start();
    },
  };
}
