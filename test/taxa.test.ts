import { describe, expect, it } from 'vitest';
import {
  binnedQuantile, countByGroup, depthBands, depthRange, groupOf, interleaveGroups, isShowable, mammalKind, obisDepthWidth,
  rankSpecies, splitDepth, sstRange, type Taxon,
} from '../src/taxa';

// Shapes copied from real OBIS checklist answers (2026-11-25/26).
const turtle: Taxon = { taxonID: 137206, scientificName: 'Chelonia mydas', taxonRank: 'Species', kingdom: 'Animalia', phylum: 'Chordata', superclass: 'Reptilia', order: 'Testudines', category: 'EN', records: 199 };
const egret: Taxon = { taxonID: 212665, scientificName: 'Egretta gularis', taxonRank: 'Species', kingdom: 'Animalia', phylum: 'Chordata', superclass: 'Reptilia', class: 'Aves', records: 40 };
const bacteria: Taxon = { taxonID: 393070, scientificName: 'Clostridiales', taxonRank: 'Order', kingdom: 'Bacteria', records: 25 };
const shark: Taxon = { taxonID: 105847, scientificName: 'Rhincodon typus', taxonRank: 'Species', kingdom: 'Animalia', phylum: 'Chordata', class: 'Elasmobranchii', records: 40 };
const tuna: Taxon = { taxonID: 127027, scientificName: 'Thunnus albacares', taxonRank: 'Species', kingdom: 'Animalia', phylum: 'Chordata', class: 'Teleostei', records: 5 };

describe('groups', () => {
  it('puts each kind of animal where a reader expects it', () => {
    expect(groupOf(turtle)).toBe('turtles');
    expect(groupOf(egret)).toBe('birds'); // OBIS gives birds superclass Reptilia: class must win
    expect(groupOf(shark)).toBe('sharks');
    expect(groupOf(tuna)).toBe('fish');
    expect(groupOf({ taxonID: 1, scientificName: 'x', kingdom: 'Animalia', phylum: 'Cnidaria' })).toBe('corals');
  });
  it('keeps true crustaceans apart from sea spiders and horseshoe crabs (real OBIS taxon fields)', () => {
    expect(groupOf({ taxonID: 107276, scientificName: 'Cancer pagurus', kingdom: 'Animalia', phylum: 'Arthropoda', subphylum: 'Crustacea', class: 'Malacostraca' })).toBe('crustaceans');
    expect(groupOf({ taxonID: 1302, scientificName: 'Pycnogonida', kingdom: 'Animalia', phylum: 'Arthropoda', subphylum: 'Chelicerata', class: 'Pycnogonida' })).toBe('other');
  });
  it('separates seaweed and seagrass from plankton', () => {
    expect(groupOf({ taxonID: 495082, scientificName: 'Zostera noltii', kingdom: 'Plantae', phylum: 'Tracheophyta', class: 'Magnoliopsida' })).toBe('algae');
    expect(groupOf({ taxonID: 1, scientificName: 'Macrocystis pyrifera', kingdom: 'Chromista', phylum: 'Ochrophyta', class: 'Phaeophyceae' })).toBe('algae');
    expect(groupOf({ taxonID: 1, scientificName: 'Guinardia striata', kingdom: 'Chromista', class: 'Bacillariophyceae' })).toBe('plankton');
  });
  it('tells whales from seals and sea cows (real OBIS orders)', () => {
    expect(mammalKind({ taxonID: 137111, scientificName: 'Tursiops truncatus', class: 'Mammalia', order: 'Cetartiodactyla' })).toBe('whale');
    expect(mammalKind({ taxonID: 137084, scientificName: 'Phoca vitulina', class: 'Mammalia', order: 'Carnivora' })).toBe('seal');
    expect(mammalKind({ taxonID: 1, scientificName: 'Dugong dugon', class: 'Mammalia', order: 'Sirenia' })).toBe('seacow');
  });
  it('hides bacteria, ranks above species, and land or river species (real WoRMS flags from the Great Barrier Reef)', () => {
    expect(isShowable(bacteria)).toBe(false);
    expect(isShowable(turtle)).toBe(true);
    const kingfisher: Taxon = { taxonID: 1, scientificName: 'Todiramphus sanctus', taxonRank: 'Species', kingdom: 'Animalia', class: 'Aves', is_marine: false, is_terrestrial: true, is_freshwater: true };
    const riverShrimp: Taxon = { taxonID: 2, scientificName: 'Caridina serratirostris', taxonRank: 'Species', kingdom: 'Animalia', is_marine: false, is_terrestrial: false, is_freshwater: true };
    const skate: Taxon = { taxonID: 3, scientificName: 'Dentiraja endeavouri', taxonRank: 'Species', kingdom: 'Animalia', is_marine: false, is_terrestrial: false, is_freshwater: false };
    const mangroveCrab: Taxon = { taxonID: 4, scientificName: 'x', taxonRank: 'Species', kingdom: 'Animalia', is_marine: true, is_terrestrial: true };
    expect(isShowable(kingfisher)).toBe(false);
    expect(isShowable(riverShrimp)).toBe(false);
    expect(isShowable(skate)).toBe(true); // all flags false = WoRMS gap, not "lives on land"
    expect(isShowable(mangroveCrab)).toBe(true);
  });
  it('ranks by records, ties by name', () => {
    expect(rankSpecies([tuna, egret, bacteria, turtle, shark]).map((t) => t.scientificName))
      .toEqual(['Chelonia mydas', 'Egretta gularis', 'Rhincodon typus', 'Thunnus albacares']);
    expect(countByGroup([turtle, shark, tuna]).get('fish')).toBe(1);
  });
  it('interleaves kinds in a fixed order so one well-surveyed group does not fill the first screen', () => {
    const birds = [1, 2, 3].map((i) => ({ ...egret, taxonID: i, scientificName: `Bird ${i}`, records: 1000 - i }));
    const out = interleaveGroups([...birds, tuna, shark]);
    expect(out.map((t) => t.scientificName)).toEqual(['Thunnus albacares', 'Rhincodon typus', 'Bird 1', 'Bird 2', 'Bird 3']);
  });
  it('lets plankton take a turn only every third round while bigger life is left', () => {
    const fish = [1, 2, 3, 4].map((i) => ({ ...tuna, taxonID: i, scientificName: `Fish ${i}` }));
    const diatoms = [1, 2, 3].map((i) => ({ taxonID: 10 + i, scientificName: `Diatom ${i}`, taxonRank: 'Species', kingdom: 'Chromista' }));
    expect(interleaveGroups([...diatoms, ...fish]).map((t) => t.scientificName))
      .toEqual(['Fish 1', 'Diatom 1', 'Fish 2', 'Fish 3', 'Fish 4', 'Diatom 2', 'Diatom 3']);
  });
});

