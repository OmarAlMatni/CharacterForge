import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  ANKLE_HEIGHT,
  CHAINS, DEFAULT_CAMERA, DEFAULT_PROPORTIONS, JOINT_DEFS, JOINT_IDS, OPENPOSE_LIMBS, OPENPOSE_NAMES, POSE_PRESETS, PROPORTION_PRESETS,
  applyPreset, blendPoses, buildRestSkeleton, clampPose, clampProportions, computePoseGuide, eulerToQuat, forwardKinematics, frameCamera,
  framingPoints, getRot, mirrorPose, moveRootPinned, normalizePose, posesEqual, projectPoint, qMul, qRotate, qSimilarity, quatToEuler,
  restPose, setRot, snapToGround, solveLimbIk, validatePose, vDist, vLen, vSub,
} from '../src/pose/index.ts';
import type { ChainId, Euler, EulerOrder, JointId, Pose3D, V3 } from '../src/pose/index.ts';

const rest = buildRestSkeleton();
const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);

describe('quaternion / Euler conversion', () => {
  const samples: Euler[] = [
    { x: 0, y: 0, z: 0 }, { x: 30, y: 40, z: 50 }, { x: -70, y: 120, z: -20 }, { x: 10, y: -170, z: 85 },
    { x: 89.9, y: 20, z: 5 }, { x: 45, y: 90, z: 45 }, { x: -120, y: 15, z: -45 }, { x: 5, y: 5, z: 89.9 },
  ];
  for (const order of ['YXZ', 'XZY'] as EulerOrder[]) {
    it(`round-trips ${order} rotations exactly (as rotations)`, () => {
      for (const e of samples) {
        const q = eulerToQuat(e, order);
        const back = quatToEuler(q, order);
        expect(qSimilarity(q, eulerToQuat(back, order))).toBeGreaterThan(1 - 1e-9);
      }
    });
    it(`handles gimbal lock for ${order}`, () => {
      const e: Euler = order === 'YXZ' ? { x: 90, y: 30, z: 0 } : { x: 25, y: 0, z: 90 };
      const q = eulerToQuat(e, order);
      expect(qSimilarity(q, eulerToQuat(quatToEuler(q, order), order))).toBeGreaterThan(1 - 1e-9);
    });
  }
  it('rotates vectors the right-handed way', () => {
    const v = qRotate(eulerToQuat({ x: 0, y: 90, z: 0 }, 'YXZ'), { x: 0, y: 0, z: 1 });
    near(v.x, 1);
    near(v.z, 0);
    const w = qRotate(eulerToQuat({ x: -90, y: 0, z: 0 }, 'XZY'), { x: 0, y: -1, z: 0 });
    near(w.z, 1); // negative X swing lifts a hanging limb forward (+Z)
  });
  it('composes in the documented order', () => {
    const e = { x: 20, y: 35, z: -15 };
    const a = eulerToQuat(e, 'YXZ');
    const b = qMul(eulerToQuat({ x: 0, y: 35, z: 0 }, 'YXZ'), qMul(eulerToQuat({ x: 20, y: 0, z: 0 }, 'YXZ'), eulerToQuat({ x: 0, y: 0, z: -15 }, 'YXZ')));
    expect(qSimilarity(a, b)).toBeGreaterThan(1 - 1e-12);
  });
});

