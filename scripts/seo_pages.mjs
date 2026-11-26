// Generate the static, crawlable pages that sit beside the globe app (search engines cannot read #sp=/#at= links):
//   public/species/<slug>/index.html   one page per well-known sea animal: records, years, depth, temperature, Red List,
//                                      migration network, photo, names in English and Uzbek (+ Taxon, Breadcrumb JSON-LD)
//   public/places/<slug>/index.html    one page per well-known sea: species count, completeness, most-recorded animals
//   public/species/, public/places/    index pages
//   public/about/index.html            what the atlas shows, FAQ, how to cite (+ WebApplication, Dataset, FAQPage JSON-LD)
//   public/sitemap.xml, public/robots.txt
// Numbers come live from OBIS, WoRMS and Wikidata at build time and are written into the pages.
// usage: node scripts/seo_pages.mjs        (a few minutes; commit the output; then scripts/indexnow.sh after deploy)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'public');
const SITE = 'https://oceanlife.bristleconelab.org';
const REPO = 'https://github.com/bristleconelab/ocean-life-atlas';
const UPDATED = new Date().toISOString().slice(0, 10);
const UA = { 'User-Agent': 'ocean-life-atlas seo build (github.com/bristleconelab/ocean-life-atlas)' };
const OBIS = 'https://api.obis.org/v3';

/** Famous sea animals beyond the 109 MiCO species, by scientific name (WoRMS gives the id). */
const EXTRA = {
  'Octopus vulgaris': 'Common octopus', 'Amphiprion ocellaris': 'Clownfish', 'Tridacna gigas': 'Giant clam', 'Mobula alfredi': 'Reef manta ray',
  'Tursiops truncatus': 'Bottlenose dolphin', 'Orcinus orca': 'Orca', 'Carcharodon carcharias': 'Great white shark', 'Physeter macrocephalus': 'Sperm whale',
  'Hippocampus kuda': 'Spotted seahorse', 'Acanthaster planci': 'Crown-of-thorns starfish', 'Aurelia aurita': 'Moon jellyfish', 'Enhydra lutris': 'Sea otter',
  'Dugong dugon': 'Dugong', 'Pterois volitans': 'Red lionfish', 'Architeuthis dux': 'Giant squid', 'Nautilus pompilius': 'Chambered nautilus',
  'Homarus americanus': 'American lobster', 'Euphausia superba': 'Antarctic krill', 'Gadus morhua': 'Atlantic cod', 'Thunnus thynnus': 'Atlantic bluefin tuna',
  'Sphyrna mokarran': 'Great hammerhead', 'Galeocerdo cuvier': 'Tiger shark', 'Aptenodytes forsteri': 'Emperor penguin', 'Odobenus rosmarus': 'Walrus',
  'Monodon monoceros': 'Narwhal', 'Delphinapterus leucas': 'Beluga whale', 'Mola mola': 'Ocean sunfish', 'Xiphias gladius': 'Swordfish',
  'Carcharhinus leucas': 'Bull shark', 'Pomacanthus imperator': 'Emperor angelfish', 'Chelonia mydas': 'Green sea turtle', 'Rhincodon typus': 'Whale shark',
  'Balaenoptera musculus': 'Blue whale', 'Megaptera novaeangliae': 'Humpback whale', 'Dermochelys coriacea': 'Leatherback sea turtle',
  'Manta birostris': 'Giant manta ray', 'Paracentrotus lividus': 'Purple sea urchin', 'Pagophilus groenlandicus': 'Harp seal',
  'Zalophus californianus': 'California sea lion', 'Hapalochlaena lunulata': 'Greater blue-ringed octopus',
};

