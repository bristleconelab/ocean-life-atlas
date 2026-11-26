import { describe, expect, it } from 'vitest';
import { buildTracks, cleanFixes, seasonCounts, trackAtElapsed, type OccRow } from '../src/tracks';
import { activityKind, speedCapFor } from '../src/journeys';
import { licenceShort, pickPlaces } from '../src/api';
import { cellAreaKm2, frameOf, geohashBounds } from '../src/geo';
import { dominantGroup, rankHits } from '../src/search-merge';
import { minQueryLength } from '../src/search';
// @ts-expect-error plain ESM build script, no types
import { displayName } from '../scripts/build_mico.mjs';

const D = 86400000;
const fix = (animal: string, t: number, lon: number, lat: number): OccRow =>
  ({ organismID: animal, dataset_id: 'ds1', eventDate: new Date(t).toISOString(), decimalLongitude: lon, decimalLatitude: lat, basisOfRecord: 'MachineObservation' });
const t0 = Date.UTC(2020, 0, 1);

describe('track cleaning', () => {
  it('does not let a bad first fix poison the whole track', () => {
    // fix 0 is a lab test position 3,000 km away; the animal then moves ~111 km a day
    const rows = [fix('A', t0, 30, 0), ...[1, 2, 3, 4, 5, 6].map((d) => fix('A', t0 + d * D, d, 0))];
    const tr = buildTracks(rows, 5, 300)[0];
    expect(tr.segments.flat().map((p) => p[0])).toEqual([1, 2, 3, 4, 5, 6]);
    expect(tr.dropped).toBe(1);
    expect(tr.km).toBeGreaterThan(540); expect(tr.km).toBeLessThan(570);
  });
  it('drops a 49 km jump made in one second (the old 1-hour floor let it through)', () => {
    const pts = [{ t: t0, lon: 0, lat: 0 }, { t: t0 + 1000, lon: 0.44, lat: 0 }, { t: t0 + D, lon: 0.1, lat: 0 }, { t: t0 + 2 * D, lon: 0.2, lat: 0 }];
    expect(cleanFixes(pts, 1200).kept.map((p) => p.lon)).toEqual([0, 0.1, 0.2]);
  });
  it('removes a lone spike between two fixes that agree', () => {
    const pts = [0, 1, 2, 3, 4].map((d) => ({ t: t0 + d * D, lon: d * 0.5, lat: d === 2 ? 20 : 0 }));
    expect(cleanFixes(pts, 300).kept.map((p) => p.lat)).toEqual([0, 0, 0, 0]);
  });
  it('does not add GPS jitter around one spot to the distance', () => {
    const rows = Array.from({ length: 40 }, (_, i) => fix('A', t0 + i * 3600000, (i % 2) * 0.03, 0)); // 3.3 km zigzag, hourly
    const tr = buildTracks(rows, 5, 300)[0];
    expect(tr.km).toBe(0);
  });
  it('uses a speed limit that fits the animal', () => {
    expect(speedCapFor({ taxonID: 1, scientificName: 'x', class: 'Aves' })).toBe(1200);
    expect(speedCapFor({ taxonID: 1, scientificName: 'x', order: 'Testudines', superclass: 'Reptilia' })).toBe(200);
    expect(speedCapFor({ taxonID: 1, scientificName: 'x', class: 'Mammalia', order: 'Sirenia' })).toBe(100);
    expect(speedCapFor(null)).toBe(400);
  });
});

