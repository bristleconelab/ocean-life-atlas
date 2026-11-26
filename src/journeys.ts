// Species-page sections about movement and time:
//   "How it travels"     MiCO migration network (stored) and satellite-tag tracks from OBIS (live, on request)
//   "When it is recorded" records by month (from a random sample), north and south apart, and by decade
import * as api from './api';
import { h, fmt, plural } from './dom';
import { L, lang, MONTHS_UZ } from './i18n';
import { greatCircle } from './geo';
import { ACTIVITY_COLORS, TRACK_COLORS, type ActivityKind } from './map';
import { groupOf, mammalKind, type Taxon } from './taxa';
import {
  buildTracks, decadeCounts, isTelemetry, MAX_KM_PER_DAY, SEACOW_KM_PER_DAY, seasonCounts, trackAtElapsed,
  type OccRow, type Track,
} from './tracks';

export type Overlay = 'micoRoutes' | 'micoSites' | 'tracks' | 'heads';
export interface JourneyHost {
  setOverlay(source: Overlay, fc: GeoJSON.FeatureCollection | null): void;
  dimRange(dim: boolean): void;
  fitTo(points: [number, number][]): void;
  base: string;
}

/** Rows fetched for tracks at most. Whole studies only (see api.obisTrackRows). */
const MAX_TRACK_ROWS = 40000;
const MAX_TRACK_STUDIES = 40;
const MAX_TRACKS_DRAWN = 150;
const PLAY_MS = 16000;
const FULL_MONTHS = lang === 'uz' ? MONTHS_UZ : ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS = FULL_MONTHS.map((m) => m.slice(0, 3));
const ext = { target: '_blank', rel: 'noopener' };
const DAY = 86400000;

const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features });

/** MiCO activity words ("Breeding;Feeding", "Staging Site", "Wintering") to the few kinds the map colours. */
export function activityKind(act: string): ActivityKind {
  if (/breed|nest|calv|pup|spawn|nurser|hatch|fledg|rear/i.test(act)) return 'breeding';
  if (/feed|forag/i.test(act)) return 'feeding';
  if (/migrat|stopover|staging|homing/i.test(act)) return 'migrating';
  if (/winter|summer|hibernat/i.test(act)) return 'season';
  return 'observed';
}
export const ACTIVITY_LABEL: Record<ActivityKind, string> = lang === 'uz'
  ? { breeding: 'koʻpayish, uya yoki bolalash', feeding: 'oziqlanish', migrating: 'yoʻldagi toʻxtash', season: 'mavsumni oʻtkazadi', observed: 'koʻrilgan' }
  : { breeding: 'breeding, nesting or nursery', feeding: 'feeding', migrating: 'stopover on the move', season: 'spends a season', observed: 'seen' };

/** The busiest run of three consecutive months (wrapping Dec to Jan), or null when records are spread evenly. */
export function peakSeason(m: number[]): { from: number; to: number; share: number } | null {
  const total = m.reduce((a, b) => a + b, 0);
  if (total < 30) return null;
  let best = 0, at = 0;
  for (let i = 0; i < 12; i++) {
    const s = m[i] + m[(i + 1) % 12] + m[(i + 2) % 12];
    if (s > best) { best = s; at = i; }
  }
  const share = best / total;
  return share >= 0.4 ? { from: at, to: (at + 2) % 12, share } : null; // three months hold 25 % by chance
}

/** Fastest believable travel for this kind of animal, for the location-error filter. */
export function speedCapFor(t: Taxon | null): number {
  if (!t) return MAX_KM_PER_DAY.default;
  const g = groupOf(t);
  if (g === 'mammals' && mammalKind(t) === 'seacow') return SEACOW_KM_PER_DAY;
  return MAX_KM_PER_DAY[g] ?? MAX_KM_PER_DAY.default;
}

const years = (tr: Track) => {
  const a = new Date(tr.start).getUTCFullYear(), b = new Date(tr.end).getUTCFullYear();
  return a === b ? String(a) : `${a}–${b}`;
};
const animalLabel = (tr: Track) => (/^\d+$/.test(tr.animal) ? L(`Tag ${tr.animal}`, `Belgi ${tr.animal}`) : tr.animal);

