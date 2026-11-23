import * as THREE from 'three';
import type { BodyShape, Box, CameraState, ChainId, JointId, Pose3D, RestSkeleton } from '../pose/index.ts';
import { CAMERA_LIMITS, CHAINS, alignFit, clampCamera, forwardKinematics, moveRootPinned, qFromAxisAngle, qMul, rotateJointByWorldDelta, solveLimbIk, cameraBasis, chainForEnd, qRotate } from '../pose/index.ts';
import type { BodyArtwork } from './characterBody.ts';
import { CharacterBody, HANDLE_JOINTS } from './characterBody.ts';

export type GesturePhase = 'start' | 'drag' | 'end';

export interface ViewportCallbacks {
  onPose(pose: Pose3D, phase: GesturePhase): void;
  onCamera(camera: CameraState): void;
  onSelect(id: JointId | null): void;
  onNotice(message: string): void;
}

export interface ViewportState {
  rest: RestSkeleton;
  shape: BodyShape;
  pose: Pose3D;
  camera: CameraState;
  /** Artwork projected onto the body (null = clay model). */
  artwork: BodyArtwork | null;
  /** Translucent copy of the drawing, lined up with the body's silhouette, for matching size and proportions. */
  overlay: { show: boolean; opacity: number; image: TexImageSource | null; width: number; height: number; box: Box | null };
  /** Output image aspect (width / height). The viewport shows exactly this frame, so what you see is what is rendered. */
  aspect: number;
  selected: JointId | null;
  pinFeet: boolean;
  showHandles: boolean;
  showGrid: boolean;
}

type Drag =
  | { kind: 'ik'; chain: ChainId; plane: THREE.Plane; offset: THREE.Vector3; pose: Pose3D; moved: boolean }
  | { kind: 'root'; plane: THREE.Plane; start: THREE.Vector3; pose0: Pose3D; pose: Pose3D; moved: boolean }
  | { kind: 'rotate'; id: JointId; x0: number; y0: number; pose0: Pose3D; pose: Pose3D; moved: boolean }
  | { kind: 'orbit' | 'pan'; x0: number; y0: number; cam0: CameraState; moved: boolean };

const v3 = (v: THREE.Vector3) => ({ x: v.x, y: v.y, z: v.z });

