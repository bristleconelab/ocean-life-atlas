// Parsing Wikidata answers into what a species card needs. Pure (test/misc.test.ts).
import { md5 } from './md5';

/** article: a Wikipedia URL, in the reader's language when one exists (articleLang says which). */
export interface WikiInfo { name?: string; image?: string; article?: string; articleLang?: string }

/** File name from a Commons Special:FilePath URL ("Whale shark Georgia aquarium.jpg"). */
export function commonsFile(url: string): string | null {
  const m = /Special:FilePath\/(.+)$/.exec(url);
  if (!m) return null;
  try { return decodeURIComponent(m[1]).replace(/_/g, ' '); } catch { return null; }
}

/** Widths Wikimedia pre-renders and caches; any other width is scaled on demand (slow, and throttled with HTTP 429). */
export const STANDARD_WIDTHS = [120, 250, 330, 500, 960, 1280];
export function standardWidth(w: number): number {
  return STANDARD_WIDTHS.find((s) => s >= w) ?? STANDARD_WIDTHS[STANDARD_WIDTHS.length - 1];
}

/** Candidate URLs for a Commons thumbnail, fastest first:
 *  1. the CDN path on upload.wikimedia.org (no redirect; keyed by the MD5 of the file name),
 *  2. Special:FilePath on commons.wikimedia.org (a redirect through the app servers; also copes with files smaller
 *     than the width, where the CDN path fails). */
export function commonsThumbs(file: string, width: number): string[] {
  const w = standardWidth(width);
  const name = file.replace(/ /g, '_').replace(/^./, (c) => c.toUpperCase());
  const fallback = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=${w}`;
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
  let thumb: string;
  if (ext === 'svg') thumb = `${w}px-${name}.png`;
  else if (ext === 'tif' || ext === 'tiff') thumb = `lossy-page1-${w}px-${name}.jpg`;
  else if (ext === 'pdf' || ext === 'djvu') thumb = `page1-${w}px-${name}.jpg`;
  else if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) thumb = `${w}px-${name}`;
  else return [fallback];
  const hash = md5(name);
  return [`https://upload.wikimedia.org/wikipedia/commons/thumb/${hash[0]}/${hash.slice(0, 2)}/${encodeURIComponent(name)}/${encodeURIComponent(thumb)}`, fallback];
}
export const commonsThumb = (file: string, width: number) => commonsThumbs(file, width)[0];

/** Wikipedia title from an article URL. */
export function articleTitle(url: string): string | null {
  const m = /\/wiki\/(.+)$/.exec(url);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

/** A readable name: the label in the reader's language, then their common name, then the English label (usually
 *  matches Wikipedia: "long-finned pilot whale"), then an English common name; never the scientific name itself
 *  (Wikidata often labels taxa with it). */
export function pickName(b: Record<string, { value: string } | undefined>, scientific?: string): string | undefined {
  const sci = scientific?.trim().toLowerCase();
  for (const k of ['label', 'common', 'labelEn', 'commonEn']) {
    const v = b[k]?.value?.trim();
    // skip catalogue entries that are not names ("Species code: Hs", seen on Halophila stipulacea)
    if (v && v.toLowerCase() !== sci && !/:|\bcode\b/i.test(v)) return v.charAt(0).toUpperCase() + v.slice(1);
  }
  return undefined;
}

export function parseWikidata(bindings: Record<string, { value: string } | undefined>[], sciById?: Map<number, string>, lang = 'en'): Map<number, WikiInfo> {
  const out = new Map<number, WikiInfo>();
  for (const b of bindings) {
    const id = Number(b.aphia?.value);
    if (!Number.isInteger(id) || id <= 0) continue;
    const image = b.image ? commonsFile(b.image.value) ?? undefined : undefined;
    const article = b.article?.value ?? b.articleEn?.value;
    const articleLang = b.article?.value ? lang : b.articleEn?.value ? 'en' : undefined;
    out.set(id, { name: pickName(b, sciById?.get(id)), image, article, articleLang });
  }
  return out;
}

/** Playable URLs for a Commons sound file: an MP3 transcode first (Safari cannot play Ogg), then the original. */
export function commonsAudio(file: string): { src: string; type: string }[] {
  const name = file.replace(/ /g, '_').replace(/^./, (c) => c.toUpperCase());
  const hash = md5(name);
  const original = { src: `https://upload.wikimedia.org/wikipedia/commons/${hash[0]}/${hash.slice(0, 2)}/${encodeURIComponent(name)}`, type: /\.mp3$/i.test(name) ? 'audio/mpeg' : /\.wav$/i.test(name) ? 'audio/wav' : /\.flac$/i.test(name) ? 'audio/flac' : 'audio/ogg' };
  if (/\.mp3$/i.test(name)) return [original];
  return [{ src: `https://upload.wikimedia.org/wikipedia/commons/transcoded/${hash[0]}/${hash.slice(0, 2)}/${encodeURIComponent(name)}/${encodeURIComponent(name)}.mp3`, type: 'audio/mpeg' }, original];
}