export interface JourneyOpts {
  id: number; commonName: string; taxon: Taxon | null;
  /** Move the globe to the network when it loads. Off when the reader came from a place: the camera stays there. */
  frame: boolean;
  signal: AbortSignal;
}

/** Everything a species page adds below the summary. Returns a cleanup that stops animations and clears the globe. */
export function renderJourneys(o: JourneyOpts, mount: HTMLElement, host: JourneyHost, alive: () => boolean): () => void {
  let raf = 0, stopped = false;
  const cleanup = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    for (const s of ['micoRoutes', 'micoSites', 'tracks', 'heads'] as const) host.setOverlay(s, null);
    host.dimRange(false);
  };
  const ok = () => alive() && !stopped;
  const { id, commonName } = o;

  const travel = h('section', { class: 'journeys' }, h('h3', { text: L('How it travels', 'Qanday sayohat qiladi') }));
  const micoBox = h('div', { class: 'mico' });
  const tagBox = h('div', { class: 'tags' }, h('p', { class: 'fine', text: L('Looking for tagged animals…', 'Belgilangan hayvonlar qidirilmoqda…') }));
  travel.append(micoBox, tagBox);
  const when = h('section', { class: 'seasons' }, h('h3', { text: L('When it is recorded', 'Qachon qayd etilgan') }), h('p', { class: 'fine', text: L('Loading…', 'Yuklanmoqda…') }));
  mount.append(travel, when);

  const shown = { mico: false, tracks: false };
  const updateDim = () => host.dimRange(shown.mico || shown.tracks);

  // ---- MiCO network ----
  api.micoIndex(host.base).then(async (idx) => {
    const meta = idx.species[String(id)];
    if (!meta || !ok()) { micoBox.remove(); return; }
    const d = await api.micoSpecies(host.base, id);
    if (!ok()) return;
    const sites = fc(d.sites.map(([lon, lat, n, act]) => ({
      type: 'Feature', properties: { n, kind: activityKind(act), act, species: d.common }, geometry: { type: 'Point', coordinates: [lon, lat] },
    })));
    const routes = fc(d.routes.map(([x1, y1, x2, y2, tracked, both]) => ({
      type: 'Feature', properties: { tracked, both, species: d.common }, geometry: { type: 'LineString', coordinates: greatCircle([x1, y1], [x2, y2], 24) },
    })));
    const points = d.sites.map(([lon, lat]) => [lon, lat] as [number, number]);
    const toggle = h('button', { class: 'btn small', text: L('Hide the network', 'Tarmoqni yashirish'), attrs: { 'aria-pressed': 'true' } });
    const frame = h('button', { class: 'btn small quiet', text: L('Show on the globe', 'Globusda koʻrsatish') });
    const show = (on: boolean) => {
      shown.mico = on;
      host.setOverlay('micoSites', on ? sites : null);
      host.setOverlay('micoRoutes', on ? routes : null);
      toggle.textContent = on ? L('Hide the network', 'Tarmoqni yashirish') : L('Show the network', 'Tarmoqni koʻrsatish');
      toggle.setAttribute('aria-pressed', String(on));
      updateDim();
    };
    toggle.addEventListener('click', () => show(!shown.mico));
    frame.addEventListener('click', () => { show(true); host.fitTo(points); });
    const kinds = [...new Set(sites.features.map((f) => f.properties!.kind as ActivityKind))];
    const tracked = d.routes.filter((r) => r[4]).length, inferred = d.routes.length - tracked;
    const what = d.routes.length
      ? L(`${plural(d.sites.length, 'place')} where this species gathers and ${plural(d.routes.length, 'link')} between them`, `bu tur toʻplanadigan ${fmt(d.sites.length)} ta joy va ular orasidagi ${fmt(d.routes.length)} ta bogʻlanish`)
      : L(`${plural(d.sites.length, 'place')} where this species gathers; no links between them are published yet`, `bu tur toʻplanadigan ${fmt(d.sites.length)} ta joy; ular orasidagi bogʻlanishlar hali eʼlon qilinmagan`);
    micoBox.append(
      h('p', { text: L(`Migration network: ${what}, pieced together from published tracking and tagging studies.`, `Migratsiya tarmogʻi: ${what}; eʼlon qilingan kuzatuv va belgilash tadqiqotlaridan yigʻilgan.`) }),
      h('ul', { class: 'legend-dots' },
        ...kinds.map((k) => h('li', {}, h('span', { class: 'dot', attrs: { style: `background:${ACTIVITY_COLORS[k]}` } }), ACTIVITY_LABEL[k])),
        tracked ? h('li', {}, h('span', { class: 'line' }), L(`followed by tagged animals (${fmt(tracked)})`, `belgilangan hayvonlar bosib oʻtgan (${fmt(tracked)})`)) : null,
        inferred ? h('li', {}, h('span', { class: 'line dashed' }), L(`linked by other studies (${fmt(inferred)})`, `boshqa tadqiqotlar bogʻlagan (${fmt(inferred)})`)) : null),
      h('div', { class: 'btn-row' }, toggle, frame),
      h('p', { class: 'fine', text: L('Lines join two places the animals use; they do not trace the water they swam through, so some cross land. Dashed links come from studies that connect the places without tracking the trip, such as tag returns. Places are summaries of many animals, not exact spots.', 'Chiziqlar hayvonlar foydalanadigan ikki joyni bogʻlaydi; ular suzilgan yoʻlni koʻrsatmaydi, shuning uchun baʼzilari quruqlikni kesib oʻtadi. Uzuq chiziqlar sayohatni kuzatmasdan joylarni bogʻlagan tadqiqotlardan (masalan, qaytgan belgilar). Joylar aniq nuqtalar emas, koʻp hayvonlarning umumlashmasi.') }),
      h('p', { class: 'fine' }, 'MiCO, ', h('a', { text: 'Bentley et al. 2025, Nature Communications', attrs: { href: 'https://doi.org/10.1038/s41467-025-59271-7', ...ext } }),
        '; data ', h('a', { text: 'CC0', attrs: { href: 'https://doi.org/10.5281/zenodo.14873514', ...ext } }), '.'),
    );
    show(true);
    if (o.frame) host.fitTo(points);
  }).catch(() => micoBox.remove());

  // ---- sample: seasonality now, tracks on request ----
  Promise.all([api.obisSample(id, o.signal).catch(() => null), api.obisYears(id).catch(() => [])]).then(([sample, yrs]) => {
    if (!ok()) return;
    renderSeasons(when, sample?.results ?? [], yrs, sample?.total ?? 0);
    if (!sample) { tagBox.replaceChildren(h('p', { class: 'fine', text: L('Tracking data did not load. Open the species again to retry.', 'Kuzatuv maʼlumotlari yuklanmadi. Turni qayta oching.') })); return; }
    const tagged = new Map<string, Set<string>>(), rowsPer = new Map<string, number>();
    for (const r of sample.results) if (isTelemetry(r)) {
      if (!tagged.has(r.dataset_id!)) tagged.set(r.dataset_id!, new Set());
      tagged.get(r.dataset_id!)!.add(r.organismID!);
      rowsPer.set(r.dataset_id!, (rowsPer.get(r.dataset_id!) ?? 0) + 1);
    }
    const studies = [...rowsPer.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s).slice(0, MAX_TRACK_STUDIES);
    if (!tagged.size) {
      const all = sample.results.length >= sample.total;
      tagBox.replaceChildren(h('p', { class: 'fine', text: all
        ? L(`None of the ${fmt(sample.total)} OBIS records of ${commonName.toLowerCase()} comes from a tagged animal.`, `${commonName} ning ${fmt(sample.total)} ta OBIS yozuvidan hech biri belgilangan hayvondan emas.`)
        : L(`None of a random ${fmt(sample.results.length)} of its ${fmt(sample.total)} OBIS records comes from a tagged animal, so tag studies are rare or absent for it.`, `Uning ${fmt(sample.total)} ta OBIS yozuvidan tasodifiy ${fmt(sample.results.length)} tasining hech biri belgilangan hayvondan emas, demak belgilash tadqiqotlari kam yoki yoʻq.`) }));
      return;
    }
    const animals = [...tagged.values()].reduce((a, s) => a + s.size, 0);
    const go = h('button', { class: 'btn small', text: L('Show their journeys', 'Yoʻllarini koʻrsat') });
    const status = h('p', { class: 'fine', attrs: { 'aria-live': 'polite' } });
    tagBox.replaceChildren(
      h('p', { text: L(`Tagged animals: at least ${fmt(animals)} carried a satellite or acoustic tag, in ${plural(tagged.size, 'study', 'studies')} published to OBIS.`, `Belgilangan hayvonlar: OBIS da eʼlon qilingan ${fmt(tagged.size)} ta tadqiqotda kamida ${fmt(animals)} tasi sunʼiy yoʻldosh yoki akustik belgi taqqan.`) }),
      go, status);
    go.addEventListener('click', async () => {
      go.disabled = true;
      status.textContent = L('Loading tracking records…', 'Kuzatuv yozuvlari yuklanmoqda…');
      try {
        const { rows, used, skipped } = await api.obisTrackRows(id, studies, MAX_TRACK_ROWS, o.signal,
          (got) => { if (ok()) status.textContent = L(`Loading tracking records: ${fmt(got)}…`, `Kuzatuv yozuvlari yuklanmoqda: ${fmt(got)}…`); });
        if (!ok()) return;
        showTracks(buildTracks(rows, 5, speedCapFor(o.taxon)), used.length, skipped.length);
      } catch {
        if (ok()) { status.textContent = L('Tracking records did not load. Try again in a moment.', 'Kuzatuv yozuvlari yuklanmadi. Birozdan keyin qayta urinib koʻring.'); go.disabled = false; }
      }
    });

    const showTracks = (tracks: Track[], usedStudies: number, skippedStudies: number) => {
      if (!tracks.length) {
        tagBox.replaceChildren(h('p', { class: 'fine', text: skippedStudies && !usedStudies
          ? L('These tag studies are too large to load in the browser. Open them on OBIS to see the tracks.', 'Bu belgilash tadqiqotlari brauzerga yuklash uchun juda katta. Yoʻllarni koʻrish uchun ularni OBIS da oching.')
          : L('The tag records here are too sparse to draw a path.', 'Bu yerdagi belgi yozuvlari yoʻl chizish uchun juda siyrak.') }));
        return;
      }
      const drawn = tracks.slice(0, MAX_TRACKS_DRAWN);
      let only: number | null = null;
      const props = (tr: Track, i: number) => ({ c: i, name: animalLabel(tr), km: tr.km, years: years(tr), species: commonName });
      const pick = <T,>(list: T[]) => list.filter((_, i) => only == null || i === only);
      const full = () => fc(drawn.flatMap((tr, i) => (only != null && i !== only ? [] : tr.segments.map((seg) => ({
        type: 'Feature' as const, properties: props(tr, i), geometry: { type: 'LineString' as const, coordinates: seg.map(([x, y]) => [x, y]) },
      })))));
      const heads = (ms: number | null) => fc(drawn.flatMap((tr, i) => {
        if (only != null && i !== only) return [];
        const p = ms == null ? tr.segments.at(-1)!.at(-1)!.slice(0, 2) as [number, number] : trackAtElapsed(tr, ms).head;
        return p ? [{ type: 'Feature' as const, properties: props(tr, i), geometry: { type: 'Point' as const, coordinates: p } }] : [];
      }));
      const draw = () => { host.setOverlay('tracks', full()); host.setOverlay('heads', heads(null)); };
      shown.tracks = true;
      updateDim();
      draw();
      host.fitTo(drawn.flatMap((tr) => tr.segments.flat().map(([x, y]) => [x, y] as [number, number])));

      const play = h('button', { class: 'btn small', text: L('Play journeys', 'Yoʻllarni ijro et') });
      const clock = h('span', { class: 'clock', attrs: { 'aria-live': 'off' } });
      let longest = 0;
      for (const tr of drawn) longest = Math.max(longest, tr.end - tr.start);
      play.addEventListener('click', () => {
        cancelAnimationFrame(raf);
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
        const span = only != null ? drawn[only].end - drawn[only].start : longest;
        const t0 = performance.now();
        let last = 0;
        const frame = (now: number) => {
          if (!ok()) return;
          const f = reduce ? 1 : Math.min(1, (now - t0) / PLAY_MS);
          if (now - last > 40 || f === 1) { // ~25 frames a second is plenty and keeps the globe smooth
            last = now;
            const ms = f * span;
            host.setOverlay('tracks', fc(pick(drawn.map((tr, i) => [tr, i] as const)).flatMap(([tr, i]) => trackAtElapsed(tr, ms).upto.map((part) => ({
              type: 'Feature' as const, properties: props(tr, i), geometry: { type: 'LineString' as const, coordinates: part },
            })))));
            host.setOverlay('heads', heads(ms));
            const moving = pick(drawn).filter((tr) => tr.end - tr.start >= ms).length;
            clock.textContent = L(`Day ${fmt(Math.round(ms / DAY))} after tagging, ${plural(moving, 'animal')} still sending`, `Belgilangandan keyin ${fmt(Math.round(ms / DAY))}-kun, ${fmt(moving)} ta hayvon hali signal beryapti`);
          }
          if (f < 1) raf = requestAnimationFrame(frame);
          else { clock.textContent = L('Every journey, from tagging to the last signal', 'Har bir yoʻl, belgilashdan oxirgi signalgacha'); draw(); }
        };
        raf = requestAnimationFrame(frame);
      });

      const showAll = h('button', { class: 'link-btn', text: L('Show every animal', 'Hamma hayvonlarni koʻrsatish'), attrs: { hidden: true } });
      const items = drawn.slice(0, 8).map((tr, i) => {
        const b = h('button', { class: 'track-item', attrs: { 'aria-pressed': 'false' } },
          h('span', { class: 'dot', attrs: { style: `background:${TRACK_COLORS[i % TRACK_COLORS.length]}` } }),
          `${animalLabel(tr)}: ${fmt(tr.km)} km, ${years(tr)}`);
        b.addEventListener('click', () => {
          cancelAnimationFrame(raf);
          only = only === i ? null : i;
          list.querySelectorAll('.track-item').forEach((x, k) => x.setAttribute('aria-pressed', String(k === only)));
          showAll.hidden = only == null;
          draw();
          host.fitTo((only == null ? drawn : [drawn[only]]).flatMap((t) => t.segments.flat().map(([x, y]) => [x, y] as [number, number])));
        });
        return h('li', {}, b);
      });
      const list = h('ol', { class: 'track-list' }, ...items);
      showAll.addEventListener('click', () => (list.querySelector<HTMLButtonElement>(`.track-item[aria-pressed="true"]`))?.click());
      const credits = h('p', { class: 'fine', text: L('Loading who tagged them…', 'Ularni kim belgilagani yuklanmoqda…') });
      const dropped = tracks.reduce((a, t) => a + t.dropped, 0);
      tagBox.replaceChildren(
        h('p', { text: L(`${plural(tracks.length, 'tagged animal')}; the longest path is ${fmt(drawn[0].km)} km. Each colour is one animal${tracks.length > drawn.length ? ` (the ${drawn.length} longest are drawn)` : ''}. Pick one to see it alone.`, `${fmt(tracks.length)} ta belgilangan hayvon; eng uzun yoʻl ${fmt(drawn[0].km)} km. Har bir rang bitta hayvon${tracks.length > drawn.length ? ` (eng uzun ${drawn.length} tasi chizilgan)` : ''}. Alohida koʻrish uchun bittasini tanlang.`) }),
        h('div', { class: 'play-row' }, play, clock), list, showAll, credits,
        h('p', { class: 'fine', text: L(`Acoustic tags are heard only near listening stations, so their paths join those stations. Gaps of more than 20 days are left open. Fixes that would need more than ${fmt(speedCapFor(o.taxon))} km a day are dropped as location errors${dropped ? ` (${fmt(dropped)} here)` : ''}, and moves under 5 km are not added to the distance, so jitter in the fixes does not inflate it.`, `Akustik belgilar faqat tinglash stansiyalari yaqinida eshitiladi, shuning uchun ularning yoʻllari shu stansiyalarni bogʻlaydi. 20 kundan uzun uzilishlar ochiq qoldiriladi. Kuniga ${fmt(speedCapFor(o.taxon))} km dan tez harakatni talab qiladigan nuqtalar joylashuv xatosi sifatida tashlanadi${dropped ? ` (bu yerda ${fmt(dropped)} ta)` : ''}, 5 km dan kichik siljishlar masofaga qoʻshilmaydi, shuning uchun nuqtalar titrashi uni oshirmaydi.`) }));
      if (skippedStudies) tagBox.append(h('p', { class: 'fine', text: L(`${plural(skippedStudies, 'large study', 'large studies')} did not fit in the browser and ${skippedStudies === 1 ? 'is' : 'are'} left out; every study drawn is complete.`, `${fmt(skippedStudies)} ta katta tadqiqot brauzerga sigʻmadi va chiqarib tashlandi; chizilgan har bir tadqiqot toʻliq.`) }));

      const byDataset = new Map<string, number>();
      for (const tr of drawn) byDataset.set(tr.dataset, (byDataset.get(tr.dataset) ?? 0) + 1);
      const top = [...byDataset.entries()].sort((a, b) => b[1] - a[1]);
      Promise.all(top.slice(0, 6).map(([d]) => api.obisDataset(d))).then((metas) => {
        if (!ok()) return;
        const its = metas.filter((m): m is api.DatasetMeta => !!m);
        credits.replaceChildren(L('Tracks from ', 'Yoʻllar manbasi: '), ...its.flatMap((m, i) => [
          i ? (i === its.length - 1 && top.length <= 6 ? ' and ' : ', ') : '',
          h('a', { text: m.title, attrs: { href: m.url, ...ext } }), ` (${m.licence})`,
        ]), top.length > 6 ? L(` and ${top.length - 6} more studies in OBIS.`, ` va OBIS dagi yana ${top.length - 6} ta tadqiqot.`) : L(', through OBIS.', ', OBIS orqali.'));
        if (its.some((m) => /aggregated|1-degree|rounded/i.test(m.title))) {
          credits.after(h('p', { class: 'fine', text: L('Some studies publish positions rounded to 1° squares to protect the animals, so their paths look stepped.', 'Baʼzi tadqiqotlar hayvonlarni himoya qilish uchun joylashuvni 1° kvadratlarga yaxlitlab eʼlon qiladi, shuning uchun yoʻllari zinapoyasimon koʻrinadi.') }));
        }
      });
    };
  });

  return cleanup;
}

