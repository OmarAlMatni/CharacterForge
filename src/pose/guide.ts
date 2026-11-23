import type { CameraState } from './camera.ts';
import { projectPoint } from './camera.ts';
import type { Pose3D, WorldPose } from './pose.ts';
import { forwardKinematics } from './pose.ts';
import type { JointId, RestSkeleton } from './skeleton.ts';
import { JOINT_IDS } from './skeleton.ts';
import type { V3 } from './vec.ts';
import { qRotate, vAdd, vLerp } from './vec.ts';

/**
 * Image-space guidance derived from a pose + camera. Everything here is plain data (no canvas, no WebGL), so it is
 * deterministic and unit-testable. Drawing it into images happens in render/poseGuideImages.ts.
 */
export interface Keypoint {
  name: string;
  world: V3;
  /** Pixel position in the output image (origin top-left). */
  x: number;
  y: number;
  depth: number;
  /** False if the point is behind the camera or outside the frame. */
  inFrame: boolean;
}

/** COCO-18 / OpenPose body keypoint order (what pose-conditioned image models are commonly trained on). */
export const OPENPOSE_NAMES = [
  'nose', 'neck', 'rShoulder', 'rElbow', 'rWrist', 'lShoulder', 'lElbow', 'lWrist',
  'rHip', 'rKnee', 'rAnkle', 'lHip', 'lKnee', 'lAnkle', 'rEye', 'lEye', 'rEar', 'lEar',
] as const;
export type OpenPoseName = (typeof OPENPOSE_NAMES)[number];

/** Limb connections (indices into OPENPOSE_NAMES), in the standard drawing order. */
export const OPENPOSE_LIMBS: [number, number][] = [
  [1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10], [1, 11], [11, 12], [12, 13], [1, 0], [0, 14], [14, 16], [0, 15], [15, 17],
];

/** Standard OpenPose palette (RGB), one colour per limb / keypoint. */
export const OPENPOSE_COLORS: [number, number, number][] = [
  [255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170],
  [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85],
];

/** Face landmarks in the head joint's local frame, for a figure of default head size (scaled by `scale.head`). */
const FACE = {
  nose: { x: 0, y: 0.085, z: 0.105 },
  eye: { x: 0.04, y: 0.115, z: 0.09 },
  ear: { x: 0.095, y: 0.095, z: -0.01 },
};

export interface SkeletonBone {
  from: JointId;
  to: JointId;
}
/** Bones used for silhouette/skeleton drawing and the mannequin's capsule limbs. */
export const BONES: SkeletonBone[] = JOINT_IDS.filter((id) => id !== 'pelvis').map((id) => ({ from: parentOf(id), to: id }));
function parentOf(id: JointId): JointId {
  const map: Partial<Record<JointId, JointId>> = {
    spine: 'pelvis', chest: 'spine', neck: 'chest', head: 'neck', headTop: 'head',
    clavicleL: 'chest', shoulderL: 'clavicleL', elbowL: 'shoulderL', wristL: 'elbowL', handL: 'wristL',
    clavicleR: 'chest', shoulderR: 'clavicleR', elbowR: 'shoulderR', wristR: 'elbowR', handR: 'wristR',
    hipL: 'pelvis', kneeL: 'hipL', ankleL: 'kneeL', toeL: 'ankleL',
    hipR: 'pelvis', kneeR: 'hipR', ankleR: 'kneeR', toeR: 'ankleR',
  };
  return map[id]!;
}

export interface PoseGuideData {
  /** Bumped when the structure of this object changes. */
  version: 1;
  size: { width: number; height: number };
  camera: CameraState;
  joints: Record<JointId, { world: V3; x: number; y: number; depth: number }>;
  keypoints: Keypoint[];
  /** Body orientation: which way the character faces, as a unit vector in world space and as an angle relative to the camera. */
  facing: { world: V3; yawToCameraDeg: number };
}

function worldFromHead(w: WorldPose, local: V3, headScale: number): V3 {
  const h = w.head;
  return vAdd(h.position, qRotate(h.rotation, { x: local.x * headScale, y: local.y * headScale, z: local.z * headScale }));
}

/** Compute joint positions and OpenPose keypoints in output-image pixels. */
export function computePoseGuide(rest: RestSkeleton, pose: Pose3D, camera: CameraState, width: number, height: number): PoseGuideData {
  const w = forwardKinematics(rest, pose);
  const proj = (p: V3) => projectPoint(camera, width, height, p);
  const joints = {} as PoseGuideData['joints'];
  for (const id of JOINT_IDS) {
    const p = proj(w[id].position);
    joints[id] = { world: w[id].position, x: p.x, y: p.y, depth: p.depth };
  }
  const hs = rest.scale.head;
  const at = (name: OpenPoseName, world: V3): Keypoint => {
    const p = proj(world);
    return { name, world, x: p.x, y: p.y, depth: p.depth, inFrame: p.depth > 0 && p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height };
  };
  const neck = vLerp(w.shoulderL.position, w.shoulderR.position, 0.5);
  const face = (name: OpenPoseName, l: V3) => at(name, worldFromHead(w, l, hs));
  const keypoints: Keypoint[] = [
    face('nose', FACE.nose),
    at('neck', neck),
    at('rShoulder', w.shoulderR.position), at('rElbow', w.elbowR.position), at('rWrist', w.wristR.position),
    at('lShoulder', w.shoulderL.position), at('lElbow', w.elbowL.position), at('lWrist', w.wristL.position),
    at('rHip', w.hipR.position), at('rKnee', w.kneeR.position), at('rAnkle', w.ankleR.position),
    at('lHip', w.hipL.position), at('lKnee', w.kneeL.position), at('lAnkle', w.ankleL.position),
    face('rEye', { ...FACE.eye, x: -FACE.eye.x }), face('lEye', FACE.eye),
    face('rEar', { ...FACE.ear, x: -FACE.ear.x }), face('lEar', FACE.ear),
  ];
  const facingWorld = qRotate(w.pelvis.rotation, { x: 0, y: 0, z: 1 });
  // Angle between the camera direction (from the character towards the camera) and the facing direction, around the vertical axis.
  const camDir = { x: Math.sin((camera.azimuth * Math.PI) / 180), z: Math.cos((camera.azimuth * Math.PI) / 180) };
  const yaw = (Math.atan2(facingWorld.x, facingWorld.z) - Math.atan2(camDir.x, camDir.z)) * (180 / Math.PI);
  const wrapped = ((yaw + 180) % 360 + 360) % 360 - 180;
  return { version: 1, size: { width, height }, camera, joints, keypoints, facing: { world: facingWorld, yawToCameraDeg: Math.round(wrapped * 100) / 100 } };
}

/** Points (joints plus head/hand/foot extents) that should be inside the frame. */
export function framingPoints(rest: RestSkeleton, pose: Pose3D): V3[] {
  const w = forwardKinematics(rest, pose);
  const pts: V3[] = [];
  const pad = 0.05 * rest.scale.k * rest.scale.build;
  for (const id of JOINT_IDS) {
    const p = w[id].position;
    pts.push(p);
    if (id === 'headTop') pts.push({ ...p, y: p.y + pad });
    if (id === 'toeL' || id === 'toeR' || id === 'ankleL' || id === 'ankleR') pts.push({ ...p, y: p.y - pad });
  }
  return pts;
}
