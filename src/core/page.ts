import type { CameraState } from '../pose/camera.ts';
import type { Pose3D } from '../pose/pose.ts';
import type { Vec2 } from './math.ts';
import type { ID } from './types.ts';

/**
 * The manga page: panel frames, the characters placed inside them, and the lettering.
 *
 * Everything here is pure data and pure functions — no React, no canvas, no Three.js — so the geometry (gutters, print
 * size, hit testing, text wrapping) is testable in Node and the renderer only has to paint what this module computed.
 *
 * Coordinates are PAGE PIXELS at the page's own DPI, with the origin at the top-left of the TRIM area. Bleed is added
 * around the trim area at export time, so a panel that reaches the page edge bleeds off it correctly.
 */

// ---------------------------------------------------------------- types

export type PanelShape = 'rect' | 'skewed' | 'free';

/** A panel frame. Always a polygon (3+ points) so rect, skewed and free panels render through one code path. */
export interface Panel {
  id: ID;
  name: string;
  shape: PanelShape;
  /** Page pixels, clockwise. */
  points: Vec2[];
}

/** Where a placed image came from, so the panel can be traced back to the character profile and the pose it was made in. */
export interface PlacementSource {
  kind: 'result' | 'canvas' | 'imported';
  /** The generation record this image is (or was) the output of. */
  generationId: ID | null;
  /** The saved pose it was made in, when it matched one. */
  poseId: ID | null;
  poseName: string | null;
  /** Snapshot of the pose and camera, so the panel still knows how the character was standing if the profile changes. */
  pose: Pose3D | null;
  camera: CameraState | null;
  capturedAt: number;
}

/** An image placed on the page. `panelId` null means it sits directly on the page (outside any frame). */
export interface Placement {
  id: ID;
  panelId: ID | null;
  assetId: ID;
  /** Natural pixel size of the image, so the placement can be rebuilt without decoding it. */
  width: number;
  height: number;
  /** Centre of the image, in page pixels. */
  x: number;
  y: number;
  /** Uniform scale: 1 = one image pixel per page pixel. */
  scale: number;
  /** Degrees, clockwise. */
  rotation: number;
  flipX: boolean;
  /** 0..1 */
  opacity: number;
  source: PlacementSource | null;
}

export type BubbleKind = 'speech' | 'thought' | 'caption' | 'shout';

/** Lettering. Drawn above every placement. */
export interface Bubble {
  id: ID;
  kind: BubbleKind;
  text: string;
  /** Centre, in page pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Direction the tail points, in degrees (0 = right, 90 = down). null = no tail. */
  tail: number | null;
  /** Font size in page pixels. */
  fontSize: number;
}

export interface PageState {
  /** Trim size in millimetres. */
  size: { width: number; height: number };
  /** Print resolution. Page pixels = mm / 25.4 * dpi. */
  dpi: number;
  /** Extra margin around the trim area, in millimetres, for print bleed. */
  bleed: number;
  /** Page paper colour. */
  background: string;
  /** Gap between adjacent panels, in millimetres. */
  gutter: number;
  /** Panel border width, in millimetres. 0 = borderless. */
  borderWidth: number;
  borderColor: string;
  panels: Panel[];
  /** Array order = z-order, first = bottom. */
  placements: Placement[];
  /** Array order = z-order, first = bottom. Always drawn above placements. */
  bubbles: Bubble[];
}

export const PAGE_LIMITS = {
  panels: 64,
  placements: 200,
  bubbles: 200,
  minDpi: 72,
  maxDpi: 600,
  maxSideMm: 2000,
  minSideMm: 20,
  text: 2000,
  maxPixels: 100_000_000,
} as const;

export const MM_PER_INCH = 25.4;

// ---------------------------------------------------------------- presets

export interface PagePreset {
  id: string;
  label: string;
  width: number;
  height: number;
  dpi: number;
  note: string;
}

