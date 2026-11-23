export interface Vec2 {
  x: number;
  y: number;
}

/** Position / rotation (degrees) / scale of something in canvas space. */
export interface Transform {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

/** 2D affine matrix, canvas convention: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const DEG = Math.PI / 180;
export const toRad = (deg: number): number => deg * DEG;
export const toDeg = (rad: number): number => rad / DEG;

export const add = (p: Vec2, q: Vec2): Vec2 => ({ x: p.x + q.x, y: p.y + q.y });
export const sub = (p: Vec2, q: Vec2): Vec2 => ({ x: p.x - q.x, y: p.y - q.y });
export const len = (p: Vec2): number => Math.hypot(p.x, p.y);
export const dist = (p: Vec2, q: Vec2): number => Math.hypot(p.x - q.x, p.y - q.y);
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const angleDeg = (v: Vec2): number => toDeg(Math.atan2(v.y, v.x));

/** Normalise an angle to (-180, 180]. */
export function normalizeDeg(deg: number): number {
  const r = ((((deg + 180) % 360) + 360) % 360) - 180;
  return r === -180 ? 180 : r;
}

export function rotateVec(v: Vec2, deg: number): Vec2 {
  const r = toRad(deg);
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

export const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Returns A ∘ B (apply B first, then A). */
export function mul(A: Mat, B: Mat): Mat {
  return {
    a: A.a * B.a + A.c * B.b,
    b: A.b * B.a + A.d * B.b,
    c: A.a * B.c + A.c * B.d,
    d: A.b * B.c + A.d * B.d,
    e: A.a * B.e + A.c * B.f + A.e,
    f: A.b * B.e + A.d * B.f + A.f,
  };
}

export function invert(m: Mat): Mat | null {
  const det = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

export function apply(m: Mat, p: Vec2): Vec2 {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

export const translation = (x: number, y: number): Mat => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });

/** T(x,y) · R(rotation) · S(scaleX, scaleY) */
export function fromTRS(t: Transform): Mat {
  const r = toRad(t.rotation);
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { a: c * t.scaleX, b: s * t.scaleX, c: -s * t.scaleY, d: c * t.scaleY, e: t.x, f: t.y };
}

/** Viewport (zoom + pan) conversions. `pan` is the screen position of the canvas origin. */
export interface View {
  zoom: number;
  panX: number;
  panY: number;
}

export const screenToCanvas = (v: View, p: Vec2): Vec2 => ({ x: (p.x - v.panX) / v.zoom, y: (p.y - v.panY) / v.zoom });
export const canvasToScreen = (v: View, p: Vec2): Vec2 => ({ x: p.x * v.zoom + v.panX, y: p.y * v.zoom + v.panY });

/** Zoom keeping the canvas point under `anchor` (screen px) fixed. */
export function zoomAt(v: View, anchor: Vec2, factor: number, min = 0.02, max = 32): View {
  const zoom = clamp(v.zoom * factor, min, max);
  const k = zoom / v.zoom;
  return { zoom, panX: anchor.x - (anchor.x - v.panX) * k, panY: anchor.y - (anchor.y - v.panY) * k };
}

/** View that fits a w×h canvas inside a viewport with padding. */
export function fitView(w: number, h: number, vw: number, vh: number, pad = 48): View {
  const zoom = clamp(Math.min((vw - pad * 2) / w, (vh - pad * 2) / h), 0.02, 32);
  return { zoom, panX: (vw - w * zoom) / 2, panY: (vh - h * zoom) / 2 };
}
