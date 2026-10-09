// Renders icons/icon.svg to the PNG sizes the PWA needs (spec §3: 180 for iOS, 192 + 512 for the manifest).
// Usage: npm run icons   (uses the Playwright Chromium already in the dev environment)
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const root = new URL('../', import.meta.url);
const svg = await readFile(new URL('icons/icon.svg', root), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [size, name] of [[180, 'apple-touch-icon-180.png'], [192, 'icon-192.png'], [512, 'icon-512.png']]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:#0A0A0B">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: new URL(`icons/${name}`, root).pathname, omitBackground: false });
  console.log(`icons/${name}`);
}
await browser.close();