describe('skeleton and proportions', () => {
  it('has a consistent hierarchy', () => {
    expect(JOINT_IDS.length).toBe(JOINT_DEFS.length);
    for (const d of JOINT_DEFS) if (d.parent) expect(JOINT_IDS).toContain(d.parent);
    expect(JOINT_DEFS.filter((d) => d.parent === null).map((d) => d.id)).toEqual(['pelvis']);
  });
  it('stands on the floor with the head at the requested height in the neutral pose', () => {
    const w = forwardKinematics(rest, restPose());
    near(w.headTop.position.y, 1.7, 1e-9);
    near(rest.restHeight, 1.7, 1e-9);
    near(w.ankleL.position.y, ANKLE_HEIGHT, 1e-9);
    near(w.toeL.position.y, ANKLE_HEIGHT - 0.0835, 1e-9);
  });
  it('puts the character\'s left on +X and faces +Z', () => {
    const w = forwardKinematics(rest, restPose());
    expect(w.shoulderL.position.x).toBeGreaterThan(0);
    expect(w.shoulderR.position.x).toBeLessThan(0);
    expect(w.toeL.position.z).toBeGreaterThan(w.ankleL.position.z);
  });
  it('scales with height and changes limb lengths with their multipliers', () => {
    const tall = buildRestSkeleton({ height: 2.0 });
    near(tall.restHeight, 2.0, 1e-9);
    const long = buildRestSkeleton({ legs: 1.2 });
    near(long.boneLength.kneeL, rest.boneLength.kneeL * 1.2, 1e-9);
    expect(long.restHeight).toBeGreaterThan(rest.restHeight);
    const wide = buildRestSkeleton({ shoulders: 1.4 });
    near(wide.offsets.shoulderL.x, rest.offsets.shoulderL.x * 1.4, 1e-9);
  });
  it('clamps and sanitises proportions', () => {
    const c = clampProportions({ height: 99, legs: -4, torso: Number.NaN, head: 1.2 });
    expect(c.height).toBe(2.4);
    expect(c.legs).toBe(0.75);
    expect(c.torso).toBe(1);
    expect(c.head).toBe(1.2);
    expect(clampProportions(undefined)).toEqual(DEFAULT_PROPORTIONS);
  });
  it('proportion presets stand on the floor', () => {
    for (const p of PROPORTION_PRESETS) {
      const sk = buildRestSkeleton(p.value);
      const w = forwardKinematics(sk, restPose());
      near(w.ankleL.position.y, ANKLE_HEIGHT * sk.scale.k, 1e-9);
    }
  });
});

