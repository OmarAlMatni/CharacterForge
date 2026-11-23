import { angleDeg, fromTRS, len, mul, normalizeDeg, rotateVec, translation } from './math.ts';
import type { Mat, Transform, Vec2 } from './math.ts';
import type { ID, Joint, Layer, PoseState } from './types.ts';

export interface JointFrame {
  /** World (canvas) position of the joint. */
  pos: Vec2;
  /** World rotation of the joint's frame, degrees (unnormalised sum along the chain). */
  rot: number;
}

export const REST: PoseState = { rotations: {}, rootOffset: { x: 0, y: 0 } };

/** Forward kinematics: world frame of every joint for a pose. Throws on cyclic hierarchies. */
export function jointFrames(joints: Joint[], pose: PoseState): Map<ID, JointFrame> {
  const byId = new Map(joints.map((j) => [j.id, j]));
  const out = new Map<ID, JointFrame>();
  const visiting = new Set<ID>();
  const visit = (j: Joint): JointFrame => {
    const cached = out.get(j.id);
    if (cached) return cached;
    if (visiting.has(j.id)) throw new Error(`Joint hierarchy contains a cycle at "${j.name}".`);
    visiting.add(j.id);
    const rot = pose.rotations[j.id] ?? 0;
    const parent = j.parentId ? byId.get(j.parentId) : undefined;
    let frame: JointFrame;
    if (!parent) {
      frame = { pos: { x: j.offset.x + pose.rootOffset.x, y: j.offset.y + pose.rootOffset.y }, rot };
    } else {
      const pf = visit(parent);
      const o = rotateVec(j.offset, pf.rot);
      frame = { pos: { x: pf.pos.x + o.x, y: pf.pos.y + o.y }, rot: pf.rot + rot };
    }
    visiting.delete(j.id);
    out.set(j.id, frame);
    return frame;
  };
  joints.forEach(visit);
  return out;
}

export const restFrames = (joints: Joint[]): Map<ID, JointFrame> => jointFrames(joints, REST);

/**
 * Where a layer is drawn for a given pose. Unattached layers use their rest transform.
 * Attached layers move rigidly with their joint: the joint's rotation/translation is applied
 * to the layer's rest placement (no shear, no scaling).
 */
export function layerPlacement(layer: Layer, rest: Map<ID, JointFrame>, posed: Map<ID, JointFrame>): Transform {
  const t = layer.transform;
  if (!layer.jointId) return t;
  const r = rest.get(layer.jointId);
  const p = posed.get(layer.jointId);
  if (!r || !p) return t;
  const d = rotateVec({ x: t.x - r.pos.x, y: t.y - r.pos.y }, p.rot);
  return { x: p.pos.x + d.x, y: p.pos.y + d.y, rotation: t.rotation + p.rot, scaleX: t.scaleX, scaleY: t.scaleY };
}

/** Placements for every raster layer — the single source of truth for both the canvas and PNG export. */
export function computePlacements(layers: Layer[], joints: Joint[], pose: PoseState): Map<ID, Transform> {
  const rest = restFrames(joints);
  const posed = jointFrames(joints, pose);
  return new Map(layers.filter((l) => l.kind === 'raster').map((l) => [l.id, layerPlacement(l, rest, posed)]));
}

/** Pixel-space → canvas-space matrix for a layer at a given placement. */
export function placementMatrix(layer: Layer, placement: Transform): Mat {
  return mul(fromTRS(placement), translation(-layer.pivot.x, -layer.pivot.y));
}

export function clampToLimits(joint: Joint | undefined, deg: number): number {
  if (!joint?.limits) return deg;
  return Math.min(joint.limits.max, Math.max(joint.limits.min, deg));
}

export function withinLimits(joint: Joint | undefined, deg: number): boolean {
  if (!joint?.limits) return true;
  return deg >= joint.limits.min - 1e-6 && deg <= joint.limits.max + 1e-6;
}

/** Drop stale joint IDs and clamp rotations to limits. */
export function sanitizePose(joints: Joint[], pose: PoseState): PoseState {
  const byId = new Map(joints.map((j) => [j.id, j]));
  const rotations: Record<ID, number> = {};
  for (const [id, r] of Object.entries(pose.rotations)) {
    const j = byId.get(id);
    if (j && Number.isFinite(r)) rotations[id] = clampToLimits(j, normalizeDeg(r));
  }
  return { rotations, rootOffset: { ...pose.rootOffset } };
}

export function boneLength(joint: Joint): number {
  return len(joint.offset);
}

export function boneAngle(joint: Joint): number {
  return angleDeg(joint.offset);
}

