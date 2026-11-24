import type { Mask } from './silhouette.ts';
import { rasterizeTriangles } from './silhouette.ts';

/**
 * Silhouette-conforming texture coordinates.
 *
 * v0.4.1 baked UVs by projecting every vertex straight along Z, so the drawing's outline and the mesh's outline only
 * coincided by luck: where the mesh was wider the extra surface sampled the background, where it was narrower the
 * drawing's outline was cut off, and the face's features slid toward the silhouette.
 *
 * Here the mesh's silhouette is rasterised in the pose the drawing was made in, its boundary vertices are pinned to the
 * nearest pixel of the DRAWING's outline, and the interior is relaxed with a Laplacian solve. The drawing's outline
 * therefore lands on the mesh's outline, and the interior follows smoothly.
 *
 * Everything is pure TypeScript on plain arrays, so it runs in Node tests and in the browser.
 */

/** 1 for every inside pixel that has at least one outside 4-neighbour (the image border counts as outside). */
export function silhouetteBoundary(m: Mask): Uint8Array {
  const out = new Uint8Array(m.w * m.h);
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const i = y * m.w + x;
      if (!m.data[i]) continue;
      const l = x > 0 ? m.data[i - 1]! : 0;
      const r = x < m.w - 1 ? m.data[i + 1]! : 0;
      const u = y > 0 ? m.data[i - m.w]! : 0;
      const d = y < m.h - 1 ? m.data[i + m.w]! : 0;
      if (!l || !r || !u || !d) out[i] = 1;
    }
  }
  return out;
}

export interface BoundaryField {
  /** Euclidean distance (pixels) to the nearest boundary pixel; 0 on the boundary, Infinity when the mask is empty. */
  dist: Float32Array;
  /** Index of the nearest boundary pixel, or -1. */
  index: Int32Array;
}

/**
 * Nearest boundary pixel of a mask, by two-pass chamfer propagation over the 8-neighbourhood. Unlike a plain distance
 * transform this keeps WHICH boundary pixel is nearest, which is what the UV pinning needs.
 */
export function nearestBoundaryField(m: Mask): BoundaryField {
  const n = m.w * m.h;
  const b = silhouetteBoundary(m);
  const dist = new Float32Array(n).fill(Infinity);
  const index = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (b[i]) {
      dist[i] = 0;
      index[i] = i;
    }
  }
  const relax = (i: number, x: number, y: number, nx: number, ny: number): void => {
    const j = ny * m.w + nx;
    const s = index[j]!;
    if (s < 0) return;
    const sx = s % m.w;
    const sy = (s / m.w) | 0;
    const d = (sx - x) * (sx - x) + (sy - y) * (sy - y);
    if (d < dist[i]!) {
      dist[i] = d;
      index[i] = s;
    }
  };
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const i = y * m.w + x;
      if (dist[i] === 0) continue;
      if (x > 0) relax(i, x, y, x - 1, y);
      if (y > 0) {
        relax(i, x, y, x, y - 1);
        if (x > 0) relax(i, x, y, x - 1, y - 1);
        if (x < m.w - 1) relax(i, x, y, x + 1, y - 1);
      }
    }
  }
  for (let y = m.h - 1; y >= 0; y--) {
    for (let x = m.w - 1; x >= 0; x--) {
      const i = y * m.w + x;
      if (dist[i] === 0) continue;
      if (x < m.w - 1) relax(i, x, y, x + 1, y);
      if (y < m.h - 1) {
        relax(i, x, y, x, y + 1);
        if (x < m.w - 1) relax(i, x, y, x + 1, y + 1);
        if (x > 0) relax(i, x, y, x - 1, y + 1);
      }
    }
  }
  for (let i = 0; i < n; i++) dist[i] = Math.sqrt(dist[i]!);
  return { dist, index };
}