describe('pose operations', () => {
  const pose: Pose3D = {
    root: { x: 0.1, y: 0.2, z: -0.05 },
    rotations: { pelvis: { x: 5, y: 30, z: 2 }, shoulderL: { x: -40, y: 10, z: 50 }, elbowL: { x: -70, y: 5, z: 0 }, hipR: { x: -50, y: 8, z: -20 }, kneeR: { x: 80, y: 0, z: 0 } },
  };
  it('mirroring reflects every joint across X = 0', () => {
    const a = forwardKinematics(rest, pose);
    const b = forwardKinematics(rest, mirrorPose(pose));
    for (const id of JOINT_IDS) {
      const mirrored = JOINT_IDS.find((j) => j === (id.endsWith('L') ? id.slice(0, -1) + 'R' : id.endsWith('R') ? id.slice(0, -1) + 'L' : id))!;
      near(b[mirrored].position.x, -a[id].position.x, 1e-9);
      near(b[mirrored].position.y, a[id].position.y, 1e-9);
      near(b[mirrored].position.z, a[id].position.z, 1e-9);
    }
  });
  it('mirroring twice is the identity', () => {
    expect(posesEqual(mirrorPose(mirrorPose(pose)), pose)).toBe(true);
  });
  it('clamps rotations to joint limits and clears end joints', () => {
    const c = clampPose({ root: { x: 0, y: 0, z: 0 }, rotations: { elbowL: { x: 40, y: 0, z: 0 }, kneeR: { x: -30, y: 20, z: 5 }, headTop: { x: 10, y: 0, z: 0 }, head: { x: 0, y: 200, z: 0 } } });
    expect(c.rotations.elbowL).toBeUndefined(); // 40 -> clamped to 0 -> removed
    expect(c.rotations.kneeR).toBeUndefined();
    expect(c.rotations.headTop).toBeUndefined();
    expect(c.rotations.head!.y).toBe(70);
    expect(clampPose(pose).rotations.elbowL!.x).toBe(-70);
  });
  it('mirrored limits are mirrored', () => {
    const l = JOINT_DEFS.find((d) => d.id === 'hipL')!.limits;
    const r = JOINT_DEFS.find((d) => d.id === 'hipR')!.limits;
    expect(r.z).toEqual({ min: -l.z.max, max: -l.z.min });
    expect(r.x).toEqual(l.x);
  });
  it('blends linearly and equality is tolerant', () => {
    const b = blendPoses(restPose(), pose, 0.5);
    near(getRot(b, 'pelvis').y, 15);
    near(b.root.y, 0.1);
    expect(posesEqual(blendPoses(restPose(), pose, 1), pose)).toBe(true);
    expect(posesEqual(restPose(), pose)).toBe(false);
  });
  it('snaps to the ground', () => {
    const squat: Pose3D = { root: { x: 0, y: 0, z: 0 }, rotations: { hipL: { x: -90, y: 0, z: 0 }, hipR: { x: -90, y: 0, z: 0 }, kneeL: { x: 90, y: 0, z: 0 }, kneeR: { x: 90, y: 0, z: 0 } } };
    const g = snapToGround(rest, squat);
    const w = forwardKinematics(rest, g);
    const lowest = Math.min(w.toeL.position.y, w.toeR.position.y, w.ankleL.position.y - ANKLE_HEIGHT);
    near(lowest, 0, 1e-9);
    expect(g.root.y).toBeLessThan(0);
  });
  it('validates and normalises untrusted data', () => {
    expect(validatePose(pose)).toEqual([]);
    expect(validatePose(null)).not.toEqual([]);
    expect(validatePose({ root: { x: 0, y: 0 }, rotations: {} })).not.toEqual([]);
    expect(validatePose({ root: { x: 0, y: 0, z: 0 }, rotations: { nope: { x: 0, y: 0, z: 0 } } }).join()).toContain('unknown joint');
    expect(validatePose({ root: { x: 0, y: 0, z: 0 }, rotations: { head: { x: Number.NaN, y: 0, z: 0 } } }).join()).toContain('numbers');
    const n = normalizePose({ root: { x: 1e-12, y: 0.123456789, z: 0 }, rotations: { head: { x: 1e-9, y: 0, z: 0 }, neck: { x: 10.123456, y: 0, z: 0 } } });
    expect(n.root).toEqual({ x: 0, y: 0.1235, z: 0 });
    expect(n.rotations.head).toBeUndefined();
    expect(n.rotations.neck!.x).toBe(10.1235);
  });
});

