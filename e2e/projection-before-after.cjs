/* Before/after render of the SAME character and pose, for the projection rewrite.
 *
 * Renders the "character render" (the artwork projected on the model) at two camera angles, twice:
 *   - AFTER:  the v0.5 projection (silhouette-conforming UV relaxation + directional side-fill + depth visibility)
 *   - BEFORE: the v0.4.1 projection, reconstructed in the page from the v0.4.1 formulas (orthographic UV bake +
 *             normal-Z front/back blend) and applied to the SAME mesh, pose and camera.
 *
 * Both images therefore come from one build, one mesh, one pose, one camera. Only the projection differs.
 *
 * Usage:  npx vite preview --port 4173 &   then   node e2e/projection-before-after.cjs
 * Env: CF_E2E_URL (default http://localhost:4173/), CF_E2E_OUT (default e2e/out), CF_E2E_HERO (default e2e/fixture-original.png)
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const D = __dirname + '/';
const OUT = process.env.CF_E2E_OUT || path.join(D, 'out');
const BASE = process.env.CF_E2E_URL || 'http://localhost:4173/';
const HERO = process.env.CF_E2E_HERO || D + 'fixture-original.png';

const OLD_VERT = `
attribute float aSide;
attribute vec2 aUvFront;
attribute vec2 aUvBack;
attribute float aFacing;
varying vec3 vNormal;
varying float vSide;
varying vec2 vUvFront;
varying vec2 vUvBack;
varying float vFacing;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vSide = aSide;
  vUvFront = aUvFront;
  vUvBack = aUvBack;
  vFacing = aFacing;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const OLD_FRAG = `
uniform sampler2D uFront;
uniform sampler2D uBack;
uniform float uHasFront;
uniform float uHasBack;
uniform float uShading;
uniform float uClay;
uniform vec3 uFill;
uniform vec3 uClayColor;
uniform vec3 uLeftTint;
uniform vec3 uRightTint;
uniform vec3 uLight;
varying vec3 vNormal;
varying float vSide;
varying vec2 vUvFront;
varying vec2 vUvBack;
varying float vFacing;
void main() {
  vec3 base = uFill;
  if (uClay > 0.5) {
    base = uClayColor;
    base = mix(base, uLeftTint, clamp(vSide, 0.0, 1.0));
    base = mix(base, uRightTint, clamp(-vSide, 0.0, 1.0));
  } else {
    if (uHasFront > 0.5) {
      vec4 f = texture2D(uFront, vUvFront);
      base = mix(base, f.rgb, f.a * smoothstep(0.12, 0.55, vFacing));
    }
    if (uHasBack > 0.5) {
      vec4 b = texture2D(uBack, vUvBack);
      base = mix(base, b.rgb, b.a * smoothstep(0.12, 0.55, -vFacing));
    }
  }
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  float lambert = max(dot(n, normalize(uLight)), 0.0);
  float hemi = 0.5 + 0.5 * n.y;
  float lit = 0.42 + 0.38 * lambert + 0.2 * hemi;
  gl_FragColor = vec4(base * mix(1.0, lit, uShading), 1.0);
  #include <colorspace_fragment>
}`;

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
  await page.getByPlaceholder('New project name').fill('Projection A/B');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByTestId('import-original').setInputFiles(HERO);
  await page.locator('[data-testid=original-box] img').waitFor();
  await page.getByTestId('ws-studio').click();
  await page.getByTestId('studio-host').locator('canvas').waitFor();
  await page.waitForTimeout(600);

  await page.getByTestId('preset-neutral').click();
  await page.waitForTimeout(300);

  const setAz = async (deg) => {
    const az = page.getByLabel('Camera angle');
    await az.fill(String(deg));
    await az.dispatchEvent('input');
    await page.waitForTimeout(500);
  };

  // project the artwork once (the v0.5 path); the bake is in the POSE, so changing the camera does not re-bake
  await page.getByTestId('project-artwork').click();
  await page.waitForTimeout(3000);

  const host = page.getByTestId('studio-host');
  for (const deg of [0, 40]) {
    await setAz(deg);
    await host.screenshot({ path: path.join(OUT, `after-${deg}.png`) });
    console.log(`wrote after-${deg}.png`);
  }

  // ---- reconstruct the v0.4.1 projection on the same mesh/pose/camera ----
  const info = await page.evaluate(({ OLD_VERT, OLD_FRAG }) => {
    const v = window.__cfStudio;
    if (!v) return { ok: false, why: 'no __cfStudio' };
    const body = v.body;
    const mesh = body && body.bodyMesh;
    const geo = body && body.geometry;
    const mat = body && body.material;
    if (!mesh || !geo || !mat) return { ok: false, why: 'no body/geometry/material' };
    const art = v.state && v.state.artwork;
    const front = art && art.front;
    if (!front) return { ok: false, why: 'no projected artwork' };

    const n = mesh.vertexCount;
    const pos = geo.getAttribute('position').array; // == the baked-pose positions right after projecting
    const nor = geo.getAttribute('normal').array;
    const fit = front.fit;
    const W = front.width, H = front.height;

    // v0.4.1 bakeUv: orthographic projection along Z, normalised by the image size
    const uvF = geo.getAttribute('aUvFront');
    for (let i = 0; i < n; i++) {
      uvF.array[i * 2] = (fit.ox + pos[i * 3]) / W;
      uvF.array[i * 2 + 1] = (fit.oy - pos[i * 3 + 1]) / H;
    }
    uvF.needsUpdate = true;

    // v0.4.1 aFacing: the model-space normal's Z
    let fac = geo.getAttribute('aFacing');
    if (!fac) {
      const Ctor = geo.getAttribute('aFront').constructor;
      fac = new Ctor(new Float32Array(n), 1);
      geo.setAttribute('aFacing', fac);
    }
    for (let i = 0; i < n; i++) fac.array[i] = nor[i * 3 + 2];
    fac.needsUpdate = true;

    mat.vertexShader = OLD_VERT;
    mat.fragmentShader = OLD_FRAG;
    mat.needsUpdate = true;
    if (v.invalidate) v.invalidate();
    return { ok: true, n };
  }, { OLD_VERT, OLD_FRAG });
  console.log('before-path:', JSON.stringify(info));

  for (const deg of [0, 40]) {
    await setAz(deg);
    await host.screenshot({ path: path.join(OUT, `before-${deg}.png`) });
    console.log(`wrote before-${deg}.png`);
  }

  console.log('console errors:', errors.length ? errors.slice(0, 5) : 'none');
  await browser.close();
  console.log('wrote to', OUT);
})().catch((e) => { console.error('HARNESS FAILED', e); process.exit(1); });
