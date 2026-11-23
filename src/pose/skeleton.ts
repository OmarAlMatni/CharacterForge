import type { Euler, EulerOrder, V3 } from './vec.ts';

/**
 * Humanoid pose-guide skeleton: definition (topology, joint types, limits) and proportions.
 * Conventions: Y up, the mannequin faces +Z, the character's LEFT side is +X.
 * In the neutral stance every joint has identity rotation and arms/legs hang straight down (-Y).
 */
export const JOINT_IDS = [
  'pelvis', 'spine', 'chest', 'neck', 'head', 'headTop',
  'clavicleL', 'shoulderL', 'elbowL', 'wristL', 'handL',
  'clavicleR', 'shoulderR', 'elbowR', 'wristR', 'handR',
  'hipL', 'kneeL', 'ankleL', 'toeL',
  'hipR', 'kneeR', 'ankleR', 'toeR',
] as const;
export type JointId = (typeof JOINT_IDS)[number];

export const isJointId = (s: string): s is JointId => (JOINT_IDS as readonly string[]).includes(s);

export type Side = 'L' | 'R' | 'C';
export type JointKind = 'root' | 'ball' | 'hinge' | 'end';

export interface AxisRange {
  min: number;
  max: number;
}
export interface JointLimits {
  x: AxisRange;
  y: AxisRange;
  z: AxisRange;
}
export interface JointDef {
  id: JointId;
  parent: JointId | null;
  label: string;
  side: Side;
  kind: JointKind;
  order: EulerOrder;
  limits: JointLimits;
}

const FREE: AxisRange = { min: -180, max: 180 };
const LOCK: AxisRange = { min: 0, max: 0 };
const r = (min: number, max: number): AxisRange => ({ min, max });
const lim = (x: AxisRange, y: AxisRange, z: AxisRange): JointLimits => ({ x, y, z });

/** Mirror a range across the sagittal plane: rotations about Y and Z change sign on the other side. */
const flip = (a: AxisRange): AxisRange => ({ min: -a.max, max: -a.min });

function limbPair(base: Omit<JointDef, 'id' | 'parent' | 'side' | 'label' | 'limits'> & { limits: JointLimits }, idL: JointId, idR: JointId, parentL: JointId, parentR: JointId, label: string): JointDef[] {
  const mirrored = lim(base.limits.x, flip(base.limits.y), flip(base.limits.z));
  return [
    { ...base, id: idL, parent: parentL, side: 'L', label: `${label} (L)` },
    { ...base, id: idR, parent: parentR, side: 'R', label: `${label} (R)`, limits: mirrored },
  ];
}

export const JOINT_DEFS: JointDef[] = [
  { id: 'pelvis', parent: null, label: 'Pelvis / body', side: 'C', kind: 'root', order: 'YXZ', limits: lim(FREE, FREE, FREE) },
  { id: 'spine', parent: 'pelvis', label: 'Waist', side: 'C', kind: 'ball', order: 'XZY', limits: lim(r(-40, 60), r(-60, 60), r(-35, 35)) },
  { id: 'chest', parent: 'spine', label: 'Chest', side: 'C', kind: 'ball', order: 'XZY', limits: lim(r(-30, 45), r(-45, 45), r(-25, 25)) },
  { id: 'neck', parent: 'chest', label: 'Neck', side: 'C', kind: 'ball', order: 'XZY', limits: lim(r(-40, 45), r(-60, 60), r(-30, 30)) },
  { id: 'head', parent: 'neck', label: 'Head', side: 'C', kind: 'ball', order: 'XZY', limits: lim(r(-40, 50), r(-70, 70), r(-35, 35)) },
  { id: 'headTop', parent: 'head', label: 'Head top', side: 'C', kind: 'end', order: 'XZY', limits: lim(LOCK, LOCK, LOCK) },
  ...limbPair({ kind: 'ball', order: 'XZY', limits: lim(r(-10, 10), r(-20, 20), r(-15, 25)) }, 'clavicleL', 'clavicleR', 'chest', 'chest', 'Collar'),
  ...limbPair({ kind: 'ball', order: 'XZY', limits: lim(FREE, FREE, FREE) }, 'shoulderL', 'shoulderR', 'clavicleL', 'clavicleR', 'Shoulder'),
  ...limbPair({ kind: 'hinge', order: 'XZY', limits: lim(r(-150, 0), r(-90, 90), LOCK) }, 'elbowL', 'elbowR', 'shoulderL', 'shoulderR', 'Elbow'),
  ...limbPair({ kind: 'ball', order: 'XZY', limits: lim(r(-70, 70), LOCK, r(-30, 30)) }, 'wristL', 'wristR', 'elbowL', 'elbowR', 'Wrist'),
  ...limbPair({ kind: 'end', order: 'XZY', limits: lim(LOCK, LOCK, LOCK) }, 'handL', 'handR', 'wristL', 'wristR', 'Hand tip'),
  ...limbPair({ kind: 'ball', order: 'XZY', limits: lim(r(-130, 35), r(-45, 45), r(-35, 70)) }, 'hipL', 'hipR', 'pelvis', 'pelvis', 'Hip'),
  ...limbPair({ kind: 'hinge', order: 'XZY', limits: lim(r(0, 150), LOCK, LOCK) }, 'kneeL', 'kneeR', 'hipL', 'hipR', 'Knee'),
  ...limbPair({ kind: 'ball', order: 'XZY', limits: lim(r(-40, 50), r(-30, 30), r(-25, 25)) }, 'ankleL', 'ankleR', 'kneeL', 'kneeR', 'Ankle'),
  ...limbPair({ kind: 'end', order: 'XZY', limits: lim(LOCK, LOCK, LOCK) }, 'toeL', 'toeR', 'ankleL', 'ankleR', 'Toe tip'),
];

