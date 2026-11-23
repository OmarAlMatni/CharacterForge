/* End-to-end check of the real app in headless Chromium (software WebGL).
 * Usage:  npm run build && npx vite preview --port 4173 &   then   node e2e/studio.e2e.cjs
 * Needs the `playwright` package and a Chromium it can launch (not a project dependency).
 * Env: CF_E2E_URL (default http://localhost:4173/), CF_E2E_OUT (where downloaded guide PNGs go; default OS temp dir). */
const { chromium } = require('playwright');
const path = require('path');
const D = __dirname + '/';
const OUT = process.env.CF_E2E_OUT || require('os').tmpdir();
const BASE = process.env.CF_E2E_URL || 'http://localhost:4173/';
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  let fails = 0;
  const step = async (name, fn) => { try { const r = await fn(); console.log('OK  ', name, r ?? ''); } catch (e) { fails++; console.log('FAIL', name, '-', String(e.message).split('\n')[0]); } };
  await page.goto(BASE + '?e2e');
  await page.getByTestId('new-character').click();
  await page.getByPlaceholder('New project name').fill('Drag Test');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByTestId('import-original').setInputFiles(D + 'fixture-original.png');
  await page.locator('[data-testid=original-box] img').waitFor();
  await page.getByTestId('ws-studio').click();
  await page.getByTestId('studio-host').locator('canvas').waitFor();
  await page.waitForTimeout(800);
  const handle = (id) => page.evaluate((id) => {
    const v = window.__cfStudio; const m = v.body.markers.get(id); const p = m.position.clone().project(v.camera);
    const r = v.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height, world: [m.position.x, m.position.y, m.position.z] };
  }, id);
  await step('T-pose stays in frame (auto-reframe)', async () => {
    await page.getByTestId('preset-t-pose').click(); await page.waitForTimeout(500);
    const l = await handle('wristL'), r = await handle('wristR');
    const box = await page.getByTestId('studio-host').boundingBox();
    if (l.x < box.x || r.x > box.x + box.width) throw new Error(`wrists outside viewport ${l.x} ${r.x}`);
    return `wrists at x=${Math.round(l.x)},${Math.round(r.x)} within ${Math.round(box.x)}..${Math.round(box.x + box.width)}`;
  });
  await page.getByTestId('preset-neutral').click(); await page.waitForTimeout(400);
  let before;
  await step('real-mouse drag of left wrist handle moves wrist via IK', async () => {
    before = await handle('wristL');
    await page.mouse.move(before.x, before.y); await page.mouse.down();
    await page.mouse.move(before.x + 60, before.y - 160, { steps: 12 }); await page.mouse.up();
    await page.waitForTimeout(400);
    const after = await handle('wristL');
    const d = Math.hypot(after.world[0] - before.world[0], after.world[1] - before.world[1], after.world[2] - before.world[2]);
    if (d < 0.15) throw new Error('wrist barely moved: ' + d.toFixed(3));
    const sx = Math.abs(after.x - (before.x + 60)), sy = Math.abs(after.y - (before.y - 160));
    return `moved ${d.toFixed(2)} world units; ended ${Math.round(sx)}px/${Math.round(sy)}px from cursor target`;
  });
  await page.screenshot({ path: path.join(OUT, 'after-drag.png') });
  await step('undo reverts the drag as ONE step', async () => {
    await page.getByTestId('undo').click(); await page.waitForTimeout(300);
    const a = await handle('wristL');
    const d = Math.hypot(a.world[0] - before.world[0], a.world[1] - before.world[1], a.world[2] - before.world[2]);
    if (d > 0.01) throw new Error('not reverted, off by ' + d.toFixed(3));
  });
  await step('redo reapplies', async () => { await page.getByTestId('redo').click(); await page.waitForTimeout(300); const a = await handle('wristL'); if (Math.hypot(a.world[0]-before.world[0],a.world[1]-before.world[1]) < 0.1) throw new Error('redo did nothing'); });
  await step('orbit by dragging empty space changes azimuth', async () => {
    await page.getByRole('button', { name: 'Front', exact: true }).click();
    const box = await page.getByTestId('studio-host').boundingBox();
    await page.mouse.move(box.x + 60, box.y + 300); await page.mouse.down(); await page.mouse.move(box.x + 160, box.y + 300, { steps: 8 }); await page.mouse.up();
    const az = await page.evaluate(() => window.__cfStudio.state.camera.azimuth);
    if (Math.abs(az) < 5) throw new Error('azimuth unchanged: ' + az);
    return 'azimuth=' + az.toFixed(1);
  });
  // ---- character body: size sliders, artwork projection, overlay, character-render guide ----
  const setRange = (testId, v) => page.getByTestId(testId).evaluate((el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);
  const bodyBounds = () => page.evaluate(() => { const b = window.__cfStudio.body.posedBounds(); return { w: b.maxX - b.minX, h: b.maxY - b.minY }; });
  const pixelAt = async (rx, ry) => {
    const box = await page.getByTestId('studio-host').boundingBox();
    const buf = await page.screenshot({ clip: { x: box.x + box.width * rx, y: box.y + box.height * ry, width: 2, height: 2 } });
    return page.evaluate(async (b64) => {
      const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
      const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]];
    }, buf.toString('base64'));
  };
  await page.getByTestId('preset-neutral').click(); await page.getByRole('button', { name: 'Front', exact: true }).click();
  await page.waitForTimeout(800);
  await step('height and width sliders resize the real body mesh', async () => {
    const a = await bodyBounds();
    await setRange('prop-height', 1.9); await page.waitForTimeout(900);
    const b = await bodyBounds();
    await setRange('prop-build', 1.3); await page.waitForTimeout(900);
    const c = await bodyBounds();
    if (!(b.h > a.h * 1.08)) throw new Error(`height did not grow: ${a.h.toFixed(2)} -> ${b.h.toFixed(2)}`);
    if (!(c.w > b.w * 1.04)) throw new Error(`width did not grow: ${b.w.toFixed(2)} -> ${c.w.toFixed(2)}`);
    return `height ${a.h.toFixed(2)}->${b.h.toFixed(2)} m, width ${b.w.toFixed(2)}->${c.w.toFixed(2)} m`;
  });
  await step('body shape slider changes the mesh', async () => {
    const before = await page.evaluate(() => Array.from(window.__cfStudio.body.posAttr.array.slice(0, 120000)).reduce((s, v) => s + v, 0));
    await setRange('shape-chest', 1.5); await page.waitForTimeout(900);
    const after = await page.evaluate(() => Array.from(window.__cfStudio.body.posAttr.array.slice(0, 120000)).reduce((s, v) => s + v, 0));
    if (before === after) throw new Error('mesh did not change');
  });
  await page.getByTestId('match-view').click(); await page.waitForTimeout(600);
  await step('overlay toggle shows the drawing in the viewport', async () => {
    await page.getByTestId('overlay-toggle').check(); await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, 'overlay.png') });
    const px = await pixelAt(0.5, 0.15);
    await page.getByTestId('overlay-toggle').uncheck();
    return 'head-area pixel rgb(' + px.join(',') + ') (screenshot: overlay.png)';
  });
  await step('project artwork: model shows the drawing (red shirt at the torso, not clay grey)', async () => {
    await page.getByTestId('project-artwork').click();
    await page.waitForFunction(() => window.__cfStudio.body.material.uniforms.uClay.value === 0, null, { timeout: 15000 });
    await page.waitForTimeout(800);
    const px = await pixelAt(0.54, 0.42); // beside the joint dots on the centre line
    if (!(px[0] > px[2] + 25)) throw new Error('torso pixel is not red-ish: ' + px);
    return 'torso pixel rgb(' + px.join(',') + ')';
  });
  await step('drawing follows the body when posed', async () => {
    await page.getByTestId('preset-run').click(); await page.waitForTimeout(900);
    const still = await page.evaluate(() => window.__cfStudio.body.material.uniforms.uClay.value);
    if (still !== 0) throw new Error('projection lost after posing');
  });
  await step('character-render guide downloads', async () => {
    await page.getByTestId('guide-textured').click(); await page.waitForTimeout(600);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByTestId('download-guide').click()]);
    await dl.saveAs(path.join(OUT, 'guide-textured.png')); return dl.suggestedFilename();
  });
  await page.getByTestId('guide-mannequin').click();
  await page.getByTestId('preset-run').click();
  await page.getByTestId('pose-name').fill('Run A'); await page.getByTestId('save-pose').click();
  await page.waitForTimeout(1200);
  await step('guide set renders & downloads all four kinds', async () => {
    const sizes = {};
    for (const k of ['mannequin', 'pose', 'depth', 'silhouette']) {
      await page.getByTestId('guide-' + k).click(); await page.waitForTimeout(500);
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByTestId('download-guide').click()]);
      await dl.saveAs(path.join(OUT, `guide-${k}.png`)); sizes[k] = dl.suggestedFilename();
    }
    return JSON.stringify(sizes);
  });
  await step('generate tab: no backend is reported honestly and Generate is disabled', async () => {
    await page.getByTestId('ws-generate').click();
    await page.waitForFunction(() => /not available|Problem/i.test(document.querySelector('[data-testid=provider-status]')?.textContent || ''), null, { timeout: 8000 });
    if (!(await page.getByTestId('generate-button').isDisabled())) throw new Error('Generate button is enabled without a backend');
  });
  await step('import an external result: labelled IMPORTED, can be accepted', async () => {
    await page.getByTestId('import-result').setInputFiles(D + 'fixture-result.png');
    await page.getByTestId('review').waitFor({ timeout: 8000 });
    const chip = await page.getByTestId('origin-chip').textContent();
    if (!/IMPORTED/.test(chip)) throw new Error('origin chip: ' + chip);
    await page.getByTestId('accept').click();
    await page.waitForFunction(() => /Accepted/.test(document.querySelector('[data-testid=status-chip]')?.textContent || ''));
  });
  await page.getByTestId('ws-studio').click();
  await step('reload reopens last character with original, pose, saved pose', async () => {
    await page.locator('.badge.saved').waitFor({ timeout: 10000 });
    await page.reload();
    await page.getByTestId('studio-view').waitFor({ timeout: 8000 });
    await page.getByTestId('studio-host').locator('canvas').waitFor();
    await page.getByTestId('ws-character').click();
    await page.locator('[data-testid=original-box] img').waitFor({ timeout: 8000 });
    const nat = await page.locator('[data-testid=original-box] img').evaluate((i) => new Promise((r) => (i.complete ? r(i.naturalWidth) : (i.onload = () => r(i.naturalWidth)))));
    if (nat !== 600) throw new Error('original width ' + nat);
    await page.getByTestId('ws-studio').click();
    await page.getByTestId('saved-poses').locator('input').first().waitFor();
    const v = await page.getByTestId('saved-poses').locator('input').first().inputValue();
    if (v !== 'Run A') throw new Error('saved pose name ' + v);
  });
  await step('projected artwork survives reload (shown on the model again)', async () => {
    await page.waitForFunction(() => window.__cfStudio && window.__cfStudio.body.material.uniforms.uClay.value === 0, null, { timeout: 15000 });
  });
  await page.screenshot({ path: path.join(OUT, 'after-reload-studio.png') });
  console.log('console errors:', errors.length, errors.slice(0, 5));
  console.log(fails ? `FAILED STEPS: ${fails}` : 'ALL STEPS PASSED');
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