function monthChart(m: number[], label: string): HTMLElement {
  const max = Math.max(...m, 1);
  return h('ol', { class: 'months', attrs: { 'aria-label': label } }, ...m.map((v, i) => h('li', { attrs: { title: `${FULL_MONTHS[i]}: ${fmt(v)}` } },
    h('span', { class: 'mbar', attrs: { style: `--h:${(v / max) * 100}%` } }), h('span', { class: 'mlabel', text: MONTHS[i][0] }))));
}

function seasonLine(m: number[], where: string): string {
  const peak = peakSeason(m);
  return peak ? L(`${where}: most records from ${FULL_MONTHS[peak.from]} to ${FULL_MONTHS[peak.to]} (${Math.round(peak.share * 100)} %).`, `${where}: koʻp yozuvlar ${FULL_MONTHS[peak.from]}dan ${FULL_MONTHS[peak.to]}gacha (${Math.round(peak.share * 100)} %).`)
    : `${where}: recorded all year round, without a clear season.`;
}

function renderSeasons(section: HTMLElement, rows: OccRow[], yrs: { year: number; records: number }[], total: number) {
  const { all, north, south } = seasonCounts(rows);
  const n = all.reduce((a, b) => a + b, 0), nN = north.reduce((a, b) => a + b, 0), nS = south.reduce((a, b) => a + b, 0);
  const dec = decadeCounts(yrs);
  section.replaceChildren(h('h3', { text: L('When it is recorded', 'Qachon qayd etilgan') }));
  if (n >= 30) {
    // two charts when both halves of the globe have enough records; else one, named for the half that has them
    const both = nN >= 30 && nS >= 30 && Math.min(nN, nS) / n >= 0.1;
    if (both) {
      section.append(
        h('p', { text: seasonLine(north, L('North of the equator', 'Ekvatordan shimolda')) }), monthChart(north, L('Records by month, north of the equator', 'Oylar boʻyicha yozuvlar, ekvatordan shimolda')),
        h('p', { text: seasonLine(south, L('South of the equator', 'Ekvatordan janubda')) }), monthChart(south, L('Records by month, south of the equator', 'Oylar boʻyicha yozuvlar, ekvatordan janubda')));
    } else {
      const where = nN >= nS ? L('Mostly north of the equator', 'Asosan ekvatordan shimolda') : L('Mostly south of the equator', 'Asosan ekvatordan janubda');
      section.append(h('p', { text: seasonLine(nN >= nS ? north : south, where) }), monthChart(nN >= nS ? north : south, L('Records by month', 'Oylar boʻyicha yozuvlar')));
    }
    section.append(h('p', { class: 'fine', text: L(`From a random sample of ${fmt(n)} dated records${total > rows.length ? ` out of ${fmt(total)}` : ''}; a tagged animal counts once a day. North and south of the equator the seasons are opposite, so they are kept apart.`, `${total > rows.length ? `${fmt(total)} ta yozuvdan ` : ''}sanasi bor ${fmt(n)} ta tasodifiy yozuv asosida; belgilangan hayvon kuniga bir marta sanaladi. Ekvatorning shimoli va janubida fasllar teskari, shuning uchun ular alohida.`) }));
  }
  if (dec.length > 1) {
    const max = Math.max(...dec.map((d) => d.records));
    const tick = (d: number, i: number) => i === 0 || i === dec.length - 1 || d % 50 === 0;
    section.append(
      h('ol', { class: 'decades', attrs: { 'aria-label': L('Records by decade', 'Oʻn yilliklar boʻyicha yozuvlar') } }, ...dec.map((d) => h('li', { attrs: { title: `${d.decade}s: ${fmt(d.records)}` } },
        h('span', { class: 'mbar', attrs: { style: `--h:${Math.max(d.records ? 4 : 0, Math.sqrt(d.records / max) * 100)}%` } })))),
      h('ol', { class: 'decade-axis', attrs: { 'aria-hidden': 'true' } }, ...dec.map((d, i) => h('li', { text: tick(d.decade, i) && !(i > 0 && i < dec.length - 1 && (dec.length - 1 - i < 3 || i < 3)) ? String(d.decade) : '' }))),
      h('p', { class: 'fine', text: L(`Records per decade, ${dec[0].decade}s to ${dec.at(-1)!.decade}s. Bar height grows with the square root, so small decades stay visible. Both charts also show when people went looking.`, `Oʻn yilliklar boʻyicha yozuvlar, ${dec[0].decade}–${dec.at(-1)!.decade} yillar. Ustun balandligi kvadrat ildiz boʻyicha oʻsadi, shuning uchun kichik oʻn yilliklar ham koʻrinadi. Ikkala grafik odamlar qachon izlaganini ham koʻrsatadi.`) }),
    );
  }
  if (n < 30 && dec.length <= 1) section.append(h('p', { class: 'fine', text: L('Too few dated records to show a pattern.', 'Qonuniyat koʻrsatish uchun sanali yozuvlar juda kam.') }));
}