/** Seas people search for; the square is the one the atlas opens for that point. */
const PLACES = [
  ['great-barrier-reef', 'Great Barrier Reef', 'Katta toʻsiq rifi', -16.5, 146.2],
  ['red-sea', 'Red Sea (Hurghada, Egypt)', 'Qizil dengiz', 27.5, 34.2],
  ['galapagos-islands', 'Galápagos Islands', 'Galapagos orollari', -0.6, -90.4],
  ['antarctic-peninsula', 'Antarctic Peninsula', 'Antarktida yarim oroli', -64.8, -63.5],
  ['monterey-bay', 'Monterey Bay, California', 'Monterey qoʻltigʻi', 36.8, -122.0],
  ['north-sea-norway', 'North Sea off Norway', 'Shimoliy dengiz, Norvegiya', 60.4, 4.8],
  ['hawaii', 'Hawaiian Islands (Oʻahu)', 'Gavayi orollari', 21.3, -157.9],
  ['florida-keys', 'Florida Keys', 'Florida Kis', 24.7, -81.0],
  ['cape-town', 'Cape Town', 'Keyptaun', -34.2, 18.4],
  ['balearic-islands', 'Mediterranean Sea, Balearic Islands', 'Oʻrta yer dengizi, Balear orollari', 39.6, 2.9],
  ['maldives', 'Maldives', 'Maldiv orollari', 4.2, 73.5],
  ['caspian-sea', 'Caspian Sea (south-east coast)', 'Kaspiy dengizi', 37.5, 53.5],
];

// ---------------- helpers ----------------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;
const fmt = (n) => Number(n).toLocaleString('en-US');
const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, tries = 4) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { headers: { ...UA, Accept: 'application/json, application/sparql-results+json' } }).catch((e) => ({ ok: false, status: 0, e }));
    if (r.ok) return r.status === 204 ? null : r.json();
    if (i >= tries || (r.status && r.status < 500 && r.status !== 429)) throw new Error(`${r.status} ${url}`);
    await sleep(1500 * (i + 1));
  }
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
const md5 = async (s) => (await import('node:crypto')).createHash('md5').update(s).digest('hex');
async function thumb(file, w = 640) {
  const name = file.replace(/ /g, '_');
  const h = await md5(name);
  return `https://upload.wikimedia.org/wikipedia/commons/thumb/${h[0]}/${h.slice(0, 2)}/${encodeURIComponent(name)}/${w}px-${encodeURIComponent(name)}`;
}
/** Middle 50 % of binned depth records (OBIS ladder: 10 m to 200, 100 m to 1,000, 1,000 m below). */
function depthRange(bins) {
  const w = (f) => (f < 200 ? 10 : f < 1000 ? 100 : 1000);
  const s = bins.filter((b) => b.from >= 0 && b.records > 0).sort((a, b) => a.from - b.from);
  const tot = s.reduce((t, b) => t + b.records, 0);
  if (tot < 10) return null;
  const q = (p) => { let acc = 0; for (let i = 0; i < s.length; i++) { const b = s[i], wd = Math.min(w(b.from), s[i + 1] ? s[i + 1].from - b.from : Infinity); if (acc + b.records >= p * tot) return b.from + ((p * tot - acc) / b.records) * wd; acc += b.records; } return s.at(-1).from; };
  // the same rounding as the atlas (src/taxa.ts depthRange), so page and globe agree
  const step = (v) => (v < 100 ? 5 : v < 1000 ? 10 : 100);
  const lo = q(0.25), hi = q(0.75);
  return { from: Math.floor(lo / step(lo)) * step(lo), to: Math.max(Math.ceil(hi / step(hi)) * step(hi), 5), records: tot };
}
function sstRange(sst) {
  const s = sst.filter((b) => b.records > 0).sort((a, b) => a.sst - b.sst);
  const tot = s.reduce((t, b) => t + b.records, 0);
  if (tot < 10) return null;
  const q = (p) => { let acc = 0; for (const b of s) { if (acc + b.records >= p * tot) return b.sst + ((p * tot - acc) / b.records) * 5; acc += b.records; } return s.at(-1).sst + 5; };
  return { from: Math.round(q(0.1)), to: Math.round(q(0.9)) };
}
const IUCN = { CR: 'Critically endangered', EN: 'Endangered', VU: 'Vulnerable', NT: 'Near threatened', LC: 'Least concern', DD: 'Data deficient', EX: 'Extinct' };
const geohashBox = (lon, lat) => {
  const lo = [-180, 180], la = [-90, 90]; let even = true;
  for (let bit = 0; bit < 15; bit++) { const r = even ? lo : la, v = even ? lon : lat, mid = (r[0] + r[1]) / 2; if (v >= mid) r[0] = mid; else r[1] = mid; even = !even; }
  return { w: lo[0], e: lo[1], s: la[0], n: la[1] };
};