/** Joints in an order where every parent precedes its children. */
export const ORDERED_DEFS: JointDef[] = (() => {
  const out: JointDef[] = [];
  const seen = new Set<JointId>();
  const visit = (id: JointId) => {
    if (seen.has(id)) return;
    const d = JOINT_DEFS.find((j) => j.id === id)!;
    if (d.parent) visit(d.parent);
    seen.add(id);
    out.push(d);
  };
  JOINT_IDS.forEach(visit);
  return out;
})();

const DEF_BY_ID = new Map<JointId, JointDef>(JOINT_DEFS.map((d) => [d.id, d]));
export const jointDef = (id: JointId): JointDef => DEF_BY_ID.get(id)!;

/** Joints whose rotation the user can edit. */
export const POSABLE_JOINTS: JointId[] = JOINT_DEFS.filter((d) => d.kind !== 'end').map((d) => d.id);

export const MIRROR: Record<JointId, JointId> = Object.fromEntries(
  JOINT_IDS.map((id) => [id, (id.endsWith('L') ? id.slice(0, -1) + 'R' : id.endsWith('R') ? id.slice(0, -1) + 'L' : id) as JointId]),
) as Record<JointId, JointId>;

// ---------------------------------------------------------------- proportions

/** Body proportions. All multipliers are relative to the default mannequin (1 = default). */
export interface Proportions {
  /** Overall standing height in scene units (default 1.7). */
  height: number;
  legs: number;
  torso: number;
  arms: number;
  /** Shoulder width. */
  shoulders: number;
  /** Hip width. */
  hips: number;
  /** Head size. */
  head: number;
  /** Limb/body thickness (rendering only; does not move joints). */
  build: number;
}

export const DEFAULT_PROPORTIONS: Proportions = { height: 1.7, legs: 1, torso: 1, arms: 1, shoulders: 1, hips: 1, head: 1, build: 1 };

export const PROPORTION_RANGES: Record<keyof Proportions, { min: number; max: number; step: number; label: string }> = {
  height: { min: 1.2, max: 2.4, step: 0.01, label: 'Height' },
  legs: { min: 0.75, max: 1.3, step: 0.01, label: 'Leg length' },
  torso: { min: 0.75, max: 1.3, step: 0.01, label: 'Torso length' },
  arms: { min: 0.75, max: 1.3, step: 0.01, label: 'Arm length' },
  shoulders: { min: 0.6, max: 1.5, step: 0.01, label: 'Shoulder width' },
  hips: { min: 0.6, max: 1.5, step: 0.01, label: 'Hip width' },
  head: { min: 0.7, max: 1.5, step: 0.01, label: 'Head size' },
  build: { min: 0.6, max: 1.6, step: 0.01, label: 'Build / thickness' },
};

/** Manga-style presets. */
export const PROPORTION_PRESETS: { id: string; label: string; value: Proportions }[] = [
  { id: 'default', label: 'Default (7.5 heads)', value: { ...DEFAULT_PROPORTIONS } },
  { id: 'shonen-tall', label: 'Tall hero', value: { height: 1.85, legs: 1.1, torso: 1, arms: 1.05, shoulders: 1.15, hips: 1, head: 0.9, build: 1.1 } },
  { id: 'slender', label: 'Slender', value: { height: 1.68, legs: 1.12, torso: 0.95, arms: 1.02, shoulders: 0.88, hips: 0.95, head: 0.92, build: 0.85 } },
  { id: 'chibi', label: 'Chibi-ish (3 heads)', value: { height: 1.2, legs: 0.78, torso: 0.8, arms: 0.8, shoulders: 0.8, hips: 0.85, head: 1.5, build: 1.2 } },
  { id: 'child', label: 'Child', value: { height: 1.3, legs: 0.9, torso: 0.9, arms: 0.9, shoulders: 0.75, hips: 0.8, head: 1.3, build: 0.9 } },
];

