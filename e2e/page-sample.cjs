/* Builds a realistic sample manga page through the real UI, then exports it at print DPI.
 * Usage: npm run build && npx vite preview --port 4173 &  then  node e2e/page-sample.cjs
 * Env: CF_E2E_URL, CF_E2E_OUT
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const D = __dirname + '/';
const OUT = process.env.CF_E2E_OUT || require('os').tmpdir();
const BASE = process.env.CF_E2E_URL || 'http://localhost:4173/';

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));

  await page.goto(BASE + '?e2e');
  await page.getByTestId('new-character').click();
  await page.getByPlaceholder('New project name').fill('Sample Page');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByTestId('import-original').setInputFiles(D + 'fixture-original.png');
  await page.locator('[data-testid=original-box] img').waitFor();

  // one accepted result to place
  await page.getByTestId('ws-generate').click();
  await page.getByTestId('import-result').setInputFiles(D + 'fixture-result.png');
  await page.getByTestId('result-item').first().waitFor();
  await page.getByTestId('result-item').first().click();
  await page.getByTestId('accept').click();
  await page.getByTestId('status-chip').filter({ hasText: 'Accepted' }).waitFor();

  await page.getByTestId('ws-page').click();
  await page.getByTestId('page-canvas').waitFor();
  await page.getByTestId('layout-splash').click();
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__cfStore.selectPageItem(null));
  await page.getByTestId('target-panel').waitFor();

  const panelIds = await page.evaluate(() => {
    const sel = document.querySelector('[data-testid=target-panel]');
    return [...sel.options].map((o) => o.value).filter(Boolean);
  });

  // place the character into each of the three panels
  for (const id of panelIds) {
    await page.evaluate(() => window.__cfStore.selectPageItem(null));
    await page.getByTestId('target-panel').waitFor();
    await page.getByTestId('target-panel').selectOption(id);
    await page.getByTestId('place-result').first().click();
    await page.waitForTimeout(250);
  }

  // lettering, positioned through the store (the same calls the inspector makes)
  const bubbles = [
    { kind: 'speech', text: 'You came back…', fx: 0.26, fy: 0.1, fw: 0.26, fh: 0.085, tail: 120 },
    { kind: 'thought', text: 'She is not the same person.', fx: 0.72, fy: 0.2, fw: 0.3, fh: 0.1, tail: 200 },
    { kind: 'caption', text: 'Three years later.', fx: 0.2, fy: 0.66, fw: 0.3, fh: 0.055, tail: null },
    { kind: 'shout', text: 'RUN!', fx: 0.72, fy: 0.8, fw: 0.2, fh: 0.1, tail: 90 },
  ];
  for (const b of bubbles) {
    await page.getByTestId(`add-bubble-${b.kind}`).click();
    await page.getByTestId('bubble-text').waitFor();
    await page.getByTestId('bubble-text').fill(b.text);
    await page.evaluate((b) => {
      const s = window.__cfStore;
      const pg = s.page;
      const sel = s.ui.page.selection;
      if (!sel || sel.kind !== 'bubble') return;
      const W = pg.size.width;
      const H = pg.size.height;
      const dpi = pg.dpi;
      const px = (mm) => (mm / 25.4) * dpi;
      s.updateBubble(sel.id, {
        x: px(W) * b.fx,
        y: px(H) * b.fy,
        width: px(W) * b.fw,
        height: px(H) * b.fh,
        tail: b.tail,
        fontSize: Math.round(px(W) * 0.021),
      });
    }, b);
    await page.waitForTimeout(150);
  }

  await page.waitForTimeout(600);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByTestId('export-page').click()]);
  const file = path.join(OUT, 'sample-page.png');
  await dl.saveAs(file);
  const buf = fs.readFileSync(file);
  console.log('exported', buf.readUInt32BE(16), 'x', buf.readUInt32BE(20), '→', file);
  await page.screenshot({ path: path.join(OUT, 'sample-workspace.png') });
  await browser.close();
})();
