import * as THREE from 'three';
import type { BodyShape, CameraState, Pose3D, RestSkeleton } from '../pose/index.ts';
import { OPENPOSE_COLORS, OPENPOSE_LIMBS, cameraBasis, computePoseGuide, forwardKinematics } from '../pose/index.ts';
import type { GuideKind } from '../core/character.ts';
import { CharacterBody } from './characterBody.ts';
import type { BodyArtwork } from './characterBody.ts';
import { canvasToPngBytes, ctx2d, newCanvas } from './pngEncode.ts';

/**
 * Renders the current pose as images a generation adapter (or an artist's own tool) can use as guidance.
 *  - mannequin (clay model) / textured (the artwork projected on the model) / depth / silhouette: Three.js offscreen render with the SAME camera as the viewport.
 *  - pose: OpenPose-style coloured skeleton, drawn in 2D from projected joint positions.
 * `transparent: true` leaves the background transparent (mannequin and silhouette default to this for export);
 * model-conditioning maps conventionally use an opaque black background, so `transparent: false` is the default for pose/depth.
 */
export interface GuideRenderRequest {
  kind: GuideKind;
  rest: RestSkeleton;
  shape: BodyShape;
  /** Decoded artwork for the `textured` kind (images must already be decoded: rendering is synchronous). */
  artwork?: BodyArtwork | null;
  pose: Pose3D;
  camera: CameraState;
  width: number;
  height: number;
  transparent: boolean;
}

let shared: { renderer: THREE.WebGLRenderer; canvas: HTMLCanvasElement } | null = null;

function offscreen(width: number, height: number): THREE.WebGLRenderer {
  if (!shared) {
    const canvas = document.createElement('canvas');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, premultipliedAlpha: false });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    shared = { renderer, canvas };
  }
  shared.renderer.setPixelRatio(1);
  shared.renderer.setSize(width, height, false);
  return shared.renderer;
}

/** Release the offscreen WebGL context (call when leaving the studio). */
export function disposeGuideRenderer(): void {
  if (!shared) return;
  shared.renderer.dispose();
  shared.renderer.forceContextLoss();
  shared = null;
}

function buildCamera(camera: CameraState, aspect: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(camera.fov, aspect, 0.05, 100);
  const b = cameraBasis(camera);
  cam.position.set(b.position.x, b.position.y, b.position.z);
  cam.up.set(0, 1, 0);
  cam.lookAt(camera.target.x, camera.target.y, camera.target.z);
  cam.updateMatrixWorld(true);
  return cam;
}

function renderThree(req: GuideRenderRequest): HTMLCanvasElement {
  const { kind, rest, shape, pose, camera, width, height, transparent } = req;
  const renderer = offscreen(width, height);
  const scene = new THREE.Scene();
  const cam = buildCamera(camera, width / height);
  const world = forwardKinematics(rest, pose);
  const man = new CharacterBody('guide', false);
  man.setBody(rest, shape, 'high');
  if (kind === 'textured') {
    if (!req.artwork) throw new Error('The artwork is not loaded yet. Project it onto the model first.');
    man.setArtwork({ ...req.artwork, show: true });
  }
  man.update(world);
  scene.add(man.group);

  const opaqueBlack = !transparent && kind !== 'mannequin' && kind !== 'textured';
  if (kind === 'mannequin' || kind === 'textured') {
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.35));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(1.5, 2.5, 3);
    cam.add(key);
    scene.add(cam);
  } else if (kind === 'silhouette') {
    scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
  } else {
    // Linear depth between the nearest and farthest joint (plus the body's thickness), near = white.
    const pts = CharacterBody.jointPoints(world);
    const depths = pts.map((p) => p.clone().applyMatrix4(cam.matrixWorldInverse).z * -1);
    const pad = 0.12 * rest.scale.k;
    const near = Math.min(...depths) - pad;
    const far = Math.max(...depths) + pad;
    scene.overrideMaterial = new THREE.ShaderMaterial({
      uniforms: { uNear: { value: near }, uFar: { value: far } },
      vertexShader: 'varying float vZ; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vZ = -mv.z; gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'uniform float uNear; uniform float uFar; varying float vZ; void main(){ float t = clamp((vZ - uNear) / (uFar - uNear), 0.0, 1.0); gl_FragColor = vec4(vec3(1.0 - t), 1.0); }',
    });
  }
  renderer.setClearColor(0x000000, opaqueBlack ? 1 : 0);
  renderer.clear();
  renderer.render(scene, cam);
  const out = newCanvas(width, height);
  ctx2d(out).drawImage(renderer.domElement, 0, 0);
  man.dispose();
  if (scene.overrideMaterial) (scene.overrideMaterial as THREE.Material).dispose();
  return out;
}

function renderPoseMap(req: GuideRenderRequest): HTMLCanvasElement {
  const { rest, pose, camera, width, height, transparent } = req;
  const g = computePoseGuide(rest, pose, camera, width, height);
  const c = newCanvas(width, height);
  const ctx = ctx2d(c);
  if (!transparent) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
  }
  const stick = Math.max(2, Math.round((Math.min(width, height) / 512) * 4));
  const kp = g.keypoints;
  ctx.globalAlpha = 0.6;
  OPENPOSE_LIMBS.forEach(([a, b], i) => {
    const p = kp[a]!;
    const q = kp[b]!;
    if (p.depth <= 0 || q.depth <= 0) return;
    const [r, gg, bl] = OPENPOSE_COLORS[i % OPENPOSE_COLORS.length]!;
    ctx.fillStyle = `rgb(${r},${gg},${bl})`;
    const mx = (p.x + q.x) / 2;
    const my = (p.y + q.y) / 2;
    const len = Math.hypot(p.x - q.x, p.y - q.y);
    const ang = Math.atan2(q.y - p.y, q.x - p.x);
    ctx.beginPath();
    ctx.ellipse(mx, my, len / 2, stick, ang, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  kp.forEach((p, i) => {
    if (p.depth <= 0) return;
    const [r, gg, bl] = OPENPOSE_COLORS[i % OPENPOSE_COLORS.length]!;
    ctx.fillStyle = `rgb(${r},${gg},${bl})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, stick, 0, Math.PI * 2);
    ctx.fill();
  });
  return c;
}

export function renderGuideCanvas(req: GuideRenderRequest): HTMLCanvasElement {
  return req.kind === 'pose' ? renderPoseMap(req) : renderThree(req);
}

export async function renderGuidePng(req: GuideRenderRequest): Promise<Uint8Array> {
  return canvasToPngBytes(renderGuideCanvas(req));
}

export const GUIDE_DEFAULT_TRANSPARENT: Record<GuideKind, boolean> = { mannequin: true, textured: true, silhouette: false, pose: false, depth: false };
