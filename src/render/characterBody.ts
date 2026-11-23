import * as THREE from 'three';
import type { ArtworkFit, BodyMesh, BodyQuality, BodyShape, Bounds2, JointId, Pose3D, RestSkeleton, WorldPose } from '../pose/index.ts';
import { JOINT_IDS, POSABLE_JOINTS, bakeUv, boundsXY, buildCharacterMesh, forwardKinematics, skinBody } from '../pose/index.ts';

/**
 * The character body in Three.js: one skinned, smooth mesh built by the pure body generator (src/pose/bodyMesh.ts), plus the
 * joint handles used for posing. Skinning runs on the CPU from the pure FK result, so what is drawn is exactly what the pose
 * engine computed. A small shader shows either a clay model or the artwork projected onto the body.
 */
export const HANDLE_JOINTS: JointId[] = ['wristL', 'wristR', 'ankleL', 'ankleR', 'pelvis'];

export type Palette = 'viewport' | 'guide';

export interface ArtworkImage {
  image: TexImageSource;
  fit: ArtworkFit;
  width: number;
  height: number;
}

/** Everything the body needs to show the artwork. */
export interface BodyArtwork {
  front: ArtworkImage | null;
  back: ArtworkImage | null;
  /** Pose the artwork was projected in. */
  bakedPose: Pose3D | null;
  show: boolean;
  fill: string;
  shading: number;
}

const VERT = /* glsl */ `
attribute float aSide;
attribute vec2 aUvFront;
attribute vec2 aUvBack;
attribute float aFacing;
varying vec3 vNormal;
varying float vSide;
varying vec2 vUvFront;
varying vec2 vUvBack;
varying float vFacing;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vSide = aSide;
  vUvFront = aUvFront;
  vUvBack = aUvBack;
  vFacing = aFacing;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D uFront;
uniform sampler2D uBack;
uniform float uHasFront;
uniform float uHasBack;
uniform float uShading;
uniform float uClay;
uniform vec3 uFill;
uniform vec3 uClayColor;
uniform vec3 uLeftTint;
uniform vec3 uRightTint;
uniform vec3 uLight;
varying vec3 vNormal;
varying float vSide;
varying vec2 vUvFront;
varying vec2 vUvBack;
varying float vFacing;
void main() {
  vec3 base = uFill;
  if (uClay > 0.5) {
    base = uClayColor;
    base = mix(base, uLeftTint, clamp(vSide, 0.0, 1.0));
    base = mix(base, uRightTint, clamp(-vSide, 0.0, 1.0));
  } else {
    if (uHasFront > 0.5) {
      vec4 f = texture2D(uFront, vUvFront);
      base = mix(base, f.rgb, f.a * smoothstep(0.12, 0.55, vFacing));
    }
    if (uHasBack > 0.5) {
      vec4 b = texture2D(uBack, vUvBack);
      base = mix(base, b.rgb, b.a * smoothstep(0.12, 0.55, -vFacing));
    }
  }
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n; // the model is made of overlapping body-part shells: seeing the inside of one is fine, a hole is not
  float lambert = max(dot(n, normalize(uLight)), 0.0);
  float hemi = 0.5 + 0.5 * n.y;
  float lit = 0.42 + 0.38 * lambert + 0.2 * hemi;
  gl_FragColor = vec4(base * mix(1.0, lit, uShading), 1.0);
  #include <colorspace_fragment>
}`;

const toV = (v: { x: number; y: number; z: number }): THREE.Vector3 => new THREE.Vector3(v.x, v.y, v.z);

function makeTexture(img: TexImageSource): THREE.Texture {
  const t = new THREE.Texture(img as unknown as HTMLImageElement);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false; // texture coordinates are image pixels / size with the origin at the top-left
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 4;
  t.premultiplyAlpha = false;
  t.needsUpdate = true;
  return t;
}

