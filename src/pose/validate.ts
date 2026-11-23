import { CAMERA_LIMITS } from './camera.ts';
import { PROPORTION_RANGES } from './skeleton.ts';
import type { Proportions } from './skeleton.ts';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate untrusted proportions data (project files). Returns error strings; empty = valid. */
export function validateProportions(p: unknown, where = 'proportions'): string[] {
  if (!isRec(p)) return [`${where}: must be an object.`];
  const errors: string[] = [];
  for (const k of Object.keys(PROPORTION_RANGES) as (keyof Proportions)[]) {
    const v = p[k];
    const r = PROPORTION_RANGES[k];
    if (!isNum(v) || v < r.min - 1e-9 || v > r.max + 1e-9) errors.push(`${where}.${k}: must be a number from ${r.min} to ${r.max}.`);
  }
  return errors;
}

/** Validate untrusted camera data. */
export function validateCamera(c: unknown, where = 'camera'): string[] {
  if (!isRec(c)) return [`${where}: must be an object.`];
  const errors: string[] = [];
  if (!isNum(c.azimuth) || c.azimuth < -360 || c.azimuth > 360) errors.push(`${where}.azimuth: must be a number from -360 to 360.`);
  if (!isNum(c.elevation) || c.elevation < CAMERA_LIMITS.elevation.min || c.elevation > CAMERA_LIMITS.elevation.max) errors.push(`${where}.elevation: out of range.`);
  if (!isNum(c.distance) || c.distance < CAMERA_LIMITS.distance.min || c.distance > CAMERA_LIMITS.distance.max) errors.push(`${where}.distance: out of range.`);
  if (!isNum(c.fov) || c.fov < CAMERA_LIMITS.fov.min || c.fov > CAMERA_LIMITS.fov.max) errors.push(`${where}.fov: out of range.`);
  const t = c.target;
  if (!isRec(t) || !isNum(t.x) || !isNum(t.y) || !isNum(t.z)) errors.push(`${where}.target: must be {x, y, z} numbers.`);
  return errors;
}
