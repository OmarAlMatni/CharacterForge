import { describe, expect, it } from 'vitest';
import { ikChainFor } from '../src/core/ik.ts';
import { restFrames } from '../src/core/rig.ts';
import { humanoidJoints } from '../src/core/templates.ts';

describe('humanoid template', () => {
  const bounds = { x: 100, y: 50, width: 400, height: 1000 };
  const joints = humanoidJoints(bounds, (k) => `j_${k}`);
  it('creates a single-rooted 16-joint skeleton, parents before children', () => {
    expect(joints).toHaveLength(16);
    expect(joints.filter((j) => !j.parentId)).toHaveLength(1);
    const seen = new Set<string>();
    for (const j of joints) {
      if (j.parentId) expect(seen.has(j.parentId)).toBe(true);
      seen.add(j.id);
    }
  });
  it('places joints inside the bounds in anatomical order', () => {
    const f = restFrames(joints);
    for (const j of joints) {
      const p = f.get(j.id)!.pos;
      expect(p.x).toBeGreaterThanOrEqual(bounds.x);
      expect(p.x).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(p.y).toBeGreaterThanOrEqual(bounds.y);
      expect(p.y).toBeLessThanOrEqual(bounds.y + bounds.height);
    }
    expect(f.get('j_head')!.pos.y).toBeLessThan(f.get('j_hips')!.pos.y);
    expect(f.get('j_ankleL')!.pos.y).toBeGreaterThan(f.get('j_kneeL')!.pos.y);
  });
  it('offers two-bone IK chains for both arms and both legs', () => {
    for (const end of ['wristL', 'wristR', 'ankleL', 'ankleR']) expect(ikChainFor(joints, `j_${end}`)).not.toBeNull();
  });
});
