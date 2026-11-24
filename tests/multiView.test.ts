import { describe, expect, it } from 'vitest';
import {
  MAX_VIEWS,
  alignFit,
  alignFitExtent,
  distinctViews,
  facingWeight,
  normalizeAngle,
  projectView,
  projectXY,
  viewCoverage,
  viewDirection,
  viewExtent,
  viewRight,
  viewWeights,
} from '../src/pose/index.ts';

/** A unit normal pointing at a given azimuth (degrees around Y), horizontal. */
const normalAt = (deg: number): [number, number, number] => {
  const d = viewDirection(deg);
  return [d.x, d.y, d.z];
};

describe('view axes', () => {
  it('a 0° view is the front view the projection always used', () => {
    const r = viewRight(0);
    const d = viewDirection(0);
    expect(r.x).toBeCloseTo(1, 12);
    expect(r.z).toBeCloseTo(0, 12);
    expect(d.z).toBeCloseTo(1, 12);
  });

  it('a 90° view looks along the character\'s left side', () => {
    const d = viewDirection(90);
    expect(d.x).toBeCloseTo(1, 12);
    expect(d.z).toBeCloseTo(0, 12);
  });

  it('a 180° view looks at the back', () => {
    const d = viewDirection(180);
    expect(d.z).toBeCloseTo(-1, 12);
  });

  it('projectView at 0° is identical to projectXY', () => {
    const pos = new Float32Array([0.1, 1.2, 0.3, -0.2, 0.4, 0.9, 0.05, 1.7, -0.1]);
    const fit = { ppm: 400, ox: 300, oy: 900 };
    const a = projectXY(pos, 3, fit);
    const b = projectView(pos, 3, fit, 0);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i]!, 6);
  });

  it('a side view projects the body\'s depth, not its width', () => {
    // two vertices at the same x but different z: a front view puts them at the same pixel, a side view separates them
    const pos = new Float32Array([0.1, 1.0, 0.2, 0.1, 1.0, -0.2]);
    const fit = { ppm: 400, ox: 300, oy: 900 };
    const front = projectView(pos, 2, fit, 0);
    const side = projectView(pos, 2, fit, 90);
    expect(front[0]).toBeCloseTo(front[2]!, 6); // same x → same pixel from the front
    expect(Math.abs(side[0]! - side[2]!)).toBeGreaterThan(100); // different z → far apart from the side
  });

  it('viewExtent measures the extent along the view axis', () => {
    const pos = new Float32Array([0.5, 1.0, 0.0, -0.5, 1.0, 0.0, 0.0, 1.0, 0.3]);
    const front = viewExtent(pos, 3, 0);
    expect(front.min).toBeCloseTo(-0.5, 6);
    expect(front.max).toBeCloseTo(0.5, 6);
    // from the side the horizontal axis is the body's DEPTH: the two vertices that shared an x are now 0.3 apart
    const side = viewExtent(pos, 3, 90);
    expect(side.max - side.min).toBeCloseTo(0.3, 6);
  });
});

describe('alignFitExtent', () => {
  it('agrees with alignFit when given the same extents', () => {
    const art = { x0: 40, y0: 30, x1: 359, y1: 929 };
    const a = alignFit({ minX: -0.3, maxX: 0.3, minY: 0, maxY: 1.7 }, art);
    const b = alignFitExtent(-0.3, 0.3, 0, 1.7, art);
    expect(b.ppm).toBeCloseTo(a.ppm, 9);
    expect(b.ox).toBeCloseTo(a.ox, 9);
    expect(b.oy).toBeCloseTo(a.oy, 9);
  });

  it('fits a side drawing to the depth extent', () => {
    const art = { x0: 0, y0: 0, x1: 99, y1: 199 };
    const fit = alignFitExtent(-0.15, 0.15, 0, 1.7, art);
    // the drawing is 200 px tall for 1.7 m, and its 100 px width covers the 0.3 m depth
    expect(fit.ppm).toBeCloseTo(200 / 1.7, 6);
    expect(fit.ox).toBeCloseTo(50, 6);
  });
});

describe('facingWeight', () => {
  it('is 1 for a surface looking straight at the view and 0 behind it', () => {
    const [x, y, z] = normalAt(0);
    expect(facingWeight(x, y, z, 0)).toBeCloseTo(1, 6);
    expect(facingWeight(x, y, z, 180)).toBe(0);
  });

  it('is 0 at the silhouette of a view', () => {
    // a normal perpendicular to the front view's direction
    expect(facingWeight(1, 0, 0, 0)).toBe(0);
  });

  it('falls off with the angle between the surface and the view', () => {
    const [x, y, z] = normalAt(0);
    const near = facingWeight(x, y, z, 20);
    const far = facingWeight(x, y, z, 70);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
  });
});

