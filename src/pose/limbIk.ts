import type { Pose3D } from './pose.ts';
import { forwardKinematics, getRot } from './pose.ts';
import type { JointId, RestSkeleton } from './skeleton.ts';
import { jointDef } from './skeleton.ts';
import type { Euler, V3 } from './vec.ts';
import { DEG, RAD, eulerToQuat, qFromBasis, qInv, qMul, qRotate, quatToEuler, vAdd, vCross, vDist, vDot, vLen, vNorm, vScale, vSub } from './vec.ts';

/**
 * Analytic two-bone IK for arms and legs in 3D.
 *
 * The root joint (shoulder / hip) is a ball joint, the middle joint (elbow / knee) is a one-axis hinge, and the end joint
 * (wrist / ankle) is the effector. The solver places the middle joint with the law of cosines, then derives the root joint's
 * rotation from the bone direction and hinge axis, so the result is exact (no iteration) and deterministic.
 */
export type ChainId = 'armL' | 'armR' | 'legL' | 'legR';

export interface ChainDef {
  id: ChainId;
  root: JointId;
  mid: JointId;
  end: JointId;
  /** Hinge rotation about local X is `bendSign * bend`: elbows bend with negative X, knees with positive X. */
  bendSign: 1 | -1;
  maxBendDeg: number;
  /** Keep the end joint's world orientation (flat feet) instead of its local rotation. */
  preserveEndWorld: boolean;
  /** Preferred direction of the middle joint relative to the root->target line. */
  pole: V3;
  /** Used when `pole` is parallel to the root->target line. */
  fallbackPole: V3;
}

const side = (s: 'L' | 'R') => (s === 'L' ? 1 : -1);

export const CHAINS: Record<ChainId, ChainDef> = {
  armL: { id: 'armL', root: 'shoulderL', mid: 'elbowL', end: 'wristL', bendSign: -1, maxBendDeg: 150, preserveEndWorld: false, pole: { x: 0.3 * side('L'), y: -1, z: -0.3 }, fallbackPole: { x: 0, y: 0, z: -1 } },
  armR: { id: 'armR', root: 'shoulderR', mid: 'elbowR', end: 'wristR', bendSign: -1, maxBendDeg: 150, preserveEndWorld: false, pole: { x: 0.3 * side('R'), y: -1, z: -0.3 }, fallbackPole: { x: 0, y: 0, z: -1 } },
  legL: { id: 'legL', root: 'hipL', mid: 'kneeL', end: 'ankleL', bendSign: 1, maxBendDeg: 150, preserveEndWorld: true, pole: { x: 0.1 * side('L'), y: 0, z: 1 }, fallbackPole: { x: 0, y: 1, z: 0 } },
  legR: { id: 'legR', root: 'hipR', mid: 'kneeR', end: 'ankleR', bendSign: 1, maxBendDeg: 150, preserveEndWorld: true, pole: { x: 0.1 * side('R'), y: 0, z: 1 }, fallbackPole: { x: 0, y: 1, z: 0 } },
};

/** The IK chain whose end effector is the given joint, if any. */
export function chainForEnd(end: JointId): ChainDef | null {
  return Object.values(CHAINS).find((c) => c.end === end) ?? null;
}

export interface IkResult {
  pose: Pose3D;
  /** True when the end joint is within tolerance of the requested target. */
  reached: boolean;
  /** Remaining distance between the end joint and the target. */
  error: number;
}

const X_AXIS: V3 = { x: 1, y: 0, z: 0 };
const clampN = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function clampJoint(id: JointId, e: Euler): Euler {
  const l = jointDef(id).limits;
  return { x: clampN(e.x, l.x.min, l.x.max), y: clampN(e.y, l.y.min, l.y.max), z: clampN(e.z, l.z.min, l.z.max) };
}

function perpendicular(v: V3, u: V3): V3 {
  return vSub(v, vScale(u, vDot(v, u)));
}