export function clampProportions(p: Partial<Proportions> | undefined): Proportions {
  const out = { ...DEFAULT_PROPORTIONS };
  for (const k of Object.keys(DEFAULT_PROPORTIONS) as (keyof Proportions)[]) {
    const v = p?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(PROPORTION_RANGES[k].max, Math.max(PROPORTION_RANGES[k].min, v));
  }
  return out;
}

/**
 * Base segment table for a 1.7-unit figure. These are the proportions of the bundled character model (an anime-style base
 * mesh, see `bodyModel.ts`), measured from its joint table and scaled to 1.7 m, so that the default skeleton fits the model
 * without stretching and the Height / Legs / Torso / Arms sliders scale it from there. A test keeps the two in step.
 */
const BASE = {
  hipDrop: 0.0557, // pelvis centre -> hip joint (vertical)
  hipHalfWidth: 0.1183,
  thigh: 0.3952,
  shin: 0.3136,
  ankleHeight: 0.0978,
  footLength: 0.2004, // ankle -> toe tip (forward)
  toeDrop: 0.0835, // ankle -> toe tip (vertical, down)
  pelvisToSpine: 0.1393,
  spineToChest: 0.167,
  chestToNeck: 0.2514,
  chestToClavicle: 0.174,
  shoulderHalfWidth: 0.1809,
  shoulderDrop: 0.0237,
  neckToHead: 0.0626,
  headHeight: 0.2174, // head joint -> top of head
  upperArm: 0.2121,
  foreArm: 0.2173,
  hand: 0.1631,
};
/** Height of the ankle joint above the sole at rest, for a 1.7 m figure (the sole is this far below the ankle). */
export const ANKLE_HEIGHT = BASE.ankleHeight;

export interface RestSkeleton {
  proportions: Proportions;
  /** Rest offset of each joint from its parent, in the parent's frame (pelvis: its rest position in the world). */
  offsets: Record<JointId, V3>;
  /** Length of each bone (distance from parent joint to this joint). */
  boneLength: Record<JointId, number>;
  /** Standing height of the top of the head. */
  restHeight: number;
  /** Rendering scale values (radii etc.). */
  scale: { k: number; head: number; build: number };
}

/** Rest-pose offsets for the given proportions. Pure and deterministic. */
export function buildRestSkeleton(input?: Partial<Proportions>): RestSkeleton {
  const p = clampProportions(input);
  const k = p.height / 1.7;
  const L = p.legs * k;
  const T = p.torso * k;
  const A = p.arms * k;
  const sw = p.shoulders * k;
  const hw = p.hips * k;
  const H = p.head * k;
  const g = k; // unscaled-by-group sizes follow height only
  const pelvisY = BASE.hipDrop * g + (BASE.thigh + BASE.shin) * L + BASE.ankleHeight * g;
  const o = {} as Record<JointId, V3>;
  const set = (id: JointId, x: number, y: number, z: number) => (o[id] = { x, y, z });
  set('pelvis', 0, pelvisY, 0);
  set('spine', 0, BASE.pelvisToSpine * T, 0);
  set('chest', 0, BASE.spineToChest * T, 0);
  set('neck', 0, BASE.chestToNeck * T, 0);
  set('head', 0, BASE.neckToHead * g, 0);
  set('headTop', 0, BASE.headHeight * H, 0);
  for (const [s, sign] of [['L', 1], ['R', -1]] as const) {
    set(`clavicle${s}`, 0, BASE.chestToClavicle * T, 0);
    set(`shoulder${s}`, sign * BASE.shoulderHalfWidth * sw, -BASE.shoulderDrop * g, 0);
    set(`elbow${s}`, 0, -BASE.upperArm * A, 0);
    set(`wrist${s}`, 0, -BASE.foreArm * A, 0);
    set(`hand${s}`, 0, -BASE.hand * A, 0);
    set(`hip${s}`, sign * BASE.hipHalfWidth * hw, -BASE.hipDrop * g, 0);
    set(`knee${s}`, 0, -BASE.thigh * L, 0);
    set(`ankle${s}`, 0, -BASE.shin * L, 0);
    set(`toe${s}`, 0, -BASE.toeDrop * g, BASE.footLength * g);
  }
  const boneLength = {} as Record<JointId, number>;
  for (const id of JOINT_IDS) boneLength[id] = id === 'pelvis' ? 0 : Math.hypot(o[id].x, o[id].y, o[id].z);
  const restHeight = pelvisY + o.spine.y + o.chest.y + o.neck.y + o.head.y + o.headTop.y;
  return { proportions: p, offsets: o, boneLength, restHeight, scale: { k, head: H, build: p.build } };
}

export const zeroEuler = (): Euler => ({ x: 0, y: 0, z: 0 });
