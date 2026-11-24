import { describe, expect, it } from 'vitest';
import { buildCharacterMesh } from '../src/pose/characterMesh.ts';
import { buildRestSkeleton } from '../src/pose/skeleton.ts';
import { DEFAULT_SHAPE } from '../src/pose/bodyShape.ts';
import { restPose } from '../src/pose/pose.ts';
import { alignFit, boundsXY, facingSilhouette, posedPositions, projectXY } from '../src/pose/projection.ts';
import { rasterizeTriangles } from '../src/pose/silhouette.ts';
import { silhouetteBoundary } from '../src/pose/uvRelax.ts';
import { loadTestModel } from './model.ts';

loadTestModel();

/**
 * The winding assumption `facingSilhouette` rests on: the bundled model is a closed mesh, so in a front projection its
 * triangles split into a front-facing and a back-facing set, and the front set's silhouette is a strict subset of the
 * union. If a future model or a mirroring change broke that, the front UV solve would silently pin against the wrong
 * outline — so it is asserted here rather than assumed.
 */
describe('front/back winding of the bundled model', () => {
  const rest = buildRestSkeleton({ height: 1.7, legs: 1, torso: 1, arms: 1, shoulders: 1, hips: 1, head: 1, build: 1 });
  const mesh = buildCharacterMesh(rest, DEFAULT_SHAPE, 'normal');
  const pos = posedPositions(mesh, rest, restPose());
  const W = 512;
  const H = 768;
  const fit = alignFit(boundsXY(pos, mesh.vertexCount), { x0: W * 0.36, y0: H * 0.04, x1: W * 0.64, y1: H * 0.96 });
  const xy = projectXY(pos, mesh.vertexCount, fit, false);

  it('splits the triangles into two non-empty, roughly balanced winding sets', () => {
    let posArea = 0;
    let negArea = 0;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = mesh.indices[t]! * 2;
      const b = mesh.indices[t + 1]! * 2;
      const c = mesh.indices[t + 2]! * 2;
      const area = (xy[b]! - xy[a]!) * (xy[c + 1]! - xy[a + 1]!) - (xy[c]! - xy[a]!) * (xy[b + 1]! - xy[a + 1]!);
      if (area > 1e-9) posArea++;
      else if (area < -1e-9) negArea++;
    }
    expect(posArea).toBeGreaterThan(1000);
    expect(negArea).toBeGreaterThan(1000);
    // neither set may be a sliver of the other: a closed mesh seen from the front is roughly half and half
    expect(Math.min(posArea, negArea) / Math.max(posArea, negArea)).toBeGreaterThan(0.4);
  });

  it('gives the front shell a silhouette inside the union, with a real boundary', () => {
    const front = facingSilhouette(xy, mesh.indices, W, H, true);
    const back = facingSilhouette(xy, mesh.indices, W, H, false);
    const all = rasterizeTriangles(xy, mesh.indices, W, H);
    const area = (m: { data: Uint8Array }): number => m.data.reduce((s, v) => s + v, 0);
    expect(area(front)).toBeGreaterThan(0);
    expect(area(back)).toBeGreaterThan(0);
    // the front shell covers most of the union (the back is hidden behind it) but not all of it
    expect(area(front)).toBeLessThanOrEqual(area(all));
    expect(area(front) / area(all)).toBeGreaterThan(0.5);
    // and it has a boundary to pin against
    const edge = silhouetteBoundary(front);
    expect(edge.reduce((s, v) => s + v, 0)).toBeGreaterThan(200);
  });

  it('places a meaningful number of vertices on the front silhouette boundary', () => {
    const front = facingSilhouette(xy, mesh.indices, W, H, true);
    const edge = silhouetteBoundary(front);
    let onEdge = 0;
    for (let v = 0; v < mesh.vertexCount; v++) {
      const px = Math.round(xy[v * 2]!);
      const py = Math.round(xy[v * 2 + 1]!);
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      if (edge[py * W + px]) onEdge++;
    }
    expect(onEdge).toBeGreaterThan(500);
  });
});