describe('depth', () => {
  // Real whale shark (105847) statistics/env depth answer, 2026-11-26: OBIS sends every bin, empty ones too,
  // 10 m wide to 200 m, 100 m to 1,000 m, 1,000 m below.
  const real = [[0, 2596], [10, 126], [20, 184], [30, 119], [40, 0], [50, 62], [60, 33], [70, 34], [80, 78], [90, 0], [100, 0],
    [110, 0], [120, 0], [130, 0], [140, 0], [150, 1], [160, 0], [170, 0], [180, 0], [190, 0], [200, 2], [300, 1], [400, 0], [500, 0],
    [600, 0], [700, 0], [800, 0], [900, 0], [1000, 0], [2000, 0], [3000, 0], [4000, 0], [5000, 2], [6000, 0], [7000, 0], [8000, 0],
    [9000, 0], [10000, 0]].map(([from, records]) => ({ from, records }));

  it('uses the OBIS bin ladder for widths', () => {
    expect(obisDepthWidth(80)).toBe(10); expect(obisDepthWidth(300)).toBe(100); expect(obisDepthWidth(5000)).toBe(1000);
  });
  it('interpolates a record-weighted quantile inside the bin', () => {
    expect(binnedQuantile([{ from: 0, records: 10 }, { from: 10, records: 10 }], 0.5, obisDepthWidth)).toBeCloseTo(10);
    expect(binnedQuantile([], 0.5, obisDepthWidth)).toBeNull();
  });
  it('never stretches a bin over values the answer skipped (80 m bin, then 1,000 m)', () => {
    // with width = next.from - from, the 80 m bin would span 920 m and the 90th percentile would land near 540 m
    const sparse = [{ from: 0, records: 10 }, { from: 80, records: 78 }, { from: 1000, records: 3 }];
    const q90 = binnedQuantile(sparse, 0.9, obisDepthWidth)!;
    expect(q90).toBeGreaterThanOrEqual(80);
    expect(q90).toBeLessThanOrEqual(90);
  });
  it('honours an explicit bin end when given', () => {
    expect(binnedQuantile([{ from: 0, to: 100, records: 10 }], 0.5, obisDepthWidth)).toBeCloseTo(50);
  });
  it('reports the middle half of the real whale shark records in readable steps', () => {
    const r = depthRange(real)!;
    expect(r.records).toBe(3238);
    expect(r.from).toBe(0);
    expect(r.to).toBe(10); // 75th percentile ~9.4 m, rounded up to a 5 m step
  });
  it('keeps records above the sea surface out of both the text and the chart', () => {
    const bins = [{ from: -10, records: 5 }, { from: 0, records: 10 }, { from: 10, records: 10 }];
    expect(splitDepth(bins).above).toBe(5);
    expect(depthRange(bins)!.records).toBe(20);
    expect(depthBands(bins).reduce((a, b) => a + b)).toBe(20);
  });
  it('sums bins into ocean zones, the same records as the text', () => {
    const z = depthBands(real);
    expect(z[0]).toBe(2596); expect(z[1]).toBe(126 + 184 + 119); expect(z[2]).toBe(62 + 33 + 34 + 78 + 1); expect(z[3]).toBe(3); expect(z[5]).toBe(2);
    expect(z.reduce((a, b) => a + b)).toBe(depthRange(real)!.records);
  });
});

describe('surface temperature', () => {
  // Real whale shark statistics/env sst answer, 2026-11-26 (5 °C bins). 16 records at -5 °C are misplaced points.
  const sst = [[-5, 16], [0, 0], [5, 0], [10, 23], [15, 124], [20, 2628], [25, 14105]].map(([s, records]) => ({ sst: s, records }));
  it('takes the middle 80 %, so a few misplaced records do not stretch the range', () => {
    const r = sstRange(sst)!;
    expect(r.from).toBeGreaterThanOrEqual(20);
    expect(r.to).toBeLessThanOrEqual(30);
    expect(r.records).toBe(16896);
  });
  it('needs a handful of records', () => {
    expect(sstRange([{ sst: 20, records: 3 }])).toBeNull();
  });
});