export class CharacterBody {
  readonly group = new THREE.Group();
  /** Pick targets, keyed by joint. Only populated for the viewport. */
  readonly markers = new Map<JointId, THREE.Mesh>();
  private readonly palette: Palette;
  private readonly withMarkers: boolean;
  private mesh: THREE.Mesh | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private body: BodyMesh | null = null;
  private rest: RestSkeleton | null = null;
  private shapeKey = '';
  private posAttr: THREE.BufferAttribute | null = null;
  private norAttr: THREE.BufferAttribute | null = null;
  private readonly material: THREE.ShaderMaterial;
  private readonly textures = new Map<TexImageSource, THREE.Texture>();
  private artwork: BodyArtwork | null = null;
  private artworkKey = '';
  private selected: JointId | null = null;
  private disposables: { dispose(): void }[] = [];
  private lastQuality: BodyQuality = 'normal';

  constructor(palette: Palette, withMarkers = palette === 'viewport') {
    this.palette = palette;
    this.withMarkers = withMarkers;
    const blank = new THREE.Texture();
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      uniforms: {
        uFront: { value: blank },
        uBack: { value: blank },
        uHasFront: { value: 0 },
        uHasBack: { value: 0 },
        uShading: { value: 1 },
        uClay: { value: 1 },
        uFill: { value: new THREE.Color('#c9ced8') },
        uClayColor: { value: new THREE.Color(palette === 'viewport' ? 0xcfd4dd : 0xd4d4d4) },
        uLeftTint: { value: new THREE.Color(palette === 'viewport' ? 0xc6d4e8 : 0xd4d4d4) },
        uRightTint: { value: new THREE.Color(palette === 'viewport' ? 0xe8d0c4 : 0xd4d4d4) },
        uLight: { value: new THREE.Vector3(0.35, 0.65, 0.7) },
      },
    });
  }

  /** (Re)build the body when the frame or shape changed. Returns true if the mesh was rebuilt. */
  setBody(rest: RestSkeleton, shape: BodyShape, quality: BodyQuality = 'normal'): boolean {
    const key = JSON.stringify([rest.proportions, shape, quality]);
    if (key === this.shapeKey) return false;
    this.shapeKey = key;
    this.lastQuality = quality;
    this.rest = rest;
    const next = buildCharacterMesh(rest, shape, quality);
    // sliders only change the per-joint sizes: the vertex data is shared, so the GPU geometry can be kept
    const sameGeometry = !!this.body && this.body.positions === next.positions && this.body.indices === next.indices;
    this.body = next;
    if (!sameGeometry) this.rebuildGeometry();
    if (this.withMarkers) this.buildMarkers(rest);
    this.artworkKey = ''; // texture coordinates belong to the old mesh
    if (this.artwork) this.setArtwork(this.artwork);
    return true;
  }

  /** Front-view (x, y) bounds of the body as currently posed. */
  posedBounds(): Bounds2 | null {
    return this.body && this.posAttr ? boundsXY(this.posAttr.array as Float32Array, this.body.vertexCount) : null;
  }

  private rebuildGeometry(): void {
    const b = this.body!;
    if (this.mesh) this.group.remove(this.mesh);
    this.geometry?.dispose();
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(b.positions), 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.norAttr = new THREE.BufferAttribute(new Float32Array(b.normals), 3);
    this.norAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('normal', this.norAttr);
    g.setAttribute('aSide', new THREE.BufferAttribute(b.side, 1));
    g.setAttribute('aUvFront', new THREE.BufferAttribute(new Float32Array(b.vertexCount * 2), 2));
    g.setAttribute('aUvBack', new THREE.BufferAttribute(new Float32Array(b.vertexCount * 2), 2));
    g.setAttribute('aFacing', new THREE.BufferAttribute(new Float32Array(b.vertexCount), 1));
    g.setIndex(new THREE.BufferAttribute(b.indices, 1));
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
  }

  private tex(img: TexImageSource): THREE.Texture {
    let t = this.textures.get(img);
    if (!t) {
      t = makeTexture(img);
      this.textures.set(img, t);
    }
    return t;
  }

  /** Show (or hide) the artwork on the body. Texture coordinates are baked from the body in the pose the artwork was projected in. */
  setArtwork(art: BodyArtwork | null): void {
    this.artwork = art;
    const u = this.material.uniforms as Record<string, { value: unknown }>;
    const on = !!art && art.show && !!art.bakedPose && (!!art.front || !!art.back) && !!this.body && !!this.rest;
    u.uClay!.value = on ? 0 : 1;
    u.uShading!.value = on ? art!.shading : 1;
    if (!on || !art || !this.body || !this.rest) {
      this.material.needsUpdate = false;
      return;
    }
    (u.uFill!.value as THREE.Color).set(art.fill);
    u.uHasFront!.value = art.front ? 1 : 0;
    u.uHasBack!.value = art.back ? 1 : 0;
    if (art.front) u.uFront!.value = this.tex(art.front.image);
    if (art.back) u.uBack!.value = this.tex(art.back.image);
    const key = JSON.stringify([art.front?.fit, art.front?.width, art.front?.height, art.back?.fit, art.back?.width, art.back?.height, art.bakedPose, this.shapeKey]);
    if (key === this.artworkKey) return;
    this.artworkKey = key;
    // positions and normals of the body in the pose the artwork was projected in
    const n = this.body.vertexCount;
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    skinBody(this.body, forwardKinematics(this.rest, art.bakedPose!), pos, nor);
    const g = this.geometry!;
    const uvF = g.getAttribute('aUvFront') as THREE.BufferAttribute;
    const uvB = g.getAttribute('aUvBack') as THREE.BufferAttribute;
    const fac = g.getAttribute('aFacing') as THREE.BufferAttribute;
    if (art.front) uvF.array.set(bakeUv(pos, n, art.front.fit, art.front.width, art.front.height, false));
    if (art.back) uvB.array.set(bakeUv(pos, n, art.back.fit, art.back.width, art.back.height, true));
    for (let i = 0; i < n; i++) fac.array[i] = nor[i * 3 + 2]!;
    uvF.needsUpdate = uvB.needsUpdate = fac.needsUpdate = true;
  }

  private buildMarkers(rest: RestSkeleton): void {
    this.markers.forEach((m) => {
      this.group.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    });
    this.markers.clear();
    this.disposables = [];
    const k = rest.scale.k;
    for (const id of POSABLE_JOINTS) {
      const isHandle = HANDLE_JOINTS.includes(id);
      const geo = id === 'pelvis' ? new THREE.OctahedronGeometry(0.05 * k) : new THREE.SphereGeometry((isHandle ? 0.034 : 0.022) * k, 16, 12);
      const m = new THREE.MeshBasicMaterial({ color: isHandle ? 0xff6b57 : 0x7cc8ee, depthTest: false, transparent: true, opacity: 0.95 });
      const mesh = new THREE.Mesh(geo, m);
      mesh.renderOrder = 10;
      mesh.userData.jointId = id;
      this.group.add(mesh);
      this.markers.set(id, mesh);
    }
    this.setSelected(this.selected);
  }

  setSelected(id: JointId | null): void {
    this.selected = id;
    for (const [jid, mesh] of this.markers) {
      const m = mesh.material as THREE.MeshBasicMaterial;
      const handle = HANDLE_JOINTS.includes(jid);
      m.color.set(jid === id ? 0xffe27a : handle ? 0xff6b57 : 0x7cc8ee);
      mesh.scale.setScalar(jid === id ? 1.45 : 1);
    }
  }

  get selection(): JointId | null {
    return this.selected;
  }

  get bodyMesh(): BodyMesh | null {
    return this.body;
  }

  get quality(): BodyQuality {
    return this.lastQuality;
  }

  /** Pose the body. Cheap enough to call on every pointer move. */
  update(w: WorldPose): void {
    if (!this.body || !this.posAttr || !this.norAttr) return;
    skinBody(this.body, w, this.posAttr.array as Float32Array, this.norAttr.array as Float32Array);
    this.posAttr.needsUpdate = true;
    this.norAttr.needsUpdate = true;
    for (const [id, mesh] of this.markers) mesh.position.set(w[id].position.x, w[id].position.y, w[id].position.z);
  }

  /** World-space bounding points of all joints (for depth normalisation). */
  static jointPoints(w: WorldPose): THREE.Vector3[] {
    return JOINT_IDS.map((id) => toV(w[id].position));
  }

  /** Release GPU resources. */
  dispose(): void {
    this.markers.forEach((m) => {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    });
    this.markers.clear();
    this.geometry?.dispose();
    this.material.dispose();
    this.textures.forEach((t) => t.dispose());
    this.textures.clear();
    this.disposables.forEach((d) => d.dispose());
    void this.palette;
  }
}