/** Trim sizes in millimetres. B5 is the Japanese manga standard; B4 is used by professional anthologies. */
export const PAGE_PRESETS: PagePreset[] = [
  { id: 'b5', label: 'B5 — manga standard', width: 182, height: 257, dpi: 300, note: '182 × 257 mm · the usual Japanese manga trim size' },
  { id: 'a5', label: 'A5 — small / pocket', width: 148, height: 210, dpi: 300, note: '148 × 210 mm' },
  { id: 'a4', label: 'A4 — doujinshi', width: 210, height: 297, dpi: 300, note: '210 × 297 mm · the usual self-published size' },
  { id: 'b4', label: 'B4 — pro anthology', width: 257, height: 364, dpi: 300, note: '257 × 364 mm' },
  { id: 'square', label: 'Square — social', width: 200, height: 200, dpi: 300, note: '200 × 200 mm' },
  { id: 'webtoon', label: 'Webtoon strip', width: 160, height: 1200, dpi: 150, note: '160 × 1200 mm · screen-native, 150 dpi is plenty' },
];

export type LayoutKind = 'single' | 'two-rows' | 'three-rows' | 'four-grid' | 'classic-6' | 'splash' | 'action-3' | 'webtoon-strip';

/** Panel layouts as fractions of the trim area: [x, y, w, h]. */
export const PAGE_LAYOUTS: { id: LayoutKind; label: string; rects: [number, number, number, number][] }[] = [
  { id: 'single', label: 'One panel', rects: [[0, 0, 1, 1]] },
  { id: 'two-rows', label: 'Two rows', rects: [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]] },
  { id: 'three-rows', label: 'Three rows', rects: [[0, 0, 1, 1 / 3], [0, 1 / 3, 1, 1 / 3], [0, 2 / 3, 1, 1 / 3]] },
  { id: 'four-grid', label: '2 × 2 grid', rects: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]] },
  {
    id: 'classic-6',
    label: 'Classic 6-panel',
    rects: [
      [0, 0, 1, 0.28],
      [0, 0.28, 0.5, 0.24],
      [0.5, 0.28, 0.5, 0.24],
      [0, 0.52, 0.5, 0.24],
      [0.5, 0.52, 0.5, 0.24],
      [0, 0.76, 1, 0.24],
    ],
  },
  { id: 'splash', label: 'Splash + two', rects: [[0, 0, 1, 0.62], [0, 0.62, 0.5, 0.38], [0.5, 0.62, 0.5, 0.38]] },
  { id: 'action-3', label: 'Action 3', rects: [[0, 0, 1, 0.4], [0, 0.4, 0.45, 0.6], [0.45, 0.4, 0.55, 0.6]] },
  { id: 'webtoon-strip', label: 'Webtoon strip', rects: [[0, 0, 1, 0.25], [0, 0.25, 1, 0.25], [0, 0.5, 1, 0.25], [0, 0.75, 1, 0.25]] },
];

export const DEFAULT_PAGE = { width: 182, height: 257, dpi: 300, bleed: 3, gutter: 4, borderWidth: 0.6, background: '#ffffff', borderColor: '#111111' } as const;

// ---------------------------------------------------------------- construction

export function emptyPage(): PageState {
  return {
    size: { width: DEFAULT_PAGE.width, height: DEFAULT_PAGE.height },
    dpi: DEFAULT_PAGE.dpi,
    bleed: DEFAULT_PAGE.bleed,
    background: DEFAULT_PAGE.background,
    gutter: DEFAULT_PAGE.gutter,
    borderWidth: DEFAULT_PAGE.borderWidth,
    borderColor: DEFAULT_PAGE.borderColor,
    panels: [],
    placements: [],
    bubbles: [],
  };
}

/** A new page starts with the classic 6-panel layout, so the artist sees what the page is for immediately. */
export function defaultPage(): PageState {
  const p = emptyPage();
  return { ...p, panels: panelLayout('classic-6', p) };
}

// ---------------------------------------------------------------- units

export const mmToPx = (mm: number, dpi: number): number => (mm / MM_PER_INCH) * dpi;
export const pxToMm = (px: number, dpi: number): number => (px / dpi) * MM_PER_INCH;

/** Trim area in page pixels (what the artist composes on). */
export function pagePixelSize(page: PageState): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(mmToPx(page.size.width, page.dpi))),
    height: Math.max(1, Math.round(mmToPx(page.size.height, page.dpi))),
  };
}

