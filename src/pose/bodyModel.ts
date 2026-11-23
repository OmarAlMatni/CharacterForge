import type { BodyMesh, BodyQuality, SkinJointId } from './bodyMesh.ts';
import { SKIN_INDEX, SKIN_JOINTS } from './bodyMesh.ts';
import type { BodyShape } from './bodyShape.ts';
import { clampShape } from './bodyShape.ts';
import type { GlbMesh } from './glb.ts';
import type { WorldPose } from './pose.ts';
import type { JointId, RestSkeleton } from './skeleton.ts';
import { JOINT_IDS, buildRestSkeleton } from './skeleton.ts';
import type { Q, V3 } from './vec.ts';
import { qIdentity, vCross, vDot, vLen, vNorm, vSub } from './vec.ts';

/**
 * The bundled character model: "Anime Character Base mesh" by Marc Ed (Sketchfab), CC-BY-4.0. It is an unrigged, untextured
 * mesh made of separate body-part shells (torso, head, arms, hands, legs, feet, ears). This module RIGS it for the pose engine:
 *
 *  - `NATIVE_JOINTS` places the engine's joints inside the mesh (measured from it; a test checks they sit inside the body);
 *  - every vertex is skinned to the joints of its shell's limb chain, blending smoothly around each joint;
 *  - each bone gets a native frame, so the posed mesh is the model's own shape moved by the engine's FK;
 *  - `buildModelMesh` then scales every bone's length and thickness from the Height / Width / Proportions / Shape settings.
 */
export const MODEL_FILE = 'models/anime-character-base-mesh.glb';
export const MODEL_CREDIT = {
  title: 'Anime Character Base mesh',
  author: 'Marc Ed',
  authorUrl: 'https://sketchfab.com/marc.edouard.lepine17',
  source: 'https://sketchfab.com/3d-models/anime-character-base-mesh-1ab99094be564a86a0dd21e23cebc5de',
  license: 'CC-BY-4.0',
  licenseUrl: 'http://creativecommons.org/licenses/by/4.0/',
} as const;

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });

/**
 * Joint positions in the model's own coordinates (metres, +Y up, facing +Z, the character's left on +X), measured from the mesh.
 * Right-hand joints mirror the left ones. `y` includes the model's 0.0247 m offset above the floor.
 */
const LEFT_RAW = {
  clavicle: v(0, 0.985, -0.03),
  shoulder: v(0.13, 0.968, -0.045),
  elbow: v(0.166, 0.82, -0.041),
  wrist: v(0.2, 0.668, -0.03),
  hand: v(0.207, 0.551, -0.03),
  hip: v(0.085, 0.6, -0.005),
  knee: v(0.104, 0.32, -0.048),
  ankle: v(0.116, 0.095, -0.045),
  toe: v(0.13, 0.035, 0.099),
};
export const NATIVE_JOINTS: Record<JointId, V3> = (() => {
  const o = {} as Record<JointId, V3>;
  o.pelvis = v(0, 0.64, -0.005);
  o.spine = v(0, 0.74, 0);
  o.chest = v(0, 0.86, 0);
  o.neck = v(0, 1.045, -0.014);
  o.head = v(0, 1.09, -0.015);
  o.headTop = v(0, 1.2462, -0.015);
  for (const [s, sign] of [['L', 1], ['R', -1]] as const) {
    for (const [k, p] of Object.entries(LEFT_RAW)) {
      const id = `${k === 'hand' ? 'hand' : k}${s}` as JointId;
      o[id] = v(p.x * sign, p.y, p.z);
    }
  }
  return o;
})();

/** The bone each joint drives (its main child). `end` joints drive nothing. */
const CHILD: Partial<Record<JointId, JointId>> = {
  pelvis: 'spine', spine: 'chest', chest: 'neck', neck: 'head', head: 'headTop',
  clavicleL: 'shoulderL', shoulderL: 'elbowL', elbowL: 'wristL', wristL: 'handL',
  clavicleR: 'shoulderR', shoulderR: 'elbowR', elbowR: 'wristR', wristR: 'handR',
  hipL: 'kneeL', kneeL: 'ankleL', ankleL: 'toeL',
  hipR: 'kneeR', kneeR: 'ankleR', ankleR: 'toeR',
};