describe('journey clock', () => {
  it('moves every animal by the same days since its own tagging', () => {
    const short = buildTracks([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((d) => fix('S', t0 + d * D, d * 0.5, 0)), 5, 300)[0];
    const long = buildTracks(Array.from({ length: 101 }, (_, d) => ({ ...fix('L', t0 + 7 * D + d * 10 * D, 50 + d * 0.5, 0) })), 5, 300)[0];
    // day 5: the 10-day animal is half way, the 1,000-day animal is half way through its first 10-day leg
    expect(trackAtElapsed(short, 5 * D).head![0]).toBeCloseTo(2.5);
    expect(trackAtElapsed(long, 5 * D).head![0]).toBeCloseTo(50.25);
    // day 500: the short track has ended at its last fix
    expect(trackAtElapsed(short, 500 * D).head![0]).toBeCloseTo(5);
  });
});

describe('seasons', () => {
  it('keeps north and south apart and counts a tagged animal once a day', () => {
    const rows: OccRow[] = [
      ...Array.from({ length: 50 }, (_, i) => fix('T', Date.UTC(2020, 6, 3 + Math.floor(i / 20), i % 20), 0, 10)), // 50 fixes, one animal, July, 3 days
      { month: 1, decimalLatitude: -40 }, { month: 1, decimalLatitude: -40 }, { month: 7, decimalLatitude: 40 },
    ];
    const s = seasonCounts(rows);
    expect(s.north[6]).toBe(4); // 3 animal-days + 1 sighting
    expect(s.south[0]).toBe(2);
    expect(s.all.reduce((a, b) => a + b)).toBe(6);
  });
});

describe('MiCO', () => {
  it('classifies every activity word in the data (2026-11-26 vocabulary)', () => {
    expect(activityKind('Spawning')).toBe('breeding');
    expect(activityKind('Nursery')).toBe('breeding');
    expect(activityKind('Hatching')).toBe('breeding');
    expect(activityKind('Fledging')).toBe('breeding');
    expect(activityKind('Stopover')).toBe('migrating');
    expect(activityKind('Staging Site')).toBe('migrating');
    expect(activityKind('Wintering')).toBe('season');
    expect(activityKind('Hibernating')).toBe('season');
    expect(activityKind('Breeding;Feeding')).toBe('breeding');
    expect(activityKind('Observation')).toBe('observed');
  });
  it('names sea turtles as sea turtles', () => {
    expect(displayName('Green', 'seaturtle')).toBe('Green sea turtle');
    expect(displayName('Leatherback', 'seaturtle')).toBe('Leatherback sea turtle');
    expect(displayName('Humpback Whale', 'mammal')).toBe('Humpback Whale');
  });
});

describe('licences', () => {
  it('keeps SA and ND (real OBIS rights statements, shortened)', () => {
    expect(licenceShort('This work is licensed under a Creative Commons Attribution (CC-BY) 4.0 License.')).toBe('CC BY');
    expect(licenceShort('https://creativecommons.org/licenses/by-sa/4.0/')).toBe('CC BY-SA');
    expect(licenceShort('http://creativecommons.org/licenses/by-nc-nd/4.0/legalcode')).toBe('CC BY-NC-ND');
    expect(licenceShort('Creative Commons Attribution Non Commercial (CC-BY-NC) 4.0')).toBe('CC BY-NC');
    expect(licenceShort('Attribution-NonCommercial-ShareAlike 4.0 International')).toBe('CC BY-NC-SA');
    expect(licenceShort('Public Domain (CC0 1.0)')).toBe('CC0');
    expect(licenceShort('')).toBe('see dataset');
  });
});

describe('place search', () => {
  it('offers the lake and the sea area, not EEZ pieces or names that merely contain the text (real Marine Regions answer)', () => {
    const r = [
      { preferredGazetteerName: 'Aral Sea', placeType: 'Lake', latitude: 45.13, longitude: 60.08 },
      { preferredGazetteerName: 'Aral Sea', placeType: 'SeaVoX SeaArea - sub-region', latitude: 45.0, longitude: 59.9 },
      { preferredGazetteerName: 'Baral Guyot', placeType: 'Guyot(s)', latitude: -25.7, longitude: -86.6 },
      { preferredGazetteerName: 'Chañaral Island', placeType: 'Island', latitude: -29.0, longitude: -71.6 },
    ];
    expect(pickPlaces(r, 'Aral').map((p) => `${p.name}|${p.type}`)).toEqual(['Aral Sea|Lake']);
  });
});

describe('geometry', () => {
  it('gives polar squares their smaller area', () => {
    const eq = cellAreaKm2(geohashBounds('s00')), polar = cellAreaKm2(geohashBounds('upb'));
    expect(eq).toBeGreaterThan(24000); expect(eq).toBeLessThan(25000);
    expect(polar / eq).toBeLessThan(0.2);
  });
  it('frames points across the antimeridian as one tight box', () => {
    const f = frameOf([[179, 10], [-179, 12], [178, 11]])!;
    expect(f.east - f.west).toBeCloseTo(3, 5);
    expect(f.wide).toBe(false);
  });
  it('handles 50,000 points without spreading them into Math.min', () => {
    const pts = Array.from({ length: 50000 }, (_, i) => [i % 40, i % 30] as [number, number]);
    expect(frameOf(pts)!.west).toBeCloseTo(0, 5);
  });
});

describe('search', () => {
  it('lets one Han or kana character through, two Latin letters', () => {
    expect(minQueryLength('鲸')).toBe(1);
    expect(minQueryLength('ot')).toBe(2);
  });
  it('lists octopuses before an "octopus coral" (real search, 2026-11-25)', () => {
    const hits = [
      { id: 1, scientificName: 'Octopus vulgaris', rank: 'Species', group: 'molluscs' as const, viaCommon: true, exact: true },
      { id: 2, scientificName: 'Galaxea fascicularis', rank: 'Species', group: 'corals' as const, viaCommon: true },
      { id: 3, scientificName: 'Octopus cyanea', rank: 'Species', group: 'molluscs' as const, viaCommon: true },
    ];
    expect(dominantGroup(hits)).toBe('molluscs');
    expect(rankHits(hits, new Map([[2, 50000], [3, 900]]), 'octopus').map((x) => x.id)).toEqual([1, 3, 2]);
  });
});

describe('track cleaning, two bad fixes at the start', () => {
  it('follows the longer run of fixes that agree with each other', () => {
    const pts = [{ t: t0, lon: 30, lat: 0 }, { t: t0 + D, lon: 30.01, lat: 0 }, ...[2, 3, 4, 5, 6].map((d) => ({ t: t0 + d * D, lon: d, lat: 0 }))];
    expect(cleanFixes(pts, 300).kept.map((p) => p.lon)).toEqual([2, 3, 4, 5, 6]);
  });
});