describe('two-bone IK', () => {
  const chainEnd = (id: ChainId, p: Pose3D) => forwardKinematics(rest, p)[CHAINS[id].end].position;
  // arm targets are placed relative to the rest shoulder so they stay reachable for the model's arm length (0.43 m)
  const shoulderAt = (side: 'shoulderL' | 'shoulderR') => forwardKinematics(rest, restPose())[side].position;
  const armTargets = (side: 'shoulderL' | 'shoulderR', sign: number): V3[] => {
    const s0 = shoulderAt(side);
    return ([[0.22, -0.05, 0.21], [0.0, -0.12, 0.31], [0.18, 0.34, 0], [0.08, -0.3, 0.14], [-0.1, -0.05, 0.28]] as const).map(([x, y, z]) => ({ x: s0.x + sign * x, y: s0.y + y, z: s0.z + z }));
  };
  const targets: Record<ChainId, V3[]> = {
    armL: armTargets('shoulderL', 1),
    armR: armTargets('shoulderR', -1),
    legL: [{ x: 0.1, y: 0.5, z: 0.4 }, { x: 0.15, y: 0.2, z: 0.2 }, { x: 0.3, y: 0.3, z: 0.1 }],
    legR: [{ x: -0.1, y: 0.5, z: 0.4 }, { x: -0.15, y: 0.2, z: 0.2 }],
  };
  for (const [id, list] of Object.entries(targets) as [ChainId, V3[]][]) {
    it(`${id} reaches reachable targets exactly and bends the hinge the right way`, () => {
      for (const t of list) {
        const r = solveLimbIk(rest, restPose(), id, t);
        expect(r.reached, `${id} -> ${JSON.stringify(t)} error ${r.error}`).toBe(true);
        near(vDist(chainEnd(id, r.pose), t), 0, 2e-3);
        const hinge = getRot(r.pose, CHAINS[id].mid);
        if (CHAINS[id].bendSign < 0) expect(hinge.x).toBeLessThanOrEqual(1e-9);
        else expect(hinge.x).toBeGreaterThanOrEqual(-1e-9);
        near(hinge.z, 0);
      }
    });
  }
  it('keeps bone lengths constant (a rigid chain)', () => {
    const sA = shoulderAt('shoulderL');
    const r = solveLimbIk(rest, restPose(), 'armL', { x: sA.x + 0.2, y: sA.y + 0.05, z: sA.z + 0.25 });
    const w = forwardKinematics(rest, r.pose);
    near(vDist(w.shoulderL.position, w.elbowL.position), rest.boneLength.elbowL, 1e-9);
    near(vDist(w.elbowL.position, w.wristL.position), rest.boneLength.wristL, 1e-9);
  });
  it('reports unreachable targets and extends towards them', () => {
    const far: V3 = { x: 3, y: 1.4, z: 0 };
    const r = solveLimbIk(rest, restPose(), 'armL', far);
    expect(r.reached).toBe(false);
    expect(r.error).toBeGreaterThan(1);
    const w = forwardKinematics(rest, r.pose);
    const reach = rest.boneLength.elbowL + rest.boneLength.wristL;
    expect(vDist(w.shoulderL.position, w.wristL.position)).toBeGreaterThan(reach * 0.99);
    expect(w.wristL.position.x).toBeGreaterThan(w.shoulderL.position.x + reach * 0.9); // pointing the right way
  });
  it('does not fold a limb past its maximum bend when the target is too close', () => {
    const r = solveLimbIk(rest, restPose(), 'legL', forwardKinematics(rest, restPose()).hipL.position);
    expect(getRot(r.pose, 'kneeL').x).toBeLessThanOrEqual(150 + 1e-9);
  });
  it('keeps the ankle\'s world orientation (flat feet) when the leg moves', () => {
    const before = forwardKinematics(rest, restPose()).ankleL.rotation;
    const r = solveLimbIk(rest, restPose(), 'legL', { x: 0.1, y: 0.45, z: 0.35 });
    expect(r.reached).toBe(true);
    const after = forwardKinematics(rest, r.pose).ankleL.rotation;
    expect(qSimilarity(before, after)).toBeGreaterThan(1 - 1e-6);
  });
  it('solves repeatedly without drifting (dragging)', () => {
    let p = restPose();
    for (let i = 0; i <= 20; i++) {
      const sA = shoulderAt('shoulderL');
      const t: V3 = { x: sA.x + 0.08 + 0.12 * Math.cos(i / 3), y: sA.y - 0.12 + 0.12 * Math.sin(i / 3), z: sA.z + 0.22 };
      const r = solveLimbIk(rest, p, 'armL', t);
      expect(r.reached).toBe(true);
      p = r.pose;
    }
  });
  it('works for a body that is turned and offset', () => {
    const base: Pose3D = { root: { x: 0.2, y: 0, z: 0.1 }, rotations: { pelvis: { x: 5, y: 50, z: 3 }, chest: { x: 0, y: -20, z: 0 } } };
    const sh = forwardKinematics(rest, base).shoulderR.position;
    const t: V3 = { x: sh.x + 0.2, y: sh.y - 0.07, z: sh.z + 0.2 };
    const r = solveLimbIk(rest, base, 'armR', t);
    expect(r.reached).toBe(true);
    near(vDist(chainEnd('armR', r.pose), t), 0, 2e-3);
  });
  it('moves the root while keeping pinned feet in place', () => {
    const start = applyPreset(rest, POSE_PRESETS.find((p) => p.id === 'neutral')!);
    const before = forwardKinematics(rest, start);
    const { pose, unreachable } = moveRootPinned(rest, start, { x: 0, y: start.root.y - 0.2, z: 0.05 }, ['legL', 'legR']);
    expect(unreachable).toEqual([]);
    const after = forwardKinematics(rest, pose);
    near(vDist(after.ankleL.position, before.ankleL.position), 0, 2e-3);
    near(vDist(after.ankleR.position, before.ankleR.position), 0, 2e-3);
    expect(after.pelvis.position.y).toBeLessThan(before.pelvis.position.y - 0.19);
    expect(getRot(pose, 'kneeL').x).toBeGreaterThan(10); // knees bent to lower the pelvis
  });
  it('flags pinned feet that become unreachable', () => {
    const { unreachable } = moveRootPinned(rest, restPose(), { x: 0, y: 1.5, z: 0 }, ['legL']);
    expect(unreachable).toEqual(['legL']);
  });
});