type ShellClass = 'torso' | 'head' | 'armL' | 'armR' | 'handL' | 'handR' | 'legL' | 'legR' | 'footL' | 'footR';
/** What each separate shell of the bundled mesh is (shells are numbered in order of their first vertex). */
const SHELLS: ShellClass[] = [
  'footL', 'footL', 'handL', 'handL', 'torso', 'armL', 'torso', 'footL', 'legL', 'legL',
  'footR', 'footR', 'handR', 'handR', 'armR', 'footR', 'legR', 'legR', 'head', 'head', 'head', 'head',
];
const EXPECTED_VERTICES = 39714;

/** Joint chain and blend half-width (metres, in model units) for each shell class. */
const CHAINS: Record<ShellClass, { joints: SkinJointId[]; blend: number[] }> = {
  torso: { joints: ['pelvis', 'spine', 'chest', 'neck'], blend: [0, 0.04, 0.04, 0.03] },
  head: { joints: ['neck', 'head'], blend: [0, 0.025] },
  // the top of each arm tube follows the collar (so its open end stays tucked into the torso), then rolls into the shoulder
  armL: { joints: ['clavicleL', 'shoulderL', 'elbowL', 'wristL'], blend: [0, 0.045, 0.03, 0.02] },
  armR: { joints: ['clavicleR', 'shoulderR', 'elbowR', 'wristR'], blend: [0, 0.045, 0.03, 0.02] },
  handL: { joints: ['wristL'], blend: [0] },
  handR: { joints: ['wristR'], blend: [0] },
  legL: { joints: ['hipL', 'kneeL', 'ankleL'], blend: [0, 0.035, 0.02] },
  legR: { joints: ['hipR', 'kneeR', 'ankleR'], blend: [0, 0.035, 0.02] },
  footL: { joints: ['ankleL'], blend: [0] },
  footR: { joints: ['ankleR'], blend: [0] },
};
const SIDE_OF: Partial<Record<ShellClass, number>> = { armL: 1, handL: 1, legL: 1, footL: 1, armR: -1, handR: -1, legR: -1, footR: -1 };

interface StaticMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  skinJoints: Uint8Array;
  skinWeights: Float32Array;
  side: Float32Array;
  vertexCount: number;
  min: V3;
  max: V3;
}

export interface BodyModel {
  credit: GlbMesh['credit'];
  /** Uniform factor from the file's metres to the engine's 1.7 m figure. */
  scale: number;
  full: StaticMesh;
  /** Joint positions and bone frames in the (scaled) bind pose. */
  bind: WorldPose;
  /** Length of each skin joint's bone as modelled (scaled). */
  nativeLength: Float64Array;
  /** Which local axis (0 X, 1 Y, 2 Z) each skin joint's bone runs along. */
  axis: Uint8Array;
  lod?: StaticMesh;
}

/** Rotation by the shortest arc taking unit vector a to unit vector b (no twist about the axis). */
function qFromTo(a: V3, b: V3): Q {
  const d = vDot(a, b);
  if (d < -0.999999) {
    const ref = Math.abs(a.x) < 0.9 ? v(1, 0, 0) : v(0, 1, 0);
    const ax = vNorm(vCross(a, ref));
    return { x: ax.x, y: ax.y, z: ax.z, w: 0 };
  }
  const c = vCross(a, b);
  const l = Math.hypot(c.x, c.y, c.z, 1 + d);
  return { x: c.x / l, y: c.y / l, z: c.z / l, w: (1 + d) / l };
}

const smoothstep = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** Weights along a joint chain for point p: blend from joint i-1 to joint i over ±blend[i] (m) around joint i. */
function chainWeights(p: V3, nodes: V3[], blend: number[], out: number[]): void {
  const n = nodes.length;
  out.fill(0);
  if (n === 1) {
    out[0] = 1;
    return;
  }
  let bestD = Infinity, bestU = 0;
  let cum = 0;
  const cums: number[] = [0];
  for (let i = 0; i < n - 1; i++) {
    const a = nodes[i]!, b = nodes[i + 1]!;
    const ab = vSub(b, a);
    const len = vLen(ab);
    const t = Math.min(1, Math.max(0, vDot(vSub(p, a), ab) / (len * len)));
    const dx = p.x - (a.x + ab.x * t), dy = p.y - (a.y + ab.y * t), dz = p.z - (a.z + ab.z * t);
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) {
      bestD = d;
      bestU = cum + t * len;
    }
    cum += len;
    cums.push(cum);
  }
  // s[i] = how far along the blend into joint i (or beyond) the point is
  const s: number[] = [1];
  for (let i = 1; i < n; i++) s.push(smoothstep((bestU - (cums[i]! - blend[i]!)) / (2 * blend[i]!)));
  for (let i = 0; i < n; i++) out[i] = s[i]! - (i + 1 < n ? s[i + 1]! : 0);
}

