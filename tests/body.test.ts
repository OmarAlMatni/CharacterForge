import { describe, expect, it } from 'vitest';
import {
  BODY_PRESETS, DEFAULT_SHAPE, JOINT_IDS, MODEL_CREDIT, NATIVE_JOINTS, SHAPE_KEYS, SHAPE_RANGES, SKIN_INDEX, SKIN_JOINTS, alignFit, applyPreset, bakeUv, bodySilhouette, boundsXY,
  buildCharacterMesh, buildRestSkeleton, clampShape, forwardKinematics, parseGlb, posedPositions, presetById, restPose, skinBody, skinTransforms, validateShape,
} from '../src/pose/index.ts';
import type { BodyMesh, SkinJointId } from '../src/pose/index.ts';
import { readFileSync } from 'node:fs';
import { MODEL_URL, loadTestModel } from './model.ts';

const model = loadTestModel();
const rest = buildRestSkeleton();
const mesh = buildCharacterMesh(rest, DEFAULT_SHAPE, 'normal');
const neutral = (m: BodyMesh, r = rest): Float32Array => posedPositions(m, r, restPose());

/** x / y / z extent of the posed vertices that one joint almost fully owns. */
function extentOf(m: BodyMesh, pos: Float32Array, joint: SkinJointId, axis: 0 | 1 | 2): number {
  const j = SKIN_INDEX[joint];
  let lo = Infinity, hi = -Infinity;
  for (let v = 0; v < m.vertexCount; v++) {
    if (m.skinJoints[v * 4] === j && m.skinWeights[v * 4]! > 0.99) {
      lo = Math.min(lo, pos[v * 3 + axis]!);
      hi = Math.max(hi, pos[v * 3 + axis]!);
    }
  }
  return hi - lo;
}

describe('the bundled character model', () => {
  const glb = parseGlb(new Uint8Array(readFileSync(MODEL_URL)));
  it('is the credited CC-BY model, unrigged and untextured, so the rig comes from this project', () => {
    expect(glb.hasSkin).toBe(false);
    expect(glb.credit.license).toMatch(/CC-BY-4\.0/);
    expect(glb.credit.author).toMatch(/Marc Ed/);
    expect(MODEL_CREDIT.license).toBe('CC-BY-4.0');
    expect(glb.positions.length / 3).toBe(39714);
    expect(glb.indices.length / 3).toBe(75096);
  });
  it('is read in metres, upright, about 1.22 m tall, facing +Z', () => {
    let minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < glb.positions.length; i += 3) {
      minY = Math.min(minY, glb.positions[i + 1]!); maxY = Math.max(maxY, glb.positions[i + 1]!);
      minZ = Math.min(minZ, glb.positions[i + 2]!); maxZ = Math.max(maxZ, glb.positions[i + 2]!);
    }
    expect(maxY - minY).toBeGreaterThan(1.2);
    expect(maxY - minY).toBeLessThan(1.25);
    expect(maxZ).toBeGreaterThan(0.09);
  });
  it('rejects data that is not a binary glTF', () => {
    expect(() => parseGlb(new Uint8Array(40))).toThrow(/binary glTF/);
  });
});

