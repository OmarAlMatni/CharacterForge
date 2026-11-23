import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { DEG } from '../core/math.ts';
import type { Transform, Vec2, View } from '../core/math.ts';
import { effectiveOpacity, isEffectivelyVisible, renderOrder } from '../core/layers.ts';
import type { DocState, ID } from '../core/types.ts';
import type { BitmapStore } from './bitmaps.ts';

export interface OverlayJoint {
  id: ID;
  pos: Vec2;
  parentPos: Vec2 | null;
  selected: boolean;
  /** Part of the IK chain that would move if this joint is dragged. */
  chain: boolean;
}

export interface OverlaySelection {
  /** TL, TR, BR, BL in canvas space */
  corners: Vec2[];
  rotateHandle: Vec2;
  pivot: Vec2;
}

export interface OverlayData {
  zoom: number;
  canvas: { width: number; height: number };
  selection: OverlaySelection | null;
  /** Outlines for additional selected layers. */
  extraBoxes: Vec2[][];
  joints: OverlayJoint[];
}

const ACCENT = 0x7cc8ee;
const PEN = 0xff6b57;
const flat = (pts: Vec2[]): number[] => pts.flatMap((p) => [p.x, p.y]);

/** PixiJS scene: checkerboard artboard, layer sprites, and an interaction overlay. Export does NOT use this. */
export class Stage {
  private app: Application;
  private world = new Container();
  private board = new Graphics();
  private layersC = new Container();
  private overlay = new Graphics();
  private sprites = new Map<ID, Sprite>();
  private textures = new Map<HTMLCanvasElement, Texture>();
  private boardKey = '';

  private constructor(app: Application) {
    this.app = app;
    this.world.addChild(this.board, this.layersC, this.overlay);
    app.stage.addChild(this.world);
  }

  static async create(host: HTMLElement): Promise<Stage> {
    const app = new Application();
    await app.init({ background: 0x1b1e24, resizeTo: host, antialias: true, autoDensity: true, resolution: window.devicePixelRatio || 1 });
    host.appendChild(app.canvas);
    return new Stage(app);
  }

  get canvasElement(): HTMLCanvasElement {
    return this.app.canvas as HTMLCanvasElement;
  }

  /** Hide the whole scene when no project is open. */
  setActive(active: boolean): void {
    this.world.visible = active;
  }

  setView(v: View): void {
    this.world.position.set(v.panX, v.panY);
    this.world.scale.set(v.zoom);
  }

  /** Transparent-background checkerboard. Tile size scales with the artboard to keep the shape count small. */
  private drawBoard(w: number, h: number): void {
    const key = `${w}x${h}`;
    if (key === this.boardKey) return;
    this.boardKey = key;
    const tile = Math.max(16, Math.ceil(Math.max(w, h) / 64));
    const g = this.board;
    g.clear();
    g.rect(0, 0, w, h).fill(0xf4f5f7);
    for (let y = 0, r = 0; y < h; y += tile, r++) {
      for (let x = 0, c = 0; x < w; x += tile, c++) {
        if ((r + c) % 2 === 1) g.rect(x, y, Math.min(tile, w - x), Math.min(tile, h - y));
      }
    }
    g.fill(0xdde1e7);
  }

  sync(doc: DocState, placements: Map<ID, Transform>, bitmaps: BitmapStore): void {
    this.drawBoard(doc.canvas.width, doc.canvas.height);
    const inUse = new Set<HTMLCanvasElement>();
    const seen = new Set<ID>();
    this.layersC.removeChildren();
    for (const layer of renderOrder(doc.layers)) {
      const bmp = bitmaps.get(layer);
      const pl = placements.get(layer.id);
      if (!bmp || !pl) continue;
      inUse.add(bmp);
      let tex = this.textures.get(bmp);
      if (!tex) {
        tex = Texture.from(bmp);
        this.textures.set(bmp, tex);
      }
      let sp = this.sprites.get(layer.id);
      if (!sp) {
        sp = new Sprite(tex);
        this.sprites.set(layer.id, sp);
      } else if (sp.texture !== tex) {
        sp.texture = tex;
      }
      sp.pivot.set(layer.pivot.x, layer.pivot.y);
      sp.position.set(pl.x, pl.y);
      sp.rotation = pl.rotation * DEG;
      sp.scale.set(pl.scaleX, pl.scaleY);
      sp.alpha = effectiveOpacity(doc.layers, layer.id);
      sp.visible = isEffectivelyVisible(doc.layers, layer.id);
      this.layersC.addChild(sp);
      seen.add(layer.id);
    }
    for (const [id, sp] of this.sprites) {
      if (!seen.has(id)) {
        sp.destroy();
        this.sprites.delete(id);
      }
    }
    for (const [canvas, tex] of this.textures) {
      if (!inUse.has(canvas)) {
        tex.destroy(true);
        this.textures.delete(canvas);
      }
    }
  }

  drawOverlay(o: OverlayData): void {
    const g = this.overlay;
    const z = o.zoom;
    const lw = 1.5 / z;
    const hs = 5 / z;
    g.clear();
    g.rect(0, 0, o.canvas.width, o.canvas.height).stroke({ width: 1 / z, color: ACCENT, alpha: 0.55 });
    for (const box of o.extraBoxes) g.poly(flat(box), true).stroke({ width: lw, color: ACCENT, alpha: 0.7 });
    const s = o.selection;
    if (s) {
      g.poly(flat(s.corners), true).stroke({ width: lw, color: ACCENT });
      const tc = { x: (s.corners[0]!.x + s.corners[1]!.x) / 2, y: (s.corners[0]!.y + s.corners[1]!.y) / 2 };
      g.moveTo(tc.x, tc.y).lineTo(s.rotateHandle.x, s.rotateHandle.y).stroke({ width: lw, color: ACCENT });
      g.circle(s.rotateHandle.x, s.rotateHandle.y, hs * 1.15).fill(0xffffff).stroke({ width: lw, color: ACCENT });
      for (const c of s.corners) g.rect(c.x - hs, c.y - hs, hs * 2, hs * 2).fill(0xffffff).stroke({ width: lw, color: ACCENT });
      const p = s.pivot;
      g.moveTo(p.x - hs * 2, p.y).lineTo(p.x + hs * 2, p.y).moveTo(p.x, p.y - hs * 2).lineTo(p.x, p.y + hs * 2).stroke({ width: lw, color: PEN });
      g.circle(p.x, p.y, hs * 0.9).stroke({ width: lw, color: PEN });
    }
    for (const j of o.joints) {
      if (j.parentPos) g.moveTo(j.parentPos.x, j.parentPos.y).lineTo(j.pos.x, j.pos.y).stroke({ width: 3 / z, color: j.chain ? ACCENT : 0x20242b, alpha: 0.9 });
    }
    for (const j of o.joints) {
      if (j.parentPos) g.moveTo(j.parentPos.x, j.parentPos.y).lineTo(j.pos.x, j.pos.y).stroke({ width: 1.5 / z, color: j.chain ? 0xffffff : 0xf4f5f7, alpha: 0.95 });
    }
    for (const j of o.joints) {
      g.circle(j.pos.x, j.pos.y, (j.selected ? 7 : 5.5) / z).fill(j.selected ? 0xffffff : PEN).stroke({ width: 1.5 / z, color: j.selected ? PEN : 0x20242b });
    }
  }

  destroy(): void {
    for (const t of this.textures.values()) t.destroy(true);
    this.textures.clear();
    this.sprites.clear();
    this.app.destroy(true, { children: true });
  }
}