describe('camera', () => {
  it('projects exactly like a Three.js perspective camera', () => {
    const cams = [DEFAULT_CAMERA, { azimuth: 55, elevation: -20, distance: 3, fov: 45, target: { x: 0.2, y: 1, z: -0.1 } }, { azimuth: -130, elevation: 60, distance: 6, fov: 20, target: { x: 0, y: 0.5, z: 0 } }];
    const pts: V3[] = [{ x: 0, y: 1, z: 0 }, { x: 0.3, y: 1.5, z: 0.2 }, { x: -0.4, y: 0.2, z: -0.3 }];
    for (const c of cams) {
      const w = 800, h = 1200;
      const cam = new THREE.PerspectiveCamera(c.fov, w / h, 0.1, 100);
      const pos = new THREE.Vector3(c.target.x + c.distance * Math.sin((c.azimuth * Math.PI) / 180) * Math.cos((c.elevation * Math.PI) / 180), c.target.y + c.distance * Math.sin((c.elevation * Math.PI) / 180), c.target.z + c.distance * Math.cos((c.azimuth * Math.PI) / 180) * Math.cos((c.elevation * Math.PI) / 180));
      cam.position.copy(pos);
      cam.lookAt(c.target.x, c.target.y, c.target.z);
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();
      for (const p of pts) {
        const n = new THREE.Vector3(p.x, p.y, p.z).project(cam);
        const mine = projectPoint(c, w, h, p);
        near(mine.ndcX, n.x, 1e-6);
        near(mine.ndcY, n.y, 1e-6);
      }
    }
  });
  it('front camera shows the character\'s left on the viewer\'s right', () => {
    const a = projectPoint({ ...DEFAULT_CAMERA, azimuth: 0 }, 1000, 1000, { x: 1, y: 0.9, z: 0 });
    expect(a.x).toBeGreaterThan(500);
    const back = projectPoint({ ...DEFAULT_CAMERA, azimuth: 180 }, 1000, 1000, { x: 1, y: 0.9, z: 0 });
    expect(back.x).toBeLessThan(500);
  });
  it('frames all points inside the frame for different aspects', () => {
    const pose = applyPreset(rest, POSE_PRESETS.find((p) => p.id === 'run')!);
    const pts = framingPoints(rest, pose);
    for (const aspect of [0.5, 0.667, 1, 1.78]) {
      const cam = frameCamera({ ...DEFAULT_CAMERA, azimuth: 30 }, pts, aspect, 0.08);
      for (const p of pts) {
        const q = projectPoint(cam, 1000 * aspect, 1000, p);
        expect(Math.abs(q.ndcX)).toBeLessThanOrEqual(0.92 + 1e-6);
        expect(Math.abs(q.ndcY)).toBeLessThanOrEqual(0.92 + 1e-6);
      }
    }
  });
});

