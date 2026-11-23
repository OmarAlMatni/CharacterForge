import { angleDeg, clamp, len, normalizeDeg, sub, toDeg } from './math.ts';
import type { Vec2 } from './math.ts';
import { clampToLimits, jointFrames, withinLimits } from './rig.ts';
import type { ID, Joint, PoseState } from './types.ts';

const EPS = 1e-6;

export interface IKChain {
  /** First joint of the chain (e.g. shoulder). Its rotation is solved. */
  rootId: ID;
  /** Middle joint (e.g. elbow). Its rotation is solved. */
  midId: ID;
  /** End effector joint (e.g. wrist). Follows the target. */
  endId: ID;
}

export interface IKResult {
  pose: PoseState;
  /** False when the target was outside the chain's reach and was clamped. */
  reachable: boolean;
  /** True when joint limits prevented an exact solution. */
  limited: boolean;
}

/** The two-bone chain ending at `endId` (end → parent → grandparent), or null if it has no grandparent. */
export function ikChainFor(joints: Joint[], endId: ID): IKChain | null {
  const byId = new Map(joints.map((j) => [j.id, j]));
  const end = byId.get(endId);
  const mid = end?.parentId ? byId.get(end.parentId) : undefined;
  const root = mid?.parentId ? byId.get(mid.parentId) : undefined;
  if (!end || !mid || !root) return null;
  return { rootId: root.id, midId: mid.id, endId: end.id };
}

/** +1 / -1 select opposite elbow sides. With bend 0 the current side is kept. */
function pickSide(mid: Joint, a: Vec2, b: Vec2, c: Vec2): 1 | -1 {
  if (mid.bend === 1 || mid.bend === -1) return mid.bend;
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(cross) > 1e-6) return cross > 0 ? -1 : 1;
  return 1;
}

/**
 * Analytic two-bone IK (law of cosines). Moves the chain so the end joint reaches `target`
 * (canvas coordinates). Only the rotations of the chain root and middle joint change.
 */
export function solveTwoBoneIK(joints: Joint[], pose: PoseState, chain: IKChain, target: Vec2): IKResult {
  const byId = new Map(joints.map((j) => [j.id, j]));
  const A = byId.get(chain.rootId);
  const B = byId.get(chain.midId);
  const C = byId.get(chain.endId);
  if (!A || !B || !C) return { pose, reachable: false, limited: false };

  const frames = jointFrames(joints, pose);
  const fA = frames.get(A.id)!;
  const fB = frames.get(B.id)!;
  const fC = frames.get(C.id)!;
  const parentRot = A.parentId ? (frames.get(A.parentId)?.rot ?? 0) : 0;

  const l1 = len(B.offset);
  const l2 = len(C.offset);
  if (l1 < EPS || l2 < EPS) return { pose, reachable: false, limited: false };
  const a1 = angleDeg(B.offset);
  const a2 = angleDeg(C.offset);

  const toT = sub(target, fA.pos);
  const rawDist = len(toT);
  const maxR = l1 + l2;
  const minR = Math.abs(l1 - l2);
  const reachable = rawDist <= maxR && rawDist >= minR;
  const d = clamp(rawDist, minR + EPS, maxR - EPS);
  const tau = rawDist < EPS ? 0 : Math.atan2(toT.y, toT.x);
  const T = { x: fA.pos.x + Math.cos(tau) * d, y: fA.pos.y + Math.sin(tau) * d };
  const gamma = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));

  const solveSide = (s: 1 | -1) => {
    const th1 = tau + s * gamma;
    const E = { x: fA.pos.x + l1 * Math.cos(th1), y: fA.pos.y + l1 * Math.sin(th1) };
    const th2 = Math.atan2(T.y - E.y, T.x - E.x);
    const rotA = normalizeDeg(toDeg(th1) - parentRot - a1);
    const rotB = normalizeDeg(toDeg(th2) - a2 - (parentRot + rotA));
    return { rotA, rotB };
  };

  const preferred = pickSide(B, fA.pos, fB.pos, fC.pos);
  const sides: Array<1 | -1> = [preferred, preferred === 1 ? -1 : 1];
  let chosen = solveSide(preferred);
  let limited = false;
  let found = false;
  for (const s of sides) {
    const sol = solveSide(s);
    if (withinLimits(A, sol.rotA) && withinLimits(B, sol.rotB)) {
      chosen = sol;
      found = true;
      break;
    }
  }
  if (!found) {
    limited = true;
    chosen = { rotA: clampToLimits(A, chosen.rotA), rotB: clampToLimits(B, chosen.rotB) };
  }
  return {
    pose: { ...pose, rotations: { ...pose.rotations, [A.id]: chosen.rotA, [B.id]: chosen.rotB } },
    reachable,
    limited,
  };
}

/**
 * Forward-kinematics drag: moving joint `jointId` toward `target` rotates its parent so the
 * parent→joint bone points at the target. Dragging a root joint translates the whole rig.
 */
export function solveFKDrag(joints: Joint[], pose: PoseState, jointId: ID, target: Vec2): PoseState {
  const byId = new Map(joints.map((j) => [j.id, j]));
  const j = byId.get(jointId);
  if (!j) return pose;
  if (!j.parentId || !byId.has(j.parentId)) {
    return { ...pose, rootOffset: { x: target.x - j.offset.x, y: target.y - j.offset.y } };
  }
  const P = byId.get(j.parentId)!;
  const frames = jointFrames(joints, pose);
  const fP = frames.get(P.id)!;
  const grandRot = P.parentId ? (frames.get(P.parentId)?.rot ?? 0) : 0;
  const v = sub(target, fP.pos);
  if (len(v) < EPS) return pose;
  const rot = clampToLimits(P, normalizeDeg(angleDeg(v) - angleDeg(j.offset) - grandRot));
  return { ...pose, rotations: { ...pose.rotations, [P.id]: rot } };
}

