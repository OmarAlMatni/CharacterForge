import { describe, expect, it } from 'vitest';
import { apply, canvasToScreen, fitView, fromTRS, invert, mul, normalizeDeg, screenToCanvas, zoomAt } from '../src/core/math.ts';

describe('math', () => {
  it('fromTRS rotates 90° clockwise on a y-down canvas', () => {
    const p = apply(fromTRS({ x: 0, y: 0, rotation: 90, scaleX: 1, scaleY: 1 }), { x: 1, y: 0 });
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(1, 9);
  });
  it('applies scale before rotation and translation', () => {
    const p = apply(fromTRS({ x: 10, y: 20, rotation: 0, scaleX: 2, scaleY: 3 }), { x: 1, y: 1 });
    expect(p).toEqual({ x: 12, y: 23 });
  });
  it('invert undoes a transform', () => {
    const m = mul(fromTRS({ x: 5, y: -3, rotation: 33, scaleX: 1.5, scaleY: 0.5 }), fromTRS({ x: 1, y: 2, rotation: -10, scaleX: 1, scaleY: 1 }));
    const p = { x: 7, y: 11 };
    const back = apply(invert(m)!, apply(m, p));
    expect(back.x).toBeCloseTo(7, 9);
    expect(back.y).toBeCloseTo(11, 9);
  });
  it('invert returns null for singular matrices', () => {
    expect(invert({ a: 0, b: 0, c: 0, d: 0, e: 1, f: 1 })).toBeNull();
  });
  it('normalizeDeg maps into (-180, 180]', () => {
    expect(normalizeDeg(190)).toBe(-170);
    expect(normalizeDeg(-180)).toBe(180);
    expect(normalizeDeg(540)).toBe(180);
    expect(normalizeDeg(-30)).toBe(-30);
  });
  it('screen/canvas conversion round-trips', () => {
    const v = { zoom: 2.5, panX: 40, panY: -12 };
    const p = screenToCanvas(v, canvasToScreen(v, { x: 33, y: 71 }));
    expect(p.x).toBeCloseTo(33, 9);
    expect(p.y).toBeCloseTo(71, 9);
  });
  it('zoomAt keeps the anchor point fixed', () => {
    const v = { zoom: 1, panX: 10, panY: 20 };
    const anchor = { x: 300, y: 200 };
    const before = screenToCanvas(v, anchor);
    const after = screenToCanvas(zoomAt(v, anchor, 1.7), anchor);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });
  it('zoomAt clamps zoom', () => {
    expect(zoomAt({ zoom: 31, panX: 0, panY: 0 }, { x: 0, y: 0 }, 10).zoom).toBe(32);
  });
  it('fitView centres the canvas', () => {
    const v = fitView(100, 100, 500, 300, 0);
    expect(v.zoom).toBeCloseTo(3, 9);
    expect(v.panX).toBeCloseTo(100, 9);
    expect(v.panY).toBeCloseTo(0, 9);
  });
});