/** Turn a parsed .glb into the rigged model. Throws if the file is not the bundled model. */
export function prepareBodyModel(glb: GlbMesh): BodyModel {
  const n = glb.positions.length / 3;
  if (n !== EXPECTED_VERTICES) throw new Error(`Unsupported character model (${n} vertices; the rig is made for ${EXPECTED_VERTICES}).`);
  // shells = connected components over the index buffer, numbered by first vertex
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  for (let i = 0; i < glb.indices.length; i += 3) {
    const a = find(glb.indices[i]!), b = find(glb.indices[i + 1]!), c = find(glb.indices[i + 2]!);
    parent[b] = a;
    parent[find(c)] = find(a);
  }
  const shellOf = new Int32Array(n);
  const ids = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!ids.has(r)) ids.set(r, ids.size);
    shellOf[i] = ids.get(r)!;
  }
  if (ids.size !== SHELLS.length) throw new Error(`Unsupported character model (${ids.size} body-part shells, expected ${SHELLS.length}).`);

  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minY = Math.min(minY, glb.positions[i * 3 + 1]!);
    maxY = Math.max(maxY, glb.positions[i * 3 + 1]!);
  }
  const scale = 1.7 / (maxY - minY);
  const toBind = (p: V3): V3 => v(p.x * scale, (p.y - minY) * scale, p.z * scale);

  // rigged joints in bind space, with swing-only bone frames
  const rest0 = buildRestSkeleton();
  const bind = {} as WorldPose;
  const nativeLength = new Float64Array(SKIN_JOINTS.length);
  const axis = new Uint8Array(SKIN_JOINTS.length);
  for (const id of JOINT_IDS) bind[id] = { position: toBind(NATIVE_JOINTS[id]), rotation: qIdentity() };
  for (const id of SKIN_JOINTS) {
    const child = CHILD[id]!;
    const restAxis = vNorm(rest0.offsets[child]);
    const nativeDir = vNorm(vSub(bind[child].position, bind[id].position));
    bind[id].rotation = qFromTo(restAxis, nativeDir);
    nativeLength[SKIN_INDEX[id]] = vLen(vSub(bind[child].position, bind[id].position));
    const ax = Math.abs(restAxis.x), ay = Math.abs(restAxis.y), az = Math.abs(restAxis.z);
    axis[SKIN_INDEX[id]] = ax > ay && ax > az ? 0 : az > ay ? 2 : 1;
  }

  // vertices: bind-space positions, skin weights from each shell's joint chain
  const positions = new Float32Array(n * 3);
  const skinJoints = new Uint8Array(n * 4);
  const skinWeights = new Float32Array(n * 4);
  const side = new Float32Array(n);
  const chainNodes = new Map<ShellClass, V3[]>();
  for (const [cls, ch] of Object.entries(CHAINS) as [ShellClass, (typeof CHAINS)[ShellClass]][]) chainNodes.set(cls, ch.joints.map((j) => NATIVE_JOINTS[j]));
  const w: number[] = [];
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < n; i++) {
    const raw = v(glb.positions[i * 3]!, glb.positions[i * 3 + 1]!, glb.positions[i * 3 + 2]!);
    const cls = SHELLS[shellOf[i]!]!;
    const ch = CHAINS[cls];
    w.length = ch.joints.length;
    chainWeights(raw, chainNodes.get(cls)!, ch.blend, w);
    let q = 0;
    for (let j = 0; j < ch.joints.length && q < 4; j++) {
      if (w[j]! > 1e-4) {
        skinJoints[i * 4 + q] = SKIN_INDEX[ch.joints[j]!];
        skinWeights[i * 4 + q] = w[j]!;
        q++;
      }
    }
    let total = 0;
    for (let k = 0; k < 4; k++) total += skinWeights[i * 4 + k]!;
    for (let k = 0; k < 4; k++) skinWeights[i * 4 + k] = skinWeights[i * 4 + k]! / total;
    if (cls === 'torso') {
      // the arm-hole rim of the torso follows the arm a little, so the hole does not open up when the arm is raised
      const sj: SkinJointId = raw.x >= 0 ? 'shoulderL' : 'shoulderR';
      const d = vLen(vSub(raw, NATIVE_JOINTS[sj]));
      const f = 0.7 * smoothstep((0.075 - d) / 0.045);
      if (f > 1e-3) {
        for (let k = 0; k < 4; k++) skinWeights[i * 4 + k] = skinWeights[i * 4 + k]! * (1 - f);
        let slot = 0;
        while (slot < 4 && skinWeights[i * 4 + slot]! > 0) slot++;
        if (slot < 4) {
          skinJoints[i * 4 + slot] = SKIN_INDEX[sj];
          skinWeights[i * 4 + slot] = f;
        }
      }
    }
    side[i] = SIDE_OF[cls] ?? 0;
    const b = toBind(raw);
    positions[i * 3] = b.x;
    positions[i * 3 + 1] = b.y;
    positions[i * 3 + 2] = b.z;
    mnx = Math.min(mnx, b.x); mny = Math.min(mny, b.y); mnz = Math.min(mnz, b.z);
    mxx = Math.max(mxx, b.x); mxy = Math.max(mxy, b.y); mxz = Math.max(mxz, b.z);
  }
  const full: StaticMesh = {
    positions, normals: new Float32Array(glb.normals), indices: new Uint32Array(glb.indices), skinJoints, skinWeights, side, vertexCount: n,
    min: v(mnx, mny, mnz), max: v(mxx, mxy, mxz),
  };
  return { credit: glb.credit, scale, full, bind, nativeLength, axis, lod: decimate(full, shellOf, 0.02) };
}

