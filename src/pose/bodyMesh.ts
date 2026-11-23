import type { JointId } from './skeleton.ts';
import type { WorldPose } from './pose.ts';
import { qInv, qToMat } from './vec.ts';

/** `normal` is the full model; `draft` is a decimated copy (used when many candidates are scored, e.g. fitting to a drawing). */
export type BodyQuality = 'draft' | 'normal' | 'high';

/** Joints that carry skin: a vertex is moved by the world transforms of these joints. */
export const SKIN_JOINTS = [
  'pelvis', 'spine', 'chest', 'neck', 'head',
  'clavicleL', 'shoulderL', 'elbowL', 'wristL',
  'clavicleR', 'shoulderR', 'elbowR', 'wristR',
  'hipL', 'kneeL', 'ankleL',
  'hipR', 'kneeR', 'ankleR',
] as const satisfies readonly JointId[];
export type SkinJointId = (typeof SKIN_JOINTS)[number];
export const SKIN_INDEX: Record<SkinJointId, number> = Object.fromEntries(SKIN_JOINTS.map((j, i) => [j, i])) as Record<SkinJointId, number>;

/**
 * The skinned character body: the model's surface in its bind pose plus, for every vertex, up to four skin joints and weights.
 * `skinBody` moves it into any pose from the pure FK result. `skinScale` is the per-joint size of the body (length along the
 * bone and thickness around it), so the same mesh can be made taller, wider or thicker to match a character.
 */
export interface BodyMesh {
  /** Bind-pose vertex data. */
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** 4 entries per vertex: index into SKIN_JOINTS and its weight (weights sum to 1). */
  skinJoints: Uint8Array;
  skinWeights: Float32Array;
  /** -1 (character's right side) … +1 (left side). Used only to tint the clay look. */
  side: Float32Array;
  /** The pose (joint positions and bone frames) the mesh was modelled in. */
  bind: WorldPose;
  /** 3 per skin joint: scale along the joint's local X, Y, Z (its rest frame). 1 = as modelled. */
  skinScale: Float64Array;
  vertexCount: number;
  /** Bind-pose bounds. */
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/** Per-joint affine transform taking a bind-pose point to the posed body: p' = M·p + t (and n' ∝ N·n for normals). */
export interface SkinTransform {
  r: Float64Array; // 9 per skin joint (row-major)
  n: Float64Array; // 9 per skin joint: normal matrix
  t: Float64Array; // 3 per skin joint
}

const mat3mul = (a: ArrayLike<number>, b: ArrayLike<number>): number[] => {
  const o = new Array<number>(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  return o;
};

/** M = R_world · S · R_bind⁻¹ about each joint, so a bone keeps its modelled shape while it is moved, posed and scaled. */
export function skinTransforms(bind: WorldPose, world: WorldPose, scale?: ArrayLike<number>): SkinTransform {
  const nj = SKIN_JOINTS.length;
  const r = new Float64Array(nj * 9);
  const nm = new Float64Array(nj * 9);
  const t = new Float64Array(nj * 3);
  SKIN_JOINTS.forEach((id, i) => {
    const rw = qToMat(world[id].rotation);
    const rbT = qToMat(qInv(bind[id].rotation));
    const sx = scale?.[i * 3] ?? 1, sy = scale?.[i * 3 + 1] ?? 1, sz = scale?.[i * 3 + 2] ?? 1;
    const S = [sx, 0, 0, 0, sy, 0, 0, 0, sz];
    const Si = [1 / sx, 0, 0, 0, 1 / sy, 0, 0, 0, 1 / sz];
    const m = mat3mul(mat3mul(rw, S), rbT);
    const nn = mat3mul(mat3mul(rw, Si), rbT);
    for (let c = 0; c < 9; c++) {
      r[i * 9 + c] = m[c]!;
      nm[i * 9 + c] = nn[c]!;
    }
    const b = bind[id].position;
    t[i * 3] = world[id].position.x - (m[0]! * b.x + m[1]! * b.y + m[2]! * b.z);
    t[i * 3 + 1] = world[id].position.y - (m[3]! * b.x + m[4]! * b.y + m[5]! * b.z);
    t[i * 3 + 2] = world[id].position.z - (m[6]! * b.x + m[7]! * b.y + m[8]! * b.z);
  });
  return { r, n: nm, t };
}

/** Linear-blend skinning. Writes posed positions (and, if given, normals) into the output arrays. */
export function skinBody(mesh: BodyMesh, world: WorldPose, outPos: Float32Array, outNor?: Float32Array): void {
  const { r, n, t } = skinTransforms(mesh.bind, world, mesh.skinScale);
  const { positions: P, normals: N, skinJoints: SJ, skinWeights: SW } = mesh;
  for (let v = 0; v < mesh.vertexCount; v++) {
    const px = P[v * 3]!, py = P[v * 3 + 1]!, pz = P[v * 3 + 2]!;
    let ox = 0, oy = 0, oz = 0, nx = 0, ny = 0, nz = 0;
    const gx = N[v * 3]!, gy = N[v * 3 + 1]!, gz = N[v * 3 + 2]!;
    for (let q = 0; q < 4; q++) {
      const w = SW[v * 4 + q]!;
      if (w === 0) continue;
      const j = SJ[v * 4 + q]!;
      const b = j * 9;
      ox += w * (r[b]! * px + r[b + 1]! * py + r[b + 2]! * pz + t[j * 3]!);
      oy += w * (r[b + 3]! * px + r[b + 4]! * py + r[b + 5]! * pz + t[j * 3 + 1]!);
      oz += w * (r[b + 6]! * px + r[b + 7]! * py + r[b + 8]! * pz + t[j * 3 + 2]!);
      if (outNor) {
        nx += w * (n[b]! * gx + n[b + 1]! * gy + n[b + 2]! * gz);
        ny += w * (n[b + 3]! * gx + n[b + 4]! * gy + n[b + 5]! * gz);
        nz += w * (n[b + 6]! * gx + n[b + 7]! * gy + n[b + 8]! * gz);
      }
    }
    outPos[v * 3] = ox; outPos[v * 3 + 1] = oy; outPos[v * 3 + 2] = oz;
    if (outNor) {
      const l = Math.hypot(nx, ny, nz) || 1;
      outNor[v * 3] = nx / l; outNor[v * 3 + 1] = ny / l; outNor[v * 3 + 2] = nz / l;
    }
  }
}
