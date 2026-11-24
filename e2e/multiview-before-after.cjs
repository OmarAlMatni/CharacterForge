/* Before/after render for the multi-view projection (upgrade 04).
 *
 * Renders the SAME character, pose and camera twice:
 *   - BEFORE: one view (the front drawing only) — the v0.5.0 behaviour, where the flank is extended from the front
 *             drawing's outline because a front drawing says nothing about the side of a torso.
 *   - AFTER:  three views (front + side + back) — each surface is painted by the drawing it faces.
 *
 * Both images come from one build, one mesh, one pose, one camera. Only the view set differs.
 *
 * Usage:  npx vite preview --port 4173 &   then   node e2e/multiview-before-after.cjs
 * Env: CF_E2E_URL (default http://localhost:4173/), CF_E2E_OUT (default e2e/out)
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const D = __dirname + '/';
const OUT = process.env.CF_E2E_OUT || path.join(D, 'out');
const BASE = process.env.CF_E2E_URL || 'http://localhost:4173/';
const FRONT = D + 'fixture-original.png';
const SIDE = process.env.CF_E2E_SIDE || D + 'fixture-side.png';
const BACK = process.env.CF_E2E_BACK || D + 'fixture-back.png';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(BASE + '?e2e');
  await page.getByTestId('new-character').click();
  await page.getByPlaceholder('New project name').fill('Multi-view A/B');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByTestId('import-original').setInputFiles(FRONT);
  await page.locator('[data-testid=original-box] img').waitFor();

  // add the side and back drawings as references, so the view picker can offer them
  await page.getByTestId('import-references').setInputFiles([SIDE, BACK]);
  await page.waitForTimeout(1500);

  await page.getByTestId('ws-studio').click();
  await page.getByTestId('studio-host').locator('canvas').waitFor();
  await page.waitForTimeout(600);
  await page.getByTestId('preset-neutral').click();
  await page.waitForTimeout(300);

  const setAz = async (deg) => {
    const az = page.getByLabel('Camera angle');
    await az.fill(String(deg));
    await az.dispatchEvent('input');
    await page.waitForTimeout(600);
  };
  const host = page.getByTestId('studio-host');

  // ---- BEFORE: one view ----
  await page.getByTestId('project-artwork').click();
  await page.waitForTimeout(3500);
  for (const deg of [0, 40, 90]) {
    await setAz(deg);
    await host.screenshot({ path: path.join(OUT, `one-view-${deg}.png`) });
    console.log(`wrote one-view-${deg}.png`);
  }

  // ---- AFTER: add the side and back views ----
  const refs = await page.getByLabel('Add view from reference').locator('option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent })));
  console.log('reference options:', JSON.stringify(refs));
  const sideOpt = refs.find((r) => r.v && /side/i.test(r.t || '')) || refs.find((r) => r.v);
  const backOpt = refs.filter((r) => r.v).find((r) => r !== sideOpt);

  if (sideOpt) {
    await page.getByLabel('Add view from reference').selectOption(sideOpt.v);
    await page.getByLabel('View angle').selectOption('90');
    await page.getByTestId('add-view').click();
    await page.waitForTimeout(4000);
  }
  if (backOpt) {
    await page.getByLabel('Add view from reference').selectOption(backOpt.v);
    await page.getByLabel('View angle').selectOption('180');
    await page.getByTestId('add-view').click();
    await page.waitForTimeout(4000);
  }

  const viewList = await page.getByTestId('view-list').innerText().catch(() => '(no view list)');
  console.log('view list:', viewList.replace(/\n/g, ' | '));

  for (const deg of [0, 40, 90]) {
    await setAz(deg);
    await host.screenshot({ path: path.join(OUT, `multi-view-${deg}.png`) });
    console.log(`wrote multi-view-${deg}.png`);
  }

  console.log('console errors:', errors.length ? errors.slice(0, 5) : 'none');
  await browser.close();
  console.log('wrote to', OUT);
})().catch((e) => { console.error('HARNESS FAILED', e); process.exit(1); });
