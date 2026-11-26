// Merge "common name" hits (WoRMS) and "scientific name" hits (OBIS autocomplete) into one short list. Pure.
import type { AphiaRecord } from './api';
import { groupOf, type GroupId, type Taxon } from './taxa';

export interface Hit { id: number; scientificName: string; rank: string; group: GroupId; viaCommon: boolean; exact?: boolean }

const RANK_OK = new Set(['Species', 'Genus', 'Family']);
const RANK_ORDER: Record<string, number> = { Species: 0, Genus: 1, Family: 2 };

export type Completion = Taxon & { id?: number; rank?: string; acceptedNameUsageID?: number | string };

export function mergeHits(worms: AphiaRecord[], obis: Completion[], query: string, limit = 8, exactIds: Set<number> = new Set()): Hit[] {
  const out = new Map<number, Hit>();
  const ql = query.trim().toLowerCase();
  for (const r of worms) {
    const id = r.valid_AphiaID ?? r.AphiaID;
    const name = r.valid_name ?? r.scientificname;
    if (!id || !RANK_OK.has(r.rank) || out.has(id) || r.isMarine === 0) continue;
    out.set(id, {
      id, scientificName: name, rank: r.rank, viaCommon: true, exact: exactIds.has(id),
      group: groupOf({ taxonID: id, scientificName: name, kingdom: r.kingdom ?? undefined, phylum: r.phylum ?? undefined, class: r.class ?? undefined, order: r.order ?? undefined }),
    });
  }
  for (const t of obis) {
    const id = Number(t.acceptedNameUsageID ?? t.id ?? t.taxonID);
    const rank = t.rank ?? t.taxonRank ?? '';
    if (!id || !RANK_OK.has(rank) || out.has(id)) continue;
    out.set(id, { id, scientificName: t.scientificName, rank, viaCommon: false, group: groupOf(t) });
  }
  const score = (h: Hit) => {
    const n = h.scientificName.toLowerCase();
    const exact = n === ql ? 0 : n.startsWith(ql) ? 1 : 2;
    return (h.viaCommon ? 0 : exact) * 10 + (RANK_ORDER[h.rank] ?? 3);
  };
  return [...out.values()].sort((a, b) => score(a) - score(b) || a.scientificName.localeCompare(b.scientificName)).slice(0, limit);
}

/** The group most exact common-name matches belong to ("octopus" -> shells, squid and octopus), if any. */
export function dominantGroup(hits: Hit[]): GroupId | null {
  const n = new Map<GroupId, number>();
  for (const h of hits) if (h.exact) n.set(h.group, (n.get(h.group) ?? 0) + 1);
  let best: GroupId | null = null, max = 0;
  for (const [g, k] of n) if (k > max) { best = g; max = k; }
  return best;
}

/** Final order: exact common-name matches, then an exact scientific match, then species of the same kind as the exact
 *  matches (so "octopus" lists octopuses before an "octopus coral"), then other species by how often OBIS has them
 *  recorded (a good proxy for "the one people mean"), then genera and families. */
export function rankHits(hits: Hit[], records: Map<number, number>, query: string, limit = 8): Hit[] {
  const ql = query.trim().toLowerCase();
  const dom = dominantGroup(hits);
  const tier = (h: Hit) => (h.exact ? 0 : h.scientificName.toLowerCase() === ql ? 1
    : h.rank === 'Species' ? (dom && h.group !== dom ? 3 : 2) : 4);
  return [...hits]
    .sort((a, b) => tier(a) - tier(b) || (records.get(b.id) ?? 0) - (records.get(a.id) ?? 0) || a.scientificName.localeCompare(b.scientificName))
    .slice(0, limit);
}
