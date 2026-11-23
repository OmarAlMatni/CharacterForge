import type { Pose3D } from './pose.ts';
import { forwardKinematics } from './pose.ts';
import type { JointId, RestSkeleton } from './skeleton.ts';
import { jointDef } from './skeleton.ts';
import type { Euler, Q } from './vec.ts';
import { qInv, qMul, quatToEuler } from './vec.ts';

const clampN = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function clampEuler(id: JointId, e: Euler): Euler {
  const l = jointDef(id).limits;
  return { x: clampN(e.x, l.x.min, l.x.max), y: clampN(e.y, l.y.min, l.y.max), z: clampN(e.z, l.z.min, l.z.max) };
}

/**
 * Rotate one joint by a rotation expressed in WORLD space (e.g. built from the camera's right/up axes while dragging).
 * The result is converted back to the joint's local Euler angles and clamped to its limits; children follow via FK.
 */
export function rotateJointByWorldDelta(rest: RestSkeleton, pose: Pose3D, id: JointId, delta: Q): Pose3D {
  const def = jointDef(id);
  if (def.kind === 'end') return pose;
  const w = forwardKinematics(rest, pose);
  const parentRot = def.parent ? w[def.parent].rotation : { x: 0, y: 0, z: 0, w: 1 };
  const newWorld = qMul(delta, w[id].rotation);
  const local = clampEuler(id, quatToEuler(qMul(qInv(parentRot), newWorld), def.order));
  return { root: { ...pose.root }, rotations: { ...pose.rotations, [id]: local } };
}
