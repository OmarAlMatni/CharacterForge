import type { Mask } from './silhouette.ts';
import { facingWeight, viewDirection, viewRight } from './projection.ts';

/**
 * Multi-view projection: blending N drawings (front / three-quarter / side / back) across the body by how much each
 * surface faces each view.
 *
 * v0.5.0 blended exactly two textures by a depth-derived front/back weight. That fixed the seam, but a front drawing
 * still says nothing about the side of a torso: the side-fill extends the silhouette's colour around the curve, it does
 * not invent detail. When the artist supplies a side or a back drawing, this module decides which drawing drives which
 * part of the model, so the flank is painted by the side view instead of being extrapolated from the front.
 *
 * The rule is geometric and needs no per-view masks beyond the drawings' own figure masks: a surface is painted by the
 * view it faces. A vertex whose normal points at the front camera is painted by the front drawing; one on the flank is
 * painted by the side drawing; one on the back by the back drawing. Weights are `max(0, n·d)^power`, normalised, so
 * they sum to 1 and the transition between two views is a smooth band rather than a seam.
 */

/** One drawing supplied for a view. */
export interface ViewInput {
  /** Degrees around Y: 0 = front, +90 = the character's left side, 180 = back. */
  angle: number;
  /** The drawing's figure mask, at the resolution the UV solve runs in. */
  mask: Mask;
}

/** A view's angle, normalised to [0, 360). */
export function normalizeAngle(angle: number): number {
  const a = angle % 360;
  return a < 0 ? a + 360 : a;
}

/**
 * Sort views by angle and drop duplicates that are closer than `minSeparation` degrees (two drawings at the same angle
 * would fight over the same surface). The first of a too-close pair wins, so the artist's earlier view is kept.
 */
export function distinctViews<T extends { angle: number }>(views: T[], minSeparation = 12): T[] {
  const sorted = [...views].sort((a, b) => normalizeAngle(a.angle) - normalizeAngle(b.angle));
  const out: T[] = [];
  for (const v of sorted) {
    const a = normalizeAngle(v.angle);
    if (out.some((o) => {
      const d = Math.abs(normalizeAngle(o.angle) - a);
      return Math.min(d, 360 - d) < minSeparation;
    })) continue;
    out.push(v);
  }
  return out;
}

/**
 * Per-vertex blend weights for a set of views, from the posed normals.
 *
 * Returns `count * views.length` weights, row-major by vertex (vertex v, view k at `v * views.length + k`). Each row
 * sums to 1. A vertex that faces no view at all (a surface exactly at a silhouette, or a view set that does not cover
 * that side) is given entirely to the view whose direction it is closest to, so no vertex is ever left unpainted.
 */
export function viewWeights(
  normals: Float32Array | Float64Array,
  count: number,
  angles: number[],
  power = 1.5,
): Float32Array {
  const k = angles.length;
  const out = new Float32Array(count * k);
  if (k === 0) return out;
  for (let v = 0; v < count; v++) {
    const nx = normals[v * 3]!;
    const ny = normals[v * 3 + 1]!;
    const nz = normals[v * 3 + 2]!;
    let sum = 0;
    let best = 0;
    let bestDot = -Infinity;
    for (let i = 0; i < k; i++) {
      const w = facingWeight(nx, ny, nz, angles[i]!, power);
      out[v * k + i] = w;
      sum += w;
      const d = viewDirection(angles[i]!);
      const c = nx * d.x + ny * d.y + nz * d.z;
      if (c > bestDot) {
        bestDot = c;
        best = i;
      }
    }
    if (sum > 1e-6) {
      const inv = 1 / sum;
      for (let i = 0; i < k; i++) out[v * k + i] = out[v * k + i]! * inv;
    } else {
      // no view faces this surface: hand it to the nearest one rather than leaving it to the fill colour
      for (let i = 0; i < k; i++) out[v * k + i] = i === best ? 1 : 0;
    }
  }
  return out;
}

/**
 * Which view drives each vertex, as an index per vertex. Used by the UI to show the artist which drawing is painting
 * which part of the model, and by the tests to assert that a flank is driven by the side view.
 */
export function dominantViewPerVertex(weights: Float32Array, count: number, views: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let v = 0; v < count; v++) {
    let best = 0;
    let bestW = -1;
    for (let i = 0; i < views; i++) {
      const w = weights[v * views + i]!;
      if (w > bestW) {
        bestW = w;
        best = i;
      }
    }
    out[v] = best;
  }
  return out;
}

/**
 * The share of the body's surface each view paints, as a fraction of the total weight (0..1 per view, summing to 1).
 * A quick way to tell the artist "your side drawing is doing 18% of the work" and to catch a view that is mis-angled
 * (a side drawing at 90° that paints almost nothing means the model's depth is far too thin).
 */
export function viewCoverage(weights: Float32Array, count: number, views: number): number[] {
  const out = new Array<number>(views).fill(0);
  if (count === 0) return out;
  for (let v = 0; v < count; v++) {
    for (let i = 0; i < views; i++) out[i]! += weights[v * views + i]!;
  }
  const total = count;
  return out.map((s) => s / total);
}

/**
 * The horizontal extent of the model along a view's right axis, for fitting that view's drawing. A side view's
 * horizontal axis is the body's depth, so it must be fitted against the depth extent, not the width.
 */
export function viewExtent(
  positions: Float32Array | Float64Array,
  count: number,
  angle: number,
): { min: number; max: number } {
  const r = viewRight(angle);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < count; i++) {
    const u = positions[i * 3]! * r.x + positions[i * 3 + 2]! * r.z;
    if (u < min) min = u;
    if (u > max) max = u;
  }
  return { min, max };
}
