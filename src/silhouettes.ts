// Simple silhouettes for each kind of sea life, shown when a species has no photo. Drawn for this atlas
// (64 x 64 viewBox, filled shapes; crabs also stroked for their legs) so a photo-less tile still says "this is a fish" at a glance.
import { groupOf, mammalKind, type GroupId, type Taxon } from './taxa';

const SHELL = 'M34 10c12 1 21 11 20 23-1 11-10 19-21 19H12c-1.7 0-2.6-2-1.4-3.2l3.6-3.6C11 41 9 36.5 9.5 31.5 10.5 19 21 9 34 10zm-1 9c-7 0-12 5-12 11.5S26 42 32 42c5.5 0 9.5-4 9.5-9 0-4.5-3.5-8-8-8-3.8 0-6.5 2.8-6.5 6.2 0 2.8 2.2 4.8 4.8 4.8 2.2 0 3.7-1.6 3.7-3.5';

/** Seals, sea lions, otters and the polar bear (Carnivora), and sea cows (Sirenia): not whale-shaped. */
const SEAL = 'M5 37c0-5 4-9 9-9 2.6 0 4.8 1 6.4 2.4C26 27 33 26 40 27.5c5 1 9 3.6 11.5 7.2l6.3-4.3c.8-.5 1.8.3 1.4 1.2L57 38l2.6 6.4c.4.9-.6 1.7-1.4 1.2l-6.6-4.4C48.6 45 42 47 34 47c-6 0-11-.9-15-2.6l-4.2 5c-.6.7-1.8.3-1.7-.7l.4-6.2C9.3 41.6 5 40 5 37zm6.5-3.2a1.6 1.6 0 1 0 .1 0z';
const SEACOW = 'M4 34c1-6 7-10 14-10 4 0 7 1 10 1 7 0 13-1 18 1 4 1.6 6 4 7 7l6.5-3c.9-.4 1.7.6 1.2 1.4L57 37l3.7 5.6c.5.8-.3 1.8-1.2 1.4L53 41c-2 4-7 6-14 6-6 0-10-1-14-1-3 0-5 2-7 4-.6.6-1.7.2-1.6-.7l.5-4.5C9 43.5 3.3 39.8 4 34z';
const P: Record<GroupId, string> = {
  fish: 'M6 32c7-9 17-13 28-12 6 .5 11 3 15 6l9-7c1 0 1 1 1 1l-3 12 3 12s0 1-1 1l-9-7c-4 3-9 5.5-15 6-11 1-21-3-28-12zm13-2.5a2 2 0 1 0 .1 0z',
  sharks: 'M3 35c6-4 14-6 23-6.5l7-12c.6-1 2-.6 2 .5l-.6 11.5c5 .3 10 1.2 14 2.6l9-8c.7-.6 1.8 0 1.5.9l-3.4 9.5 3.4 9.5c.3.9-.8 1.5-1.5.9l-9-8c-6 2.2-14 3.2-22 3l-3 6.5c-.4.9-1.7.7-1.8-.3l-.4-6.6C14 39.6 8 38 3 35z',
  mammals: 'M5 34c0-9 9-15 22-15 12 0 21 5 25 12 1.5-3 4.5-6 8-6.5.8-.1 1.3.8.8 1.4l-3.3 4.6 3.4 4.4c.5.7 0 1.6-.8 1.5-3.6-.6-6.6-3-8-6.2C49 39 42 45 30 45c-5 0-9-1-12-2.5L13 47c-.7.6-1.7 0-1.4-.9l1.7-5.6C8.5 38.5 5 36.5 5 34z',
  turtles: 'M32 18c9 0 16 6 16 14s-7 14-16 14-16-6-16-14 7-14 16-14zm16 6c4-3 8-3 10-2 1 .5 1 1.5.4 2-2 2-5 3-8.5 3zm0 16c3.5 0 6.5 1 8.5 3 .6.5.6 1.5-.4 2-2 1-6 1-10-2zM16 24c-3.5 0-6.5-1-8.5-3-.6-.5-.6-1.5.4-2 2-1 6-1 10 2zm0 16c-4 3-8 3-10 2-1-.5-1-1.5-.4-2 2-2 5-3 8.5-3zm.5-8c-3 0-6 .8-9 2-.8.3-1.5-.4-1.2-1.2C7.5 29 10 28 13 28z',
  birds: 'M4 30c6-1.5 12 0 17 4 3-8 11-14 22-15 4-.4 8 .2 11 1.5.8.3.7 1.4-.1 1.6-9 2.5-15 8-17 15 4 0 8 1 11 3 .7.4.5 1.5-.3 1.6-6 .5-12 .8-17 0-3-.4-6-1.6-8.5-3.4C17 34.6 11 32 4.4 31.3 3.6 31.2 3.3 30.2 4 30z',
  corals: 'M30 58V40c-6-1-10-5-11-11l-5-3c-.8-.5-.5-1.7.4-1.8l3.6-.4-1-7c-.1-.9 1-1.4 1.6-.7L23 21c1 4 3.5 7 7 8V16l-3-5c-.4-.8.5-1.6 1.2-1.1L32 13l3.8-3.1c.7-.5 1.6.3 1.2 1.1l-3 5v18c4-1 7-4 8-8l1-8c.1-.9 1.3-1.1 1.6-.2l1.6 4.3 3.4-2c.8-.4 1.6.5 1.1 1.2L48 26c-1 7-6 12-14 13.5V58z',
  molluscs: 'M32 8c9 0 15 7 15 15 0 5-2 9-5 11l2 6c1 3 4 4 6 3 .9-.4 1.7.6 1.1 1.4-2.5 3-7 3.5-9.5.5L40 40l-.5 9c-.2 3 2 6 4.5 7 .9.4.6 1.7-.4 1.7-4.3 0-7.5-3.5-7.6-7.7L36 41l-2.3 13c-.5 2.6.6 5 2.4 6.3.8.6.3 1.8-.7 1.6-3.6-.6-5.8-4.2-5.2-7.8L32 41l-2.8 8c-1 2.8-3.8 4.6-6.8 4.3-1-.1-1.2-1.4-.3-1.8 2.4-1 4-3.3 4.2-5.8L27 40l-3 2.5c-2.5 3-7 2.5-9.5-.5-.6-.8.2-1.8 1.1-1.4 2 1 5 0 6-3l2-6c-3-2-5-6-5-11 0-8 6-15 15-15z',
  crustaceans: 'M32 26c8 0 14 4 14 10s-6 10-14 10-14-4-14-10 6-10 14-10zM14 14c4 1 7 4 7 8l-2 3c-3-1-6-3-7-6l-3 1c-.9.3-1.5-.8-.8-1.4zm36 0l5.8 4.6c.7.6.1 1.7-.8 1.4l-3-1c-1 3-4 5-7 6l-2-3c0-4 3-7 7-8zM18 38l-8 4m8 0l-7 7m35-11l8 4m-8 0l7 7M23 26l-3-5m21 5l3-5',
  echinoderms: 'M32 5l6.5 17.5L57 23l-14.5 11.5L48 53 32 42.5 16 53l5.5-18.5L7 23l18.5-.5z',
  algae: 'M20 60c-2-10 4-16 1-26-2-6-6-10-4-18 .2-.9 1.5-1 1.8-.1 2 6 7 11 7 19 0 9-5 15-3 25zm12 0c0-12 6-18 4-30-1-6-4-10-2-18 .2-.9 1.5-.9 1.8 0 2.4 7 6 12 5.6 20-.4 10-6 16-6 28zm12 0c-1-9 3-14 1-22-1.5-5-4-8-2.5-14 .2-.8 1.4-.9 1.7-.1 1.8 5 5 9 4.8 15-.2 8-4 12-3 21z',
  // a diatom: a ribbed disc
  plankton: 'M32 12a20 20 0 1 1 0 40 20 20 0 0 1 0-40zm0 5a15 15 0 1 0 0 30 15 15 0 0 0 0-30zm0 6a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm0 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  // a vase sponge
  other: 'M22 56c-4-8-6-18-6-28 0-6 1-11 3-15 .5-1 2-1 2.3.1C23 17 26 19 32 19s9-2 10.7-5.9c.4-1.1 1.8-1.1 2.3-.1 2 4 3 9 3 15 0 10-2 20-6 28-.4.8-1.2 1.3-2 1.3H24c-.8 0-1.6-.5-2-1.3zm10-30a2.2 2.2 0 1 0 .1 0zm-6 9a2 2 0 1 0 .1 0zm12 2a2 2 0 1 0 .1 0zm-6 9a2 2 0 1 0 .1 0z',
};

/** Groups whose shapes are lines (legs, tentacles): drawn with a stroke as well as a fill. */
const STROKED = new Set<GroupId>(['crustaceans']);
const EVENODD = new Set<string>([SHELL, P.plankton, P.other]);

/** Silhouette for a taxon: as its group, except snails and clams get a shell (not an octopus) and seals and sea cows
 *  their own shapes (not a whale). */
export function silhouetteFor(t: Taxon): SVGSVGElement {
  const g = groupOf(t);
  if (g === 'molluscs' && t.class !== 'Cephalopoda') return silhouette(g, SHELL);
  if (g === 'mammals') { const k = mammalKind(t); if (k !== 'whale') return silhouette(g, k === 'seal' ? SEAL : SEACOW); }
  return silhouette(g);
}

export function silhouette(group: GroupId, d = P[group]): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('silhouette');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  if (EVENODD.has(d)) { path.setAttribute('fill-rule', 'evenodd'); }
  else if (STROKED.has(group)) { path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '3'); path.setAttribute('stroke-linecap', 'round'); }
  svg.append(path);
  return svg;
}
