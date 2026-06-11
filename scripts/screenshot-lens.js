#!/usr/bin/env node
// Usage: node scripts/screenshot-lens.js [slug] [width] [height]
// Renders output/playwright/living-agent-lens/lens-preview.html in Chromium at
// the given viewport and saves a screenshot named YYYYMMDD-HHMMSS-<slug>.png
// under output/playwright/living-agent-lens/ (intentionally gitignored — see
// docs/analysis/living-agent-lens-evidence.md).

const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'output/playwright/living-agent-lens');
const previewPath = path.join(outDir, 'lens-preview.html');

const slug = (process.argv[2] || 'frame').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
const width = Number(process.argv[3] || 1586);
const height = Number(process.argv[4] || 992);

function stamp() {
  const d = new Date();
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

(async () => {
  if (!fs.existsSync(previewPath)) {
    console.error('Preview HTML not found. Run scripts/build-lens-preview.js first.');
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const filename = `${stamp()}-${slug}-${width}x${height}.png`;
  const outPath = path.join(outDir, filename);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto('file://' + previewPath);
    // Wait for the lens app to mount and for one render cycle.
    await page.waitForSelector('.lens-app');
    await page.waitForTimeout(900);
    await page.screenshot({ path: outPath, fullPage: false });
    console.log(`Wrote ${path.relative(root, outPath)}`);
  } finally {
    await browser.close();
  }
})();