describe('viewWeights', () => {
  it('gives a front-facing surface entirely to the front view', () => {
    const [x, y, z] = normalAt(0);
    const w = viewWeights(new Float32Array([x, y, z]), 1, [0, 90, 180]);
    expect(w[0]).toBeCloseTo(1, 5);
    expect(w[1]).toBeCloseTo(0, 5);
    expect(w[2]).toBeCloseTo(0, 5);
  });

  it('gives a flank surface to the side view', () => {
    const [x, y, z] = normalAt(90);
    const w = viewWeights(new Float32Array([x, y, z]), 1, [0, 90, 180]);
    expect(w[1]).toBeCloseTo(1, 5);
    expect(w[0]).toBeCloseTo(0, 5);
  });

  it('gives a back-facing surface to the back view', () => {
    const [x, y, z] = normalAt(180);
    const w = viewWeights(new Float32Array([x, y, z]), 1, [0, 90, 180]);
    expect(w[2]).toBeCloseTo(1, 5);
  });

  it('normalises every row to 1', () => {
    const normals = new Float32Array(30);
    for (let i = 0; i < 10; i++) {
      const [x, y, z] = normalAt(i * 36);
      normals[i * 3] = x;
      normals[i * 3 + 1] = y;
      normals[i * 3 + 2] = z;
    }
    const views = 3;
    const w = viewWeights(normals, 10, [0, 90, 180]);
    for (let v = 0; v < 10; v++) {
      let s = 0;
      for (let k = 0; k < views; k++) s += w[v * views + k]!;
      expect(s).toBeCloseTo(1, 5);
    }
  });

  it('never leaves a surface unpainted when the views do not cover it', () => {
    // only a front view, but the surface faces the back: it must still get weight 1 somewhere
    const [x, y, z] = normalAt(180);
    const w = viewWeights(new Float32Array([x, y, z]), 1, [0]);
    expect(w[0]).toBeCloseTo(1, 6);
  });

  it('blends smoothly between two views rather than switching', () => {
    // a surface at 45° between the front and the side view gets a share of both
    const [x, y, z] = normalAt(45);
    const w = viewWeights(new Float32Array([x, y, z]), 1, [0, 90]);
    expect(w[0]).toBeGreaterThan(0.1);
    expect(w[1]).toBeGreaterThan(0.1);
    expect(w[0]! + w[1]!).toBeCloseTo(1, 5);
  });
});

describe('viewCoverage', () => {
  it('reports the share of the body each view paints', () => {
    const normals = new Float32Array(9);
    const angles = [0, 90, 180];
    for (let i = 0; i < 3; i++) {
      const [x, y, z] = normalAt(angles[i]!);
      normals[i * 3] = x;
      normals[i * 3 + 1] = y;
      normals[i * 3 + 2] = z;
    }
    const cov = viewCoverage(viewWeights(normals, 3, angles), 3, 3);
    expect(cov[0]).toBeCloseTo(1 / 3, 5);
    expect(cov[1]).toBeCloseTo(1 / 3, 5);
    expect(cov[2]).toBeCloseTo(1 / 3, 5);
  });

  it('shows a single view doing all the work', () => {
    const normals = new Float32Array([0, 0, 1, 0, 0, 1]);
    const cov = viewCoverage(viewWeights(normals, 2, [0]), 2, 1);
    expect(cov[0]).toBeCloseTo(1, 6);
  });
});

describe('distinctViews', () => {
  it('sorts by angle', () => {
    const out = distinctViews([{ angle: 180 }, { angle: 0 }, { angle: 90 }]);
    expect(out.map((v) => v.angle)).toEqual([0, 90, 180]);
  });

  it('drops a view that is too close to one already kept', () => {
    const out = distinctViews([{ angle: 0 }, { angle: 5 }, { angle: 90 }]);
    expect(out).toHaveLength(2);
    expect(out.map((v) => v.angle)).toEqual([0, 90]);
  });

  it('keeps views that are far enough apart', () => {
    const out = distinctViews([{ angle: 0 }, { angle: 45 }, { angle: 90 }, { angle: 180 }]);
    expect(out).toHaveLength(4);
  });

  it('treats 355° and 5° as close across the wrap', () => {
    const out = distinctViews([{ angle: 355 }, { angle: 5 }]);
    expect(out).toHaveLength(1);
  });

  it('keeps 350° and 10° apart, which are 20° from each other', () => {
    const out = distinctViews([{ angle: 350 }, { angle: 10 }]);
    expect(out).toHaveLength(2);
  });
});

describe('normalizeAngle', () => {
  it('wraps into [0, 360)', () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(360)).toBe(0);
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(450)).toBe(90);
  });
});

describe('MAX_VIEWS', () => {
  it('matches the shader\'s four texture slots', () => {
    expect(MAX_VIEWS).toBe(4);
  });
});