/** Vertex-clustering decimation (per shell, so overlapping body parts are never merged). Used for silhouette scoring only. */
function decimate(m: StaticMesh, shellOf: Int32Array, cell: number): StaticMesh {
  const nj = SKIN_JOINTS.length;
  const map = new Map<string, number>();
  const cluster = new Int32Array(m.vertexCount);
  const sums: { p: V3; n: V3; side: number; count: number; w: Float64Array }[] = [];
  for (let i = 0; i < m.vertexCount; i++) {
    const x = m.positions[i * 3]!, y = m.positions[i * 3 + 1]!, z = m.positions[i * 3 + 2]!;
    const key = `${shellOf[i]}:${Math.floor(x / cell)}:${Math.floor(y / cell)}:${Math.floor(z / cell)}`;
    let c = map.get(key);
    if (c === undefined) {
      c = sums.length;
      map.set(key, c);
      sums.push({ p: v(0, 0, 0), n: v(0, 0, 0), side: 0, count: 0, w: new Float64Array(nj) });
    }
    cluster[i] = c;
    const s = sums[c]!;
    s.p.x += x; s.p.y += y; s.p.z += z;
    s.n.x += m.normals[i * 3]!; s.n.y += m.normals[i * 3 + 1]!; s.n.z += m.normals[i * 3 + 2]!;
    s.side += m.side[i]!;
    s.count++;
    for (let k = 0; k < 4; k++) {
      const j = m.skinJoints[i * 4 + k]!;
      s.w[j] = s.w[j]! + m.skinWeights[i * 4 + k]!;
    }
  }
  const nv = sums.length;
  const positions = new Float32Array(nv * 3);
  const normals = new Float32Array(nv * 3);
  const skinJoints = new Uint8Array(nv * 4);
  const skinWeights = new Float32Array(nv * 4);
  const side = new Float32Array(nv);
  sums.forEach((s, c) => {
    positions[c * 3] = s.p.x / s.count; positions[c * 3 + 1] = s.p.y / s.count; positions[c * 3 + 2] = s.p.z / s.count;
    const l = vLen(s.n) || 1;
    normals[c * 3] = s.n.x / l; normals[c * 3 + 1] = s.n.y / l; normals[c * 3 + 2] = s.n.z / l;
    side[c] = s.side / s.count;
    const top = Array.from(s.w, (wt, j) => [j, wt] as const).filter((e) => e[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const total = top.reduce((a, e) => a + e[1], 0);
    top.forEach(([j, wt], q) => {
      skinJoints[c * 4 + q] = j;
      skinWeights[c * 4 + q] = wt / total;
    });
  });
  const tris: number[] = [];
  for (let i = 0; i < m.indices.length; i += 3) {
    const a = cluster[m.indices[i]!]!, b = cluster[m.indices[i + 1]!]!, c = cluster[m.indices[i + 2]!]!;
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  return { positions, normals, indices: new Uint32Array(tris), skinJoints, skinWeights, side, vertexCount: nv, min: m.min, max: m.max };
}

/**
 * Per-joint size of the body for the given frame and shape: along each bone it follows the skeleton's bone length (so the
 * Height, Legs, Torso, Arms, Shoulders, Hips and Head sliders stretch the model), and around it the Build and Shape values.
 */
export function modelSkinScale(model: BodyModel, rest: RestSkeleton, shapeIn: Partial<BodyShape> | undefined): Float64Array {
  const sh = clampShape(shapeIn);
  const k = rest.scale.k, bd = rest.scale.build, p = rest.proportions;
  const sw = p.shoulders * k, hw = p.hips * k, H = rest.scale.head, dp = sh.depth;
  // [width (local X, or Y for sideways bones), depth (local Z), axial multiplier]
  const spec: Record<SkinJointId, [number, number, number]> = {
    pelvis: [hw * bd * sh.pelvis, k * bd * sh.pelvis * dp, 1],
    spine: [k * bd * sh.waist, k * bd * sh.waist * dp, 1],
    chest: [sw * bd * sh.chest, k * bd * sh.chest * dp, 1],
    neck: [k * bd * sh.neck, k * bd * sh.neck, 1],
    head: [H, H, 1],
    clavicleL: [k * bd * sh.chest, k * bd * sh.chest * dp, 1], clavicleR: [k * bd * sh.chest, k * bd * sh.chest * dp, 1],
    shoulderL: [k * bd * sh.arms, k * bd * sh.arms * dp, 1], shoulderR: [k * bd * sh.arms, k * bd * sh.arms * dp, 1],
    elbowL: [k * bd * sh.arms, k * bd * sh.arms * dp, 1], elbowR: [k * bd * sh.arms, k * bd * sh.arms * dp, 1],
    wristL: [k * bd * sh.hands, k * bd * sh.hands, sh.hands], wristR: [k * bd * sh.hands, k * bd * sh.hands, sh.hands],
    hipL: [k * bd * sh.legs, k * bd * sh.legs * dp, 1], hipR: [k * bd * sh.legs, k * bd * sh.legs * dp, 1],
    kneeL: [k * bd * sh.legs, k * bd * sh.legs * dp, 1], kneeR: [k * bd * sh.legs, k * bd * sh.legs * dp, 1],
    ankleL: [k * bd * sh.feet, k * bd * sh.feet, sh.feet], ankleR: [k * bd * sh.feet, k * bd * sh.feet, sh.feet],
  };
  const out = new Float64Array(SKIN_JOINTS.length * 3);
  SKIN_JOINTS.forEach((id, i) => {
    const [width, depth, mult] = spec[id];
    const child = CHILD[id]!;
    const axial = (rest.boneLength[child] * mult) / model.nativeLength[i]!;
    const ax = model.axis[i]!;
    // ax 1 (vertical bones): X = width, Z = depth. ax 0 (collar, runs sideways): Y = width, Z = depth. ax 2 (foot): X = width, Y = depth.
    const s: [number, number, number] = [width, width, depth];
    if (ax === 2) {
      s[0] = width;
      s[1] = depth;
      s[2] = axial;
    } else s[ax] = axial;
    out[i * 3] = s[0];
    out[i * 3 + 1] = s[1];
    out[i * 3 + 2] = s[2];
  });
  return out;
}

/** The model as a skinned body for the given frame and shape. Cheap: the heavy data is shared, only the per-joint sizes change. */
export function buildModelMesh(model: BodyModel, rest: RestSkeleton, shape: Partial<BodyShape> | undefined, quality: BodyQuality = 'normal'): BodyMesh {
  const m = quality === 'draft' && model.lod ? model.lod : model.full;
  return {
    positions: m.positions, normals: m.normals, indices: m.indices, skinJoints: m.skinJoints, skinWeights: m.skinWeights, side: m.side,
    bind: model.bind, skinScale: modelSkinScale(model, rest, shape), vertexCount: m.vertexCount, min: m.min, max: m.max,
  };
}
