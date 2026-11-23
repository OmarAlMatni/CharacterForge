import type { Proportions } from './skeleton.ts';
import { DEFAULT_PROPORTIONS, PROPORTION_PRESETS } from './skeleton.ts';

/**
 * Body SHAPE: how thick the character is, as opposed to `Proportions`, which place the joints (lengths and widths of the frame).
 * All values are multipliers relative to the default body (1 = default). Together with `Proportions.build` (overall thickness)
 * they let an artist match their character's size, height and width.
 */
export interface BodyShape {
  /** Rib-cage / upper-torso girth. */
  chest: number;
  /** Waist girth. */
  waist: number;
  /** Hip / pelvis mass. */
  pelvis: number;
  neck: number;
  /** Upper-arm and forearm thickness. */
  arms: number;
  /** Thigh and calf thickness. */
  legs: number;
  /** Hand size. */
  hands: number;
  /** Foot size. */
  feet: number;
  /** Front-to-back thickness of the whole body (flat ↔ deep). */
  depth: number;
}

export const DEFAULT_SHAPE: BodyShape = { chest: 1, waist: 1, pelvis: 1, neck: 1, arms: 1, legs: 1, hands: 1, feet: 1, depth: 1 };

export const SHAPE_RANGES: Record<keyof BodyShape, { min: number; max: number; step: number; label: string }> = {
  chest: { min: 0.6, max: 1.6, step: 0.01, label: 'Chest' },
  waist: { min: 0.6, max: 1.6, step: 0.01, label: 'Waist' },
  pelvis: { min: 0.6, max: 1.6, step: 0.01, label: 'Hips / pelvis' },
  neck: { min: 0.6, max: 1.6, step: 0.01, label: 'Neck' },
  arms: { min: 0.6, max: 1.6, step: 0.01, label: 'Arm thickness' },
  legs: { min: 0.6, max: 1.6, step: 0.01, label: 'Leg thickness' },
  hands: { min: 0.6, max: 1.6, step: 0.01, label: 'Hand size' },
  feet: { min: 0.6, max: 1.6, step: 0.01, label: 'Foot size' },
  depth: { min: 0.6, max: 1.6, step: 0.01, label: 'Front-back depth' },
};

export const SHAPE_KEYS = Object.keys(DEFAULT_SHAPE) as (keyof BodyShape)[];

export function clampShape(s: Partial<BodyShape> | undefined | null): BodyShape {
  const out = { ...DEFAULT_SHAPE };
  for (const k of SHAPE_KEYS) {
    const v = s?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(SHAPE_RANGES[k].max, Math.max(SHAPE_RANGES[k].min, v));
  }
  return out;
}

export const shapesEqual = (a: BodyShape, b: BodyShape, eps = 1e-9): boolean => SHAPE_KEYS.every((k) => Math.abs(a[k] - b[k]) <= eps);

/** Validate untrusted shape data (project files). Returns error strings; empty = valid. */
export function validateShape(s: unknown, where = 'shape'): string[] {
  if (typeof s !== 'object' || s === null || Array.isArray(s)) return [`${where}: must be an object.`];
  const rec = s as Record<string, unknown>;
  const errors: string[] = [];
  for (const k of SHAPE_KEYS) {
    const v = rec[k];
    const r = SHAPE_RANGES[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < r.min - 1e-9 || v > r.max + 1e-9) errors.push(`${where}.${k}: must be a number from ${r.min} to ${r.max}.`);
  }
  return errors;
}

export interface BodyPreset {
  id: string;
  label: string;
  proportions: Proportions;
  shape: BodyShape;
}

const shapeOf = (p: Partial<BodyShape>): BodyShape => clampShape(p);
const propsOf = (id: string): Proportions => ({ ...PROPORTION_PRESETS.find((x) => x.id === id)!.value });

/** Starting points for common manga builds. They are only presets: every value stays adjustable. */
export const BODY_PRESETS: BodyPreset[] = [
  { id: 'default', label: 'Default (model proportions)', proportions: { ...DEFAULT_PROPORTIONS }, shape: { ...DEFAULT_SHAPE } },
  { id: 'tall-hero', label: 'Tall hero', proportions: propsOf('shonen-tall'), shape: shapeOf({ chest: 1.12, waist: 1.02, arms: 1.1, legs: 1.05 }) },
  { id: 'slender', label: 'Slender', proportions: propsOf('slender'), shape: shapeOf({ chest: 0.92, waist: 0.9, pelvis: 0.95, arms: 0.85, legs: 0.88, neck: 0.9 }) },
  { id: 'sturdy', label: 'Sturdy', proportions: { height: 1.72, legs: 0.96, torso: 1.05, arms: 1, shoulders: 1.2, hips: 1.1, head: 0.95, build: 1.15 }, shape: shapeOf({ chest: 1.15, waist: 1.15, pelvis: 1.1, neck: 1.2, arms: 1.15, legs: 1.12, hands: 1.1 }) },
  { id: 'chibi', label: 'Chibi-ish (3 heads)', proportions: propsOf('chibi'), shape: shapeOf({ hands: 1.15, feet: 1.15 }) },
];