// ---------------- data ----------------
async function wikidata(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const vals = ids.slice(i, i + 50).map((x) => `"${x}"`).join(' ');
    const q = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?aphia (SAMPLE(?img) AS ?image) (SAMPLE(?l_en) AS ?en) (SAMPLE(?c_en) AS ?cen) (SAMPLE(?l_uz) AS ?uz) WHERE {
  VALUES ?aphia { ${vals} } ?i wdt:P850 ?aphia . OPTIONAL { ?i wdt:P12765 ?acc } BIND(COALESCE(?acc, ?i) AS ?item)
  OPTIONAL { ?item wdt:P18 ?img } OPTIONAL { ?item rdfs:label ?l_en FILTER(LANG(?l_en) = "en") }
  OPTIONAL { ?item rdfs:label ?l_uz FILTER(LANG(?l_uz) = "uz") }
  OPTIONAL { ?item wdt:P1843 ?c_en FILTER(LANG(?c_en) = "en") }
} GROUP BY ?aphia`;
    const r = await get(`https://qlever.dev/api/wikidata?query=${encodeURIComponent(q)}`);
    for (const b of r.results.bindings) {
      const img = b.image?.value ? decodeURIComponent(b.image.value.split('Special:FilePath/')[1]).replace(/_/g, ' ') : null;
      // Wikidata often labels a taxon with its scientific name; the everyday name then sits in P1843
      const sci = (b.en?.value ?? '').match(/^[A-Z][a-z]+ [a-z-]+$/) ? b.en.value : null;
      const en = sci && b.cen?.value ? b.cen.value : b.en?.value ?? b.cen?.value;
      out.set(Number(b.aphia.value), { image: img, en: en ? en.charAt(0).toUpperCase() + en.slice(1) : undefined, uz: b.uz?.value });
    }
  }
  return out;
}

