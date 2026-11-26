// Guided tour: a few stops that each open a real view of the atlas (a place, a species, a layer) with two or three
// sentences on what to notice. The steps are a sequence, so they are numbered.
import { h } from './dom';
import { L } from './i18n';

export interface TourHost {
  place(lat: number, lon: number, zoom: number): void;
  species(id: number): void;
  layer(mode: false | 'records' | 'age'): void;
  globe(lon: number, lat: number, zoom: number): void;
  closePanel(): void;
  setStep(step: number | null): void;
}

interface Stop { title: string; text: string; go: (h: TourHost) => void }

export const STOPS: Stop[] = [
  { title: L('Where people have looked', 'Odamlar qayerni oʻrgangan'),
    text: L('Each square is coloured by how many records of sea life it holds, per 10,000 km². Bright coasts of Europe, North America and Australia; dark open ocean. A short species list usually means few people looked, not that little lives there.',
      'Har bir kvadrat 10 000 km² ga toʻgʻri keladigan dengiz hayoti yozuvlari soniga qarab boʻyalgan. Yevropa, Shimoliy Amerika va Avstraliya qirgʻoqlari yorqin, ochiq okean qorongʻi. Qisqa roʻyxat odatda u yerda kam hayot borligini emas, kam odam qaraganini bildiradi.'),
    go: (x) => { x.closePanel(); x.layer('records'); x.globe(-30, 15, 1.4); } },
  { title: L('The Great Barrier Reef', 'Katta toʻsiq rifi'),
    text: L('One square off Queensland holds more than 3,000 recorded species: reef fish, hard corals, giant clams, sea turtles and humpback whales passing through. Use the chips to see one kind at a time.',
      'Kvinslend yaqinidagi bitta kvadratda 3 000 dan ortiq tur qayd etilgan: rif baliqlari, marjonlar, ulkan tridaknalar, dengiz toshbaqalari va oʻtib ketadigan bukri kitlar. Bir turkumni koʻrish uchun tugmachalardan foydalaning.'),
    go: (x) => { x.layer(false); x.place(-16.5, 146.2, 4); } },
  { title: L('Galápagos: where currents meet', 'Galapagos: oqimlar uchrashadigan joy'),
    text: L('Cold water from the south and warm water from the north meet at the equator, so penguins and fur seals live beside tropical reef fish and hammerhead sharks.',
      'Janubdan sovuq va shimoldan iliq suv ekvatorda uchrashadi, shuning uchun pingvinlar va mushuk tyulenlari tropik rif baliqlari va bolgʻabosh akulalar bilan yonma-yon yashaydi.'),
    go: (x) => { x.layer(false); x.place(-0.6, -90.4, 4.5); } },
  { title: L('Leatherback sea turtles cross oceans', 'Teri toshbaqalari okeanlarni kesib oʻtadi'),
    text: L('Pink dots are nesting beaches, green ones feeding grounds. Press "Show their journeys" to load the tracks of tagged turtles, then "Play journeys": every turtle starts on the day it was tagged.',
      'Pushti nuqtalar — tuxum qoʻyadigan plyajlar, yashillari — oziqlanish joylari. Belgilangan toshbaqalarning yoʻllarini yuklash uchun "Yoʻllarini koʻrsat"ni, keyin "Yoʻllarni ijro et"ni bosing: har bir toshbaqa belgilangan kunidan boshlaydi.'),
    go: (x) => { x.layer(false); x.species(137209); } },
  { title: L('Humpback whales: food at the poles, calves in the tropics', 'Bukri kitlar: oziq qutblarda, bolalari tropikda'),
    text: L('Humpbacks feed in cold polar water in summer and swim thousands of kilometres to warm, shallow water to breed. Open "When it is recorded": north and south of the equator the seasons are opposite.',
      'Bukri kitlar yozda sovuq qutb suvida oziqlanadi va koʻpayish uchun minglab kilometr suzib iliq, sayoz suvga boradi. "Qachon qayd etilgan" boʻlimini oching: ekvatorning shimoli va janubida fasllar teskari.'),
    go: (x) => { x.layer(false); x.species(137092); } },
  { title: L('The open Pacific: hardly looked at', 'Ochiq Tinch okean: deyarli oʻrganilmagan'),
    text: L('Far from coasts and shipping lanes, a square the size of a small country may hold a few dozen records. This is most of the ocean.',
      'Qirgʻoqlar va kema yoʻllaridan uzoqda kichik davlatdek kvadratda bir necha oʻnlab yozuv boʻlishi mumkin. Okeanning katta qismi shunday.'),
    go: (x) => { x.layer('records'); x.place(8, -140, 2.6); } },
  { title: L('When was it last looked at?', 'Oxirgi marta qachon qaralgan?'),
    text: L('Squares coloured by their newest record: teal within 10 years, yellow 10 to 20, orange 20 to 50, purple older or undated. Purple water has not been looked at in a lifetime.',
      'Kvadratlar eng yangi yozuviga qarab boʻyalgan: zangori — 10 yil ichida, sariq — 10–20 yil, toʻq sariq — 20–50 yil, binafsha — undan eski yoki sanasiz. Binafsha suvga bir umr davomida hech kim qaramagan.'),
    go: (x) => { x.closePanel(); x.layer('age'); x.globe(20, 0, 1.4); } },
];

export function initTour(card: HTMLElement, host: TourHost) {
  let step = 0;
  const title = h('h2', { class: 'tour-title' });
  const text = h('p', { class: 'tour-text' });
  const count = h('span', { class: 'tour-count' });
  const prev = h('button', { class: 'btn small quiet' });
  const next = h('button', { class: 'btn small' });
  const close = h('button', { class: 'about-close', attrs: { 'aria-label': L('End the tour', 'Sayohatni tugatish') }, text: '×' });
  card.append(close, count, title, text, h('div', { class: 'btn-row' }, prev, next));

  const show = (i: number, move = true) => {
    step = Math.max(0, Math.min(STOPS.length - 1, i));
    const s = STOPS[step];
    card.hidden = false;
    count.textContent = L(`Stop ${step + 1} of ${STOPS.length}`, `${STOPS.length} tadan ${step + 1}-bekat`);
    title.textContent = s.title;
    text.textContent = s.text;
    prev.textContent = L('Back', 'Orqaga');
    prev.hidden = step === 0;
    next.textContent = step === STOPS.length - 1 ? L('Finish', 'Tugatish') : L('Next', 'Keyingisi');
    if (move) s.go(host);
    host.setStep(step + 1);
  };
  const end = () => { card.hidden = true; host.setStep(null); };
  prev.addEventListener('click', () => show(step - 1));
  next.addEventListener('click', () => (step === STOPS.length - 1 ? end() : show(step + 1)));
  close.addEventListener('click', end);
  return { start: (i = 1) => show(i - 1), end, get open() { return !card.hidden; } };
}
