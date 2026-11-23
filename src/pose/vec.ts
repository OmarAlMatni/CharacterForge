/**
 * Minimal 3D vector / quaternion maths for the pose engine.
 * Right-handed, Y up. The mannequin faces +Z, so the character's LEFT side is +X.
 * No dependencies: the engine stays testable in Node and independent of Three.js and React.
 */
export interface V3 {
  x: number;
  y: number;
  z: number;
}
/** Unit quaternion. */
export interface Q {
  x: number;
  y: number;
  z: number;
  w: number;
}
/** Euler angles in degrees. How they combine depends on the joint (see skeleton.ts `EulerOrder`). */
export interface Euler {
  x: number;
  y: number;
  z: number;
}
export type EulerOrder = 'YXZ' | 'XZY';

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
export const vAdd = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const vSub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vScale = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const vDot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const vCross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
export const vLen = (a: V3): number => Math.hypot(a.x, a.y, a.z);
export const vDist = (a: V3, b: V3): number => vLen(vSub(a, b));
export const vLerp = (a: V3, b: V3, t: number): V3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
export function vNorm(a: V3, fallback: V3 = { x: 0, y: 1, z: 0 }): V3 {
  const l = vLen(a);
  return l < 1e-12 ? { ...fallback } : { x: a.x / l, y: a.y / l, z: a.z / l };
}
export const vClose = (a: V3, b: V3, eps = 1e-6): boolean => Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.z - b.z) <= eps;

export const qIdentity = (): Q => ({ x: 0, y: 0, z: 0, w: 1 });
export function qMul(a: Q, b: Q): Q {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
/** Inverse of a UNIT quaternion. */
export const qInv = (q: Q): Q => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
export function qNorm(q: Q): Q {
  const l = Math.hypot(q.x, q.y, q.z, q.w);
  return l < 1e-12 ? qIdentity() : { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}
export function qFromAxisAngle(axis: V3, rad: number): Q {
  const a = vNorm(axis);
  const s = Math.sin(rad / 2);
  return { x: a.x * s, y: a.y * s, z: a.z * s, w: Math.cos(rad / 2) };
}
export function qRotate(q: Q, v: V3): V3 {
  // v' = v + 2w(u×v) + 2u×(u×v), u = q.xyz
  const u = { x: q.x, y: q.y, z: q.z };
  const t = vScale(vCross(u, v), 2);
  return vAdd(vAdd(v, vScale(t, q.w)), vCross(u, t));
}
/** |dot| of two unit quaternions: 1 means the same rotation (q and -q are the same rotation). */
export const qSimilarity = (a: Q, b: Q): number => Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);

/** Row-major 3x3 rotation matrix of a unit quaternion. */
export function qToMat(q: Q): number[] {
  const { x, y, z, w } = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/** Quaternion of the rotation whose columns (images of the local X, Y, Z axes) are the given orthonormal vectors. */
export function qFromBasis(xa: V3, ya: V3, za: V3): Q {
  const m00 = xa.x, m10 = xa.y, m20 = xa.z;
  const m01 = ya.x, m11 = ya.y, m21 = ya.z;
  const m02 = za.x, m12 = za.y, m22 = za.z;
  const tr = m00 + m11 + m22;
  let q: Q;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = { w: 0.25 * s, x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s };
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = { w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s };
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = { w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s };
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s };
  }
  return qNorm(q);
}

const AX = { x: 1, y: 0, z: 0 };
const AY = { x: 0, y: 1, z: 0 };
const AZ = { x: 0, y: 0, z: 1 };

/**
 * Euler (degrees) -> quaternion.
 *  'YXZ': R = Ry·Rx·Rz  (yaw outermost; used by the pelvis/root so "turn" is about the vertical axis)
 *  'XZY': R = Rx·Rz·Ry  (twist about the bone's own Y axis is innermost; used by limbs, spine, neck, head)
 */
export function eulerToQuat(e: Euler, order: EulerOrder): Q {
  const qx = qFromAxisAngle(AX, e.x * DEG);
  const qy = qFromAxisAngle(AY, e.y * DEG);
  const qz = qFromAxisAngle(AZ, e.z * DEG);
  return order === 'YXZ' ? qMul(qy, qMul(qx, qz)) : qMul(qx, qMul(qz, qy));
}

const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));

/** Quaternion -> Euler degrees for the given order. At gimbal lock the free angle is assigned to Y (or X for XZY). */
export function quatToEuler(q: Q, order: EulerOrder): Euler {
  const m = qToMat(qNorm(q));
  const [m11, m12, m13, m21, m22, m23, m31, m32, m33] = m as [number, number, number, number, number, number, number, number, number];
  let x: number, y: number, z: number;
  if (order === 'YXZ') {
    x = Math.asin(-clamp1(m23));
    if (Math.abs(m23) < 0.9999999) {
      y = Math.atan2(m13, m33);
      z = Math.atan2(m21, m22);
    } else {
      y = Math.atan2(-m31, m11);
      z = 0;
    }
  } else {
    z = Math.asin(-clamp1(m12));
    if (Math.abs(m12) < 0.9999999) {
      x = Math.atan2(m32, m22);
      y = Math.atan2(m13, m11);
    } else {
      const s = m12 < 0 ? 1 : -1; // sin(z)
      x = Math.atan2(s * m31, s * m21);
      y = 0;
    }
  }
  const clean = (r: number): number => {
    const d = r * RAD;
    return Math.abs(d) < 1e-9 ? 0 : d;
  };
  return { x: clean(x), y: clean(y), z: clean(z) };
}