describe('rig', () => {
  it('places every joint inside the model, in the body, symmetrically', () => {
    const mn = model.full.min, mx = model.full.max;
    for (const id of JOINT_IDS) {
      const p = model.bind[id].position;
      expect(p.x).toBeGreaterThan(mn.x); expect(p.x).toBeLessThan(mx.x);
      expect(p.y).toBeGreaterThan(mn.y - 1e-6); expect(p.y).toBeLessThan(mx.y + 1e-6);
      let best = Infinity;
      for (let v = 0; v < model.full.vertexCount; v += 3) best = Math.min(best, Math.hypot(model.full.positions[v * 3]! - p.x, model.full.positions[v * 3 + 1]! - p.y, model.full.positions[v * 3 + 2]! - p.z));
      expect(best, id).toBeLessThan(0.12); // every joint sits inside the body (the chest is mid-torso)
    }
    for (const base of ['shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle'] as const) {
      expect(NATIVE_JOINTS[`${base}L` as keyof typeof NATIVE_JOINTS].x).toBeCloseTo(-NATIVE_JOINTS[`${base}R` as keyof typeof NATIVE_JOINTS].x, 9);
    }
  });
  it('matches the default skeleton to the model, so the model is not stretched at default sliders', () => {
    const w = forwardKinematics(rest, restPose());
    const bone = (a: keyof typeof w, b: keyof typeof w) => Math.hypot(w[a].position.x - w[b].position.x, w[a].position.y - w[b].position.y, w[a].position.z - w[b].position.z);
    const nat = (a: keyof typeof w, b: keyof typeof w) => Math.hypot(model.bind[a].position.x - model.bind[b].position.x, model.bind[a].position.y - model.bind[b].position.y, model.bind[a].position.z - model.bind[b].position.z);
    for (const [a, b] of [['shoulderL', 'elbowL'], ['elbowL', 'wristL'], ['hipL', 'kneeL'], ['kneeL', 'ankleL'], ['pelvis', 'spine'], ['spine', 'chest'], ['neck', 'head'], ['head', 'headTop']] as const) {
      expect(Math.abs(bone(a, b) - nat(a, b)), `${a}-${b}`).toBeLessThan(0.012);
    }
    expect(rest.restHeight).toBeCloseTo(1.7, 9);
  });
  it('gives every vertex valid, normalised skin weights over real skin joints', () => {
    for (let v = 0; v < mesh.vertexCount; v++) {
      let s = 0;
      for (let q = 0; q < 4; q++) {
        const wgt = mesh.skinWeights[v * 4 + q]!;
        expect(wgt).toBeGreaterThanOrEqual(0);
        s += wgt;
        expect(mesh.skinJoints[v * 4 + q]!).toBeLessThan(SKIN_JOINTS.length);
      }
      expect(s).toBeCloseTo(1, 4);
    }
  });
  it('blends smoothly across the elbow and knee instead of splitting at a hard edge', () => {
    const blended = (joint: SkinJointId): number => {
      const j = SKIN_INDEX[joint];
      let n = 0;
      for (let v = 0; v < mesh.vertexCount; v++) {
        for (let q = 0; q < 4; q++) if (mesh.skinJoints[v * 4 + q] === j && mesh.skinWeights[v * 4 + q]! > 0.15 && mesh.skinWeights[v * 4 + q]! < 0.85) n++;
      }
      return n;
    };
    expect(blended('elbowL')).toBeGreaterThan(100);
    expect(blended('kneeR')).toBeGreaterThan(100);
  });
});

describe('the posed body', () => {
  it('is a finite, sizeable mesh', () => {
    expect(mesh.vertexCount).toBe(39714);
    expect(mesh.positions.every(Number.isFinite)).toBe(true);
    expect(mesh.normals.every(Number.isFinite)).toBe(true);
    for (let i = 0; i < mesh.indices.length; i++) expect(mesh.indices[i]!).toBeLessThan(mesh.vertexCount);
  });
  it('has a lower-detail copy for scoring many candidates', () => {
    const d = buildCharacterMesh(rest, DEFAULT_SHAPE, 'draft');
    expect(d.vertexCount).toBeLessThan(mesh.vertexCount / 4);
    expect(d.indices.length).toBeGreaterThan(3000);
  });
  it('stands on the ground at the requested height and faces +Z', () => {
    const b = boundsXY(neutral(mesh), mesh.vertexCount);
    expect(b.minY).toBeGreaterThan(-0.01);
    expect(b.minY).toBeLessThan(0.02);
    expect(b.maxY).toBeGreaterThan(1.68);
    expect(b.maxY).toBeLessThan(1.72);
    const p = neutral(mesh);
    let maxZ = -Infinity, minZ = Infinity;
    for (let i = 0; i < mesh.vertexCount; i++) { maxZ = Math.max(maxZ, p[i * 3 + 2]!); minZ = Math.min(minZ, p[i * 3 + 2]!); }
    expect(maxZ).toBeGreaterThan(-minZ);
    expect(Math.abs(b.minX + b.maxX)).toBeLessThan(0.02); // left/right symmetric
  });
  it('is deterministic', () => {
    const again = buildCharacterMesh(rest, DEFAULT_SHAPE, 'normal');
    expect(Array.from(neutral(again).slice(0, 300))).toEqual(Array.from(neutral(mesh).slice(0, 300)));
  });
  it('rebuilds quickly when only the sliders change (the heavy data is shared)', () => {
    const t = Date.now();
    for (let i = 0; i < 50; i++) buildCharacterMesh(buildRestSkeleton({ height: 1.5 + i * 0.01 }), { ...DEFAULT_SHAPE, chest: 1 + i * 0.01 }, 'normal');
    expect(Date.now() - t).toBeLessThan(500);
    expect(buildCharacterMesh(rest, DEFAULT_SHAPE).positions).toBe(mesh.positions);
  });
});