describe('presets', () => {
  it('has unique ids and a useful range of poses', () => {
    const ids = POSE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(10);
  });
  it('every preset is within joint limits and finite, for every proportion preset', () => {
    for (const body of PROPORTION_PRESETS) {
      const sk = buildRestSkeleton(body.value);
      for (const p of POSE_PRESETS) {
        const pose = applyPreset(sk, p);
        expect(validatePose(pose), p.id).toEqual([]);
        expect(posesEqual(pose, { ...clampPose(pose), root: pose.root }), `${p.id} exceeds limits`).toBe(true);
        const w = forwardKinematics(sk, pose);
        for (const id of JOINT_IDS) expect(Number.isFinite(w[id].position.y)).toBe(true);
      }
    }
  });
  it('grounded presets touch the floor and do not sink through it', () => {
    for (const p of POSE_PRESETS.filter((x) => x.grounded)) {
      const w = forwardKinematics(rest, applyPreset(rest, p));
      const sole = Math.min(w.ankleL.position.y - ANKLE_HEIGHT, w.ankleR.position.y - ANKLE_HEIGHT, w.toeL.position.y, w.toeR.position.y);
      near(sole, 0, 1e-9);
      expect(w.headTop.position.y, p.id).toBeGreaterThan(0.4);
    }
  });
  it('T-pose has the arms level with the shoulders; A-pose angles them down', () => {
    const t = forwardKinematics(rest, applyPreset(rest, POSE_PRESETS.find((p) => p.id === 't-pose')!));
    expect(Math.abs(t.wristL.position.y - t.shoulderL.position.y)).toBeLessThan(1e-6);
    expect(t.wristL.position.x).toBeGreaterThan(0.5);
    expect(t.wristR.position.x).toBeLessThan(-0.5);
    const a = forwardKinematics(rest, applyPreset(rest, POSE_PRESETS.find((p) => p.id === 'a-pose')!));
    expect(a.wristL.position.y).toBeLessThan(a.shoulderL.position.y - 0.3);
    expect(a.wristL.position.x).toBeGreaterThan(a.shoulderL.position.x);
  });
  it('sitting has the knees above the feet and the thighs horizontal', () => {
    const w = forwardKinematics(rest, applyPreset(rest, POSE_PRESETS.find((p) => p.id === 'sit')!));
    near(w.kneeL.position.y, w.hipL.position.y, 1e-6);
    expect(w.kneeL.position.z).toBeGreaterThan(w.hipL.position.z + 0.3);
    expect(w.pelvis.position.y).toBeLessThan(0.6);
  });
  it('wave raises the right hand above the head', () => {
    const w = forwardKinematics(rest, applyPreset(rest, POSE_PRESETS.find((p) => p.id === 'wave')!));
    expect(w.wristR.position.y).toBeGreaterThan(w.head.position.y);
  });
  it('jump is airborne', () => {
    const w = forwardKinematics(rest, applyPreset(rest, POSE_PRESETS.find((p) => p.id === 'jump')!));
    expect(Math.min(w.ankleL.position.y, w.ankleR.position.y)).toBeGreaterThan(0.3);
  });
});

