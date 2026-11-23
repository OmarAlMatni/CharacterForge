import type { Pose3D } from './pose.ts';
import { clampPose, mirrorPose, snapToGround } from './pose.ts';
import type { JointId, RestSkeleton } from './skeleton.ts';
import type { Euler } from './vec.ts';

/**
 * Predefined poses (joint rotations in degrees; see skeleton.ts for axis conventions).
 * Arms/legs hang along -Y at rest, so for the LEFT limbs:
 *   shoulder x < 0 raises the arm forward, z > 0 raises it sideways; elbow x < 0 bends the forearm forward;
 *   hip x < 0 lifts the thigh forward; knee x > 0 bends the shin backward.
 * Right-side values are produced by mirroring the left-side ones where a pose is symmetrical.
 */
export interface PosePreset {
  id: string;
  label: string;
  description: string;
  /** Rest the soles on the floor after applying. */
  grounded: boolean;
  rotations: Partial<Record<JointId, Euler>>;
  root?: { x?: number; y?: number; z?: number };
}

const e = (x = 0, y = 0, z = 0): Euler => ({ x, y, z });
/** Ankle angle that keeps the foot flat for a leg flexed in the sagittal plane. */
const flat = (hipX: number, kneeX: number): number => -(hipX + kneeX);

export const POSE_PRESETS: PosePreset[] = [
  { id: 'neutral', label: 'Neutral stand', description: 'Straight standing, arms at the sides.', grounded: true, rotations: {} },
  {
    id: 'a-pose',
    label: 'A-pose',
    description: 'Arms angled down and out. A good reference pose for character sheets.',
    grounded: true,
    rotations: { shoulderL: e(0, 0, 38), shoulderR: e(0, 0, -38), elbowL: e(-6), elbowR: e(-6) },
  },
  {
    id: 't-pose',
    label: 'T-pose',
    description: 'Arms straight out to the sides.',
    grounded: true,
    rotations: { shoulderL: e(0, 0, 90), shoulderR: e(0, 0, -90) },
  },
  {
    id: 'relaxed',
    label: 'Relaxed (contrapposto)',
    description: 'Weight on one leg, slight hip and shoulder counter-tilt.',
    grounded: true,
    rotations: {
      pelvis: e(0, 6, 4),
      spine: e(2, -3, -5),
      chest: e(0, -5, -2),
      head: e(0, 6, 2),
      shoulderL: e(0, 0, 10),
      shoulderR: e(0, 0, -12),
      elbowL: e(-14),
      elbowR: e(-18),
      hipL: e(-4, 0, 3),
      hipR: e(0, 0, -6),
      kneeL: e(8),
      ankleL: e(flat(-4, 8)),
    },
  },
  {
    id: 'walk',
    label: 'Walking',
    description: 'Mid-stride: opposite arm and leg swing.',
    grounded: true,
    rotations: {
      pelvis: e(0, 6, 0),
      chest: e(0, -9, 0),
      head: e(0, 3, 0),
      hipL: e(-28), kneeL: e(8), ankleL: e(-10),
      hipR: e(20), kneeR: e(22), ankleR: e(34),
      shoulderL: e(24, 0, 5), elbowL: e(-22),
      shoulderR: e(-26, 0, -5), elbowR: e(-38),
    },
  },
  {
    id: 'run',
    label: 'Running',
    description: 'Forward lean, bent arms, one knee driven high.',
    grounded: true,
    rotations: {
      pelvis: e(8, 8, 0),
      spine: e(10, 0, 0),
      chest: e(8, -10, 0),
      head: e(-12, 4, 0),
      hipL: e(-78), kneeL: e(100), ankleL: e(-10),
      hipR: e(28), kneeR: e(72), ankleR: e(40),
      shoulderL: e(40, 0, 10), elbowL: e(-95),
      shoulderR: e(-45, 0, -10), elbowR: e(-100),
    },
  },
  {
    id: 'sit',
    label: 'Sitting',
    description: 'Seated on an invisible chair, hands resting on the thighs.',
    grounded: true,
    rotations: {
      hipL: e(-90, 0, 4), hipR: e(-90, 0, -4),
      kneeL: e(90), kneeR: e(90),
      ankleL: e(flat(-90, 90)), ankleR: e(flat(-90, 90)),
      spine: e(-4), chest: e(-4),
      shoulderL: e(-30, 0, 12), elbowL: e(-60),
      shoulderR: e(-30, 0, -12), elbowR: e(-60),
    },
  },
  {
    id: 'crouch',
    label: 'Crouching',
    description: 'Deep crouch with the torso leaning forward, feet flat.',
    grounded: true,
    rotations: {
      hipL: e(-115, 0, 12), hipR: e(-115, 0, -12),
      kneeL: e(135), kneeR: e(135),
      ankleL: e(flat(-115, 135)), ankleR: e(flat(-115, 135)),
      spine: e(18), chest: e(14), head: e(-25),
      shoulderL: e(-50, 0, 10), elbowL: e(-30),
      shoulderR: e(-50, 0, -10), elbowR: e(-30),
    },
  },
  {
    id: 'wave',
    label: 'Waving',
    description: 'Right arm raised and waving, left arm relaxed.',
    grounded: true,
    rotations: {
      head: e(0, -8, -6),
      shoulderR: e(-20, 0, -140), elbowR: e(-70),
      shoulderL: e(0, 0, 10), elbowL: e(-12),
      chest: e(0, 0, 4),
    },
  },
  {
    id: 'point',
    label: 'Pointing',
    description: 'Right arm extended forward, left hand on the hip.',
    grounded: true,
    rotations: {
      chest: e(0, 8, 0),
      head: e(0, 10, 0),
      shoulderR: e(-88, 0, -8), elbowR: e(-6),
      shoulderL: e(14, -60, 40), elbowL: e(-100),
      hipL: e(0, 0, 6),
      hipR: e(-6, 0, -6),
    },
  },
  {
    id: 'hands-on-hips',
    label: 'Hands on hips',
    description: 'Confident stance, both hands on the hips.',
    grounded: true,
    rotations: {
      shoulderL: e(14, -60, 40), elbowL: e(-100),
      shoulderR: e(14, 60, -40), elbowR: e(-100),
      hipL: e(0, 0, 8), hipR: e(0, 0, -8),
      head: e(-3),
    },
  },
  {
    id: 'guard',
    label: 'Fighting guard',
    description: 'Staggered stance, fists raised, torso turned.',
    grounded: true,
    rotations: {
      pelvis: e(0, 32, 0),
      spine: e(6, -10, 0),
      chest: e(8, -14, 0),
      head: e(8, -12, 0),
      hipL: e(-32, 0, 8), kneeL: e(40), ankleL: e(flat(-32, 40)),
      hipR: e(20, 0, -14), kneeR: e(34), ankleR: e(flat(20, 34)),
      shoulderL: e(-58, 0, 14), elbowL: e(-115),
      shoulderR: e(-42, 0, -22), elbowR: e(-125),
    },
  },
  {
    id: 'jump',
    label: 'Jumping',
    description: 'Airborne, knees tucked, arms thrown up.',
    grounded: false,
    root: { y: 0.45 },
    rotations: {
      hipL: e(-55, 0, 10), hipR: e(-45, 0, -10),
      kneeL: e(75), kneeR: e(90),
      ankleL: e(30), ankleR: e(30),
      spine: e(-6), head: e(-12),
      shoulderL: e(-10, 0, 150), elbowL: e(-20),
      shoulderR: e(-10, 0, -150), elbowR: e(-20),
    },
  },
];

export const presetById = (id: string): PosePreset | undefined => POSE_PRESETS.find((p) => p.id === id);

/** Instantiate a preset for a given body (grounding depends on leg length). Result is within joint limits. */
export function applyPreset(rest: RestSkeleton, preset: PosePreset): Pose3D {
  let pose: Pose3D = clampPose({ root: { x: preset.root?.x ?? 0, y: preset.root?.y ?? 0, z: preset.root?.z ?? 0 }, rotations: { ...preset.rotations } });
  if (preset.grounded) pose = snapToGround(rest, pose);
  else pose = { ...pose, root: { ...pose.root, y: pose.root.y } };
  return pose;
}

/** Mirror helper for authors of asymmetric presets. */
export const mirroredPreset = (p: PosePreset): PosePreset => ({ ...p, rotations: mirrorPose({ root: { x: 0, y: 0, z: 0 }, rotations: p.rotations }).rotations });