describe('skinning', () => {
  const unscaled: BodyMesh = { ...mesh, skinScale: new Float64Array(SKIN_JOINTS.length * 3).fill(1) };
  it('reproduces the modelled shape exactly when the pose equals the modelled pose', () => {
    const out = new Float32Array(mesh.vertexCount * 3);
    skinBody(unscaled, model.bind, out);
    let worst = 0;
    for (let i = 0; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i]! - mesh.positions[i]!));
    expect(worst).toBeLessThan(1e-4);
    const t = skinTransforms(model.bind, model.bind);
    expect(t.r[0]).toBeCloseTo(1, 9);
  });
  it('moves a fully bound vertex rigidly with its joint', () => {
    const w0 = forwardKinematics(rest, restPose());
    const w1 = forwardKinematics(rest, { root: { x: 0, y: 0, z: 0 }, rotations: { shoulderR: { x: -60, y: 0, z: 0 }, elbowR: { x: -90, y: 0, z: 0 }, wristR: { x: 30, y: 0, z: 0 } } });
    const a = new Float32Array(mesh.vertexCount * 3), b = new Float32Array(mesh.vertexCount * 3);
    skinBody(unscaled, w0, a);
    skinBody(unscaled, w1, b);
    const wristIdx = SKIN_INDEX.wristR;
    let checked = 0;
    for (let v = 0; v < mesh.vertexCount; v++) {
      if (mesh.skinJoints[v * 4] === wristIdx && mesh.skinWeights[v * 4]! > 0.999) {
        // a hand vertex follows its wrist rigidly: its distance to the wrist joint is preserved
        const d0 = Math.hypot(a[v * 3]! - w0.wristR.position.x, a[v * 3 + 1]! - w0.wristR.position.y, a[v * 3 + 2]! - w0.wristR.position.z);
        const d1 = Math.hypot(b[v * 3]! - w1.wristR.position.x, b[v * 3 + 1]! - w1.wristR.position.y, b[v * 3 + 2]! - w1.wristR.position.z);
        expect(d1).toBeCloseTo(d0, 4);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
  it('keeps every vertex and normal finite and the figure whole across all pose presets', () => {
    const out = new Float32Array(mesh.vertexCount * 3);
    const nor = new Float32Array(mesh.vertexCount * 3);
    for (const p of ['neutral', 'a-pose', 't-pose', 'walk', 'run', 'sit', 'crouch', 'wave', 'jump', 'guard', 'point']) {
      const preset = presetById(p);
      if (!preset) continue;
      skinBody(mesh, forwardKinematics(rest, applyPreset(rest, preset)), out, nor);
      expect(out.every(Number.isFinite), p).toBe(true);
      expect(nor.every(Number.isFinite), p).toBe(true);
      const b = boundsXY(out, mesh.vertexCount);
      expect(b.maxY - b.minY, p).toBeGreaterThan(0.5);
    }
  });
  it('bends the elbow without tearing the arm apart', () => {
    const bent = new Float32Array(mesh.vertexCount * 3);
    const flat = new Float32Array(mesh.vertexCount * 3);
    skinBody(mesh, forwardKinematics(rest, restPose()), flat);
    skinBody(mesh, forwardKinematics(rest, { root: { x: 0, y: 0, z: 0 }, rotations: { elbowL: { x: -100, y: 0, z: 0 } } }), bent);
    // neighbouring vertices of the model stay close to each other: no triangle edge grows more than ~3x
    let worst = 0;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = mesh.indices[t + k]!, b = mesh.indices[t + ((k + 1) % 3)]!;
        const before = Math.hypot(flat[a * 3]! - flat[b * 3]!, flat[a * 3 + 1]! - flat[b * 3 + 1]!, flat[a * 3 + 2]! - flat[b * 3 + 2]!);
        const after = Math.hypot(bent[a * 3]! - bent[b * 3]!, bent[a * 3 + 1]! - bent[b * 3 + 1]!, bent[a * 3 + 2]! - bent[b * 3 + 2]!);
        if (before > 1e-4) worst = Math.max(worst, after / before);
      }
    }
    expect(worst).toBeLessThan(3);
  });
});