async function main() {
  const mico = JSON.parse(readFileSync(join(PUB, 'data', 'mico', 'index.json'), 'utf8')).species;
  const ids = new Map(Object.entries(mico).map(([id, m]) => [Number(id), { mico: m }]));
  const extraName = new Map();
  for (const name of Object.keys(EXTRA)) {
    let id = await get(`https://www.marinespecies.org/rest/AphiaIDByName/${encodeURIComponent(name)}?marine_only=true`).catch(() => null);
    if (id === -999) { const recs = await get(`https://www.marinespecies.org/rest/AphiaRecordsByName/${encodeURIComponent(name)}?like=false&marine_only=true`).catch(() => []); id = (recs?.find((x) => x.status === 'accepted') ?? recs?.[0])?.valid_AphiaID; }
    if (Number.isInteger(id) && id > 0) { const rec = await get(`https://www.marinespecies.org/rest/AphiaRecordByAphiaID/${id}`).catch(() => null); const v = rec?.valid_AphiaID ?? id; extraName.set(v, EXTRA[name]); if (!ids.has(v)) ids.set(v, {}); }
    else console.warn(`no WoRMS id for ${name}`);
  }
  console.log(`${ids.size} species`);
  const wd = await wikidata([...ids.keys()]);
  const species = (await pool([...ids.entries()], 4, async ([id, x]) => {
    const [taxon, stats, env, grid] = await Promise.all([
      get(`${OBIS}/taxon/${id}`).then((r) => r.results?.[0]).catch(() => null),
      get(`${OBIS}/statistics?taxonid=${id}`).catch(() => null),
      get(`${OBIS}/statistics/env?taxonid=${id}`).catch(() => null),
      get(`${OBIS}/occurrence/grid/3?taxonid=${id}&exclude=ON_LAND`).catch(() => null),
    ]);
    if (!taxon || !stats?.records) return null;
    const w = wd.get(id) ?? {};
    // names people search for: our own list first, then MiCO's (checked by its authors), then Wikidata's English label
    const wdName = w.en && w.en.toLowerCase() !== taxon.scientificName.toLowerCase() ? w.en : null;
    const common = extraName.get(id) ?? x.mico?.common ?? wdName ?? taxon.scientificName;
    return { id, sci: taxon.scientificName, common: common.charAt(0).toUpperCase() + common.slice(1), uz: w.uz && w.uz.toLowerCase() !== taxon.scientificName.toLowerCase() ? w.uz : null,
      image: w.image ? await thumb(w.image) : null, imageFile: w.image, family: taxon.family, order: taxon.order, cls: taxon.class, iucn: taxon.category,
      records: stats.records, years: stats.yearrange, datasets: stats.datasets, depth: env ? depthRange(env.depth ?? []) : null, sst: env ? sstRange(env.sst ?? []) : null,
      squares: grid?.features?.length ?? 0, mico: x.mico ?? null };
  })).filter(Boolean);
  const used = new Set();
  for (const s of species) { let k = slug(s.common) || slug(s.sci); if (used.has(k)) k = slug(`${s.common} ${s.sci}`); used.add(k); s.slug = k; }
  species.sort((a, b) => a.common.localeCompare(b.common));
  console.log(`${species.length} species pages`);

  const places = (await pool(PLACES, 3, async ([sl, name, uz, lat, lon]) => {
    const b = geohashBox(lon, lat);
    const wkt = `POLYGON((${b.w} ${b.s},${b.e} ${b.s},${b.e} ${b.n},${b.w} ${b.n},${b.w} ${b.s}))`;
    const [cl, st] = await Promise.all([get(`${OBIS}/checklist?geometry=${encodeURIComponent(wkt)}&size=5000&exclude=ON_LAND`), get(`${OBIS}/statistics?geometry=${encodeURIComponent(wkt)}&exclude=ON_LAND`)]);
    const sp = cl.results.filter((t) => t.taxonRank === 'Species' && ['Animalia', 'Plantae', 'Chromista'].includes(t.kingdom))
      .filter((t) => !(t.is_marine !== true && t.is_brackish !== true && (t.is_terrestrial === true || t.is_freshwater === true)))
      .sort((a, c) => (c.records ?? 0) - (a.records ?? 0));
    const counts = sp.map((t) => t.records ?? 0);
    const f1 = counts.filter((n) => n === 1).length, f2 = counts.filter((n) => n === 2).length;
    const complete = cl.results.length < cl.total ? null : sp.length / (sp.length + (f1 * (f1 - 1)) / (2 * (f2 + 1)));
    const animals = sp.filter((t) => t.kingdom === 'Animalia' && /Teleostei|Actinopteri|Elasmobranchii|Mammalia|Aves|Hexacorallia|Cephalopoda|Gastropoda|Bivalvia|Malacostraca|Asteroidea|Echinoidea/.test(t.class ?? '')).slice(0, 40);
    const names = await wikidata(animals.map((t) => t.taxonID));
    const top = animals.map((t) => ({ id: t.taxonID, sci: t.scientificName, en: names.get(t.taxonID)?.en, records: t.records })).filter((t) => t.en && t.en.toLowerCase() !== t.sci.toLowerCase()).slice(0, 15);
    return { slug: sl, name, uz, lat, lon, species: sp.length, records: st.records, years: st.yearrange, complete, total: cl.total, fetched: cl.results.length, top };
  }));
  return { species, places };
}

