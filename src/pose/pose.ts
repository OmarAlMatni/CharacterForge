import type { JointId, RestSkeleton } from './skeleton.ts';
import { ANKLE_HEIGHT, JOINT_IDS, MIRROR, ORDERED_DEFS, isJointId, jointDef } from './skeleton.ts';
import type { Euler, Q, V3 } from './vec.ts';
import { eulerToQuat, qMul, qRotate, qIdentity, vAdd } from './vec.ts';

/**
 * A pose = joint rotations (degrees, relative to the parent frame) + a translation of the pelvis from its standing position.
 * Missing joints are at rest. This is the unit that is saved, restored, rendered and sent to generation adapters.
 */
export interface Pose3D {
  root: V3;
  rotations: Partial<Record<JointId, Euler>>;
}

export const restPose = (): Pose3D => ({ root: { x: 0, y: 0, z: 0 }, rotations: {} });

export const getRot = (pose: Pose3D, id: JointId): Euler => pose.rotations[id] ?? { x: 0, y: 0, z: 0 };

export function setRot(pose: Pose3D, id: JointId, e: Partial<Euler>): Pose3D {
  const cur = getRot(pose, id);
  return { ...pose, rotations: { ...pose.rotations, [id]: { x: e.x ?? cur.x, y: e.y ?? cur.y, z: e.z ?? cur.z } } };
}

export interface WorldJoint {
  position: V3;
  /** World rotation of the joint's frame (includes its own local rotation). */
  rotation: Q;
}
export type WorldPose = Record<JointId, WorldJoint>;

/** Forward kinematics. */
export function forwardKinematics(rest: RestSkeleton, pose: Pose3D): WorldPose {
  const out = {} as WorldPose;
  for (const def of ORDERED_DEFS) {
    const e = pose.rotations[def.id];
    const local = def.kind === 'end' || !e ? qIdentity() : eulerToQuat(e, def.order);
    if (!def.parent) {
      out[def.id] = { position: vAdd(rest.offsets[def.id], pose.root), rotation: local };
    } else {
      const p = out[def.parent];
      out[def.id] = { position: vAdd(p.position, qRotate(p.rotation, rest.offsets[def.id])), rotation: qMul(p.rotation, local) };
    }
  }
  return out;
}

export const worldPositions = (w: WorldPose): Record<JointId, V3> => Object.fromEntries(JOINT_IDS.map((id) => [id, w[id].position])) as Record<JointId, V3>;

const clampN = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Clamp every joint rotation to its limits (end joints are cleared). Returns a new pose; never mutates. */
export function clampPose(pose: Pose3D): Pose3D {
  const rotations: Pose3D['rotations'] = {};
  for (const [k, e] of Object.entries(pose.rotations)) {
    if (!isJointId(k) || !e) continue;
    const d = jointDef(k);
    if (d.kind === 'end') continue;
    const c = { x: clampN(e.x, d.limits.x.min, d.limits.x.max), y: clampN(e.y, d.limits.y.min, d.limits.y.max), z: clampN(e.z, d.limits.z.min, d.limits.z.max) };
    if (Math.abs(c.x) > 1e-9 || Math.abs(c.y) > 1e-9 || Math.abs(c.z) > 1e-9) rotations[k] = c;
  }
  return { root: { ...pose.root }, rotations };
}

/** Mirror a pose left <-> right (reflection across the sagittal plane, X = 0). */
export function mirrorPose(pose: Pose3D): Pose3D {
  const rotations: Pose3D['rotations'] = {};
  for (const [k, e] of Object.entries(pose.rotations)) {
    if (!isJointId(k) || !e) continue;
    rotations[MIRROR[k]] = { x: e.x, y: -e.y, z: -e.z };
  }
  return { root: { x: -pose.root.x, y: pose.root.y, z: pose.root.z }, rotations };
}