describe('size, height and width controls', () => {
  it('scales the whole body with height', () => {
    const r = buildRestSkeleton({ height: 2.0 });
    const b = boundsXY(neutral(buildCharacterMesh(r, DEFAULT_SHAPE), r), mesh.vertexCount);
    expect(b.maxY).toBeCloseTo(2.0, 1);
  });
  it('lengthens legs, torso, arms and head with their proportion sliders', () => {
    const h = (p: Parameters<typeof buildRestSkeleton>[0]) => { const r = buildRestSkeleton(p); const b = boundsXY(neutral(buildCharacterMesh(r, DEFAULT_SHAPE), r), mesh.vertexCount); return b.maxY - b.minY; };
    expect(h({ legs: 1.2 })).toBeGreaterThan(h({}) + 0.1);
    expect(h({ torso: 1.2 })).toBeGreaterThan(h({}) + 0.05);
    expect(h({ head: 1.3 })).toBeGreaterThan(h({}) + 0.03);
    const reach = (p: Parameters<typeof buildRestSkeleton>[0]) => { const r = buildRestSkeleton(p); const pos = posedPositions(buildCharacterMesh(r, DEFAULT_SHAPE), r, { root: { x: 0, y: 0, z: 0 }, rotations: { shoulderL: { x: 0, y: 0, z: 90 } } }); return boundsXY(pos, mesh.vertexCount).maxX; };
    expect(reach({ arms: 1.3 })).toBeGreaterThan(reach({}) + 0.1);
  });
  it('widens the body with overall width (build), shoulders and hips', () => {
    const wid = (p: Parameters<typeof buildRestSkeleton>[0], joint: SkinJointId) => { const r = buildRestSkeleton(p); const m = buildCharacterMesh(r, DEFAULT_SHAPE); return extentOf(m, neutral(m, r), joint, 0); };
    expect(wid({ build: 1.4 }, 'chest')).toBeGreaterThan(wid({}, 'chest') * 1.2);
    expect(wid({ shoulders: 1.4 }, 'chest')).toBeGreaterThan(wid({}, 'chest') * 1.2);
    expect(wid({ hips: 1.4 }, 'pelvis')).toBeGreaterThan(wid({}, 'pelvis') * 1.2);
    // overall width as the artist sees it: the whole silhouette gets wider
    const sil = (p: Parameters<typeof buildRestSkeleton>[0]) => { const r = buildRestSkeleton(p); const b = boundsXY(neutral(buildCharacterMesh(r, DEFAULT_SHAPE), r), mesh.vertexCount); return b.maxX - b.minX; };
    expect(sil({ build: 1.4 })).toBeGreaterThan(sil({}) * 1.15);
  });
  it('each shape control changes the body locally', () => {
    const base = neutral(mesh);
    const ext = (shape: Partial<typeof DEFAULT_SHAPE>, joint: SkinJointId, axis: 0 | 1 | 2) => { const m = buildCharacterMesh(rest, { ...DEFAULT_SHAPE, ...shape }); return extentOf(m, neutral(m), joint, axis); };
    const was = (joint: SkinJointId, axis: 0 | 1 | 2) => extentOf(mesh, base, joint, axis);
    expect(ext({ chest: 1.5 }, 'chest', 0)).toBeGreaterThan(was('chest', 0) * 1.25);
    expect(ext({ waist: 1.5 }, 'spine', 0)).toBeGreaterThan(was('spine', 0) * 1.25);
    expect(ext({ pelvis: 1.5 }, 'pelvis', 0)).toBeGreaterThan(was('pelvis', 0) * 1.25);
    expect(ext({ neck: 1.5 }, 'neck', 0)).toBeGreaterThan(was('neck', 0) * 1.25);
    expect(ext({ depth: 1.5 }, 'chest', 2)).toBeGreaterThan(was('chest', 2) * 1.25);
    expect(ext({ feet: 1.5 }, 'ankleL', 2)).toBeGreaterThan(was('ankleL', 2) * 1.25);
    expect(ext({ hands: 1.5 }, 'wristL', 1)).toBeGreaterThan(was('wristL', 1) * 1.25);
    expect(ext({ arms: 1.5 }, 'shoulderL', 0)).toBeGreaterThan(was('shoulderL', 0) * 1.2);
    expect(ext({ legs: 1.5 }, 'kneeL', 0)).toBeGreaterThan(was('kneeL', 0) * 1.2);
    // and a control leaves the rest of the body alone
    expect(ext({ chest: 1.5 }, 'kneeL', 0)).toBeCloseTo(was('kneeL', 0), 6);
    for (const k of SHAPE_KEYS) expect(() => buildCharacterMesh(rest, { ...DEFAULT_SHAPE, [k]: SHAPE_RANGES[k].max }, 'draft')).not.toThrow();
  });
  it('builds a valid mesh at the extremes of every control', () => {
    const lo = Object.fromEntries(SHAPE_KEYS.map((k) => [k, SHAPE_RANGES[k].min]));
    const r = buildRestSkeleton({ height: 1.2, legs: 0.75, torso: 0.75, arms: 0.75, shoulders: 0.6, hips: 0.6, head: 1.5, build: 0.6 });
    const m = buildCharacterMesh(r, lo);
    expect(neutral(m, r).every(Number.isFinite)).toBe(true);
    const hi = Object.fromEntries(SHAPE_KEYS.map((k) => [k, SHAPE_RANGES[k].max]));
    const r2 = buildRestSkeleton({ height: 2.3, legs: 1.3, torso: 1.3, arms: 1.3, shoulders: 1.5, hips: 1.5, head: 0.7, build: 1.5 });
    expect(neutral(buildCharacterMesh(r2, hi), r2).every(Number.isFinite)).toBe(true);
  });
  it('every body preset produces a body', () => {
    for (const p of BODY_PRESETS) {
      const r = buildRestSkeleton(p.proportions);
      const b = boundsXY(neutral(buildCharacterMesh(r, p.shape), r), mesh.vertexCount);
      expect(b.maxY - b.minY).toBeGreaterThan(p.proportions.height * 0.85);
    }
  });
});

