#!/usr/bin/env node
// Reduced-motion lens screenshot WITH the Honest Gaps panel open, against the
// fixture preview. Useful for documenting backend-gap surfacing. Writes to
// output/playwright/living-agent-lens/ which is intentionally gitignored — see
// docs/analysis/living-agent-lens-evidence.md.

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'output/playwright/living-agent-lens');
const previewPath = path.join(outDir, 'lens-preview.html');

(async () => {
  if (!fs.existsSync(previewPath)) {
    console.error('Preview HTML not found. Run scripts/build-lens-preview.js first.');
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1586, height: 992 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce'
  });
  const page = await ctx.newPage();
  await page.goto('file://' + previewPath);
  await page.waitForSelector('.lens-app');
  await page.waitForTimeout(400);
  await page.evaluate(() =>
    document.querySelector('.lens-missing-chip')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  );
  await page.waitForTimeout(400);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = path.join(outDir, `${stamp}-reduced-motion-with-gaps.png`);
  await page.screenshot({ path: file });
  console.log(`Wrote ${path.relative(root, file)}`);
  await browser.close();
})();