/** Undirected vertex adjacency from a triangle index buffer (deduplicated, no self-loops). */
export function meshAdjacency(indices: Uint32Array, vertexCount: number): { start: Uint32Array; list: Uint32Array } {
  const deg = new Uint32Array(vertexCount);
  const bump = (a: number, b: number): void => {
    if (a !== b) deg[a]!++;
  };
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!, b = indices[t + 1]!, c = indices[t + 2]!;
    bump(a, b); bump(b, a); bump(b, c); bump(c, b); bump(c, a); bump(a, c);
  }
  const rawStart = new Uint32Array(vertexCount + 1);
  for (let v = 0; v < vertexCount; v++) rawStart[v + 1] = rawStart[v]! + deg[v]!;
  const raw = new Uint32Array(rawStart[vertexCount]!);
  const fill = rawStart.slice(0, vertexCount);
  const put = (a: number, b: number): void => {
    if (a !== b) raw[fill[a]!++] = b;
  };
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!, b = indices[t + 1]!, c = indices[t + 2]!;
    put(a, b); put(b, a); put(b, c); put(c, b); put(c, a); put(a, c);
  }
  // a vertex shared by several triangles appears once per triangle: sort each neighbour list and drop the repeats, so the
  // Laplacian weights every neighbour equally
  const start = new Uint32Array(vertexCount + 1);
  const list = new Uint32Array(raw.length);
  let w = 0;
  for (let v = 0; v < vertexCount; v++) {
    start[v] = w;
    const a = rawStart[v]!;
    const b = rawStart[v + 1]!;
    if (b > a) {
      const seg = raw.subarray(a, b);
      seg.sort();
      let prev = -1;
      for (let k = 0; k < seg.length; k++) {
        const val = seg[k]!;
        if (val !== prev) {
          list[w++] = val;
          prev = val;
        }
      }
    }
  }
  start[vertexCount] = w;
  return { start, list: list.subarray(0, w) };
}

export interface RelaxOptions {
  /** Projected pixel coordinates of every vertex (2 per vertex), in the SAME pixel space as `mask`. */
  xy: Float32Array;
  indices: Uint32Array;
  /** The drawing's figure mask, at the resolution `xy` is expressed in. */
  mask: Mask;
  /** How far (pixels) a boundary vertex may be pulled to reach the drawing's outline. Beyond this it stays free. */
  maxPull?: number;
  /** Gauss–Seidel sweeps. */
  sweeps?: number;
  /**
   * The mesh's own silhouette to pin against. Pass `facingSilhouette(..., front)` so the front solve only sees the front
   * shell and the back solve only the back shell. Defaults to the union of all triangles.
   */
  silhouette?: Mask;
}

export interface RelaxResult {
  /** New pixel coordinates (2 per vertex). */
  xy: Float32Array;
  /** Number of vertices pinned to the drawing's outline. */
  pinned: number;
  /** Mean displacement of the pinned vertices, in pixels. */
  meanPull: number;
}

/**
 * Move the mesh's texture coordinates so its silhouette boundary sits on the drawing's outline, and relax the interior.
 *
 * Boundary vertices are pinned to the nearest pixel of the drawing's figure outline (when that is within `maxPull`);
 * every other vertex is relaxed toward the mean of its neighbours. This is a harmonic map with Dirichlet boundary
 * conditions: smooth, fold-free for the roughly disk-like regions a limb or a torso projects to, and it converges in a
 * few hundred sweeps.
 */