describe('shape data', () => {
  it('clamps out-of-range and missing values', () => {
    const c = clampShape({ chest: 9, waist: -1, neck: Number.NaN });
    expect(c.chest).toBe(SHAPE_RANGES.chest.max);
    expect(c.waist).toBe(SHAPE_RANGES.waist.min);
    expect(c.neck).toBe(1);
    expect(clampShape(undefined)).toEqual(DEFAULT_SHAPE);
  });
  it('validates untrusted shape data', () => {
    expect(validateShape(DEFAULT_SHAPE)).toEqual([]);
    expect(validateShape({ ...DEFAULT_SHAPE, arms: 5 })[0]).toMatch(/arms/);
    expect(validateShape(null)[0]).toMatch(/object/);
    expect(validateShape({ chest: 1 }).length).toBe(SHAPE_KEYS.length - 1);
  });
});

describe('artwork projection geometry', () => {
  const pos = posedPositions(mesh, rest, restPose());
  it('aligns the model box to the artwork box (same height, centred)', () => {
    const b = boundsXY(pos, mesh.vertexCount);
    const art = { x0: 100, y0: 50, x1: 399, y1: 849 };
    const fit = alignFit(b, art);
    expect(fit.oy - b.maxY * fit.ppm).toBeCloseTo(art.y0, 3);
    expect(fit.oy - b.minY * fit.ppm).toBeCloseTo(art.y1 + 1, 3);
    expect(fit.ox + ((b.minX + b.maxX) / 2) * fit.ppm).toBeCloseTo((art.x0 + art.x1 + 1) / 2, 3);
  });
  it('bakes texture coordinates from the front projection', () => {
    const fit = { ppm: 400, ox: 300, oy: 900 };
    const uv = bakeUv(pos, mesh.vertexCount, fit, 600, 1000);
    const i = 123;
    expect(uv[i * 2]!).toBeCloseTo((300 + pos[i * 3]! * 400) / 600, 5);
    expect(uv[i * 2 + 1]!).toBeCloseTo((900 - pos[i * 3 + 1]! * 400) / 1000, 5);
    const back = bakeUv(pos, mesh.vertexCount, fit, 600, 1000, true);
    expect(back[i * 2]!).toBeCloseTo((300 - pos[i * 3]! * 400) / 600, 5);
  });
  it('rasterises a silhouette that fills the artwork box', () => {
    const b = boundsXY(pos, mesh.vertexCount);
    const fit = alignFit(b, { x0: 10, y0: 10, x1: 109, y1: 309 });
    const m = bodySilhouette(pos, mesh, fit, 120, 320);
    let n = 0;
    for (const v of m.data) n += v;
    expect(n).toBeGreaterThan(2000);
    expect(m.data[5 * 120 + 5]).toBe(0);
  });
});
