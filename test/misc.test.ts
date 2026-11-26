import { describe, expect, it } from 'vitest';
import { pickSeaName, speciesQuery } from '../src/api';
import { mergeHits, rankHits } from '../src/search-merge';
import { formatHash, parseHash } from '../src/state';
import { articleTitle, commonsFile, commonsThumb, parseWikidata, pickName } from '../src/wiki';

describe('url state', () => {
  it('round-trips place, species and layer', () => {
    const s = { at: { lat: 22.52, lon: 69.61 }, sp: 105847, looked: true };
    expect(parseHash(formatHash(s))).toEqual(s);
  });
  it('ignores junk', () => {
    expect(parseHash('#at=999,1&sp=-3&layer=x')).toEqual({});
    expect(formatHash({})).toBe('');
  });
});

describe('wikidata', () => {
  it('reads file names and article titles', () => {
    expect(commonsFile('http://commons.wikimedia.org/wiki/Special:FilePath/Whale%20shark%20Georgia%20aquarium.jpg')).toBe('Whale shark Georgia aquarium.jpg');
    expect(commonsThumb('A b.jpg', 360)).toBe('https://upload.wikimedia.org/wikipedia/commons/thumb/9/96/A_b.jpg/500px-A_b.jpg');
    expect(articleTitle('https://en.wikipedia.org/wiki/Whale_shark')).toBe('Whale_shark');
  });
  it('never shows the scientific name as the common name', () => {
    expect(pickName({ label: { value: 'Rhincodon typus' }, commonEn: { value: 'whale shark' } }, 'Rhincodon typus')).toBe('Whale shark');
    expect(pickName({ common: { value: 'kit akula' } }, 'Rhincodon typus')).toBe('Kit akula');
    expect(pickName({ label: { value: 'Rhincodon typus' } }, 'Rhincodon typus')).toBeUndefined();
    expect(pickName({ label: { value: 'Species code: Hs' }, labelEn: { value: 'Halophila stipulacea' } }, 'Halophila stipulacea')).toBeUndefined();
  });
  it('parses SPARQL bindings', () => {
    const m = parseWikidata([{ aphia: { value: '105847' }, image: { value: 'http://commons.wikimedia.org/wiki/Special:FilePath/X.jpg' }, labelEn: { value: 'whale shark' } }]);
    expect(m.get(105847)).toEqual({ name: 'Whale shark', image: 'X.jpg', article: undefined });
  });
});

describe('search merge', () => {
  it('dedupes synonyms to the accepted id and puts common-name hits first', () => {
    const worms = [
      { AphiaID: 1, scientificname: 'Rhiniodon typus', status: 'unaccepted', rank: 'Species', valid_AphiaID: 105847, valid_name: 'Rhincodon typus', kingdom: 'Animalia', phylum: 'Chordata', class: 'Elasmobranchii', order: null, family: null },
      { AphiaID: 105847, scientificname: 'Rhincodon typus', status: 'accepted', rank: 'Species', valid_AphiaID: 105847, valid_name: 'Rhincodon typus', kingdom: 'Animalia', phylum: 'Chordata', class: 'Elasmobranchii', order: null, family: null },
    ];
    const obis = [{ taxonID: 105706, id: 105706, acceptedNameUsageID: 105706, scientificName: 'Rhincodontidae', rank: 'Family', kingdom: 'Animalia' }];
    const hits = mergeHits(worms, obis as never, 'whale shark');
    expect(hits.map((x) => x.id)).toEqual([105847, 105706]);
    expect(hits[0].group).toBe('sharks');
  });
});