// ---------------- pages ----------------
const CSS = `:root{color-scheme:dark;--bg:#0b2233;--panel:#12384a;--line:rgba(168,213,200,.2);--ink:#f4f8f7;--muted:#b6cdd1;--accent:#f2c94c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
a{color:var(--accent)}main{max-width:820px;margin:0 auto;padding:16px 16px 64px}header.top{display:flex;align-items:center;justify-content:space-between;gap:12px;max-width:820px;margin:0 auto;padding:16px}
header.top a.brand{color:var(--ink);text-decoration:none;font-weight:700;font-size:20px}.cta{display:inline-block;background:var(--accent);color:#1a1a1a;font-weight:600;text-decoration:none;padding:10px 18px;border-radius:999px}
h1{font-size:clamp(28px,5vw,42px);line-height:1.1;margin:8px 0 6px;letter-spacing:-.02em}.sci{font-family:Georgia,serif;font-style:italic;color:var(--muted);font-size:20px;margin:0 0 14px}
h2{font-size:24px;margin:36px 0 8px}.lede{font-size:19px}figure{margin:18px 0}figure img{width:100%;max-height:460px;object-fit:cover;border-radius:12px;display:block}figcaption{color:var(--muted);font-size:13px;margin-top:6px}
table{border-collapse:collapse;width:100%;font-size:15px}td,th{border-bottom:1px solid var(--line);padding:8px 6px;text-align:left;vertical-align:top}td:last-child{font-weight:600}
ul.grid{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}ul.grid a{display:block;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--panel);text-decoration:none;color:var(--ink)}
ul.grid small{display:block;color:var(--muted);font-style:italic}.crumbs{font-size:14px;color:var(--muted)}.crumbs a{color:var(--muted)}pre{white-space:pre-wrap;background:var(--panel);border-radius:10px;padding:12px;font-size:14px}
footer{max-width:820px;margin:0 auto;padding:24px 16px 40px;color:var(--muted);font-size:14px;border-top:1px solid var(--line)}`;

function page({ path, title, description, image, body, jsonld = [] }) {
  const url = `${SITE}${path}`;
  const img = image ?? `${SITE}/og-image.png`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%230b2233'/%3E%3Cpath d='M6 18c4-5 9-6 14-3l5-3-1 5 1 5-5-3c-5 3-10 2-14-1z' fill='%23f2c94c'/%3E%3C/svg%3E">
<meta property="og:type" content="website"><meta property="og:site_name" content="Ocean Life Atlas">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}"><meta property="og:image" content="${esc(img)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#0b2233">
<style>${CSS}</style>
${jsonld.map(ld).join('\n')}
</head>
<body>
<header class="top"><a class="brand" href="/">Ocean Life Atlas</a><a class="cta" href="/">Open the 3D globe</a></header>
<main>
${body}
</main>
<footer>
<p>Ocean Life Atlas is an independent, open-source project of <a href="https://bristleconelab.org">Bristlecone Lab</a>, built on open data from OBIS, WoRMS, Wikidata and MiCO. Numbers as of ${UPDATED}.</p>
<p><a href="/">3D globe</a> · <a href="/species/">Sea animals</a> · <a href="/places/">Seas</a> · <a href="/about/">About &amp; FAQ</a> · <a href="${REPO}">Source code</a></p>
</footer>
</body>
</html>
`;
}
const crumbs = (items) => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${SITE}${path}` })) });