export function relaxUvToSilhouette(o: RelaxOptions): RelaxResult {
  const { xy, indices, mask } = o;
  const n = xy.length / 2;
  const out = new Float32Array(xy);
  if (n === 0) return { xy: out, pinned: 0, meanPull: 0 };
  const maxPull = o.maxPull ?? Math.max(6, 0.08 * Math.max(mask.w, mask.h));
  const sweeps = o.sweeps ?? 160;

  // the mesh's silhouette in the drawing's pixel space
  const sil = o.silhouette ?? rasterizeTriangles(xy, indices, mask.w, mask.h);
  const silEdge = silhouetteBoundary(sil);
  const art = nearestBoundaryField(mask);

  const pinned = new Uint8Array(n);
  let pinnedCount = 0;
  let pullSum = 0;
  for (let v = 0; v < n; v++) {
    const px = Math.round(xy[v * 2]!);
    const py = Math.round(xy[v * 2 + 1]!);
    if (px < 0 || py < 0 || px >= mask.w || py >= mask.h) continue;
    if (!silEdge[py * mask.w + px]) continue;
    const s = art.index[py * mask.w + px]!;
    if (s < 0) continue;
    const sx = s % mask.w;
    const sy = (s / mask.w) | 0;
    const d = Math.hypot(sx - xy[v * 2]!, sy - xy[v * 2 + 1]!);
    if (d > maxPull) continue; // the drawing does not reach this part of the body: leave it free
    out[v * 2] = sx;
    out[v * 2 + 1] = sy;
    pinned[v] = 1;
    pinnedCount++;
    pullSum += d;
  }

  if (pinnedCount === 0) return { xy: out, pinned: 0, meanPull: 0 };

  const { start, list } = meshAdjacency(indices, n);
  for (let s = 0; s < sweeps; s++) {
    for (let v = 0; v < n; v++) {
      if (pinned[v]) continue;
      const a = start[v]!;
      const b = start[v + 1]!;
      if (b <= a) continue;
      let sx = 0;
      let sy = 0;
      for (let k = a; k < b; k++) {
        const j = list[k]!;
        sx += out[j * 2]!;
        sy += out[j * 2 + 1]!;
      }
      const inv = 1 / (b - a);
      out[v * 2] = sx * inv;
      out[v * 2 + 1] = sy * inv;
    }
  }
  return { xy: out, pinned: pinnedCount, meanPull: pinnedCount ? pullSum / pinnedCount : 0 };
}

/**
 * Nearest-surface depth per pixel (view depth, larger = farther). Triangles of either winding are rasterised, so the
 * result is the depth of the front-most surface at every pixel.
 */
export function depthBuffer(xy: Float32Array, depth: Float32Array, indices: Uint32Array, w: number, h: number): Float32Array {
  const buf = new Float32Array(w * h).fill(Infinity);
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t]!, ib = indices[t + 1]!, ic = indices[t + 2]!;
    const ax = xy[ia * 2]!, ay = xy[ia * 2 + 1]!, az = depth[ia]!;
    const bx = xy[ib * 2]!, by = xy[ib * 2 + 1]!, bz = depth[ib]!;
    const cx = xy[ic * 2]!, cy = xy[ic * 2 + 1]!, cz = depth[ic]!;
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy) - 0.5));
    const maxY = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy) - 0.5));
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 0.5));
    const maxX = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx) - 0.5));
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-12) continue;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den;
        const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
        const z = l1 * az + l2 * bz + l3 * cz;
        const i = y * w + x;
        if (z < buf[i]!) buf[i] = z;
      }
    }
  }
  return buf;
}

/**
 * Per-vertex front/back weight from a depth buffer: 1 when the vertex is on the front-most surface at its pixel, 0 when
 * it is behind it. Smoothed over the mesh so the transition is a band a few vertices wide instead of a hard seam.
 *
 * This replaces v0.4.1's `smoothstep(0.12, 0.55, normal.z)`, which degenerated exactly at the silhouette — where the
 * front and back textures have to meet.
 */
export function visibilityField(
  xy: Float32Array,
  depth: Float32Array,
  indices: Uint32Array,
  w: number,
  h: number,
  eps = 0.02,
  smoothSweeps = 6,
): Float32Array {
  const n = xy.length / 2;
  const buf = depthBuffer(xy, depth, indices, w, h);
  const out = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    const px = Math.min(w - 1, Math.max(0, Math.floor(xy[v * 2]!)));
    const py = Math.min(h - 1, Math.max(0, Math.floor(xy[v * 2 + 1]!)));
    const z = buf[py * w + px]!;
    out[v] = depth[v]! <= z + eps ? 1 : 0;
  }
  if (smoothSweeps > 0) {
    const { start, list } = meshAdjacency(indices, n);
    const tmp = new Float32Array(n);
    for (let s = 0; s < smoothSweeps; s++) {
      for (let v = 0; v < n; v++) {
        const a = start[v]!;
        const b = start[v + 1]!;
        if (b <= a) {
          tmp[v] = out[v]!;
          continue;
        }
        let sum = out[v]!;
        for (let k = a; k < b; k++) sum += out[list[k]!]!;
        tmp[v] = sum / (b - a + 1);
      }
      out.set(tmp);
    }
  }
  return out;
}