export function solveLimbIk(rest: RestSkeleton, pose: Pose3D, chainId: ChainId, target: V3): IkResult {
  const c = CHAINS[chainId];
  const w = forwardKinematics(rest, pose);
  const rootDef = jointDef(c.root);
  const A = w[c.root].position;
  const parentRot = w[rootDef.parent!].rotation;
  const l1 = rest.boneLength[c.mid];
  const l2 = rest.boneLength[c.end];

  const toTarget = vSub(target, A);
  const u = vNorm(toTarget, { x: 0, y: -1, z: 0 });
  const dMax = (l1 + l2) * 0.999999;
  const dMin = Math.sqrt(Math.max(1e-12, l1 * l1 + l2 * l2 - 2 * l1 * l2 * Math.cos(Math.PI - c.maxBendDeg * DEG)));
  const d = clampN(vLen(toTarget), dMin, dMax);

  const cosInterior = clampN((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1);
  const bend = Math.PI - Math.acos(cosInterior);
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const C = vAdd(A, vScale(u, d));
  const midOld = getRot(pose, c.mid);

  /** Build the solution for one choice of "pole" (the side the elbow/knee points to). */
  const attempt = (pole: V3): IkResult => {
    const B = vAdd(vAdd(A, vScale(u, a)), vScale(pole, h));
    const AB = vSub(B, A);
    const BC = vSub(C, B);
    const n = vCross(AB, BC);
    // Straight limb: no bend plane, so keep the current hinge axis.
    const hingeWorld = vLen(n) > 1e-9 * l1 * l2 ? vScale(vNorm(n), c.bendSign) : qRotate(w[c.root].rotation, X_AXIS);
    const yw = vScale(vNorm(AB), -1);
    const xw = vNorm(perpendicular(hingeWorld, yw), X_AXIS);
    const zw = vCross(xw, yw);
    const upperWorld = qFromBasis(xw, yw, zw);

    const rootLocal = clampJoint(c.root, quatToEuler(qMul(qInv(parentRot), upperWorld), rootDef.order));
    const mid = clampJoint(c.mid, { x: c.bendSign * bend * RAD, y: midOld.y, z: 0 });
    const next: Pose3D = { root: { ...pose.root }, rotations: { ...pose.rotations, [c.root]: rootLocal, [c.mid]: mid } };
    if (c.preserveEndWorld) {
      // Re-derive the world rotations from the (possibly clamped) values, then restore the end joint's world rotation.
      const upperW = qMul(parentRot, eulerToQuat(rootLocal, rootDef.order));
      const midW = qMul(upperW, eulerToQuat(mid, jointDef(c.mid).order));
      next.rotations[c.end] = clampJoint(c.end, quatToEuler(qMul(qInv(midW), w[c.end].rotation), jointDef(c.end).order));
    }
    const error = vDist(forwardKinematics(rest, next)[c.end].position, target);
    return { pose: next, error, reached: error <= 2e-3 * rest.scale.k };
  };

  // Candidate poles, best first: (1) continue the current bend plane while the limb is clearly bent (smooth dragging);
  // (2) the anatomical default, expressed in the parent's frame so it follows body turns; (3) a fallback axis.
  const candidates: V3[] = [];
  const oldAB = vSub(w[c.mid].position, A);
  const oldBC = vSub(w[c.end].position, w[c.mid].position);
  const oldBend = Math.acos(clampN(vDot(vNorm(oldAB), vNorm(oldBC)), -1, 1)) * RAD;
  const current = perpendicular(oldAB, u);
  if (oldBend > 8 && vLen(current) > 0.02 * l1) candidates.push(vNorm(current));
  const pref = perpendicular(qRotate(parentRot, c.pole), u);
  if (vLen(pref) > 1e-3) candidates.push(vNorm(pref));
  const fb = perpendicular(qRotate(parentRot, c.fallbackPole), u);
  candidates.push(vLen(fb) > 1e-3 ? vNorm(fb) : vNorm(perpendicular(X_AXIS, u), { x: 0, y: 0, z: 1 }));

  let best: IkResult | null = null;
  for (const pole of candidates) {
    const r = attempt(pole);
    if (!best || r.error < best.error - 1e-12) best = r;
    if (r.reached) break;
  }
  return best!;
}

/**
 * Move the whole body (pelvis) and keep the listed chains' end joints exactly where they were (e.g. feet planted on the floor).
 */
export function moveRootPinned(rest: RestSkeleton, pose: Pose3D, newRoot: V3, pins: ChainId[]): { pose: Pose3D; unreachable: ChainId[] } {
  const before = forwardKinematics(rest, pose);
  let next: Pose3D = { ...pose, root: { ...newRoot } };
  const unreachable: ChainId[] = [];
  for (const id of pins) {
    const r = solveLimbIk(rest, next, id, before[CHAINS[id].end].position);
    next = r.pose;
    if (!r.reached) unreachable.push(id);
  }
  return { pose: next, unreachable };
}
