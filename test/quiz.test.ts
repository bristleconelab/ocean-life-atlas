import { describe, expect, it } from 'vitest';
import { buildRound, sample, QUIZ_PLACES } from '../src/quiz';

const cand = (id: number) => ({ id, sci: `S${id}`, name: `N${id}`, image: 'x.jpg', group: 'fish' as const, records: id });
const place = (ids: number[], photo: number[]) => ({ place: QUIZ_PLACES[0], box: { west: 0, east: 1, south: 0, north: 1 }, ids: new Set(ids), photo: photo.map(cand) });

describe('quiz', () => {
  it('never offers as a decoy an animal recorded at the place', () => {
    const here = place([1, 2, 3, 10], [1, 2, 3]);
    const others = [place([10, 11, 12], [10, 11, 12]), place([13, 14], [13, 14])];
    for (let i = 0; i < 50; i++) {
      const r = buildRound(here, others)!;
      expect(r.choices).toHaveLength(4);
      expect(r.choices.filter((c) => here.ids.has(c.id))).toEqual([r.answer]); // 10 is recorded here: never a decoy
    }
  });
  it('gives up rather than inventing decoys', () => {
    expect(buildRound(place([1], [1]), [place([1, 2], [1, 2])])).toBeNull();
    expect(buildRound(place([1], []), [])).toBeNull();
  });
  it('samples without repeats', () => {
    const s = sample([1, 2, 3, 4, 5], 5);
    expect(new Set(s).size).toBe(5);
  });
});
