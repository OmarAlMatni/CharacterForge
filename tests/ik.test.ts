import { describe, expect, it } from 'vitest';
import { ikChainFor, solveFKDrag, solveTwoBoneIK } from '../src/core/ik.ts';
import { dist } from '../src/core/math.ts';
import { jointFrames } from '../src/core/rig.ts';
import type { Joint } from '../src/core/types.ts';
import { joint } from './helpers.ts';

const rest = { rotations: {}, rootOffset: { x: 0, y: 0 } };
const arm = (over: Partial<Joint> = {}, mid: Partial<Joint> = {}): Joint[] => [
  joint('shoulder', null, 0, 0, over),
  joint('elbow', 'shoulder', 0, 100, mid),
  joint('wrist', 'elbow', 0, 100),
];
const wristPos = (js: Joint[], pose: Parameters<typeof jointFrames>[1]) => jointFrames(js, pose).get('wrist')!.pos;
const elbowPos = (js: Joint[], pose: Parameters<typeof jointFrames>[1]) => jointFrames(js, pose).get('elbow')!.pos;
const chain = { rootId: 'shoulder', midId: 'elbow', endId: 'wrist' };

describe('two-bone IK', () => {
  it('finds the chain from an end joint', () => {
    expect(ikChainFor(arm(), 'wrist')).toEqual(chain);
    expect(ikChainFor(arm(), 'elbow')).toBeNull();
  });
  it('reaches reachable targets exactly', () => {
    for (const t of [{ x: 100, y: 100 }, { x: -120, y: 60 }, { x: 30, y: -150 }, { x: 0, y: 199 }]) {
      const r = solveTwoBoneIK(arm(), rest, chain, t);
      expect(r.reachable).toBe(true);
      const p = wristPos(arm(), r.pose);
      expect(p.x).toBeCloseTo(t.x, 3);
      expect(p.y).toBeCloseTo(t.y, 3);
    }
  });
  it('stretches toward unreachable targets without breaking', () => {
    const r = solveTwoBoneIK(arm(), rest, chain, { x: 0, y: 500 });
    expect(r.reachable).toBe(false);
    const p = wristPos(arm(), r.pose);
    expect(p.x).toBeCloseTo(0, 3);
    expect(p.y).toBeCloseTo(200, 3);
    expect(Number.isFinite(r.pose.rotations.shoulder)).toBe(true);
  });
  it('handles targets closer than the minimum reach', () => {
    const js = [joint('s', null, 0, 0), joint('e', 's', 0, 150), joint('w', 'e', 0, 50)];
    const r = solveTwoBoneIK(js, rest, { rootId: 's', midId: 'e', endId: 'w' }, { x: 0, y: 0 });
    expect(r.reachable).toBe(false);
    const p = jointFrames(js, r.pose).get('w')!.pos;
    expect(dist(p, { x: 0, y: 0 })).toBeCloseTo(100, 2);
  });
  it('explicit bend values put the elbow on opposite sides', () => {
    const t = { x: 100, y: 100 };
    const a = elbowPos(arm({}, { bend: 1 }), solveTwoBoneIK(arm({}, { bend: 1 }), rest, chain, t).pose);
    const b = elbowPos(arm({}, { bend: -1 }), solveTwoBoneIK(arm({}, { bend: -1 }), rest, chain, t).pose);
    expect(Math.sign(a.x - 50)).toBe(-Math.sign(b.x - 50));
  });
  it('bend 0 keeps the elbow on its current side while dragging', () => {
    const forced = arm({}, { bend: 1 });
    const bent = solveTwoBoneIK(forced, rest, chain, { x: 100, y: 100 }).pose;
    const auto = arm();
    const before = elbowPos(auto, bent);
    const after = elbowPos(auto, solveTwoBoneIK(auto, bent, chain, { x: 120, y: 90 }).pose);
    const lineSide = (p: { x: number; y: number }, t: { x: number; y: number }) => Math.sign(t.x * p.y - t.y * p.x);
    expect(lineSide(after, { x: 120, y: 90 })).toBe(lineSide(before, { x: 100, y: 100 }));
  });
  it('respects joint limits by choosing a legal elbow side', () => {
    const js = arm({}, { limits: { min: 0, max: 150 } });
    const r = solveTwoBoneIK(js, rest, chain, { x: 100, y: 100 });
    expect(r.limited).toBe(false);
    const rotB = r.pose.rotations.elbow!;
    expect(rotB).toBeGreaterThanOrEqual(-1e-6);
    expect(rotB).toBeLessThanOrEqual(150 + 1e-6);
    const p = wristPos(js, r.pose);
    expect(p.x).toBeCloseTo(100, 3);
  });
  it('flags unsatisfiable limits and clamps', () => {
    const js = arm({}, { limits: { min: -5, max: 5 } });
    const r = solveTwoBoneIK(js, rest, chain, { x: 100, y: 100 });
    expect(r.limited).toBe(true);
    expect(Math.abs(r.pose.rotations.elbow!)).toBeLessThanOrEqual(5 + 1e-6);
  });
  it('works under a rotated and translated parent', () => {
    const js = [joint('p', null, 300, 300), joint('shoulder', 'p', 0, 20), joint('elbow', 'shoulder', 0, 100), joint('wrist', 'elbow', 0, 100)];
    const pose = { rotations: { p: 37 }, rootOffset: { x: 11, y: -4 } };
    const t = { x: 380, y: 420 };
    const r = solveTwoBoneIK(js, pose, chain, t);
    const p = jointFrames(js, r.pose).get('wrist')!.pos;
    expect(p.x).toBeCloseTo(t.x, 3);
    expect(p.y).toBeCloseTo(t.y, 3);
    expect(r.pose.rotations.p).toBe(37);
  });
  it('returns the pose unchanged for zero-length bones', () => {
    const js = [joint('s', null, 0, 0), joint('e', 's', 0, 0), joint('w', 'e', 0, 10)];
    const r = solveTwoBoneIK(js, rest, { rootId: 's', midId: 'e', endId: 'w' }, { x: 5, y: 5 });
    expect(r.pose).toBe(rest);
  });
});

describe('FK drag', () => {
  const js = [joint('p', null, 0, 0), joint('j', 'p', 100, 0)];
  it('rotates the parent so the bone points at the cursor', () => {
    const pose = solveFKDrag(js, rest, 'j', { x: 0, y: 100 });
    expect(pose.rotations.p).toBeCloseTo(90, 9);
    const f = jointFrames(js, pose).get('j')!.pos;
    expect(f.x).toBeCloseTo(0, 9);
    expect(f.y).toBeCloseTo(100, 9);
  });
  it('translates the rig when dragging a root', () => {
    const pose = solveFKDrag(js, rest, 'p', { x: 20, y: 30 });
    expect(pose.rootOffset).toEqual({ x: 20, y: 30 });
  });
  it('honours limits', () => {
    const limited = [joint('p', null, 0, 0, { limits: { min: -20, max: 20 } }), joint('j', 'p', 100, 0)];
    expect(solveFKDrag(limited, rest, 'j', { x: 0, y: 100 }).rotations.p).toBe(20);
  });
});
