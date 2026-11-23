import { describe, expect, it } from 'vitest';
import { addJointAt, attachLayers, moveJointRest, removeJoint, setJointParent, updateJoint, saveNamedPose, applyNamedPose, setPose } from '../src/core/doc.ts';
import { clampToLimits, computePlacements, jointFrames, restFrames, sanitizePose } from '../src/core/rig.ts';
import { emptyDoc, joint, layer } from './helpers.ts';

const rest = { rotations: {}, rootOffset: { x: 0, y: 0 } };

describe('forward kinematics', () => {
  it('rest frames accumulate offsets', () => {
    const f = restFrames([joint('a', null, 100, 100), joint('b', 'a', 0, 50), joint('c', 'b', 0, 50)]);
    expect(f.get('c')!.pos).toEqual({ x: 100, y: 200 });
  });
  it('rotating a parent swings its children', () => {
    const f = jointFrames([joint('a', null, 100, 100), joint('b', 'a', 0, 50)], { rotations: { a: 90 }, rootOffset: { x: 0, y: 0 } });
    expect(f.get('b')!.pos.x).toBeCloseTo(50, 9);
    expect(f.get('b')!.pos.y).toBeCloseTo(100, 9);
    expect(f.get('b')!.rot).toBe(90);
  });
  it('rootOffset translates every root', () => {
    const f = jointFrames([joint('a', null, 10, 10), joint('r', null, 50, 50)], { rotations: {}, rootOffset: { x: 5, y: -5 } });
    expect(f.get('a')!.pos).toEqual({ x: 15, y: 5 });
    expect(f.get('r')!.pos).toEqual({ x: 55, y: 45 });
  });
  it('detects cycles', () => {
    expect(() => jointFrames([joint('a', 'b', 0, 0), joint('b', 'a', 0, 0)], rest)).toThrow('cycle');
  });
});

describe('layer placement', () => {
  const joints = [joint('a', null, 100, 100)];
  it('is the rest transform at rest', () => {
    const l = { ...layer('l'), jointId: 'a' };
    const p = computePlacements([l], joints, rest).get('l')!;
    expect(p).toEqual(l.transform);
  });
  it('unattached layers ignore the pose', () => {
    const l = layer('l');
    const p = computePlacements([l], joints, { rotations: { a: 45 }, rootOffset: { x: 9, y: 9 } }).get('l')!;
    expect(p).toEqual(l.transform);
  });
  it('attached layers rotate rigidly about the joint', () => {
    const l = { ...layer('l'), jointId: 'a', transform: { x: 100, y: 120, rotation: 10, scaleX: 2, scaleY: 1 } };
    const p = computePlacements([l], joints, { rotations: { a: 90 }, rootOffset: { x: 0, y: 0 } }).get('l')!;
    expect(p.x).toBeCloseTo(80, 9);
    expect(p.y).toBeCloseTo(100, 9);
    expect(p.rotation).toBeCloseTo(100, 9);
    expect(p.scaleX).toBe(2);
  });
  it('moves with root translation', () => {
    const l = { ...layer('l'), jointId: 'a' };
    const p = computePlacements([l], joints, { rotations: {}, rootOffset: { x: 30, y: -10 } }).get('l')!;
    expect(p.x).toBeCloseTo(l.transform.x + 30, 9);
    expect(p.y).toBeCloseTo(l.transform.y - 10, 9);
  });
});

describe('skeleton editing', () => {
  const base = () => emptyDoc([layer('l')], [joint('a', null, 10, 10), joint('b', 'a', 0, 50), joint('c', 'b', 0, 50)]);
  it('adds a joint at a world position relative to its parent', () => {
    const d = addJointAt(base(), 'n', 'New', 'c', { x: 40, y: 150 });
    expect(restFrames(d.joints).get('n')!.pos).toEqual({ x: 40, y: 150 });
  });
  it('moving a joint leaves its children in place by default', () => {
    const d = moveJointRest(base(), 'b', { x: 30, y: 70 });
    const f = restFrames(d.joints);
    expect(f.get('b')!.pos).toEqual({ x: 30, y: 70 });
    expect(f.get('c')!.pos).toEqual({ x: 10, y: 110 });
  });
  it('moving with subtree carries children along', () => {
    const f = restFrames(moveJointRest(base(), 'b', { x: 30, y: 70 }, true).joints);
    expect(f.get('c')!.pos).toEqual({ x: 30, y: 120 });
  });
  it('re-parenting preserves rest world positions and rejects cycles', () => {
    const d = setJointParent(base(), 'c', 'a');
    expect(restFrames(d.joints).get('c')!.pos).toEqual({ x: 10, y: 110 });
    expect(() => setJointParent(base(), 'a', 'c')).toThrow('descendants');
  });
  it('removing a joint re-parents children and attached layers', () => {
    let d = attachLayers(base(), ['l'], 'b');
    d = setPose(d, { rotations: { b: 20, c: 5 }, rootOffset: { x: 0, y: 0 } });
    d = removeJoint(d, 'b');
    expect(d.joints.map((j) => j.id)).toEqual(['a', 'c']);
    expect(d.joints.find((j) => j.id === 'c')!.parentId).toBe('a');
    expect(restFrames(d.joints).get('c')!.pos).toEqual({ x: 10, y: 110 });
    expect(d.layers[0]!.jointId).toBe('a');
    expect(d.pose.rotations).toEqual({ c: 5 });
  });
  it('attaching to an unknown joint throws', () => {
    expect(() => attachLayers(base(), ['l'], 'nope')).toThrow('Joint not found');
  });
  it('joint limits clamp poses', () => {
    let d = updateJoint(base(), 'b', { limits: { min: -10, max: 40 } });
    d = setPose(d, { rotations: { b: 170 }, rootOffset: { x: 0, y: 0 } });
    expect(d.pose.rotations.b).toBe(40);
    expect(clampToLimits(d.joints[1], -90)).toBe(-10);
  });
  it('sanitizePose drops unknown joints', () => {
    expect(sanitizePose(base().joints, { rotations: { zzz: 5, a: 3 }, rootOffset: { x: 0, y: 0 } }).rotations).toEqual({ a: 3 });
  });
});

describe('named poses', () => {
  it('saves and restores poses independently of later edits', () => {
    let d = emptyDoc([], [joint('a', null, 0, 0), joint('b', 'a', 0, 10)]);
    d = setPose(d, { rotations: { a: 30 }, rootOffset: { x: 4, y: 5 } });
    d = saveNamedPose(d, 'p1', '  Wave ', 123);
    expect(d.poses[0]!.name).toBe('Wave');
    d = setPose(d, { rotations: { a: -50 }, rootOffset: { x: 0, y: 0 } });
    d = applyNamedPose(d, 'p1');
    expect(d.pose.rotations.a).toBe(30);
    expect(d.pose.rootOffset).toEqual({ x: 4, y: 5 });
    expect(() => applyNamedPose(d, 'missing')).toThrow('Pose not found');
  });
});
