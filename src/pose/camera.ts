import type { V3 } from './vec.ts';
import { DEG, vCross, vDot, vNorm, vScale, vSub, vAdd } from './vec.ts';

/**
 * Orbit camera. azimuth 0 / elevation 0 looks at the mannequin from the front (camera on +Z, mannequin faces +Z).
 * Positive azimuth moves the camera towards +X (the character's left side). Positive elevation raises the camera.
 */
export interface CameraState {
  azimuth: number;
  elevation: number;
  distance: number;
  /** Vertical field of view in degrees. */
  fov: number;
  target: V3;
}

export const DEFAULT_CAMERA: CameraState = { azimuth: 0, elevation: 8, distance: 4.2, fov: 30, target: { x: 0, y: 0.9, z: 0 } };

export const CAMERA_LIMITS = { elevation: { min: -85, max: 85 }, distance: { min: 0.5, max: 30 }, fov: { min: 10, max: 80 } } as const;

export function clampCamera(c: CameraState): CameraState {
  const wrap = ((c.azimuth + 180) % 360 + 360) % 360 - 180;
  return {
    azimuth: wrap,
    elevation: Math.min(CAMERA_LIMITS.elevation.max, Math.max(CAMERA_LIMITS.elevation.min, c.elevation)),
    distance: Math.min(CAMERA_LIMITS.distance.max, Math.max(CAMERA_LIMITS.distance.min, c.distance)),
    fov: Math.min(CAMERA_LIMITS.fov.max, Math.max(CAMERA_LIMITS.fov.min, c.fov)),
    target: { ...c.target },
  };
}

export function cameraPosition(c: CameraState): V3 {
  const az = c.azimuth * DEG;
  const el = c.elevation * DEG;
  return vAdd(c.target, { x: c.distance * Math.sin(az) * Math.cos(el), y: c.distance * Math.sin(el), z: c.distance * Math.cos(az) * Math.cos(el) });
}

export interface CameraBasis {
  position: V3;
  forward: V3;
  right: V3;
  up: V3;
}

export function cameraBasis(c: CameraState): CameraBasis {
  const position = cameraPosition(c);
  const forward = vNorm(vSub(c.target, position), { x: 0, y: 0, z: -1 });
  const right = vNorm(vCross(forward, { x: 0, y: 1, z: 0 }), { x: 1, y: 0, z: 0 });
  const up = vCross(right, forward);
  return { position, forward, right, up };
}

export interface Projected {
  /** Pixel coordinates, origin top-left. */
  x: number;
  y: number;
  /** Distance along the view direction (>0 = in front of the camera). */
  depth: number;
  /** Normalised device coordinates (-1..1, +y up). */
  ndcX: number;
  ndcY: number;
}

/** Perspective projection identical to a Three.js PerspectiveCamera built from the same state. */
export function projectPoint(c: CameraState, width: number, height: number, p: V3): Projected {
  const b = cameraBasis(c);
  const v = vSub(p, b.position);
  const depth = vDot(v, b.forward);
  const t = Math.tan((c.fov * DEG) / 2);
  const aspect = width / height;
  const safe = Math.max(depth, 1e-6);
  const ndcX = vDot(v, b.right) / safe / (t * aspect);
  const ndcY = vDot(v, b.up) / safe / t;
  return { x: (ndcX * 0.5 + 0.5) * width, y: (1 - (ndcY * 0.5 + 0.5)) * height, depth, ndcX, ndcY };
}

/** Choose the closest distance (and centre) at which all points sit inside the frame with a margin. Deterministic. */
export function frameCamera(base: CameraState, points: V3[], aspect: number, margin = 0.08): CameraState {
  if (!points.length) return base;
  const lo = { x: Infinity, y: Infinity, z: Infinity };
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of points) {
    lo.x = Math.min(lo.x, p.x); lo.y = Math.min(lo.y, p.y); lo.z = Math.min(lo.z, p.z);
    hi.x = Math.max(hi.x, p.x); hi.y = Math.max(hi.y, p.y); hi.z = Math.max(hi.z, p.z);
  }
  const target = vScale(vAdd(lo, hi), 0.5);
  const limit = 1 - margin;
  const fits = (distance: number): boolean => {
    const cam = { ...base, target, distance };
    return points.every((p) => {
      const q = projectPoint(cam, 1000 * aspect, 1000, p);
      return q.depth > 0.05 && Math.abs(q.ndcX) <= limit && Math.abs(q.ndcY) <= limit;
    });
  };
  let a = 0.3;
  let b = 200;
  for (let i = 0; i < 60; i++) {
    const m = (a + b) / 2;
    if (fits(m)) b = m;
    else a = m;
  }
  return clampCamera({ ...base, target, distance: b });
}

export const VIEW_PRESETS: { id: string; label: string; azimuth: number; elevation: number }[] = [
  { id: 'front', label: 'Front', azimuth: 0, elevation: 8 },
  { id: 'three-quarter-left', label: '3/4 left', azimuth: 40, elevation: 10 },
  { id: 'three-quarter-right', label: '3/4 right', azimuth: -40, elevation: 10 },
  { id: 'side-left', label: 'Side (left)', azimuth: 90, elevation: 5 },
  { id: 'side-right', label: 'Side (right)', azimuth: -90, elevation: 5 },
  { id: 'back', label: 'Back', azimuth: 180, elevation: 8 },
  { id: 'low', label: 'Low angle', azimuth: 20, elevation: -25 },
  { id: 'high', label: 'High angle', azimuth: 20, elevation: 40 },
];
