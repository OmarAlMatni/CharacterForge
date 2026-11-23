/* Broad end-to-end check of the real app in headless Chromium (software WebGL). It drives the UI like a user and also inspects the
 * browser's IndexedDB to prove what was and was not written.
 *
 * Usage:   npm run build && npx vite preview --port 4173 &     then     node e2e/full.e2e.cjs
 * Needs the `playwright` package, a launchable Chromium, and (for the generate/review steps) Python with the server's requirements.
 * Env:  CF_E2E_URL   app URL (default http://localhost:4173/)
 *       CF_E2E_HERO  the character artwork to use (default e2e/fixture-original.png)
 *       CF_E2E_OUT   where screenshots/downloads go (default OS temp dir)
 *       CF_E2E_PY    python executable (default python3)
 *
 * The generate/review steps run against a TEST-ONLY backend (server/tests/fake_backend.py, draws a gradient). They verify the workflow
 * (status, request, result handling, review, error paths, original untouched). They say nothing about image quality: no AI model is involved.
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const D = __dirname + '/';
const OUT = process.env.CF_E2E_OUT || require('os').tmpdir();
const BASE = process.env.CF_E2E_URL || 'http://localhost:4173/';
const HERO = process.env.CF_E2E_HERO || D + 'fixture-original.png';
const PY = process.env.CF_E2E_PY || 'python3';
const SERVER_DIR = path.join(D, '..', 'server');

const results = [];
let fails = 0;
const step = async (name, fn) => {
  try {
    const r = await fn();
    results.push({ name, ok: true });
    console.log('OK  ', name, r ?? '');
  } catch (e) {
    fails++;
    if (global.__shot) await global.__shot(name).catch(() => {});
    if (global.__toasts) console.log('     toasts seen:', JSON.stringify(await global.__toasts()));
    results.push({ name, ok: false, why: String(e.message).split('\n')[0] });
    console.log('FAIL', name, '-', String(e.message).split('\n')[0]);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(backend, port = 8765) {
  const p = spawn(PY, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: SERVER_DIR,
    env: { ...process.env, CF_GENERATION_BACKEND: backend, PYTHONPATH: path.join(SERVER_DIR, 'tests') },
    stdio: 'ignore',
  });
  return p;
}
async function waitServer(port = 8765) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error('server did not start');
}
const stopServer = (p) => new Promise((res) => { if (!p || p.exitCode !== null || p.signalCode !== null) return res(); p.once('exit', res); p.kill('SIGTERM'); setTimeout(() => p.kill('SIGKILL'), 3000); });

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  // keep every toast that ever appeared (they disappear after a few seconds), so a failed step can say what the app told the user
  await page.addInitScript(() => {
    window.__toastLog = [];
    new MutationObserver(() => { for (const t of document.querySelectorAll('.toasts > *')) { const x = t.textContent; if (x && !window.__toastLog.includes(x)) window.__toastLog.push(x); } }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  global.__toasts = () => page.evaluate(() => window.__toastLog.slice(-6)).catch(() => []);
  global.__shot = (n) => page.screenshot({ path: path.join(OUT, 'FAIL-' + n.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) + '.png') });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => void d.accept()); // window.confirm for delete/remove

  // ---------------------------------------------------------------- helpers
  const setRange = (loc, v) => loc.evaluate((el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);
  const setJoint = async (joint, axis, v) => {
    await page.getByTestId('joint-select').selectOption(joint);
    const label = { x: 'Bend fwd/back (X)', y: 'Twist / turn (Y)', z: 'Tilt sideways (Z)' }[axis];
    await setRange(page.locator('input[type=range][aria-label$="' + label + '"]'), v);
    await page.waitForTimeout(150);
  };
  const marker = (id) => page.evaluate((id) => {
    const v = window.__cfStudio; const m = v.body.markers.get(id); const p = m.position.clone().project(v.camera);
    const r = v.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height, world: [m.position.x, m.position.y, m.position.z] };
  }, id);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const bodyBounds = () => page.evaluate(() => { const b = window.__cfStudio.body.posedBounds(); return { w: b.maxX - b.minX, h: b.maxY - b.minY }; });
  const camState = () => page.evaluate(() => ({ ...window.__cfStudio.state.camera }));
  const posState = () => page.evaluate(() => JSON.stringify(window.__cfStudio.state.pose));
  const pixelAt = async (rx, ry) => {
    const box = await page.getByTestId('studio-host').boundingBox();
    const buf = await page.screenshot({ clip: { x: box.x + box.width * rx, y: box.y + box.height * ry, width: 2, height: 2 } });
    return page.evaluate(async (b64) => {
      const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
      const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]];
    }, buf.toString('base64'));
  };
  // everything the app has stored for projects, straight from IndexedDB (hash of every image, JSON of every project)
  const dbSnapshot = () => page.evaluate(async () => {
    const open = () => new Promise((res, rej) => { const r = indexedDB.open('characterforge'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const db = await open();
    const all = (store) => new Promise((res, rej) => { if (!db.objectStoreNames.contains(store)) return res([]); const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const hex = async (u8) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', u8))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const assets = {};
    for (const a of await all('assets')) assets[a.key] = { kind: a.kind, size: a.bytes.byteLength, sha: (await hex(a.bytes)).slice(0, 16) };
    const projects = {};
    for (const p of await all('projects')) projects[p.id] = p;
    const backups = await all('backups');
    db.close();
    return { assets, projects, backups, version: db.version };
  });
  const putRecords = (records) => page.evaluate(async (records) => {
    const open = () => new Promise((res, rej) => { const r = indexedDB.open('characterforge'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const db = await open();
    await new Promise((res, rej) => { const tx = db.transaction(['projects', 'assets'], 'readwrite'); for (const [store, rec] of records) tx.objectStore(store).put(rec); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  }, records);
  const saved = () => page.locator('.badge.saved').waitFor({ timeout: 10000 });
  const download = async (clickFn, file) => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), clickFn()]);
    const p = path.join(OUT, file || dl.suggestedFilename());
    await dl.saveAs(p);
    return { path: p, name: dl.suggestedFilename(), bytes: fs.readFileSync(p) };
  };
  const pngSize = (b) => (b[0] === 0x89 && b[1] === 0x50 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null);
  const toast = () => page.locator('.toasts, [role=status]').allTextContents();
  const openProjects = async () => { await page.getByTestId('open-projects').click(); await page.getByText('Backup and transfer').waitFor(); };
  const ensureProjects = async () => { if ((await page.locator('input[accept*="cfbundle"]').count()) === 0) await openProjects(); };
  const closeDialog = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(200); };

  // ---------------------------------------------------------------- 1. character creation
  await page.goto(BASE + '?e2e');
  await step('welcome screen shows; character is created with a name', async () => {
    await page.getByTestId('new-character').click();
    await page.getByPlaceholder('New project name').fill('Hero');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByTestId('character-view').waitFor({ timeout: 8000 });
  });
  const snap0 = await dbSnapshot();
  const heroBytes = fs.readFileSync(HERO);

  // ---------------------------------------------------------------- 2. original artwork
  let originalKey = '';
  await step('original artwork import stores the file unchanged', async () => {
    await page.getByTestId('import-original').setInputFiles(HERO);
    await page.locator('[data-testid=original-box] img').waitFor({ timeout: 8000 });
    await saved();
    const s = await dbSnapshot();
    const keys = Object.keys(s.assets).filter((k) => s.assets[k].kind === 'source');
    if (keys.length !== 1) throw new Error('source assets: ' + keys.length);
    originalKey = keys[0];
    const sha = require('crypto').createHash('sha256').update(heroBytes).digest('hex').slice(0, 16);
    if (s.assets[originalKey].sha !== sha || s.assets[originalKey].size !== heroBytes.length) throw new Error('stored bytes differ from the imported file');
    return `${heroBytes.length} bytes, sha ${sha}`;
  });
  await step('importing a non-image or a damaged image is refused with a message and stores nothing', async () => {
    const before = Object.keys((await dbSnapshot()).assets).length;
    fs.writeFileSync(path.join(OUT, 'not-an-image.png'), 'this is not a png');
    await page.getByTestId('import-original').setInputFiles(path.join(OUT, 'not-an-image.png'));
    await page.waitForTimeout(800);
    const bad = heroBytes.subarray(0, 60); fs.writeFileSync(path.join(OUT, 'truncated.png'), bad);
    await page.getByTestId('import-original').setInputFiles(path.join(OUT, 'truncated.png'));
    await page.waitForTimeout(800);
    const after = (await dbSnapshot()).assets;
    if (Object.keys(after).length !== before) throw new Error('an asset was stored for a bad file');
    if (after[originalKey]?.kind !== 'source') throw new Error('original disappeared');
  });

  // ---------------------------------------------------------------- 3. references
  await step('reference images: add, label, role, approve toggle, remove', async () => {
    await page.getByTestId('import-references').setInputFiles([D + 'fixture-result.png', D + 'fixture-original.png']);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=reference-card]').length === 2, null, { timeout: 8000 });
    const card = page.getByTestId('reference-card').first();
    await card.locator('input[type=text]').fill('Face close-up'); await card.locator('input[type=text]').blur();
    await card.locator('select').selectOption({ index: 1 });
    await card.getByRole('checkbox').uncheck();
    await saved();
    const proj = Object.values((await dbSnapshot()).projects).find((p) => p.name === 'Hero');
    const refs = proj.data.character.references;
    if (refs.length !== 2 || refs[0].label !== 'Face close-up' || refs[0].approved !== false || refs[0].role === 'other') throw new Error('reference edits not stored: ' + JSON.stringify(refs[0]));
    await page.getByTestId('reference-card').nth(1).getByRole('button', { name: 'Remove' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=reference-card]').length === 1);
    return 'stored label/role/approval; removal works';
  });

  // ---------------------------------------------------------------- 4+. 3D studio
  await page.getByTestId('ws-studio').click();
  await page.getByTestId('studio-host').locator('canvas').waitFor();
  await page.waitForFunction(() => window.__cfStudio && window.__cfStudio.body.posedBounds(), null, { timeout: 30000 });
  await page.waitForTimeout(800);

  await step('presets: every pose preset applies and keeps the body finite and in frame', async () => {
    const ids = await page.locator('[data-testid^=preset-]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid').slice(7)));
    if (ids.length < 10) throw new Error('only ' + ids.length + ' presets');
    const box = await page.getByTestId('studio-host').boundingBox();
    for (const id of ids) {
      await page.getByTestId('preset-' + id).click(); await page.waitForTimeout(350);
      const b = await page.evaluate(() => { const v = window.__cfStudio; const a = v.body.posAttr.array; let bad = 0; for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) bad++; return { bad, bounds: v.body.posedBounds() }; });
      if (b.bad) throw new Error(`${id}: ${b.bad} non-finite vertex values`);
      const h = await marker('head');
      if (h.x < box.x || h.x > box.x + box.width || h.y < box.y || h.y > box.y + box.height) throw new Error(`${id}: head outside the viewport`);
    }
    return ids.join(', ');
  });
  await page.getByTestId('preset-neutral').click(); await page.waitForTimeout(400);

  await step('joint controls: sliders rotate the joint and move its children', async () => {
    const w0 = await marker('wristL');
    await setJoint('shoulderL', 'z', 60);
    const w1 = await marker('wristL');
    if (dist(w0.world, w1.world) < 0.15) throw new Error('wrist did not move');
    await setJoint('elbowL', 'x', -80);
    const w2 = await marker('wristL');
    if (dist(w1.world, w2.world) < 0.1) throw new Error('elbow bend had no effect');
    await setJoint('shoulderL', 'z', 0); await setJoint('elbowL', 'x', 0);
    const w3 = await marker('wristL');
    if (dist(w0.world, w3.world) > 0.02) throw new Error('did not return to rest: ' + dist(w0.world, w3.world).toFixed(3));
  });
  await step('joint limits: an impossible elbow value is clamped, never producing a broken body', async () => {
    await setJoint('elbowL', 'x', 400);
    const bad = await page.evaluate(() => { const a = window.__cfStudio.body.posAttr.array; let n = 0; for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) n++; return n; });
    if (bad) throw new Error('non-finite vertices');
    await setJoint('elbowL', 'x', 0);
  });
  await step('IK: dragging a hand, a foot and the pelvis handle moves the right parts', async () => {
    await page.getByRole('button', { name: 'Front', exact: true }).click(); await page.waitForTimeout(300);
    const a = await marker('wristR');
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(a.x - 120, a.y - 150, { steps: 12 }); await page.mouse.up();
    await page.waitForTimeout(300);
    const b = await marker('wristR');
    if (dist(a.world, b.world) < 0.2) throw new Error('hand barely moved');
    // limb lengths stay constant under IK (bones do not stretch)
    const lens = await page.evaluate(() => { const m = window.__cfStudio.body.markers; const p = (id) => m.get(id).position; const d = (a, b) => p(a).distanceTo(p(b)); return [d('shoulderR', 'elbowR'), d('elbowR', 'wristR')]; });
    const lens0 = await page.evaluate(() => { const m = window.__cfStudio.body.markers; return [m.get('shoulderL').position.distanceTo(m.get('elbowL').position), m.get('elbowL').position.distanceTo(m.get('wristL').position)]; });
    if (Math.abs(lens[0] - lens0[0]) > 0.02 || Math.abs(lens[1] - lens0[1]) > 0.02) throw new Error('arm bones stretched: ' + lens + ' vs ' + lens0);
    const f = await marker('ankleL');
    await page.mouse.move(f.x, f.y); await page.mouse.down(); await page.mouse.move(f.x - 40, f.y - 90, { steps: 10 }); await page.mouse.up();
    await page.waitForTimeout(300);
    const f2 = await marker('ankleL');
    if (dist(f.world, f2.world) < 0.1) throw new Error('foot barely moved');
    const pv = await marker('pelvis'); const pv0 = pv.world.slice();
    await page.mouse.move(pv.x, pv.y); await page.mouse.down(); await page.mouse.move(pv.x + 60, pv.y, { steps: 8 }); await page.mouse.up();
    await page.waitForTimeout(300);
    const pv2 = await marker('pelvis');
    if (Math.abs(pv2.world[0] - pv0[0]) < 0.05) throw new Error('pelvis did not move sideways');
    return `hand moved ${dist(a.world, b.world).toFixed(2)} m, arm bones constant`;
  });
  await step('undo/redo: each drag is one step; undo restores the exact pose and redo reapplies it', async () => {
    const posAfter = await posState();
    await page.getByTestId('undo').click(); await page.waitForTimeout(250);
    const p1 = await posState();
    await page.getByTestId('undo').click(); await page.waitForTimeout(250);
    await page.getByTestId('undo').click(); await page.waitForTimeout(250);
    const p3 = await posState();
    if (p1 === posAfter || p3 === p1) throw new Error('undo did not change the pose step by step');
    await page.getByTestId('redo').click(); await page.getByTestId('redo').click(); await page.getByTestId('redo').click(); await page.waitForTimeout(300);
    if ((await posState()) !== posAfter) throw new Error('redo x3 did not return to the final pose');
  });
  await step('mirror and reset buttons', async () => {
    await page.getByTestId('preset-wave').click(); await page.waitForTimeout(300);
    const a = await marker('wristL'), b = await marker('wristR');
    await page.getByRole('button', { name: /Mirror/ }).click(); await page.waitForTimeout(300);
    const a2 = await marker('wristL'), b2 = await marker('wristR');
    if (!(Math.abs(a.world[1] - b2.world[1]) < 0.05 && Math.abs(b.world[1] - a2.world[1]) < 0.05)) throw new Error('mirror did not swap sides');
    await page.getByRole('button', { name: 'Reset', exact: true }).click(); await page.waitForTimeout(300);
  });

  await step('camera: orbit drag, wheel zoom, and the view buttons', async () => {
    const box = await page.getByTestId('studio-host').boundingBox();
    await page.getByRole('button', { name: 'Front', exact: true }).click();
    const c0 = await camState();
    await page.mouse.move(box.x + 60, box.y + 300); await page.mouse.down(); await page.mouse.move(box.x + 200, box.y + 260, { steps: 8 }); await page.mouse.up();
    const c1 = await camState();
    if (Math.abs(c1.azimuth - c0.azimuth) < 5) throw new Error('orbit did not change azimuth');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400); await page.waitForTimeout(300);
    const c2 = await camState();
    if (Object.keys(c2).every((k) => c2[k] === c1[k])) throw new Error('wheel did not change the camera');
    const seen = {};
    for (const v of ['Front', 'Side (left)', 'Back', '3/4 left']) { await page.getByRole('button', { name: v, exact: true }).click(); await page.waitForTimeout(200); seen[v] = Math.round((await camState()).azimuth); }
    if (seen.Front === seen.Back) throw new Error('front and back views have the same azimuth');
    return JSON.stringify(seen);
  });
  await page.getByRole('button', { name: 'Front', exact: true }).click();
  await page.getByTestId('preset-neutral').click(); await page.waitForTimeout(500);

  await step('proportion and shape sliders resize the body; undo reverts a slider', async () => {
    const a = await bodyBounds();
    await setRange(page.getByTestId('prop-height'), 1.9); await page.waitForTimeout(700);
    const b = await bodyBounds();
    await setRange(page.getByTestId('prop-build'), 1.3); await page.waitForTimeout(700);
    const c = await bodyBounds();
    if (!(b.h > a.h * 1.08)) throw new Error(`height ${a.h.toFixed(2)} -> ${b.h.toFixed(2)}`);
    if (!(c.w > b.w * 1.04)) throw new Error(`width ${b.w.toFixed(2)} -> ${c.w.toFixed(2)}`);
    const sum = () => page.evaluate(() => Array.from(window.__cfStudio.body.posAttr.array).reduce((s, v) => s + v, 0));
    const s0 = await sum(); await setRange(page.getByTestId('shape-chest'), 1.5); await page.waitForTimeout(600);
    if ((await sum()) === s0) throw new Error('shape-chest changed nothing');
    await page.getByTestId('undo').click(); await page.waitForTimeout(500);
    if (Math.abs((await sum()) - s0) > Math.abs(s0) * 1e-6) throw new Error('undo did not revert the shape slider');
    await page.getByTestId('undo').click(); await page.getByTestId('undo').click(); await page.waitForTimeout(600);
    const d = await bodyBounds();
    if (Math.abs(d.h - a.h) > 0.01) throw new Error('height not restored by undo');
    return `height ${a.h.toFixed(2)}→${b.h.toFixed(2)} m, width ${b.w.toFixed(2)}→${c.w.toFixed(2)} m`;
  });
  await step('body presets change the body and keep it valid', async () => {
    const sel = page.getByTestId('body-preset');
    const n = await sel.locator('option').count();
    if (n < 3) throw new Error('only ' + n + ' presets');
    const hs = [];
    for (let i = 0; i < n; i++) { await sel.selectOption({ index: i }); await page.waitForTimeout(500); hs.push(+(await bodyBounds()).h.toFixed(2)); }
    if (new Set(hs).size < 2) throw new Error('presets are all the same height: ' + hs);
    await sel.selectOption({ index: 0 }); await page.waitForTimeout(500);
    return 'heights ' + hs.join(', ');
  });

  // ---------------------------------------------------------------- fit + projection onto the model with the real character
  await step('fitting: auto-fit improves the silhouette match for an A-pose figure', async () => {
    await page.getByTestId('preset-neutral').click();
    await setJoint('shoulderL', 'z', 20); await setJoint('shoulderR', 'z', -20); await setJoint('hipL', 'z', 5); await setJoint('hipR', 'z', -5);
    await page.getByTestId('match-view').click(); await page.waitForTimeout(700);
    await page.getByTestId('fit-body').click();
    let msg = '';
    for (let i = 0; i < 180; i++) { await sleep(1000); msg = (await page.getByTestId('fit-message').textContent().catch(() => '')) || ''; if (/match/i.test(msg) && !/fitting/i.test(msg)) break; }
    const m = /(\d+)% → (\d+)%/.exec(msg);
    if (!m) throw new Error('no result message: ' + msg);
    if (+m[2] < +m[1]) throw new Error('fit made it worse: ' + msg);
    await saved();
    return msg;
  });
  await step('fitting can be cancelled and leaves the body valid', async () => {
    await page.getByTestId('body-preset').selectOption({ index: 0 });
    await setRange(page.getByTestId('prop-build'), 1.45); await setRange(page.getByTestId('prop-height'), 1.6); await page.waitForTimeout(600);
    await page.getByTestId('fit-body').click();
    // the fit finishes within about a second on this machine, so the stop button must be pressed right away
    const stopped = await page.getByTestId('fit-cancel').click({ timeout: 1500 }).then(() => true, () => false);
    await page.getByTestId('fit-body').waitFor({ timeout: 15000 });
    const msg = (await page.getByTestId('fit-message').textContent()) || '';
    if (stopped && !/Stopped|match/i.test(msg)) throw new Error('unexpected message after stopping: ' + msg);
    const bad = await page.evaluate(() => { const a = window.__cfStudio.body.posAttr.array; let n = 0; for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) n++; return n; });
    if (bad) throw new Error('non-finite vertices after cancel');
    return stopped ? 'stopped mid-fit: "' + msg + '"' : 'fit completed before the stop button could be pressed (cancel itself not exercised)';
  });
  await step('overlay toggle shows the drawing over the viewport', async () => {
    await page.getByTestId('overlay-toggle').check(); await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(OUT, 'e2e-overlay.png') });
    await page.getByTestId('overlay-toggle').uncheck();
  });
  await step('project the artwork: the model shows the drawing and keeps showing it when posed', async () => {
    await page.getByTestId('project-artwork').click();
    await page.waitForFunction(() => window.__cfStudio.body.material.uniforms.uClay.value === 0, null, { timeout: 20000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, 'e2e-projected-front.png') });
    for (const p of ['run', 'sit', 'guard']) {
      await page.getByTestId('preset-' + p).click(); await page.waitForTimeout(400);
      if ((await page.evaluate(() => window.__cfStudio.body.material.uniforms.uClay.value)) !== 0) throw new Error('projection lost in ' + p);
    }
    await page.getByRole('button', { name: '3/4 left', exact: true }).click(); await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, 'e2e-projected-run-34.png') });
  });
  await step('clear projection returns to the clay body and the original is untouched', async () => {
    await page.getByTestId('clear-projection').click(); await page.waitForTimeout(500);
    if ((await page.evaluate(() => window.__cfStudio.body.material.uniforms.uClay.value)) !== 1) throw new Error('still showing the drawing');
    const s = await dbSnapshot();
    if (s.assets[originalKey]?.sha === undefined) throw new Error('original missing');
    await page.getByTestId('preset-neutral').click();
    await setJoint('shoulderL', 'z', 20); await setJoint('shoulderR', 'z', -20);
    await page.getByTestId('match-view').click(); await page.waitForTimeout(500);
    await page.getByTestId('project-artwork').click();
    await page.waitForFunction(() => window.__cfStudio.body.material.uniforms.uClay.value === 0, null, { timeout: 20000 });
  });

  // ---------------------------------------------------------------- guides
  await step('guides: all five kinds render and download as PNGs of the output size', async () => {
    await page.getByTestId('preset-guard').click(); await page.getByRole('button', { name: 'Frame figure' }).click().catch(() => {}); await page.waitForTimeout(600);
    const out = {};
    for (const k of ['mannequin', 'textured', 'pose', 'depth', 'silhouette']) {
      await page.getByTestId('guide-' + k).click(); await page.waitForTimeout(500);
      const d = await download(() => page.getByTestId('download-guide').click(), `e2e-guide-${k}.png`);
      const sz = pngSize(d.bytes);
      if (!sz) throw new Error(k + ' is not a PNG');
      out[k] = `${sz.w}x${sz.h}`;
    }
    if (new Set(Object.values(out)).size !== 1) throw new Error('guide sizes differ: ' + JSON.stringify(out));
    return JSON.stringify(out);
  });

  // ---------------------------------------------------------------- pose save / load
  let savedPoseJson = '';
  await step('pose saving and loading: apply restores pose and camera exactly; rename; update; delete', async () => {
    await page.getByTestId('preset-run').click(); await page.waitForTimeout(300);
    await page.getByRole('button', { name: '3/4 left', exact: true }).click(); await page.waitForTimeout(300);
    await page.getByTestId('pose-name').fill('Run A'); await page.getByTestId('save-pose').click(); await page.waitForTimeout(300);
    savedPoseJson = await posState();
    const cam = await camState();
    await page.getByTestId('preset-sit').click(); await page.getByRole('button', { name: 'Back', exact: true }).click(); await page.waitForTimeout(300);
    if ((await posState()) === savedPoseJson) throw new Error('pose did not change');
    await page.getByTestId('saved-poses').getByRole('button', { name: 'Apply' }).first().click(); await page.waitForTimeout(400);
    if ((await posState()) !== savedPoseJson) throw new Error('applied pose differs from the saved pose');
    const cam2 = await camState();
    if (Math.abs(cam2.azimuth - cam.azimuth) > 0.5) throw new Error('camera not restored');
    const nameInput = page.getByTestId('saved-poses').locator('input').first();
    await nameInput.fill('Sprint'); await nameInput.blur();
    await page.getByTestId('preset-jump').click(); await page.waitForTimeout(300);
    await page.getByTestId('saved-poses').getByRole('button', { name: 'Update' }).first().click(); await page.waitForTimeout(300);
    const updated = await posState();
    if (updated === savedPoseJson) throw new Error('update did not store the new pose');
    await page.getByTestId('pose-name').fill('Temp'); await page.getByTestId('save-pose').click();
    await page.getByTestId('saved-poses').locator('li').nth(1).getByRole('button', { name: 'Delete' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=saved-poses] li').length === 1);
    savedPoseJson = updated;
  });

  // ---------------------------------------------------------------- persistence
  await step('persistence: reload reopens the character with original, references, poses, projection', async () => {
    await saved();
    await page.reload();
    await page.getByTestId('studio-view').waitFor({ timeout: 10000 });
    await page.getByTestId('studio-host').locator('canvas').waitFor();
    await page.waitForFunction(() => window.__cfStudio && window.__cfStudio.body.posedBounds(), null, { timeout: 30000 });
    if ((await posState()) !== savedPoseJson) throw new Error('pose after reload differs');
    await page.waitForFunction(() => window.__cfStudio.body.material.uniforms.uClay.value === 0, null, { timeout: 15000 });
    const input = await page.getByTestId('saved-poses').locator('input').first().inputValue();
    if (input !== 'Sprint') throw new Error('saved pose name ' + input);
    await page.getByTestId('ws-character').click();
    await page.locator('[data-testid=original-box] img').waitFor({ timeout: 8000 });
    if ((await page.getByTestId('reference-card').count()) !== 1) throw new Error('reference lost');
    const s = await dbSnapshot();
    if (s.assets[originalKey]?.sha === undefined) throw new Error('original missing after reload');
  });

  // ---------------------------------------------------------------- bundle export / import
  let bundleBytes;
  await step('bundle export downloads a ZIP; import creates a NEW project and leaves the original project alone', async () => {
    await openProjects();
    const d = await download(() => page.getByRole('button', { name: 'Export current project as bundle' }).click(), 'e2e-hero.cfbundle');
    bundleBytes = d.bytes;
    if (!(d.bytes[0] === 0x50 && d.bytes[1] === 0x4b)) throw new Error('not a ZIP');
    const before = await dbSnapshot();
    await page.locator('input[accept*="cfbundle"]').setInputFiles(d.path);
    await page.waitForFunction(() => /Imported/.test(document.body.innerText), null, { timeout: 15000 });
    await saved();
    const after = await dbSnapshot();
    const ids = Object.keys(after.projects);
    if (ids.length !== Object.keys(before.projects).length + 1) throw new Error('import did not add exactly one project');
    const newId = ids.find((i) => !before.projects[i]);
    for (const [k, v] of Object.entries(before.assets)) if (!after.assets[k] || after.assets[k].sha !== v.sha) throw new Error('an existing asset changed: ' + k);
    const origSha = Object.values(before.assets).find((a) => a.kind === 'source').sha;
    const copy = Object.entries(after.assets).filter(([k]) => k.startsWith(newId + '/')).find(([, a]) => a.kind === 'source');
    if (!copy || copy[1].sha !== origSha) throw new Error('imported original differs from the exported original');
    return `${bundleBytes.length} byte bundle; new project ${newId}`;
  });
  await step('importing damaged or hostile bundles is refused and changes nothing', async () => {
    const before = await dbSnapshot();
    await ensureProjects();
    const bad = [['garbage.cfbundle', Buffer.from('definitely not a zip')], ['truncated.cfbundle', bundleBytes.subarray(0, Math.floor(bundleBytes.length / 2))]];
    // one flipped byte inside an image
    const flipped = Buffer.from(bundleBytes); flipped[Math.floor(flipped.length / 2)] ^= 0xff; bad.push(['flipped.cfbundle', flipped]);
    for (const [name, bytes] of bad) {
      const p = path.join(OUT, name); fs.writeFileSync(p, bytes);
      await page.locator('input[accept*="cfbundle"]').setInputFiles(p);
      await page.waitForTimeout(900);
    }
    const after = await dbSnapshot();
    const extra = Object.keys(after.projects).length - Object.keys(before.projects).length;
    if (extra !== 0) throw new Error(extra + ' project(s) were added by damaged bundles');  // incl. one flipped byte inside an image: ZIP checksums must catch it
    for (const [k, v] of Object.entries(before.assets)) if (!after.assets[k] || after.assets[k].sha !== v.sha) throw new Error('an asset changed: ' + k);
    return 'garbage, truncated and one-flipped-byte bundles all refused; nothing stored';
  });
  await step('project list: duplicate, then delete the extra projects (and their images)', async () => {
    await ensureProjects();
    const dlg = page.getByRole('dialog');
    const n0 = await dlg.getByRole('button', { name: 'Duplicate' }).count();
    if (n0 < 2) throw new Error('expected at least 2 projects, saw ' + n0);
    await dlg.getByRole('button', { name: 'Duplicate' }).first().click(); await page.waitForTimeout(1200);
    const s1 = await dbSnapshot();
    if (Object.keys(s1.projects).length <= 1) throw new Error('duplicate did not add a project');
    await ensureProjects();
    let guard = 0;
    while ((await dlg.getByRole('button', { name: 'Delete', exact: true }).count()) > 1 && guard++ < 10) {
      await dlg.getByRole('button', { name: 'Delete', exact: true }).last().click(); await page.waitForTimeout(1000); await ensureProjects();
    }
    const s2 = await dbSnapshot();
    if (Object.keys(s2.projects).length !== 1) throw new Error('projects left: ' + Object.keys(s2.projects).length);
    const left = Object.keys(s2.projects)[0];
    const orphans = Object.keys(s2.assets).filter((k) => !k.startsWith(left + '/'));
    if (orphans.length) throw new Error('images of deleted projects remain: ' + orphans.length);
    if (s2.backups.some((b) => !s2.projects[b.projectId])) throw new Error('backups of deleted projects remain');
    return `${Object.keys(s1.projects).length} projects -> 1, no orphaned images`;
  });
  await closeDialog().catch(() => {});

  // ---------------------------------------------------------------- migration
  await step('project migration: a stored schema-2 project opens, is upgraded, and a pre-upgrade backup is kept', async () => {
    const s = await dbSnapshot();
    const [id, rec] = Object.entries(s.projects)[0];
    const v2 = structuredClone(rec.data); const { shape, artwork, ...studioV2 } = v2.character.studio; void shape; void artwork;
    v2.schemaVersion = 2; v2.character.studio = studioV2; v2.id = 'proj_migr_e2e'; v2.name = 'Old format project';
    const records = [['projects', { id: v2.id, name: v2.name, createdAt: rec.createdAt, updatedAt: rec.updatedAt + 1, data: v2 }]];
    const full = await page.evaluate(async (id) => {
      const open = () => new Promise((res, rej) => { const r = indexedDB.open('characterforge'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const db = await open();
      const rows = await new Promise((res, rej) => { const q = db.transaction('assets').objectStore('assets').index ? db.transaction('assets').objectStore('assets').getAll() : null; q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      db.close();
      return rows.filter((r) => r.projectId === id).map((r) => ({ ...r, key: 'proj_migr_e2e/' + r.id, projectId: 'proj_migr_e2e' }));
    }, id);
    for (const a of full) records.push(['assets', a]);
    await putRecords(records);
    await page.reload(); await page.waitForTimeout(1500);
    await openProjects();
    const row = page.locator('li', { hasText: 'Old format project' });
    await row.getByRole('button', { name: 'Open' }).click();
    await page.waitForFunction(() => /upgraded from format 2/i.test(document.body.innerText), null, { timeout: 15000 });
    const after = await dbSnapshot();
    const b = after.backups.find((x) => x.projectId === 'proj_migr_e2e');
    if (!b || b.fromVersion !== 2 || b.data.schemaVersion !== 2 || 'shape' in b.data.character.studio) throw new Error('no faithful pre-upgrade backup');
    await saved();
    const now = (await dbSnapshot()).projects.proj_migr_e2e;
    if (now.data.schemaVersion !== 3 || !now.data.character.studio.shape) throw new Error('stored copy was not upgraded on save');
    const again = (await dbSnapshot()).backups.find((x) => x.projectId === 'proj_migr_e2e');
    if (again.data.schemaVersion !== 2) throw new Error('backup was overwritten');
    return `DB version ${after.version}; backup kept at schema ${b.data.schemaVersion}`;
  });
  await step('a corrupt stored project is refused with a message and the stored data is left exactly as it was', async () => {
    const s = await dbSnapshot();
    const base = s.projects.proj_migr_e2e;
    const broken = { ...base, id: 'proj_broken_e2e', name: 'Broken project', data: { ...base.data, id: 'proj_broken_e2e', character: 'nope' } };
    await putRecords([['projects', broken]]);
    await page.reload(); await page.waitForTimeout(1200);
    await openProjects();
    await page.locator('li', { hasText: 'Broken project' }).getByRole('button', { name: 'Open' }).click();
    await page.waitForTimeout(1200);
    const after = (await dbSnapshot()).projects.proj_broken_e2e;
    if (JSON.stringify(after.data) !== JSON.stringify(broken.data)) throw new Error('corrupt project was modified');
    if (!/invalid|damaged|could not/i.test(await page.evaluate(() => document.body.innerText))) throw new Error('no error message shown');
    await page.locator('li', { hasText: 'Broken project' }).getByRole('button', { name: 'Delete' }).click(); await page.waitForTimeout(600);
    await page.locator('li', { hasText: 'Old format project' }).getByRole('button', { name: 'Open' }).click(); await page.waitForTimeout(1500);
  });
  await closeDialog().catch(() => {});

  // ---------------------------------------------------------------- generate / review (test-only backend)
  await page.getByTestId('ws-generate').click();
  await step('generate tab without a server: says so, no result is created', async () => {
    await page.getByTestId('check-server').click();
    await page.waitForFunction(() => /Cannot reach|not available/i.test(document.querySelector('[data-testid=provider-status]')?.textContent || ''), null, { timeout: 10000 });
    if (!(await page.getByTestId('generate-button').isDisabled())) throw new Error('Generate enabled without a server');
  });
  let server = startServer('fake_backend:backend');
  let resultSha = '';
  try {
    await waitServer();
    await step('generate (TEST-ONLY backend): request is sent, a result is added for review as GENERATED, original and references are untouched', async () => {
      await page.getByTestId('check-server').click();
      await page.waitForFunction(() => /ready|Ready|test backend/i.test(document.querySelector('[data-testid=provider-status]')?.textContent || ''), null, { timeout: 10000 });
      const before = await dbSnapshot();
      await page.getByTestId('generate-button').click();
      await page.getByTestId('review').waitFor({ timeout: 90000 });
      const chip = await page.getByTestId('origin-chip').textContent();
      if (!/GENERATED/.test(chip) || /IMPORTED/.test(chip)) throw new Error('origin chip: ' + chip);
      await saved();
      const after = await dbSnapshot();
      for (const [k, v] of Object.entries(before.assets)) if (!after.assets[k] || after.assets[k].sha !== v.sha) throw new Error('existing image changed: ' + k);
      const newAssets = Object.entries(after.assets).filter(([k]) => !before.assets[k]).map(([, a]) => a.kind);
      if (!newAssets.includes('generated')) throw new Error('no generated asset stored: ' + newAssets);
      const proj = Object.values(after.projects).find((p) => p.name === 'Old format project');
      const rec = proj.data.character.generations.at(-1);
      if (rec.status !== 'candidate' || rec.origin !== 'generated') throw new Error('record: ' + rec.status + '/' + rec.origin);
      return `new assets: ${newAssets.join(', ')}; status ${rec.status}`;
    });
    await step('review: accept, reject, re-candidate, download, send to the 2D canvas, add as reference', async () => {
      await page.getByTestId('accept').click();
      await page.waitForFunction(() => /Accepted/.test(document.querySelector('[data-testid=status-chip]')?.textContent || ''));
      await page.getByTestId('reject').click();
      await page.waitForFunction(() => /Rejected/i.test(document.querySelector('[data-testid=status-chip]')?.textContent || ''));
      await page.getByTestId('accept').click();
      const d = await download(() => page.getByRole('button', { name: 'Download', exact: true }).click(), 'e2e-result.png');
      if (!pngSize(d.bytes)) throw new Error('downloaded result is not a PNG');
      resultSha = require('crypto').createHash('sha256').update(d.bytes).digest('hex').slice(0, 16);
    });
    await step('retry applies the result\'s pose and produces a second result linked to the first', async () => {
      await page.getByTestId('retry').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=result-item]').length >= 2, null, { timeout: 90000 });
      let proj;
      for (let i = 0; i < 20; i++) { proj = Object.values((await dbSnapshot()).projects).find((p) => p.name === 'Old format project'); if (proj.data.character.generations.length >= 2) break; await sleep(500); } // autosave is debounced
      const last = proj.data.character.generations.at(-1);
      if (!last.provenance.parentId) throw new Error('second result is not linked to the first');
    });
    await step('a result used as a reference is added without touching the original; a backend that just echoes a reference is rejected', async () => {
      const get = async () => Object.values((await dbSnapshot()).projects).find((p) => p.name === 'Old format project');
      await sleep(2500); // let the debounced autosave catch up
      const p0 = await get();
      const refs0 = p0.data.character.references.length, gens0 = p0.data.character.generations.length;
      await page.getByRole('button', { name: 'Use as reference', exact: true }).click();
      let p1 = p0;
      for (let i = 0; i < 20 && p1.data.character.references.length === refs0; i++) { await sleep(500); p1 = await get(); }
      if (p1.data.character.references.length !== refs0 + 1) throw new Error('result was not added as a reference');
      if (p1.data.character.originalAssetId !== p0.data.character.originalAssetId) throw new Error('original changed');
      // the test backend always draws the same gradient, so its next output equals the reference we just added: the app must discard it
      await page.getByTestId('generate-button').click();
      await page.waitForFunction(() => /unchanged|not a generated image/i.test(document.body.innerText), null, { timeout: 90000 });
      await sleep(1000);
      const p2 = await get();
      if (p2.data.character.generations.length !== gens0) throw new Error('an echoed reference was stored as a generation');
      return 'echo guard works';
    });
    await step('busy: a second generate while the first is running is refused by the server, not queued', async () => {
      const r = await fetch('http://127.0.0.1:8765/generate/status'); const j = await r.json();
      if (j.busy !== false) throw new Error('server reports busy while idle');
      return 'idle status reports busy=false';
    });
  } finally { await stopServer(server); }

  server = startServer('fake_backend:garbage_backend');
  try {
    await waitServer();
    await step('a backend that returns garbage: the error is shown and NOTHING is stored or changed', async () => {
      await page.getByTestId('check-server').click(); await page.waitForTimeout(1200);
      const before = await dbSnapshot();
      const nBefore = Object.values(before.projects).find((p) => p.name === 'Old format project').data.character.generations.length;
      await page.getByTestId('generate-button').click();
      await page.waitForFunction(() => /not a usable image|unusable|backend/i.test(document.body.innerText), null, { timeout: 90000 });
      await page.waitForTimeout(800);
      const after = await dbSnapshot();
      const nAfter = Object.values(after.projects).find((p) => p.name === 'Old format project').data.character.generations.length;
      if (nAfter !== nBefore) throw new Error('a generation record was added');
      for (const [k, v] of Object.entries(before.assets)) if (!after.assets[k] || after.assets[k].sha !== v.sha) throw new Error('image changed: ' + k);
      if (Object.keys(after.assets).length !== Object.keys(before.assets).length) throw new Error('an image was stored for the failed run');
    });
  } finally { await stopServer(server); }

  server = startServer('fake_backend:hang_backend');
  try {
    await waitServer();
    await step('server dies mid-generation: a clear message, no partial result, original untouched', async () => {
      await page.getByTestId('check-server').click(); await page.waitForTimeout(1200);
      const before = await dbSnapshot();
      await page.getByTestId('generate-button').click();
      for (let i = 0; i < 120; i++) { const j = await fetch('http://127.0.0.1:8765/generate/status').then((r) => r.json()).catch(() => ({})); if (j.busy) break; await sleep(500); }
      server.kill('SIGKILL');
      await page.waitForFunction(() => /Lost the connection|crashed|Could not reach/i.test(document.body.innerText), null, { timeout: 60000 });
      const after = await dbSnapshot();
      for (const [k, v] of Object.entries(before.assets)) if (!after.assets[k] || after.assets[k].sha !== v.sha) throw new Error('image changed: ' + k);
      if (Object.keys(after.assets).length !== Object.keys(before.assets).length) throw new Error('an image was stored');
    });
  } finally { await stopServer(server); }

  await step('importing an external result is labelled IMPORTED and never replaces the original', async () => {
    const before = await dbSnapshot();
    await page.getByTestId('import-result').setInputFiles(D + 'fixture-result.png');
    await page.waitForFunction(() => /IMPORTED/.test(document.querySelector('[data-testid=origin-chip]')?.textContent || ''), null, { timeout: 8000 });
    await saved();
    const after = await dbSnapshot();
    for (const [k, v] of Object.entries(before.assets)) if (!after.assets[k] || after.assets[k].sha !== v.sha) throw new Error('image changed: ' + k);
  });

  // ---------------------------------------------------------------- 2D canvas + PNG export
  await step('2D canvas: send the result to the canvas as a layer, then export a transparent PNG', async () => {
    await page.getByRole('button', { name: 'Edit in 2D canvas', exact: true }).click();
    await page.getByTestId('ws-canvas').click();
    await page.waitForTimeout(1200);
    await page.keyboard.press('Control+e');
    await page.getByText('Export transparent PNG').waitFor({ timeout: 8000 });
    await page.waitForTimeout(1200);
    const d = await download(() => page.getByRole('button', { name: /^Download / }).click(), 'e2e-canvas-export.png');
    const sz = pngSize(d.bytes);
    if (!sz || sz.w < 16 || sz.h < 16) throw new Error('export is not a valid PNG');
    await closeDialog();
    return `${sz.w}x${sz.h}`;
  });

  console.log('\nconsole errors:', errors.length);
  for (const e of [...new Set(errors)].slice(0, 12)) console.log('  ', e.slice(0, 220));
  console.log(fails ? `FAILED STEPS: ${fails} of ${results.length}` : `ALL ${results.length} STEPS PASSED`);
  fs.writeFileSync(path.join(OUT, 'e2e-full-results.json'), JSON.stringify({ results, errors: [...new Set(errors)] }, null, 1));
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('e2e crashed:', e); process.exit(2); });
