import * as THREE from 'three';
import type { ArtworkFit, BodyMesh, BodyQuality, BodyShape, Bounds2, JointId, Mask, Pose3D, RestSkeleton, WorldPose } from '../pose/index.ts';
import { JOINT_IDS, MAX_VIEWS, POSABLE_JOINTS, boundsXY, buildCharacterMesh, facingSilhouette, forwardKinematics, projectView, relaxUvToSilhouette, skinBody, viewWeights } from '../pose/index.ts';

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
  /** The drawing's figure mask, at the resolution the UV relaxation solves in (see `ArtImage.mask`). */
  mask: Mask;
  /** Mask pixels per full-resolution artwork pixel (see `ArtImage.maskScale`). */
  maskScale: number;
}

/** One drawing, with the angle of the view it was drawn from. */
export interface ArtworkView extends ArtworkImage {
  /** Degrees around Y: 0 = front, +90 = the character's left side, 180 = back. */
  angle: number;
}

/** Everything the body needs to show the artwork. */
export interface BodyArtwork {
  /** The drawings to blend, at most `MAX_VIEWS`, sorted by angle. */
  views: ArtworkView[];
  /** Pose the artwork was projected in. */
  bakedPose: Pose3D | null;
  show: boolean;
  fill: string;
  shading: number;
}

