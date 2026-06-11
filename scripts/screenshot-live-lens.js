#!/usr/bin/env node
// Capture live-route evidence from a running Symphony /lens at multiple viewports.
// Usage: node scripts/screenshot-live-lens.js [baseUrl]
// Writes output/playwright/living-agent-lens/live-<stamp>-<slug>-<w>x<h>.png
// (output/playwright/ is intentionally gitignored — see
//  docs/analysis/living-agent-lens-evidence.md for the regeneration recipe.)

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const baseUrl = process.argv[2] || 'http://127.0.0.1:61029';
const outDir = path.resolve(__dirname, '..', 'output/playwright/living-agent-lens');

function stamp() {
  const d = new Date();
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const matrix = [
  { slug: 'desktop',         width: 1586, height: 992,  reducedMotion: 'no-preference' },
  { slug: 'medium',          width: 1440, height: 1000, reducedMotion: 'no-preference' },
  { slug: 'small',           width: 1280, height: 900,  reducedMotion: 'no-preference' },
  { slug: 'mobile',          width: 680,  height: 1000, reducedMotion: 'no-preference' },
  { slug: 'reduced-motion',  width: 1586, height: 992,  reducedMotion: 'reduce' }
];

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const frame of matrix) {
      const ctx = await browser.newContext({
        viewport: { width: frame.width, height: frame.height },
        deviceScaleFactor: 2,
        reducedMotion: frame.reducedMotion
      });
      const page = await ctx.newPage();
      const url = `${baseUrl}/lens`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.lens-app');
      // Wait for the first /api/v1/living-agent-lens response to render.
      await page.waitForTimeout(1400);
      const file = `live-${stamp()}-${frame.slug}-${frame.width}x${frame.height}.png`;
      await page.screenshot({ path: path.join(outDir, file), fullPage: false });
      console.log(`Wrote ${path.relative(path.resolve(__dirname, '..'), path.join(outDir, file))}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
})();