function speciesPage(s) {
  const y = s.years ? `${s.years[0]} to ${s.years[1]}` : null;
  const facts = [
    ['Scientific name', `<i>${esc(s.sci)}</i>`],
    s.uz && ['In Uzbek', esc(s.uz)],
    ['Group', esc([s.cls, s.order, s.family].filter(Boolean).join(', '))],
    s.iucn && IUCN[s.iucn] && ['IUCN Red List', IUCN[s.iucn]],
    ['Records in OBIS', fmt(s.records)],
    y && ['Recorded', y],
    ['Places at sea (1.4° squares)', fmt(s.squares)],
    s.depth && ['Usual depth (middle half of records)', `${fmt(s.depth.from)}–${fmt(s.depth.to)} m`],
    s.sst && ['Sea surface temperature where recorded', `${s.sst.from}–${s.sst.to} °C`],
    s.mico && ['Migration network (MiCO)', `${fmt(s.mico.sites)} places${s.mico.routes ? `, ${fmt(s.mico.routes)} links` : ''}`],
  ].filter(Boolean);
  const lede = `${s.common} (<i>${esc(s.sci)}</i>) has been recorded ${fmt(s.records)} times in the Ocean Biodiversity Information System${y ? `, from ${y}` : ''}, in ${fmt(s.squares)} places at sea${s.depth ? `, usually ${fmt(s.depth.from)} to ${fmt(s.depth.to)} m deep` : ''}.`;
  const desc = `Where does the ${s.common.toLowerCase()} live? Map of ${fmt(s.records)} records, how deep it lives${s.mico ? ', its migration routes' : ''} and when it is seen, from open ocean data.`;
  const body = `<p class="crumbs"><a href="/">Ocean Life Atlas</a> › <a href="/species/">Sea animals</a> › ${esc(s.common)}</p>
<h1>${esc(s.common)}: where it lives</h1>
<p class="sci">${esc(s.sci)}${s.uz ? ` · ${esc(s.uz)}` : ''}</p>
${s.image ? `<figure><img src="${esc(s.image)}" alt="${esc(s.common)}" loading="lazy" width="640"><figcaption>Photo: <a href="https://commons.wikimedia.org/wiki/File:${encodeURIComponent(s.imageFile.replace(/ /g, '_'))}">Wikimedia Commons</a> (see the file page for author and licence)</figcaption></figure>` : ''}
<p class="lede">${lede}</p>
<p><a class="cta" href="/#sp=${s.id}">See its range on the 3D globe</a></p>
<h2>Key facts</h2>
<table>${facts.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</table>
<h2>On the globe</h2>
<p>The species page in the atlas shows every 1.4° square of sea where it has been recorded, a photo and a short summary, how deep it lives zone by zone${s.mico ? ', its migration network (breeding, feeding and stopover places and the links between them) and the tracks of tagged animals' : ''}, the months it is recorded north and south of the equator, records by decade, and records before 1990 against records since 2010.</p>
<p>Records show where people looked as much as where the animal lives: a blank part of the ocean usually means nobody has surveyed it.</p>
<p>Data: <a href="https://obis.org/taxon/${s.id}">OBIS</a>, <a href="https://www.marinespecies.org/aphia.php?p=taxdetails&amp;id=${s.id}">WoRMS AphiaID ${s.id}</a>${s.mico ? ', <a href="https://doi.org/10.1038/s41467-025-59271-7">MiCO</a>' : ''}.</p>`;
  return page({ path: `/species/${s.slug}/`, title: `${s.common} (${s.sci}): where it lives, how deep, migration map`, description: desc, image: s.image, body,
    jsonld: [{ '@context': 'https://schema.org', '@type': 'Taxon', name: s.sci, alternateName: [s.common, s.uz].filter(Boolean), taxonRank: 'species',
      identifier: `urn:lsid:marinespecies.org:taxname:${s.id}`, sameAs: [`https://www.marinespecies.org/aphia.php?p=taxdetails&id=${s.id}`, `https://obis.org/taxon/${s.id}`],
      url: `${SITE}/species/${s.slug}/`, ...(s.image ? { image: s.image } : {}) },
    crumbs([['Ocean Life Atlas', '/'], ['Sea animals', '/species/'], [s.common, `/species/${s.slug}/`]])] });
}

