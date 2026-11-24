/* End-to-end check of the Page workspace in headless Chromium.
 * Usage:  npm run build && npx vite preview --port 4173 &   then   node e2e/page.e2e.cjs
 * Env: CF_E2E_URL (default http://localhost:4173/), CF_E2E_OUT (where the exported page goes; default OS temp dir)
 *
 * Walks the real product path: create a character, import the original, import a result, accept it, open the Page tab,
 * place the accepted result into a panel, add a speech bubble, then export the page and check the PNG is print-sized.
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
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  let fails = 0;
  const step = async (name, fn) => {
    try { const r = await fn(); console.log('OK  ', name, r ?? ''); }
    catch (e) { fails++; console.log('FAIL', name, '-', String(e.message).split('\n')[0]); }
  };

  await page.goto(BASE + '?e2e');
  await page.getByTestId('new-character').click();
  await page.getByPlaceholder('New project name').fill('Page Test');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByTestId('import-original').setInputFiles(D + 'fixture-original.png');
  await page.locator('[data-testid=original-box] img').waitFor();

  await step('import a result and accept it', async () => {
    await page.getByTestId('ws-generate').click();
    await page.getByTestId('import-result').setInputFiles(D + 'fixture-result.png');
    await page.getByTestId('result-item').first().waitFor();
    await page.getByTestId('result-item').first().click();
    await page.getByTestId('accept').click();
    await page.getByTestId('status-chip').filter({ hasText: 'Accepted' }).waitFor();
  });

  await step('open the Page workspace', async () => {
    await page.getByTestId('ws-page').click();
    await page.getByTestId('page-canvas').waitFor();
    const n = await page.locator('[data-testid=page-canvas]').count();
    if (n !== 1) throw new Error('page canvas missing');
  });

  await step('the page starts with a 6-panel layout', async () => {
    const txt = await page.locator('.status').first().innerText();
    if (!/6 panels/.test(txt)) throw new Error(`expected 6 panels, got: ${txt}`);
    return txt.split('\n')[0];
  });

  await step('place the accepted result into a panel', async () => {
    await page.getByTestId('accepted-list').waitFor();
    await page.getByTestId('place-result').first().click();
    await page.waitForTimeout(400);
    const txt = await page.locator('.status').first().innerText();
    if (!/1 image/.test(txt)) throw new Error(`expected 1 image, got: ${txt}`);
    return txt.split('\n')[0];
  });

  await step('the placed image is actually painted (not a blank panel)', async () => {
    const stats = await page.evaluate(() => {
      const c = document.querySelector('[data-testid=page-canvas]');
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let nonWhite = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) nonWhite++;
      }
      return { total: d.length / 4, nonWhite, w: c.width, h: c.height };
    });
    const frac = stats.nonWhite / stats.total;
    if (frac < 0.02) throw new Error(`only ${(frac * 100).toFixed(1)}% of the page is non-white — the image did not draw`);
    return `${(frac * 100).toFixed(1)}% of ${stats.w}×${stats.h} painted`;
  });

  await step('add a speech bubble and type into it', async () => {
    await page.getByTestId('add-bubble-speech').click();
    await page.getByTestId('bubble-text').waitFor();
    await page.getByTestId('bubble-text').fill('I will protect you!');
    await page.waitForTimeout(300);
    const txt = await page.locator('.status').first().innerText();
    if (!/1 bubble/.test(txt)) throw new Error(`expected 1 bubble, got: ${txt}`);
  });

  await step('switch to a different layout and keep the placed image', async () => {
    await page.getByTestId('layout-four-grid').click();
    await page.waitForTimeout(300);
    const txt = await page.locator('.status').first().innerText();
    if (!/4 panels/.test(txt)) throw new Error(`expected 4 panels, got: ${txt}`);
    if (!/1 image/.test(txt)) throw new Error(`the placed image was lost: ${txt}`);
    return txt.split('\n')[0];
  });

  await step('export the page at print DPI', async () => {
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.getByTestId('export-page').click(),
    ]);
    const file = path.join(OUT, 'page-export.png');
    await dl.saveAs(file);
    const buf = fs.readFileSync(file);
    // PNG IHDR: width/height are big-endian uint32 at bytes 16..24
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (buf.length < 1000) throw new Error(`exported file is only ${buf.length} bytes`);
    // B5 182×257 mm at 300 dpi + 3 mm bleed = 2150+71 × 3035+71
    if (w < 2100 || h < 3000) throw new Error(`exported ${w}×${h}, expected print size`);
    return `${w}×${h} px, ${(buf.length / 1024).toFixed(0)} KB → ${file}`;
  });

  await step('the page survives a reload (autosave)', async () => {
    await page.waitForTimeout(1200);
    await page.reload();
    await page.getByTestId('ws-page').click();
    await page.getByTestId('page-canvas').waitFor();
    await page.waitForTimeout(600);
    const txt = await page.locator('.status').first().innerText();
    if (!/1 image/.test(txt)) throw new Error(`the placed image did not persist: ${txt}`);
    return txt.split('\n')[0];
  });

  await page.screenshot({ path: path.join(OUT, 'page-workspace.png') });
  console.log('\nconsole errors:', errors.length ? errors.slice(0, 5) : 'none');
  console.log(fails === 0 ? '\nALL STEPS PASSED' : `\n${fails} STEP(S) FAILED`);
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})();
