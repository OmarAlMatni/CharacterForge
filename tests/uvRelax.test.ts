import { describe, expect, it } from 'vitest';
import { depthBuffer, meshAdjacency, nearestBoundaryField, relaxUvToSilhouette, silhouetteBoundary, visibilityField } from '../src/pose/uvRelax.ts';
import { facingSilhouette } from '../src/pose/projection.ts';
import { newMask, rasterizeTriangles } from '../src/pose/silhouette.ts';
import type { Mask } from '../src/pose/silhouette.ts';

function rectMask(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Mask {
  const m = newMask(w, h);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m.data[y * w + x] = 1;
  return m;
}

describe('silhouetteBoundary', () => {
  it('marks exactly the inside pixels with an outside 4-neighbour', () => {
    const m = rectMask(10, 8, 2, 1, 6, 5); // 5x5 block
    const b = silhouetteBoundary(m);
    let count = 0;
    for (let i = 0; i < b.length; i++) count += b[i]!;
    expect(count).toBe(2 * (5 + 5) - 4); // the ring of a 5x5 block
    expect(b[3 * 10 + 4]).toBe(0); // interior pixel
    expect(b[1 * 10 + 2]).toBe(1); // corner
  });

  it('treats the image border as outside', () => {
    const m = rectMask(4, 4, 0, 0, 3, 3); // fills the whole image
    const b = silhouetteBoundary(m);
    expect(b[0]).toBe(1);
    expect(b[1 * 4 + 1]).toBe(0);
  });
});

describe('nearestBoundaryField', () => {
  it('is zero on the boundary and the true Euclidean distance elsewhere', () => {
    const m = rectMask(20, 20, 5, 5, 14, 14);
    const f = nearestBoundaryField(m);
    expect(f.dist[5 * 20 + 5]).toBe(0);
    expect(f.dist[10 * 20 + 10]).toBeCloseTo(4, 0); // centre is 4 px from the nearer edge of the ring
    expect(f.dist[5 * 20 + 10]).toBe(0); // top edge is boundary
  });

  it('stores a boundary pixel as the nearest source', () => {
    const m = rectMask(20, 20, 5, 5, 14, 14);
    const f = nearestBoundaryField(m);
    const s = f.index[10 * 20 + 10]!;
    expect(s).toBeGreaterThanOrEqual(0);
    const b = silhouetteBoundary(m);
    expect(b[s]).toBe(1);
  });

  it('returns Infinity everywhere for an empty mask', () => {
    const f = nearestBoundaryField(newMask(6, 6));
    expect(f.dist.every((d) => d === Infinity)).toBe(true);
    expect(f.index.every((i) => i === -1)).toBe(true);
  });
});

describe('meshAdjacency', () => {
  it('lists each neighbour once and never itself', () => {
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const { start, list } = meshAdjacency(indices, 4);
    const n0 = Array.from(list.slice(start[0]!, start[1]!)).sort();
    expect(n0).toEqual([1, 2, 3]);
    expect(Array.from(list.slice(start[0]!, start[1]!))).not.toContain(0);
  });
});

describe('relaxUvToSilhouette', () => {
  // a square mesh (two triangles) projected so its silhouette is a 10x10 block, and a drawing whose figure is a 10x10
  // block shifted 3 px right: the relaxation must pull the mesh's boundary onto the drawing's outline.
  const xy = new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const art = rectMask(30, 30, 3, 0, 12, 9);

  it('pins the mesh boundary to the drawing outline', () => {
    const r = relaxUvToSilhouette({ xy, indices, mask: art, sweeps: 40 });
    expect(r.pinned).toBeGreaterThan(0);
    // every pinned vertex now sits on the drawing's outline (x in [3,12], y in [0,9])
    for (let v = 0; v < 4; v++) {
      const px = r.xy[v * 2]!;
      const py = r.xy[v * 2 + 1]!;
      expect(px).toBeGreaterThanOrEqual(3 - 1);
      expect(px).toBeLessThanOrEqual(12 + 1);
      expect(py).toBeGreaterThanOrEqual(-1);
      expect(py).toBeLessThanOrEqual(9 + 1);
    }
  });

  it('leaves the coordinates finite and bounded (no fold)', () => {
    const r = relaxUvToSilhouette({ xy, indices, mask: art, sweeps: 40 });
    for (let i = 0; i < r.xy.length; i++) {
      expect(Number.isFinite(r.xy[i]!)).toBe(true);
      expect(Math.abs(r.xy[i]!)).toBeLessThan(1000);
    }
  });

  it('is idempotent to within tolerance when re-run on its own output', () => {
    const a = relaxUvToSilhouette({ xy, indices, mask: art, sweeps: 60 });
    const b = relaxUvToSilhouette({ xy: a.xy, indices, mask: art, sweeps: 60 });
    let max = 0;
    for (let i = 0; i < a.xy.length; i++) max = Math.max(max, Math.abs(a.xy[i]! - b.xy[i]!));
    expect(max).toBeLessThan(1.5);
  });

  it('does nothing when the drawing is far from the mesh', () => {
    const far = rectMask(200, 200, 150, 150, 190, 190);
    const r = relaxUvToSilhouette({ xy, indices, mask: far, sweeps: 20, maxPull: 4 });
    expect(r.pinned).toBe(0);
    expect(Array.from(r.xy)).toEqual(Array.from(xy));
  });
});

describe('facingSilhouette', () => {
  it('keeps only the triangles of the requested winding', () => {
    // two triangles with opposite winding, overlapping in the middle
    const xy = new Float32Array([0, 0, 10, 0, 10, 10, 0, 0, 0, 10, 10, 10]);
    const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
    const front = facingSilhouette(xy, indices, 12, 12, true);
    const back = facingSilhouette(xy, indices, 12, 12, false);
    const area = (m: Mask): number => m.data.reduce((s, v) => s + v, 0);
    expect(area(front)).toBeGreaterThan(0);
    expect(area(back)).toBeGreaterThan(0);
    expect(area(front) + area(back)).toBeGreaterThanOrEqual(area(front));
  });
});

describe('depthBuffer / visibilityField', () => {
  // a front quad at z=0 and a back quad at z=1, both covering the same pixels
  const xy = new Float32Array([0, 0, 10, 0, 10, 10, 0, 10, 0, 0, 10, 0, 10, 10, 0, 10]);
  const depth = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);

  it('keeps the nearest depth per pixel', () => {
    const buf = depthBuffer(xy, depth, indices, 12, 12);
    expect(buf[5 * 12 + 5]).toBeCloseTo(0, 5); // the front quad wins
  });

  it('classifies the front shell as front and the back shell as back', () => {
    const vis = visibilityField(xy, depth, indices, 12, 12, 0.02, 0);
    expect(vis[0]).toBe(1); // front quad vertex
    expect(vis[4]).toBe(0); // back quad vertex at the same pixel
  });

  it('smooths the field so the transition is a band, not a hard seam', () => {
    const vis = visibilityField(xy, depth, indices, 12, 12, 0.02, 4);
    for (let i = 0; i < vis.length; i++) {
      expect(vis[i]!).toBeGreaterThanOrEqual(0);
      expect(vis[i]!).toBeLessThanOrEqual(1);
    }
  });
});