function placePage(p, bySci) {
  const pct = p.complete != null ? Math.round(p.complete * 100) : null;
  const y = p.years ? `${p.years[0]} to ${p.years[1]}` : null;
  const body = `<p class="crumbs"><a href="/">Ocean Life Atlas</a> › <a href="/places/">Seas</a> › ${esc(p.name)}</p>
<h1>What lives in the ${esc(p.name.replace(/^the /i, ''))}?</h1>
<p class="sci">${esc(p.uz)} · ${Math.abs(p.lat).toFixed(1)}° ${p.lat >= 0 ? 'N' : 'S'}, ${Math.abs(p.lon).toFixed(1)}° ${p.lon >= 0 ? 'E' : 'W'}</p>
<p class="lede">${fmt(p.species)} species of sea life have been recorded in the 1.4° square around this point (about 150 km across), from ${fmt(p.records)} records${y ? ` made from ${y}` : ''}.${pct != null ? ` By the Chao1 estimate that is about ${pct} % of the species more looking would probably find.` : ''}</p>
<p><a class="cta" href="/#at=${p.lat.toFixed(2)},${p.lon.toFixed(2)}">See every species with photos</a></p>
<h2>Most-recorded animals here</h2>
<ul class="grid">${p.top.map((t) => { const s = bySci.get(t.sci); const inner = `${esc(t.en)}<small>${esc(t.sci)} · ${fmt(t.records)} records</small>`; return `<li>${s ? `<a href="/species/${s.slug}/">${inner}</a>` : `<a href="/#sp=${t.id}">${inner}</a>`}</li>`; }).join('')}</ul>
${p.species < 300 ? `<p><b>Few records:</b> this water is barely covered in OBIS (${fmt(p.records)} records). Most of the life here has never been recorded there, so the list is only a start.</p>` : ''}
<p>Record counts reflect where people looked and what they looked for, not only what is common: bird counts and plankton surveys produce many records.</p>
<p>Data: <a href="https://obis.org">OBIS</a> checklist for this square, records flagged as on land left out.</p>`;
  return page({ path: `/places/${p.slug}/`, title: `What lives in the ${p.name.replace(/^the /i, '')}? ${fmt(p.species)} species on a map`,
    description: `${fmt(p.species)} species of sea life recorded around the ${p.name}: fish, corals, turtles, sharks, whales and more, with photos and names, from open ocean data.`, body,
    jsonld: [{ '@context': 'https://schema.org', '@type': 'Place', name: p.name, geo: { '@type': 'GeoCoordinates', latitude: p.lat, longitude: p.lon }, url: `${SITE}/places/${p.slug}/` },
      crumbs([['Ocean Life Atlas', '/'], ['Seas', '/places/'], [p.name, `/places/${p.slug}/`]])] });
}