/** Linear blend of two poses in Euler space (adequate for small differences; used for UI previews and tests). */
export function blendPoses(a: Pose3D, b: Pose3D, t: number): Pose3D {
  const rotations: Pose3D['rotations'] = {};
  for (const id of JOINT_IDS) {
    const ea = getRot(a, id);
    const eb = getRot(b, id);
    const e = { x: ea.x + (eb.x - ea.x) * t, y: ea.y + (eb.y - ea.y) * t, z: ea.z + (eb.z - ea.z) * t };
    if (Math.abs(e.x) + Math.abs(e.y) + Math.abs(e.z) > 1e-9) rotations[id] = e;
  }
  return {
    root: { x: a.root.x + (b.root.x - a.root.x) * t, y: a.root.y + (b.root.y - a.root.y) * t, z: a.root.z + (b.root.z - a.root.z) * t },
    rotations,
  };
}

/** Lowest point of the figure (feet, toes, hands, head) — used to place the figure on the ground plane. */
export function lowestPoint(w: WorldPose): number {
  return Math.min(...(['ankleL', 'ankleR', 'toeL', 'toeR', 'handL', 'handR', 'headTop'] as JointId[]).map((id) => w[id].position.y));
}

/**
 * Translate the pose vertically so the lowest of the toes/ankles touches the ground (y = floor).
 * Ankle height is accounted for: the sole is ANKLE_HEIGHT·k below the ankle joint.
 */
export function snapToGround(rest: RestSkeleton, pose: Pose3D, floor = 0): Pose3D {
  const w = forwardKinematics(rest, pose);
  const sole = rest.scale.k * ANKLE_HEIGHT;
  const lowest = Math.min(w.ankleL.position.y - sole, w.ankleR.position.y - sole, w.toeL.position.y, w.toeR.position.y);
  return { ...pose, root: { ...pose.root, y: pose.root.y + (floor - lowest) } };
}

const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) <= eps;

export function posesEqual(a: Pose3D, b: Pose3D, eps = 1e-6): boolean {
  if (!near(a.root.x, b.root.x, eps) || !near(a.root.y, b.root.y, eps) || !near(a.root.z, b.root.z, eps)) return false;
  return JOINT_IDS.every((id) => {
    const x = getRot(a, id);
    const y = getRot(b, id);
    return near(x.x, y.x, eps) && near(x.y, y.y, eps) && near(x.z, y.z, eps);
  });
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate untrusted pose data (e.g. from a project file). Returns error strings; empty = valid. */
export function validatePose(p: unknown, where = 'pose'): string[] {
  const errors: string[] = [];
  if (!isRec(p)) return [`${where}: must be an object.`];
  const r = p.root;
  if (!isRec(r) || !isNum(r.x) || !isNum(r.y) || !isNum(r.z)) errors.push(`${where}.root: must be {x, y, z} numbers.`);
  if (!isRec(p.rotations)) return [...errors, `${where}.rotations: must be an object.`];
  for (const [k, e] of Object.entries(p.rotations)) {
    if (!isJointId(k)) errors.push(`${where}.rotations: unknown joint "${k}".`);
    else if (!isRec(e) || !isNum(e.x) || !isNum(e.y) || !isNum(e.z)) errors.push(`${where}.rotations["${k}"]: must be {x, y, z} numbers.`);
  }
  return errors;
}

/** Round to a fixed precision so saved poses are stable (no 1e-15 noise) and diff-friendly. */
export function normalizePose(p: Pose3D, digits = 4): Pose3D {
  const f = 10 ** digits;
  const rd = (n: number) => Math.round(n * f) / f || 0;
  const rotations: Pose3D['rotations'] = {};
  for (const id of JOINT_IDS) {
    const e = p.rotations[id];
    if (!e) continue;
    const n = { x: rd(e.x), y: rd(e.y), z: rd(e.z) };
    if (n.x !== 0 || n.y !== 0 || n.z !== 0) rotations[id] = n;
  }
  return { root: { x: rd(p.root.x), y: rd(p.root.y), z: rd(p.root.z) }, rotations };
}