export class StudioViewport {
  private readonly host: HTMLElement;
  private readonly cb: ViewportCallbacks;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 2 / 3, 0.05, 100);
  private body: CharacterBody;
  private lastBodyKey = '';
  private overlayMesh: THREE.Mesh | null = null;
  private overlayTex: THREE.Texture | null = null;
  private overlayImage: TexImageSource | null = null;
  private readonly grid: THREE.Group;
  private readonly facing: THREE.Mesh;
  private readonly ray = new THREE.Raycaster();
  private state: ViewportState;
  private drag: Drag | null = null;
  private frame = 0;
  private disposed = false;
  private readonly ro: ResizeObserver;
  private cssW = 1;
  private cssH = 1;

  constructor(host: HTMLElement, initial: ViewportState, cb: ViewportCallbacks) {
    this.host = host;
    this.cb = cb;
    this.state = initial;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const el = this.renderer.domElement;
    el.style.cssText = 'position:absolute;display:block;touch-action:none;outline:none;border-radius:2px;box-shadow:0 0 0 1px #343a46';
    el.tabIndex = 0;
    el.setAttribute('data-testid', 'studio-canvas');
    host.appendChild(el);

    this.scene.background = new THREE.Color(0x1d2128);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x4a5568, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1.5, 2.5, 3);
    this.camera.add(key);
    this.scene.add(this.camera);

    this.grid = new THREE.Group();
    const gridHelper = new THREE.GridHelper(6, 24, 0x445066, 0x2a303b);
    const disk = new THREE.Mesh(new THREE.CircleGeometry(0.75, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x252b35 }));
    disk.position.y = -0.002;
    this.grid.add(gridHelper, disk);
    this.scene.add(this.grid);

    const shape = new THREE.Shape();
    shape.moveTo(0, 0.2);
    shape.lineTo(0.11, -0.05);
    shape.lineTo(0, 0.0);
    shape.lineTo(-0.11, -0.05);
    shape.closePath();
    this.facing = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffb454, side: THREE.DoubleSide }));
    this.facing.position.y = 0.004;
    this.scene.add(this.facing);

    this.body = new CharacterBody('viewport');
    this.scene.add(this.body.group);

    // Listen on the host, not the canvas: the canvas is letterboxed to the output aspect, and dragging in the grey area
    // around the frame should still orbit/pan/zoom.
    host.style.touchAction = 'none';
    host.addEventListener('pointerdown', this.onDown);
    host.addEventListener('pointermove', this.onMove);
    host.addEventListener('pointerup', this.onUp);
    host.addEventListener('pointercancel', this.onUp);
    host.addEventListener('wheel', this.onWheel, { passive: false });
    host.addEventListener('contextmenu', this.noMenu);
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(host);
    this.applyState(initial, true);
  }

  // ------------------------------------------------------------------ state

  setState(next: Partial<ViewportState>): void {
    if (this.disposed) return;
    const merged = { ...this.state, ...next };
    const relayout = merged.aspect !== this.state.aspect;
    this.state = merged;
    this.applyState(merged, relayout);
  }

  private applyState(s: ViewportState, relayout: boolean): void {
    const bodyKey = JSON.stringify([s.rest.proportions, s.shape]);
    if (bodyKey !== this.lastBodyKey) {
      this.lastBodyKey = bodyKey;
      this.body.setBody(s.rest, s.shape, 'normal'); // the model's skinning is cheap, so sliders update the body live
    }
    this.body.setArtwork(s.artwork);
    this.body.group.traverse((o) => {
      if (o.userData.jointId) o.visible = s.showHandles;
    });
    this.grid.visible = s.showGrid;
    this.body.setSelected(s.selected);
    const w = forwardKinematics(s.rest, s.pose);
    this.body.update(w);
    this.syncOverlay(s);
    const f = qRotate(w.pelvis.rotation, { x: 0, y: 0, z: 1 });
    this.facing.position.set(w.pelvis.position.x + f.x * 0.45, 0.004, w.pelvis.position.z + f.z * 0.45);
    this.facing.rotation.y = Math.atan2(f.x, f.z);
    this.syncCamera();
    if (relayout) this.layout();
    this.invalidate();
  }

  /** The drawing as a translucent card behind/over the body, scaled so its figure is as tall as the body's current silhouette. */
  private syncOverlay(s: ViewportState): void {
    const o = s.overlay;
    const bounds = this.body.posedBounds();
    if (!o.show || !o.image || !o.box || !bounds) {
      if (this.overlayMesh) this.overlayMesh.visible = false;
      return;
    }
    if (this.overlayImage !== o.image) {
      this.overlayTex?.dispose();
      const t = new THREE.Texture(o.image as unknown as HTMLImageElement);
      t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
      this.overlayTex = t;
      this.overlayImage = o.image;
      if (!this.overlayMesh) {
        this.overlayMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
        this.overlayMesh.renderOrder = 6;
        this.scene.add(this.overlayMesh);
      }
      (this.overlayMesh.material as THREE.MeshBasicMaterial).map = t;
      (this.overlayMesh.material as THREE.MeshBasicMaterial).needsUpdate = true;
    }
    const fit = alignFit(bounds, o.box);
    const m = this.overlayMesh!;
    m.visible = true;
    (m.material as THREE.MeshBasicMaterial).opacity = o.opacity;
    m.scale.set(o.width / fit.ppm, o.height / fit.ppm, 1);
    m.position.set((o.width / 2 - fit.ox) / fit.ppm, (fit.oy - o.height / 2) / fit.ppm, 0);
  }

  private syncCamera(): void {
    const c = this.state.camera;
    const b = cameraBasis(c);
    this.camera.position.set(b.position.x, b.position.y, b.position.z);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(c.target.x, c.target.y, c.target.z);
    this.camera.fov = c.fov;
    this.camera.aspect = this.state.aspect;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
  }

  /** Fit the output-aspect frame inside the host and centre it. */
  private layout(): void {
    const hw = Math.max(this.host.clientWidth, 1);
    const hh = Math.max(this.host.clientHeight, 1);
    const pad = 12;
    const aw = Math.max(hw - pad * 2, 1);
    const ah = Math.max(hh - pad * 2, 1);
    let w = aw;
    let h = w / this.state.aspect;
    if (h > ah) {
      h = ah;
      w = h * this.state.aspect;
    }
    w = Math.max(Math.floor(w), 1);
    h = Math.max(Math.floor(h), 1);
    this.cssW = w;
    this.cssH = h;
    this.renderer.setSize(w, h, false);
    const el = this.renderer.domElement;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.style.left = `${Math.floor((hw - w) / 2)}px`;
    el.style.top = `${Math.floor((hh - h) / 2)}px`;
    this.syncCamera();
    this.invalidate();
  }

  private invalidate(): void {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.disposed) return;
      this.renderer.render(this.scene, this.camera);
    });
  }

  /** Render synchronously (used by tests and before reading pixels). */
  renderNow(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** Screen position (CSS px, relative to the host) of a joint — handy for tests and overlays. */
  jointScreenPosition(id: JointId): { x: number; y: number } {
    const w = forwardKinematics(this.state.rest, this.state.pose)[id].position;
    const v = new THREE.Vector3(w.x, w.y, w.z).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    const h = this.host.getBoundingClientRect();
    return { x: r.left - h.left + ((v.x + 1) / 2) * r.width, y: r.top - h.top + ((1 - v.y) / 2) * r.height };
  }

  // ------------------------------------------------------------------ interaction

  private ndc(e: PointerEvent | WheelEvent): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
  }

  private pickJoint(e: PointerEvent): JointId | null {
    if (!this.state.showHandles) return null;
    this.ray.setFromCamera(this.ndc(e), this.camera);
    const hits = this.ray.intersectObjects([...this.body.markers.values()], false);
    // Prefer handles (wrists/ankles/pelvis) when markers overlap.
    const ordered = hits.sort((a, b) => Number(HANDLE_JOINTS.includes(b.object.userData.jointId)) - Number(HANDLE_JOINTS.includes(a.object.userData.jointId)) || a.distance - b.distance);
    return (ordered[0]?.object.userData.jointId as JointId | undefined) ?? null;
  }

  private planeThrough(point: THREE.Vector3): THREE.Plane {
    const n = new THREE.Vector3();
    this.camera.getWorldDirection(n);
    return new THREE.Plane().setFromNormalAndCoplanarPoint(n, point);
  }

  private hitPlane(e: PointerEvent, plane: THREE.Plane): THREE.Vector3 | null {
    this.ray.setFromCamera(this.ndc(e), this.camera);
    return this.ray.ray.intersectPlane(plane, new THREE.Vector3());
  }

  private noMenu = (e: Event): void => e.preventDefault();

  private onDown = (e: PointerEvent): void => {
    if (this.drag) return;
    const el = this.host;
    this.renderer.domElement.focus({ preventScroll: true });
    const { rest, pose, camera } = this.state;
    const id = e.button === 0 && !e.altKey ? this.pickJoint(e) : null;
    if (id) {
      this.cb.onSelect(id);
      const world = forwardKinematics(rest, pose);
      const jp = new THREE.Vector3(world[id].position.x, world[id].position.y, world[id].position.z);
      const chain = chainForEnd(id);
      if (chain) {
        const plane = this.planeThrough(jp);
        const hit = this.hitPlane(e, plane) ?? jp.clone();
        this.drag = { kind: 'ik', chain: chain.id, plane, offset: jp.clone().sub(hit), pose, moved: false };
      } else if (id === 'pelvis') {
        const plane = e.shiftKey ? new THREE.Plane(new THREE.Vector3(0, 1, 0), -jp.y) : this.planeThrough(jp);
        this.drag = { kind: 'root', plane, start: this.hitPlane(e, plane) ?? jp.clone(), pose0: pose, pose, moved: false };
      } else {
        this.drag = { kind: 'rotate', id, x0: e.clientX, y0: e.clientY, pose0: pose, pose, moved: false };
      }
    } else {
      const pan = e.button === 2 || e.button === 1 || e.shiftKey;
      this.drag = { kind: pan ? 'pan' : 'orbit', x0: e.clientX, y0: e.clientY, cam0: camera, moved: false };
    }
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  private onMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d) {
      const over = this.pickJoint(e);
      this.host.style.cursor = over ? (HANDLE_JOINTS.includes(over) ? 'grab' : 'pointer') : 'default';
      return;
    }
    const { rest } = this.state;
    if (d.kind === 'ik') {
      const hit = this.hitPlane(e, d.plane);
      if (!hit) return;
      if (!d.moved) {
        d.moved = true;
        this.cb.onPose(d.pose, 'start');
      }
      const r = solveLimbIk(rest, d.pose, d.chain, v3(hit.add(d.offset)));
      d.pose = r.pose;
      this.cb.onPose(r.pose, 'drag');
      if (!r.reached) this.cb.onNotice(`${CHAINS[d.chain].end.replace(/L$/, ' (left)').replace(/R$/, ' (right)')} is at the limit of its reach.`);
    } else if (d.kind === 'root') {
      const hit = this.hitPlane(e, d.plane);
      if (!hit) return;
      if (!d.moved) {
        d.moved = true;
        this.cb.onPose(d.pose, 'start');
      }
      const delta = hit.sub(d.start);
      const root = { x: d.pose0.root.x + delta.x, y: d.pose0.root.y + delta.y, z: d.pose0.root.z + delta.z };
      let next: Pose3D = { ...d.pose0, root };
      if (this.state.pinFeet) {
        const r = moveRootPinned(rest, d.pose0, root, ['legL', 'legR']);
        next = r.pose;
        if (r.unreachable.length) this.cb.onNotice('A planted foot cannot follow that far — the legs are fully stretched.');
      }
      d.pose = next;
      this.cb.onPose(next, 'drag');
    } else if (d.kind === 'rotate') {
      const dx = e.clientX - d.x0;
      const dy = e.clientY - d.y0;
      if (!d.moved && Math.hypot(dx, dy) < 3) return;
      if (!d.moved) {
        d.moved = true;
        this.cb.onPose(d.pose, 'start');
      }
      const b = cameraBasis(this.state.camera);
      const yaw = qFromAxisAngle(b.up, dx * 0.012);
      const pitch = qFromAxisAngle(b.right, dy * 0.012);
      d.pose = rotateJointByWorldDelta(rest, d.pose0, d.id, qMul(yaw, pitch));
      this.cb.onPose(d.pose, 'drag');
    } else {
      const dx = e.clientX - d.x0;
      const dy = e.clientY - d.y0;
      if (!d.moved && Math.hypot(dx, dy) < 2) return;
      d.moved = true;
      let next: CameraState;
      if (d.kind === 'orbit') {
        next = clampCamera({ ...d.cam0, azimuth: d.cam0.azimuth - dx * 0.4, elevation: d.cam0.elevation + dy * 0.4 });
      } else {
        const b = cameraBasis(d.cam0);
        const k = (2 * d.cam0.distance * Math.tan((d.cam0.fov * Math.PI) / 360)) / this.cssH;
        next = { ...d.cam0, target: { x: d.cam0.target.x + (-b.right.x * dx + b.up.x * dy) * k, y: d.cam0.target.y + (-b.right.y * dx + b.up.y * dy) * k, z: d.cam0.target.z + (-b.right.z * dx + b.up.z * dy) * k } };
      }
      this.state = { ...this.state, camera: next };
      this.syncCamera();
      this.invalidate();
      this.cb.onCamera(next);
    }
  };

  private onUp = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const el = this.host;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if ((d.kind === 'ik' || d.kind === 'root' || d.kind === 'rotate') && d.moved) this.cb.onPose(d.pose, 'end');
    else if ((d.kind === 'orbit' || d.kind === 'pan') && !d.moved) this.cb.onSelect(null);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const c = this.state.camera;
    const distance = Math.min(CAMERA_LIMITS.distance.max, Math.max(CAMERA_LIMITS.distance.min, c.distance * Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) * 0.0015)));
    const next = { ...c, distance };
    this.state = { ...this.state, camera: next };
    this.syncCamera();
    this.invalidate();
    this.cb.onCamera(next);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.ro.disconnect();
    const el = this.renderer.domElement;
    const h = this.host;
    h.removeEventListener('pointerdown', this.onDown);
    h.removeEventListener('pointermove', this.onMove);
    h.removeEventListener('pointerup', this.onUp);
    h.removeEventListener('pointercancel', this.onUp);
    h.removeEventListener('wheel', this.onWheel);
    h.removeEventListener('contextmenu', this.noMenu);
    this.body.dispose();
    this.overlayTex?.dispose();
    this.overlayMesh?.geometry.dispose();
    (this.overlayMesh?.material as THREE.Material | undefined)?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    el.remove();
  }
}
