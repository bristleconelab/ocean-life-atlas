import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PUB = join(__dirname, '..', 'public');
const SITE = 'https://oceanlife.bristleconelab.org';

describe('static pages for search engines', () => {
  const sitemap = readFileSync(join(PUB, 'sitemap.xml'), 'utf8');
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  it('lists every generated page in the sitemap, and only those', () => {
    const species = readdirSync(join(PUB, 'species')).filter((d) => d !== 'index.html');
    const places = readdirSync(join(PUB, 'places')).filter((d) => d !== 'index.html');
    expect(urls).toHaveLength(4 + species.length + places.length);
    for (const u of urls.slice(1)) expect(existsSync(join(PUB, u.replace(SITE, ''), 'index.html'))).toBe(true);
    expect(readFileSync(join(PUB, 'robots.txt'), 'utf8')).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });
  it('gives each page a canonical URL, a title, a description and valid JSON-LD', () => {
    for (const u of urls.slice(1)) {
      const html = readFileSync(join(PUB, u.replace(SITE, ''), 'index.html'), 'utf8');
      expect(html).toContain(`<link rel="canonical" href="${u}">`);
      expect(html).toMatch(/<title>[^<]{10,}<\/title>/);
      expect(html).toMatch(/<meta name="description" content="[^"]{40,}">/);
      for (const m of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)) expect(() => JSON.parse(m[1])).not.toThrow();
    }
  });
  it('writes the same numbers the summary recorded (whale shark)', () => {
    const sum = JSON.parse(readFileSync(join(PUB, 'data', 'seo-summary.json'), 'utf8'));
    const ws = sum.species.find((s: { slug: string }) => s.slug === 'whale-shark');
    expect(ws.id).toBe(105847);
    const html = readFileSync(join(PUB, 'species', 'whale-shark', 'index.html'), 'utf8');
    expect(html).toContain(`recorded ${ws.records.toLocaleString('en-US')} times`);
    expect(html).toContain('href="/#sp=105847"');
  });
});
