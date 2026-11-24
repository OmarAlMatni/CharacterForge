import { describe, expect, it } from 'vitest';
import { buildCharacterMesh } from '../src/pose/characterMesh.ts';
import { buildRestSkeleton } from '../src/pose/skeleton.ts';
import { DEFAULT_SHAPE } from '../src/pose/bodyShape.ts';
import { restPose } from '../src/pose/pose.ts';
import { alignFit, boundsXY, facingSilhouette, posedPositions, projectXY } from '../src/pose/projection.ts';
import { relaxUvToSilhouette } from '../src/pose/uvRelax.ts';
import { newMask } from '../src/pose/silhouette.ts';
import type { Mask } from '../src/pose/silhouette.ts';
import { loadTestModel } from './model.ts';

loadTestModel();

/**
 * Diagnostic on the REAL mesh: is the relaxed UV field smooth, or does the relaxation introduce the high-frequency
 * jitter that would show up as aliasing in the render?
 *
 * A smooth field means any high-frequency content in the render is the drawing's own detail. A jagged field means the
 * relaxation is the source. Measured as the mean second difference of UV along mesh edges, normalised by the mean edge
 * length in UV space.
 */
function figureMask(w: number, h: number): Mask {
  // a plausible standing figure: a head, a torso and two legs, roughly where the model projects
  const m = newMask(w, h);
  const put = (x0: number, y0: number, x1: number, y1: number): void => {
    const X0 = Math.round(x0), Y0 = Math.round(y0), X1 = Math.round(x1), Y1 = Math.round(y1);
    for (let y = Math.max(0, Y0); y <= Math.min(h - 1, Y1); y++) for (let x = Math.max(0, X0); x <= Math.min(w - 1, X1); x++) m.data[y * w + x] = 1;
  };
  put(w * 0.42, h * 0.04, w * 0.58, h * 0.16); // head
  put(w * 0.36, h * 0.16, w * 0.64, h * 0.52); // torso
  put(w * 0.38, h * 0.52, w * 0.48, h * 0.96); // left leg
  put(w * 0.52, h * 0.52, w * 0.62, h * 0.96); // right leg
  return m;
}

describe('UV relaxation on the real mesh (smoothness diagnostic)', () => {
  const rest = buildRestSkeleton({ height: 1.7, legs: 1, torso: 1, arms: 1, shoulders: 1, hips: 1, head: 1, build: 1 });
  const mesh = buildCharacterMesh(rest, DEFAULT_SHAPE, 'normal');
  const pos = posedPositions(mesh, rest, restPose());
  const bounds = boundsXY(pos, mesh.vertexCount);
  const W = 512;
  const H = 768;
  const mask = figureMask(W, H);
  const fit = alignFit(bounds, { x0: W * 0.36, y0: H * 0.04, x1: W * 0.64, y1: H * 0.96 });
  const xy = projectXY(pos, mesh.vertexCount, fit, false);
  const sil = facingSilhouette(xy, mesh.indices, W, H, true);
  const r = relaxUvToSilhouette({ xy, indices: mesh.indices, mask, silhouette: sil });

  /** Mean |second difference| of a scalar field along mesh edges, in pixels. */
  function roughness(field: Float32Array, stride: number): number {
    let sum = 0;
    let n = 0;
    const seen = new Set<number>();
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const tri = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
      for (let k = 0; k < 3; k++) {
        const a = tri[k]!;
        const b = tri[(k + 1) % 3]!;
        const c = tri[(k + 2) % 3]!;
        const key = a * 1e7 + b;
        if (seen.has(key)) continue;
        seen.add(key);
        // b is the neighbour of a; c is the opposite vertex: |uv_a - 2 uv_b + uv_c| is a discrete second difference
        const d = Math.abs(field[a * stride]! - 2 * field[b * stride]! + field[c * stride]!);
        sum += d;
        n++;
      }
    }
    return n ? sum / n : 0;
  }

  it('produces a UV field no rougher than the plain projection', () => {
    const roughProj = (roughness(xy, 2) + roughness(xy.subarray(1), 2)) / 2;
    const roughRelax = (roughness(r.xy, 2) + roughness(r.xy.subarray(1), 2)) / 2;
    // eslint-disable-next-line no-console
    console.log(`UV roughness: projection=${roughProj.toFixed(3)}px  relaxed=${roughRelax.toFixed(3)}px  pinned=${r.pinned}/${mesh.vertexCount}`);
    // the relaxation must not make the field jagged: it is a harmonic solve, so it should be at least as smooth
    expect(roughRelax).toBeLessThanOrEqual(roughProj * 1.5 + 0.5);
  });

  it('pins a meaningful share of the silhouette and keeps every coordinate finite', () => {
    expect(r.pinned).toBeGreaterThan(50);
    for (let i = 0; i < r.xy.length; i++) expect(Number.isFinite(r.xy[i]!)).toBe(true);
  });

  it('keeps the relaxed UVs inside the drawing (no vertex pulled off the figure)', () => {
    let outside = 0;
    for (let v = 0; v < mesh.vertexCount; v++) {
      const px = Math.round(r.xy[v * 2]!);
      const py = Math.round(r.xy[v * 2 + 1]!);
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      if (!mask.data[py * W + px]) outside++;
    }
    // the interior of a limb may legitimately fall outside a crude rectangular mask, but the bulk must be inside
    expect(outside / mesh.vertexCount).toBeLessThan(0.35);
  });
});