describe('pose guide data', () => {
  const sizeW = 768, sizeH = 1152;
  it('produces the 18 OpenPose keypoints with sensible geometry', () => {
    const cam = frameCamera(DEFAULT_CAMERA, framingPoints(rest, restPose()), sizeW / sizeH);
    const g = computePoseGuide(rest, restPose(), cam, sizeW, sizeH);
    expect(g.keypoints.map((k) => k.name)).toEqual([...OPENPOSE_NAMES]);
    expect(g.keypoints.every((k) => k.inFrame)).toBe(true);
    const by = Object.fromEntries(g.keypoints.map((k) => [k.name, k]));
    expect(by.nose!.y).toBeLessThan(by.neck!.y); // head above neck (image y grows downward)
    expect(by.lShoulder!.x).toBeGreaterThan(by.rShoulder!.x); // character's left on the viewer's right when facing the camera
    expect(by.lAnkle!.y).toBeGreaterThan(by.lKnee!.y);
    expect(by.lEye!.x).toBeGreaterThan(by.rEye!.x);
    for (const [a, b] of OPENPOSE_LIMBS) expect(a).not.toBe(b);
  });
  it('reports the facing direction relative to the camera', () => {
    const g0 = computePoseGuide(rest, restPose(), { ...DEFAULT_CAMERA, azimuth: 0 }, sizeW, sizeH);
    near(g0.facing.yawToCameraDeg, 0, 1e-6);
    const g90 = computePoseGuide(rest, restPose(), { ...DEFAULT_CAMERA, azimuth: 90 }, sizeW, sizeH);
    near(Math.abs(g90.facing.yawToCameraDeg), 90, 1e-6);
    const gb = computePoseGuide(rest, restPose(), { ...DEFAULT_CAMERA, azimuth: 180 }, sizeW, sizeH);
    near(Math.abs(gb.facing.yawToCameraDeg), 180, 1e-6);
    const turned = computePoseGuide(rest, setRot(restPose(), 'pelvis', { y: 45 }), { ...DEFAULT_CAMERA, azimuth: 0 }, sizeW, sizeH);
    near(Math.abs(turned.facing.yawToCameraDeg), 45, 1e-6);
  });
  it('is deterministic', () => {
    const a = computePoseGuide(rest, applyPreset(rest, POSE_PRESETS[5]!), DEFAULT_CAMERA, sizeW, sizeH);
    const b = computePoseGuide(rest, applyPreset(rest, POSE_PRESETS[5]!), DEFAULT_CAMERA, sizeW, sizeH);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it('vector helpers behave', () => {
    near(vLen(vSub({ x: 3, y: 4, z: 0 }, { x: 0, y: 0, z: 0 })), 5);
    const _id: JointId = 'head';
    expect(_id).toBe('head');
  });
});

describe('free rotation (FK drag)', () => {
  it('rotates a joint about a world axis and children follow', async () => {
    const { rotateJointByWorldDelta, qFromAxisAngle } = await import('../src/pose/index.ts');
    const before = forwardKinematics(rest, restPose());
    const delta = qFromAxisAngle({ x: 0, y: 0, z: 1 }, (30 * Math.PI) / 180); // swing about world Z: left arm moves out
    const next = rotateJointByWorldDelta(rest, restPose(), 'shoulderL', delta);
    const after = forwardKinematics(rest, next);
    expect(after.wristL.position.x).toBeGreaterThan(before.wristL.position.x + 0.2);
    near(vDist(after.shoulderL.position, before.shoulderL.position), 0, 1e-9); // the joint itself stays put
    near(after.wristL.position.x - after.shoulderL.position.x, Math.sin((30 * Math.PI) / 180) * (rest.boneLength.elbowL + rest.boneLength.wristL), 1e-6);
  });
  it('clamps to joint limits (a head turn cannot exceed its range) and ignores end joints', async () => {
    const { rotateJointByWorldDelta, qFromAxisAngle } = await import('../src/pose/index.ts');
    const turned = rotateJointByWorldDelta(rest, restPose(), 'head', qFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI * 0.9));
    expect(getRot(turned, 'head').y).toBe(70);
    const same = rotateJointByWorldDelta(rest, restPose(), 'headTop', qFromAxisAngle({ x: 0, y: 1, z: 0 }, 1));
    expect(same).toEqual(restPose());
  });
  it('keeps hinge joints on their axis', async () => {
    const { rotateJointByWorldDelta, qFromAxisAngle } = await import('../src/pose/index.ts');
    const p = rotateJointByWorldDelta(rest, restPose(), 'elbowL', qFromAxisAngle({ x: 0.3, y: 0.2, z: 0.9 }, -1.0));
    const e = getRot(p, 'elbowL');
    expect(e.z).toBe(0);
    expect(e.x).toBeLessThanOrEqual(0);
  });
});
