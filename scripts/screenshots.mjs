// Regenerate the README screenshots from a running site (default: the Vite dev server).
// usage: npm run dev   (in another terminal)   then   node scripts/screenshots.mjs [baseUrl]
// Needs Google Chrome installed (playwright-core drives it, nothing is downloaded).
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5199/';
const out = 'docs/img';
mkdirSync(out, { recursive: true });

const shots = [
  { file: 'hero.png', hash: '#at=-16.50,146.20', size: [1440, 900], wait: '.tile img.in' },
  { file: 'migrations-tracks.png', hash: '#sp=137209', size: [1440, 900], click: '.tags .btn', wait: '.track-list' },
  { file: 'complete.png', hash: '#layer=complete', size: [1440, 900], wait: null },
  { file: 'phone.png', hash: '#at=27.50,34.20', size: [390, 844], wait: '.tile img.in', mobile: true },
]

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
for (const s of shots) {
  const ctx = await browser.newContext({ viewport: { width: s.size[0], height: s.size[1] }, deviceScaleFactor: s.mobile ? 2 : 1, isMobile: !!s.mobile, hasTouch: !!s.mobile });
  const page = await ctx.newPage();
  await page.goto(base + s.hash, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  if (s.search) {
    await page.fill('#search', s.search);
    await page.waitForSelector('#hits .hit-thumb img', { timeout: 40000 }).catch(() => console.warn(`${s.file}: no thumbnails`));
  }
  if (s.click) {
    await page.waitForSelector(s.click, { timeout: 45000 }).catch(() => {});
    await page.click(s.click).catch((e) => console.warn(`${s.file}: click failed: ${e.message}`));
  }
  if (s.wait) await page.waitForSelector(s.wait, { timeout: 90000 }).catch(() => console.warn(`${s.file}: ${s.wait} did not appear`));
  await page.waitForTimeout(4000); // tiles, photos and the fly-to settle
  await page.screenshot({ path: `${out}/${s.file}` });
  console.log(`${out}/${s.file}`);
  await ctx.close();
}
await browser.close();