function aboutPage(species, places) {
  const faq = [
    ['What is Ocean Life Atlas?', 'A free, open-source 3D globe of life in the sea. Click any spot to see the animals and plants recorded within a square about 150 km across, with photos and everyday names, or search an animal to see where it lives, how deep, how it migrates and when it is seen.'],
    ['Where does the data come from?', 'Species records, ranges, depths and temperatures come from OBIS, the Ocean Biodiversity Information System of UNESCO\'s Intergovernmental Oceanographic Commission. Names come from the World Register of Marine Species (WoRMS), photos and everyday names from Wikimedia Commons and Wikidata, migration networks from MiCO (Bentley et al. 2025).'],
    ['Why does part of the ocean look empty?', 'Because nobody has recorded anything there. Most of the open ocean has hardly been surveyed. The atlas shows where people have looked, how long ago, and how complete each area\'s species list probably is (Chao1 estimate).'],
    ['Can I download the data?', 'Yes. Each square\'s species list downloads as CSV, each species range as GeoJSON, and the code that builds the atlas is MIT-licensed on GitHub. Each data source keeps its own licence.'],
    ['Is it available in Uzbek?', 'Yes. The interface switches between English and Uzbek (EN / UZ), and animal names and Wikipedia summaries follow the chosen language where Wikidata has them.'],
  ];
  const body = `<p class="crumbs"><a href="/">Ocean Life Atlas</a> › About</p>
<h1>About Ocean Life Atlas</h1>
<p class="lede">Click the sea, see who lives there. An open, plain-language atlas of ocean life on a 3D globe, built on more than 200 million records of where marine species were seen or sampled.</p>
<p><a class="cta" href="/">Open the 3D globe</a></p>
<h2>Questions</h2>
${faq.map(([q, a]) => `<h3>${esc(q)}</h3><p>${esc(a)}</p>`).join('\n')}
<h2>Explore</h2>
<p><a href="/species/">${fmt(species.length)} well-known sea animals</a> and <a href="/places/">${fmt(places.length)} seas</a> have their own pages.</p>
<h2>How to cite</h2>
<pre>Ocean Life Atlas (${UPDATED.slice(0, 4)}). Bristlecone Lab. ${SITE}/ (accessed ${UPDATED}). Data: OBIS (${UPDATED.slice(0, 4)}) Ocean Biodiversity Information System, Intergovernmental Oceanographic Commission of UNESCO, https://obis.org.</pre>`;
  return page({ path: '/about/', title: 'About Ocean Life Atlas: an open 3D globe of sea life', description: 'What Ocean Life Atlas shows, where its data comes from (OBIS, WoRMS, Wikidata, MiCO), how complete the ocean\'s species lists are, and how to cite it.', body,
    jsonld: [{ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
      { '@context': 'https://schema.org', '@type': 'Dataset', name: 'Ocean inventory completeness by H3 cell (Chao1), from OBIS',
        description: 'For every H3 resolution-3 hexagon of the ocean (~12,400 km²): species recorded, species recorded once and twice, records, newest year and the bias-corrected Chao1 inventory-completeness estimate, computed from the full OBIS open-data store (records not dropped, not absences, not flagged as on land).',
        url: `${SITE}/about/`, isAccessibleForFree: true, license: 'https://creativecommons.org/licenses/by/4.0/', creator: { '@type': 'Organization', name: 'Bristlecone Lab', url: 'https://bristleconelab.org' },
        distribution: [{ '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: `${SITE}/data/completeness-h3.json` }],
        isBasedOn: 'https://obis.org', keywords: ['marine biodiversity', 'OBIS', 'species richness', 'Chao1', 'sampling completeness', 'H3'],
        spatialCoverage: { '@type': 'Place', geo: { '@type': 'GeoShape', box: '-90 -180 90 180' } }, dateModified: UPDATED },
      crumbs([['Ocean Life Atlas', '/'], ['About', '/about/']])] });
}

function indexPage(path, title, description, h1, items) {
  return page({ path, title, description, body: `<p class="crumbs"><a href="/">Ocean Life Atlas</a> › ${esc(h1)}</p><h1>${esc(h1)}</h1><p class="lede">${esc(description)}</p><ul class="grid">${items}</ul>`,
    jsonld: [crumbs([['Ocean Life Atlas', '/'], [h1, path]])] });
}

const out = await main();
const write = (path, html) => { const f = join(PUB, path, 'index.html'); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, html); };
rmSync(join(PUB, 'species'), { recursive: true, force: true });
rmSync(join(PUB, 'places'), { recursive: true, force: true });
const bySci = new Map(out.species.map((s) => [s.sci, s]));
for (const s of out.species) write(`species/${s.slug}`, speciesPage(s));
for (const p of out.places) write(`places/${p.slug}`, placePage(p, bySci));
write('species', indexPage('/species/', 'Sea animals: where they live, how deep, migration maps', `${out.species.length} well-known sea animals, from whale sharks to octopuses, each with its range, depth and records from open ocean data.`, 'Sea animals',
  out.species.map((s) => `<li><a href="/species/${s.slug}/">${esc(s.common)}<small>${esc(s.sci)}</small></a></li>`).join('')));
write('places', indexPage('/places/', 'Seas and reefs: what lives there', `${out.places.length} well-known seas and reefs with the number of species recorded, how complete the list is, and the most-recorded animals.`, 'Seas and reefs',
  out.places.map((p) => `<li><a href="/places/${p.slug}/">${esc(p.name)}<small>${fmt(p.species)} species</small></a></li>`).join('')));
write('about', aboutPage(out.species, out.places));
const urls = ['/', '/about/', '/species/', '/places/', ...out.places.map((p) => `/places/${p.slug}/`), ...out.species.map((s) => `/species/${s.slug}/`)];
writeFileSync(join(PUB, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE}${u}</loc><lastmod>${UPDATED}</lastmod></url>`).join('\n')}\n</urlset>\n`);
writeFileSync(join(PUB, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
writeFileSync(join(PUB, 'data', 'seo-summary.json'), JSON.stringify({ updated: UPDATED, species: out.species.map((s) => ({ slug: s.slug, id: s.id, common: s.common, records: s.records })), places: out.places.map((p) => ({ slug: p.slug, species: p.species, complete: p.complete })) }));
console.log(`${urls.length} URLs -> public/sitemap.xml`);
