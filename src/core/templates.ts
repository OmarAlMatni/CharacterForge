import { sub } from './math.ts';
import type { Vec2 } from './math.ts';
import type { ID, Joint } from './types.ts';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Spec {
  key: string;
  name: string;
  parent: string | null;
  /** Position as fractions of the bounds: [fx, fy] where (0,0) = top-left, (1,1) = bottom-right. */
  at: [number, number];
}

/**
 * Rough standing-humanoid skeleton scaled to the artwork's bounds. It is a starting point: the
 * artist is expected to drag every joint onto the right place. "L"/"R" refer to screen left/right.
 */
const HUMANOID: Spec[] = [
  { key: 'hips', name: 'Hips', parent: null, at: [0.5, 0.52] },
  { key: 'chest', name: 'Chest', parent: 'hips', at: [0.5, 0.36] },
  { key: 'neck', name: 'Neck', parent: 'chest', at: [0.5, 0.22] },
  { key: 'head', name: 'Head', parent: 'neck', at: [0.5, 0.14] },
  { key: 'shoulderL', name: 'Shoulder L', parent: 'chest', at: [0.36, 0.25] },
  { key: 'elbowL', name: 'Elbow L', parent: 'shoulderL', at: [0.32, 0.39] },
  { key: 'wristL', name: 'Wrist L', parent: 'elbowL', at: [0.3, 0.52] },
  { key: 'shoulderR', name: 'Shoulder R', parent: 'chest', at: [0.64, 0.25] },
  { key: 'elbowR', name: 'Elbow R', parent: 'shoulderR', at: [0.68, 0.39] },
  { key: 'wristR', name: 'Wrist R', parent: 'elbowR', at: [0.7, 0.52] },
  { key: 'hipL', name: 'Hip L', parent: 'hips', at: [0.44, 0.52] },
  { key: 'kneeL', name: 'Knee L', parent: 'hipL', at: [0.43, 0.72] },
  { key: 'ankleL', name: 'Ankle L', parent: 'kneeL', at: [0.43, 0.93] },
  { key: 'hipR', name: 'Hip R', parent: 'hips', at: [0.56, 0.52] },
  { key: 'kneeR', name: 'Knee R', parent: 'hipR', at: [0.57, 0.72] },
  { key: 'ankleR', name: 'Ankle R', parent: 'kneeR', at: [0.57, 0.93] },
];

export function humanoidJoints(bounds: Bounds, makeId: (key: string) => ID): Joint[] {
  const ids = new Map<string, ID>(HUMANOID.map((s) => [s.key, makeId(s.key)]));
  const world = new Map<string, Vec2>(
    HUMANOID.map((s) => [s.key, { x: bounds.x + s.at[0] * bounds.width, y: bounds.y + s.at[1] * bounds.height }]),
  );
  return HUMANOID.map((s) => {
    const parentPos = s.parent ? world.get(s.parent)! : { x: 0, y: 0 };
    return {
      id: ids.get(s.key)!,
      name: s.name,
      parentId: s.parent ? ids.get(s.parent)! : null,
      offset: sub(world.get(s.key)!, parentPos),
      limits: null,
      bend: 0,
    };
  });
}