describe('sea names', () => {
  it('prefers the most specific water body and adds the ocean', () => {
    const r = [
      { preferredGazetteerName: 'Gujarat', placeType: 'State' },
      { preferredGazetteerName: 'Indian Ocean', placeType: 'IHO Sea Area' },
      { preferredGazetteerName: 'Gulf of Kutch', placeType: 'Gulf' },
      { preferredGazetteerName: 'Northern Arabian Sea', placeType: 'General Sea Area' },
    ];
    expect(pickSeaName(r)).toEqual({ name: 'Gulf of Kutch, Indian Ocean', land: false });
    expect(pickSeaName([{ preferredGazetteerName: 'Indian Ocean', placeType: 'IHO Sea Area' }])).toEqual({ name: 'Indian Ocean', land: false });
    expect(pickSeaName([])).toBeNull();
  });
  it('prefers a named sea over the ocean (real Great Barrier Reef answer, trimmed)', () => {
    const r = ['Great Barrier Reef|Reef', 'Queensland|State', 'South Pacific Ocean|IHO Sea Area', 'Pacific Ocean|Ocean', 'Coral Sea|IHO Sea Area', 'Central Indo-Pacific|Realm']
      .map((s) => { const [preferredGazetteerName, placeType] = s.split('|'); return { preferredGazetteerName, placeType }; });
    expect(pickSeaName(r)).toEqual({ name: 'Great Barrier Reef, Coral Sea', land: false });
  });
  it('names inland seas such as the Caspian (typed Lake, real answer trimmed)', () => {
    const r = ['Turkmen Exclusive Economic Zone|EEZ', 'Caspian Sea|Lake', 'Asia|Continent']
      .map((s) => { const [preferredGazetteerName, placeType] = s.split('|'); return { preferredGazetteerName, placeType }; });
    expect(pickSeaName(r)).toEqual({ name: 'Caspian Sea', land: false });
  });
  it('says land when only land places match (real inland Arabia answer, trimmed)', () => {
    const r = ['Saudi Arabia|Nation', 'Asia|Continent', 'Central Indo-Pacific|General Sea Area']
      .map((s) => { const [preferredGazetteerName, placeType] = s.split('|'); return { preferredGazetteerName, placeType }; });
    expect(pickSeaName(r)).toEqual({ name: 'Saudi Arabia', land: true });
  });
});

describe('search ranking', () => {
  const hit = (id: number, scientificName: string, rank = 'Species', exact = false) => ({ id, scientificName, rank, group: 'molluscs' as const, viaCommon: true, exact });
  it('puts the exact common name first, then the most recorded species', () => {
    const hits = [hit(1, 'Abdopus horridus'), hit(2, 'Octopus cyanea'), hit(3, 'Octopus', 'Genus'), hit(4, 'Octopus vulgaris', 'Species', true)];
    const counts = new Map([[1, 12], [2, 900], [4, 11102]]);
    expect(rankHits(hits, counts, 'octopus').map((h) => h.scientificName)).toEqual(['Octopus vulgaris', 'Octopus', 'Octopus cyanea', 'Abdopus horridus']);
  });
});

describe('species query', () => {
  it('declares its prefixes (QLever needs them) and refuses odd language codes', () => {
    const qy = speciesQuery([105847, 137206], 'uz');
    expect(qy).toContain('PREFIX wdt:');
    expect(qy).toContain('"105847" "137206"');
    expect(qy).toContain('LANG(?cn) = "uz"');
    expect(speciesQuery([1], 'x") } DROP')).toContain('LANG(?cn) = "en"');
  });
  it('prefers the English label over an English common name', () => {
    expect(pickName({ labelEn: { value: 'long-finned pilot whale' }, commonEn: { value: 'Atlantic Pilot Whale' } }, 'Globicephala melas')).toBe('Long-finned pilot whale');
  });
});

describe('commons thumbnails', () => {
  it('md5 matches RFC 1321 / Python hashlib', async () => {
    const { md5 } = await import('../src/md5');
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5('Amphiprion_bicinctus_(Red_Sea_anemonefish)_–_ägypten.jpg')).toBe('bd9abb13dc61e2804e4c4ae31eb373e2');
    expect(md5('x'.repeat(100))).toBe('aed563ecafb4bcc5654c597a421547b2');
  });
  it('builds the CDN path at a standard width, with the redirect as fallback', async () => {
    const { commonsThumbs, standardWidth } = await import('../src/wiki');
    expect(standardWidth(360)).toBe(500);
    expect(standardWidth(330)).toBe(330);
    const [cdn, fb] = commonsThumbs('Whale shark Georgia aquarium.jpg', 330);
    expect(cdn).toBe('https://upload.wikimedia.org/wikipedia/commons/thumb/f/f1/Whale_shark_Georgia_aquarium.jpg/330px-Whale_shark_Georgia_aquarium.jpg');
    expect(fb).toContain('Special:FilePath/Whale_shark_Georgia_aquarium.jpg?width=330');
    expect(commonsThumbs('Map.svg', 120)[0]).toMatch(/\/120px-Map\.svg\.png$/);
    expect(commonsThumbs('clip.webm', 120)).toHaveLength(1);
  });
});
