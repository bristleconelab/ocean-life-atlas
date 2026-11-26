import { describe, expect, it } from 'vitest';
import { chao1, formatLength, formatMass, overlap, parseTraits, rangeShift, toCsv } from '../src/science';
import { geohashBounds } from '../src/geo';

const W = (id: string) => ({ value: `http://www.wikidata.org/entity/${id}` });
const V = (v: number) => ({ value: String(v) });

describe('Chao1', () => {
  it('matches the bias-corrected formula', () => {
    // 20 species: 6 seen once, 4 twice, 10 often -> 20 + 6*5 / (2*5) = 23
    const r = chao1([...Array(6).fill(1), ...Array(4).fill(2), ...Array(10).fill(50)])!;
    expect(r.estimate).toBeCloseTo(23);
    expect(r.completeness).toBeCloseTo(20 / 23);
    expect(r.f1).toBe(6); expect(r.f2).toBe(4);
  });
  it('says nothing about tiny lists, and stays finite with no doubletons', () => {
    expect(chao1([1, 1, 2])).toBeNull();
    const r = chao1(Array(25).fill(1))!;
    expect(Number.isFinite(r.estimate)).toBe(true);
    expect(r.estimate).toBe(25 + (25 * 24) / 2);
  });
});

describe('traits', () => {
  it('converts units and keeps the largest value (real humpback rows from Wikidata, 2026-11-26)', () => {
    const t = parseTraits([
      { massAmt: V(45), massUnit: W('Q191118'), lenAmt: V(16), lenUnit: W('Q11573'), lifeAmt: V(47.5), lifeUnit: W('Q577') },
      { massAmt: V(1.5), massUnit: W('Q191118'), lenAmt: V(4.5), lenUnit: W('Q11573') },
    ]);
    expect(t).toEqual({ massKg: 45000, lengthM: 16, lifeYears: 47.5 });
    expect(parseTraits([{ lenAmt: V(46), lenUnit: W('Q3710') }]).lengthM).toBeCloseTo(14.02, 2); // whale shark, feet
    expect(parseTraits([{ massAmt: V(3), massUnit: W('Q999999') }])).toEqual({}); // unknown unit: skipped
  });
  it('formats sizes readably', () => {
    expect(formatMass(45000)).toBe('45 t'); expect(formatMass(0.35)).toBe('350 g'); expect(formatMass(12.34)).toBe('12.3 kg');
    expect(formatLength(16)).toBe('16 m'); expect(formatLength(0.42)).toBe('42 cm'); expect(formatLength(0.004)).toBe('4 mm');
  });
});

describe('ranges', () => {
  const cell = (gh: string) => ({ bbox: geohashBounds(gh), n: 1 });
  const ring = (lat0: number) => Array.from({ length: 20 }, (_, i) => ({ bbox: { west: i * 2, east: i * 2 + 1.4, south: lat0, north: lat0 + 1.4 }, n: 3 }));
  it('measures a move away from the equator by squares, not records', () => {
    const r = rangeShift(ring(30), ring(33))!;
    expect(r.shiftKm).toBeGreaterThan(320); expect(r.shiftKm).toBeLessThan(345);
    expect(rangeShift(ring(30).slice(0, 5), ring(33))).toBeNull();
  });
  it('finds shared squares and their area', () => {
    const o = overlap([cell('s00'), cell('s01')], [cell('s01'), cell('s02')]);
    expect(o.shared).toBe(1); expect(o.onlyA).toBe(1); expect(o.onlyB).toBe(1);
    expect(o.sharedKm2).toBeGreaterThan(24000);
  });
});

describe('csv', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(toCsv([['a', 'b,c', 'say "hi"', null, 3]])).toBe('a,"b,c","say ""hi""",,3\r\n');
  });
});