const VERT = /* glsl */ `
attribute float aSide;
attribute vec2 aUv0;
attribute vec2 aUv1;
attribute vec2 aUv2;
attribute vec2 aUv3;
attribute float aW0;
attribute float aW1;
attribute float aW2;
attribute float aW3;
varying vec3 vNormal;
varying float vSide;
varying vec2 vUv0;
varying vec2 vUv1;
varying vec2 vUv2;
varying vec2 vUv3;
varying float vW0;
varying float vW1;
varying float vW2;
varying float vW3;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vSide = aSide;
  vUv0 = aUv0; vUv1 = aUv1; vUv2 = aUv2; vUv3 = aUv3;
  vW0 = aW0; vW1 = aW1; vW2 = aW2; vW3 = aW3;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D uTex0;
uniform sampler2D uTex1;
uniform sampler2D uTex2;
uniform sampler2D uTex3;
uniform float uHas0;
uniform float uHas1;
uniform float uHas2;
uniform float uHas3;
uniform float uShading;
uniform float uClay;
uniform vec3 uFill;
uniform vec3 uClayColor;
uniform vec3 uLeftTint;
uniform vec3 uRightTint;
uniform vec3 uLight;
varying vec3 vNormal;
varying float vSide;
varying vec2 vUv0;
varying vec2 vUv1;
varying vec2 vUv2;
varying vec2 vUv3;
varying float vW0;
varying float vW1;
varying float vW2;
varying float vW3;
void main() {
  vec3 base = uFill;
  if (uClay > 0.5) {
    base = uClayColor;
    base = mix(base, uLeftTint, clamp(vSide, 0.0, 1.0));
    base = mix(base, uRightTint, clamp(-vSide, 0.0, 1.0));
  } else {
    // Multi-view blend: each drawing contributes in proportion to how much this surface faces its view (the weights are
    // computed per vertex from the posed normals, see src/pose/multiView.ts). A flank is painted by the side drawing
    // instead of the front drawing being stretched around it, and the transition between two views is a smooth band.
    // The alpha of each sample is the side-fill's confidence, so a surface just outside a drawing still shows that
    // drawing's edge colour rather than the flat fill.
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    if (uHas0 > 0.5) { vec4 s = texture2D(uTex0, vUv0); float w = vW0 * s.a; acc += s.rgb * w; wsum += w; }
    if (uHas1 > 0.5) { vec4 s = texture2D(uTex1, vUv1); float w = vW1 * s.a; acc += s.rgb * w; wsum += w; }
    if (uHas2 > 0.5) { vec4 s = texture2D(uTex2, vUv2); float w = vW2 * s.a; acc += s.rgb * w; wsum += w; }
    if (uHas3 > 0.5) { vec4 s = texture2D(uTex3, vUv3); float w = vW3 * s.a; acc += s.rgb * w; wsum += w; }
    if (wsum > 1e-4) base = mix(base, acc / wsum, clamp(wsum, 0.0, 1.0));
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
        uTex0: { value: blank },
        uTex1: { value: blank },
        uTex2: { value: blank },
        uTex3: { value: blank },
        uHas0: { value: 0 },
        uHas1: { value: 0 },
        uHas2: { value: 0 },
        uHas3: { value: 0 },
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
    for (let k = 0; k < MAX_VIEWS; k++) {
      g.setAttribute(`aUv${k}`, new THREE.BufferAttribute(new Float32Array(b.vertexCount * 2), 2));
      g.setAttribute(`aW${k}`, new THREE.BufferAttribute(new Float32Array(b.vertexCount), 1));
    }
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
    const views = art ? art.views.slice(0, MAX_VIEWS) : [];
    const on = !!art && art.show && !!art.bakedPose && views.length > 0 && !!this.body && !!this.rest;
    u.uClay!.value = on ? 0 : 1;
    u.uShading!.value = on ? art!.shading : 1;
    if (!on || !art || !this.body || !this.rest) {
      this.material.needsUpdate = false;
      return;
    }
    (u.uFill!.value as THREE.Color).set(art.fill);
    for (let k = 0; k < MAX_VIEWS; k++) {
      const v = views[k];
      u[`uHas${k}`]!.value = v ? 1 : 0;
      if (v) u[`uTex${k}`]!.value = this.tex(v.image);
    }
    const key = JSON.stringify([views.map((v) => [v.angle, v.fit, v.width, v.height]), art.bakedPose, this.shapeKey]);
    if (key === this.artworkKey) return;
    this.artworkKey = key;
    // positions and normals of the body in the pose the artwork was projected in
    const n = this.body.vertexCount;
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    skinBody(this.body, forwardKinematics(this.rest, art.bakedPose!), pos, nor);
    const g = this.geometry!;
    // Texture coordinates are solved against each drawing's outline, not just projected: the mesh's silhouette boundary is
    // pinned to the nearest pixel of that drawing's figure outline and the interior is relaxed (see src/pose/uvRelax.ts).
    // Each view is projected along its OWN axis (`projectView`), and only the shell facing that view is used for the
    // silhouette, so a side drawing is fitted to the body's depth rather than to its width.
    // `fit` is in FULL-resolution artwork pixels; the mask is at working resolution, so the solve runs in mask space
    // (maskScale = mask pixels per full-res pixel) and the result is normalised by the mask size.
    const bake = (img: ArtworkView): Float32Array => {
      const s = img.maskScale;
      const xyFull = projectView(pos, n, img.fit, img.angle);
      const xy = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        xy[i * 2] = xyFull[i * 2]! * s;
        xy[i * 2 + 1] = xyFull[i * 2 + 1]! * s;
      }
      const sil = facingSilhouette(xy, this.body!.indices, img.mask.w, img.mask.h, true);
      const r = relaxUvToSilhouette({ xy, indices: this.body!.indices, mask: img.mask, silhouette: sil });
      const uv = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        uv[i * 2] = r.xy[i * 2]! / img.mask.w;
        uv[i * 2 + 1] = r.xy[i * 2 + 1]! / img.mask.h;
      }
      return uv;
    };
    // Per-vertex blend weights from the posed normals: a surface is painted by the view it faces (src/pose/multiView.ts).
    const weights = viewWeights(nor, n, views.map((v) => v.angle));
    for (let k = 0; k < MAX_VIEWS; k++) {
      const uvAttr = g.getAttribute(`aUv${k}`) as THREE.BufferAttribute;
      const wAttr = g.getAttribute(`aW${k}`) as THREE.BufferAttribute;
      const v = views[k];
      if (v) {
        uvAttr.array.set(bake(v));
        for (let i = 0; i < n; i++) wAttr.array[i] = weights[i * views.length + k]!;
      } else {
        (uvAttr.array as Float32Array).fill(0);
        (wAttr.array as Float32Array).fill(0);
      }
      uvAttr.needsUpdate = true;
      wAttr.needsUpdate = true;
    }
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