/** Bleed in page pixels. */
export const bleedPx = (page: PageState): number => Math.max(0, Math.round(mmToPx(page.bleed, page.dpi)));

/** Full export size: trim plus bleed on all four sides. */
export function pageExportSize(page: PageState): { width: number; height: number; bleed: number } {
  const t = pagePixelSize(page);
  const b = bleedPx(page);
  return { width: t.width + b * 2, height: t.height + b * 2, bleed: b };
}

/** Effective print resolution of the page as it will be exported. */
export function pagePrintInfo(page: PageState): { width: number; height: number; dpi: number; megapixels: number; mm: string } {
  const s = pageExportSize(page);
  return {
    width: s.width,
    height: s.height,
    dpi: page.dpi,
    megapixels: (s.width * s.height) / 1e6,
    mm: `${page.size.width} × ${page.size.height} mm + ${page.bleed} mm bleed`,
  };
}

// ---------------------------------------------------------------- polygon geometry

/** Signed area. Positive = clockwise in screen coordinates (y down). */
export function signedArea(points: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export const polygonArea = (points: Vec2[]): number => Math.abs(signedArea(points));

/** Clockwise in screen coordinates, which is the orientation the inset maths assumes. */
export function ensureClockwise(points: Vec2[]): Vec2[] {
  return signedArea(points) < 0 ? [...points].reverse() : points;
}

export function polygonBounds(points: Vec2[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

export function polygonCentroid(points: Vec2[]): Vec2 {
  const a = signedArea(points);
  if (Math.abs(a) < 1e-9) {
    const b = polygonBounds(points);
    return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

/** Ray casting. Points exactly on an edge may fall either way, which is fine for hit testing. */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Shrink a convex polygon by `d` on every side, by offsetting each edge inward and intersecting neighbours.
 * This is what makes gutters exact: two panels that share an edge, each inset by gutter/2, end up exactly `gutter` apart.
 * Falls back to the input when the result would be degenerate (a panel narrower than the gutter).
 */
export function insetPolygon(points: Vec2[], d: number): Vec2[] {
  if (points.length < 3 || d === 0) return points;
  const cw = ensureClockwise(points);
  const n = cw.length;
  const lines: { p: Vec2; dir: Vec2 }[] = [];
  for (let i = 0; i < n; i++) {
    const p = cw[i]!;
    const q = cw[(i + 1) % n]!;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return points;
    // inward normal for a clockwise (y-down) polygon
    const nx = -dy / len;
    const ny = dx / len;
    lines.push({ p: { x: p.x + nx * d, y: p.y + ny * d }, dir: { x: dx, y: dy } });
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = lines[(i - 1 + n) % n]!;
    const b = lines[i]!;
    const cross = a.dir.x * b.dir.y - a.dir.y * b.dir.x;
    if (Math.abs(cross) < 1e-9) {
      out.push(b.p);
      continue;
    }
    const t = ((b.p.x - a.p.x) * b.dir.y - (b.p.y - a.p.y) * b.dir.x) / cross;
    out.push({ x: a.p.x + a.dir.x * t, y: a.p.y + a.dir.y * t });
  }
  if (out.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return points;
  // Reject a degenerate result: an inset larger than the shape turns the polygon inside out, and the area check alone
  // does not catch every case (a symmetric collapse can keep a positive area). Requiring every new vertex to lie inside
  // the original polygon is the reliable test.
  if (signedArea(out) <= 0) return points;
  if (!out.every((p) => pointInPolygon(p, cw))) return points;
  return out;
}

/** The polygon a panel is actually painted into: its frame inset by half the gutter. */
export function panelContentPolygon(panel: Panel, page: PageState): Vec2[] {
  return insetPolygon(panel.points, mmToPx(page.gutter, page.dpi) / 2);
}

export const rectToPolygon = (x: number, y: number, w: number, h: number): Vec2[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

/** Turn a rectangle into a parallelogram by sliding the top edge sideways. `amount` is a fraction of the width. */
export function skewPolygon(rect: Vec2[], amount: number): Vec2[] {
  const b = polygonBounds(rect);
  const dx = (b.x1 - b.x0) * amount;
  return [
    { x: b.x0 + dx, y: b.y0 },
    { x: b.x1 + dx, y: b.y0 },
    { x: b.x1, y: b.y1 },
    { x: b.x0, y: b.y1 },
  ];
}

// ---------------------------------------------------------------- layouts

/** Build the panels for a named layout, filling the trim area. */
export function panelLayout(kind: LayoutKind, page: PageState): Panel[] {
  const layout = PAGE_LAYOUTS.find((l) => l.id === kind);
  if (!layout) return [];
  const s = pagePixelSize(page);
  return layout.rects.map((r, i) => ({
    id: `panel_${kind}_${i}`,
    name: `Panel ${i + 1}`,
    shape: 'rect' as PanelShape,
    points: rectToPolygon(r[0] * s.width, r[1] * s.height, r[2] * s.width, r[3] * s.height),
  }));
}

// ---------------------------------------------------------------- text

/**
 * Greedy word wrap. `measure` returns the width of a string in the target font, so this stays pure and testable
 * (the renderer passes a canvas-backed measurer; tests pass a character-count measurer).
 */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) {
        lines.push(line);
        line = '';
      }
      if (measure(word) <= maxWidth) {
        line = word;
        continue;
      }
      // a single word wider than the box: break it by character
      let chunk = '';
      for (const ch of word) {
        if (measure(chunk + ch) <= maxWidth) chunk += ch;
        else {
          if (chunk) lines.push(chunk);
          chunk = ch;
        }
      }
      line = chunk;
    }
    if (line) lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------- bubble outlines

const TAU = Math.PI * 2;

/**
 * The outline of a bubble as a single closed polygon, so it can be filled and stroked without a seam.
 * Speech: an ellipse whose arc is interrupted by a tail triangle. Thought: a scalloped ellipse.
 * Caption: a rectangle. Shout: a spiky star.
 */
export function bubbleOutline(b: Bubble): Vec2[] {
  const rx = Math.max(1, b.width / 2);
  const ry = Math.max(1, b.height / 2);
  const at = (a: number, k = 1): Vec2 => ({ x: b.x + Math.cos(a) * rx * k, y: b.y + Math.sin(a) * ry * k });

  if (b.kind === 'caption') return rectToPolygon(b.x - rx, b.y - ry, b.width, b.height);

  if (b.kind === 'shout') {
    const n = 24;
    const out: Vec2[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      out.push(at(a, i % 2 === 0 ? 1 : 0.82));
    }
    return out;
  }

  if (b.kind === 'thought') {
    const n = 72;
    const out: Vec2[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      out.push(at(a, 1 + 0.055 * Math.sin(a * 9)));
    }
    return out;
  }

  // speech: ellipse with a tail
  const n = 64;
  const spread = 0.32; // radians either side of the tail direction
  if (b.tail === null) {
    const out: Vec2[] = [];
    for (let i = 0; i < n; i++) out.push(at((i / n) * TAU));
    return out;
  }
  const theta = (b.tail * Math.PI) / 180;
  const a0 = theta - spread;
  const a1 = theta + spread;
  const out: Vec2[] = [];
  // walk the long way round from a1 to a0, then out to the tip and back
  for (let i = 0; i <= n; i++) {
    const a = a1 + ((TAU - spread * 2) * i) / n;
    out.push(at(a));
  }
  out.push({ x: b.x + Math.cos(theta) * rx * 1.55, y: b.y + Math.sin(theta) * ry * 1.55 });
  return out;
}

/** The small trailing circles of a thought bubble, from the bubble toward the thinker. */
export function thoughtTrail(b: Bubble): { x: number; y: number; r: number }[] {
  if (b.kind !== 'thought' || b.tail === null) return [];
  const theta = (b.tail * Math.PI) / 180;
  const rx = b.width / 2;
  const ry = b.height / 2;
  const r0 = Math.min(rx, ry) * 0.16;
  return [1.18, 1.5].map((k, i) => ({
    x: b.x + Math.cos(theta) * rx * k,
    y: b.y + Math.sin(theta) * ry * k,
    r: r0 * (1 - i * 0.3),
  }));
}

/** Inner box available for text, in page pixels. */
export function bubbleTextBox(b: Bubble): { x: number; y: number; width: number; height: number } {
  const padX = b.kind === 'caption' ? 0.06 : 0.16;
  const padY = b.kind === 'caption' ? 0.1 : 0.2;
  return { x: b.x - b.width / 2 + b.width * padX, y: b.y - b.height / 2 + b.height * padY, width: b.width * (1 - padX * 2), height: b.height * (1 - padY * 2) };
}

// ---------------------------------------------------------------- placement geometry

export function placementBounds(p: Placement): { x0: number; y0: number; x1: number; y1: number } {
  const w = (p.width * p.scale) / 2;
  const h = (p.height * p.scale) / 2;
  const r = (p.rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  const hw = w * c + h * s;
  const hh = w * s + h * c;
  return { x0: p.x - hw, y0: p.y - hh, x1: p.x + hw, y1: p.y + hh };
}

/** Scale that makes an image cover a panel (like `object-fit: cover`), so a character fills the frame. */
export function coverScale(p: Placement, panel: Panel, page: PageState): number {
  const b = polygonBounds(panelContentPolygon(panel, page));
  const pw = Math.max(1, b.x1 - b.x0);
  const ph = Math.max(1, b.y1 - b.y0);
  return Math.max(pw / p.width, ph / p.height);
}

/** Scale that makes an image fit inside a panel without cropping. */
export function containScale(p: Placement, panel: Panel, page: PageState): number {
  const b = polygonBounds(panelContentPolygon(panel, page));
  const pw = Math.max(1, b.x1 - b.x0);
  const ph = Math.max(1, b.y1 - b.y0);
  return Math.min(pw / p.width, ph / p.height);
}

// ---------------------------------------------------------------- hit testing

export type PageHit = { kind: 'bubble'; id: ID } | { kind: 'placement'; id: ID } | { kind: 'panel'; id: ID } | null;

/** Topmost thing under a page point: bubbles, then placements, then panels. */
export function hitTestPage(page: PageState, p: Vec2): PageHit {
  for (let i = page.bubbles.length - 1; i >= 0; i--) {
    const b = page.bubbles[i]!;
    if (pointInPolygon(p, bubbleOutline(b))) return { kind: 'bubble', id: b.id };
  }
  for (let i = page.placements.length - 1; i >= 0; i--) {
    const pl = page.placements[i]!;
    const b = placementBounds(pl);
    if (p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1) return { kind: 'placement', id: pl.id };
  }
  for (let i = page.panels.length - 1; i >= 0; i--) {
    const panel = page.panels[i]!;
    if (pointInPolygon(p, panel.points)) return { kind: 'panel', id: panel.id };
  }
  return null;
}

// ---------------------------------------------------------------- pure operations

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const finite = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

export function addPanel(page: PageState, panel: Panel): PageState {
  if (page.panels.length >= PAGE_LIMITS.panels) throw new Error(`A page can have at most ${PAGE_LIMITS.panels} panels.`);
  return { ...page, panels: [...page.panels, panel] };
}

export function updatePanel(page: PageState, id: ID, patch: Partial<Omit<Panel, 'id'>>): PageState {
  return { ...page, panels: page.panels.map((p) => (p.id === id ? { ...p, ...patch } : p)) };
}

/** Delete a panel. Placements inside it are kept but become free on the page, so no artwork is lost. */
export function deletePanel(page: PageState, id: ID): PageState {
  return {
    ...page,
    panels: page.panels.filter((p) => p.id !== id),
    placements: page.placements.map((pl) => (pl.panelId === id ? { ...pl, panelId: null } : pl)),
  };
}

export function addPlacement(page: PageState, placement: Placement): PageState {
  if (page.placements.length >= PAGE_LIMITS.placements) throw new Error(`A page can hold at most ${PAGE_LIMITS.placements} images.`);
  return { ...page, placements: [...page.placements, placement] };
}

export function updatePlacement(page: PageState, id: ID, patch: Partial<Omit<Placement, 'id'>>): PageState {
  return {
    ...page,
    placements: page.placements.map((p) => {
      if (p.id !== id) return p;
      const next = { ...p, ...patch };
      return { ...next, scale: Math.max(0.001, finite(next.scale, p.scale)), opacity: clamp01(finite(next.opacity, p.opacity)) };
    }),
  };
}

export function deletePlacement(page: PageState, id: ID): PageState {
  return { ...page, placements: page.placements.filter((p) => p.id !== id) };
}

/** Move a placement one step in the stack. `up` = toward the viewer. */
export function movePlacement(page: PageState, id: ID, dir: 'up' | 'down' | 'top' | 'bottom'): PageState {
  const i = page.placements.findIndex((p) => p.id === id);
  if (i < 0) return page;
  const target = dir === 'up' ? i + 1 : dir === 'down' ? i - 1 : dir === 'top' ? page.placements.length - 1 : 0;
  if (target < 0 || target >= page.placements.length || target === i) return page;
  const next = [...page.placements];
  const [moved] = next.splice(i, 1);
  next.splice(target, 0, moved!);
  return { ...page, placements: next };
}

/**
 * Swap the image behind a placement while keeping its position, scale and rotation — this is how re-posing a character
 * updates the panel: generate a new result, then point the existing placement at it.
 */
export function relinkPlacement(page: PageState, id: ID, assetId: ID, width: number, height: number, source: PlacementSource | null): PageState {
  return updatePlacement(page, id, { assetId, width, height, source });
}

export function addBubble(page: PageState, bubble: Bubble): PageState {
  if (page.bubbles.length >= PAGE_LIMITS.bubbles) throw new Error(`A page can hold at most ${PAGE_LIMITS.bubbles} bubbles.`);
  return { ...page, bubbles: [...page.bubbles, { ...bubble, text: bubble.text.slice(0, PAGE_LIMITS.text) }] };
}

export function updateBubble(page: PageState, id: ID, patch: Partial<Omit<Bubble, 'id'>>): PageState {
  return {
    ...page,
    bubbles: page.bubbles.map((b) => {
      if (b.id !== id) return b;
      const next = { ...b, ...patch };
      return {
        ...next,
        text: next.text.slice(0, PAGE_LIMITS.text),
        width: Math.max(8, finite(next.width, b.width)),
        height: Math.max(8, finite(next.height, b.height)),
        fontSize: Math.max(4, finite(next.fontSize, b.fontSize)),
      };
    }),
  };
}

export function deleteBubble(page: PageState, id: ID): PageState {
  return { ...page, bubbles: page.bubbles.filter((b) => b.id !== id) };
}

/** Change the page size/DPI. Panel and placement coordinates are rescaled so the layout survives the change. */
export function resizePage(page: PageState, size: { width: number; height: number }, dpi: number): PageState {
  const before = pagePixelSize(page);
  const next: PageState = { ...page, size: { ...size }, dpi: Math.min(PAGE_LIMITS.maxDpi, Math.max(PAGE_LIMITS.minDpi, Math.round(dpi))) };
  const after = pagePixelSize(next);
  const sx = after.width / before.width;
  const sy = after.height / before.height;
  if (Math.abs(sx - 1) < 1e-9 && Math.abs(sy - 1) < 1e-9) return next;
  const s = (sx + sy) / 2;
  return {
    ...next,
    panels: page.panels.map((p) => ({ ...p, points: p.points.map((pt) => ({ x: pt.x * sx, y: pt.y * sy })) })),
    placements: page.placements.map((pl) => ({ ...pl, x: pl.x * sx, y: pl.y * sy, scale: pl.scale * s })),
    bubbles: page.bubbles.map((b) => ({ ...b, x: b.x * sx, y: b.y * sy, width: b.width * sx, height: b.height * sy, fontSize: b.fontSize * s })),
  };
}

/** Every asset id the page refers to (for pruning, bundle export and integrity checks). */
export function pageAssetIds(page: PageState): Set<ID> {
  return new Set(page.placements.map((p) => p.assetId));
}

/** Placements whose image is no longer in the project. */
export function danglingPlacements(page: PageState, assetIds: Set<ID>): Placement[] {
  return page.placements.filter((p) => !assetIds.has(p.assetId));
}
