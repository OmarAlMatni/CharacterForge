import { describe, expect, it } from 'vitest';
import { planPsdImport } from '../src/core/psdPlan.ts';

const px = (w = 10, h = 10) => ({ width: w, height: h });

describe('planPsdImport', () => {
  it('keeps names, order, visibility, opacity and positions', () => {
    const plan = planPsdImport({
      width: 500,
      height: 800,
      children: [
        { name: 'Body', left: 10, top: 20, canvas: px(100, 200) },
        { name: 'Hair', left: 0, top: 0, canvas: px(50, 60), hidden: true, opacity: 0.4 },
      ],
    });
    expect(plan.width).toBe(500);
    expect(plan.layers.map((l) => l.name)).toEqual(['Body', 'Hair']);
    expect(plan.layers[0]).toMatchObject({ left: 10, top: 20, width: 100, height: 200, visible: true, opacity: 1 });
    expect(plan.layers[1]).toMatchObject({ visible: false, opacity: 0.4 });
    expect(plan.warnings).toEqual([]);
  });
  it('maps nested groups to parent indices', () => {
    const plan = planPsdImport({
      width: 10,
      height: 10,
      children: [{ name: 'Arm', children: [{ name: 'Sleeve', canvas: px() }, { name: 'Hand', canvas: px() }] }, { name: 'Head', canvas: px() }],
    });
    expect(plan.layers.map((l) => [l.name, l.kind, l.parentIndex])).toEqual([
      ['Arm', 'group', null],
      ['Sleeve', 'raster', 0],
      ['Hand', 'raster', 0],
      ['Head', 'raster', null],
    ]);
  });
  it('warns about every unsupported feature instead of silently dropping it', () => {
    const plan = planPsdImport({
      width: 10,
      height: 10,
      bitsPerChannel: 16,
      colorMode: 4,
      children: [
        { name: 'Glow', canvas: px(), blendMode: 'screen' },
        { name: 'Masked', canvas: px(), mask: {} },
        { name: 'Clip', canvas: px(), clipping: true },
        { name: 'Title', canvas: px(), text: {} },
        { name: 'Fx', canvas: px(), effects: {} },
        { name: 'Levels', adjustment: {} },
        { name: 'Empty' },
      ],
    });
    const w = plan.warnings.join('\n');
    for (const needle of ['16 bits', 'RGB', 'screen', 'layer mask', 'clipping', 'Text layer', 'effects', 'Adjustment', 'no pixels']) expect(w).toContain(needle);
    expect(plan.layers.map((l) => l.name)).toEqual(['Glow', 'Masked', 'Clip', 'Title', 'Fx']);
  });
  it('treats normal and pass-through as supported and de-duplicates warnings', () => {
    const plan = planPsdImport({ width: 1, height: 1, children: [{ canvas: px(), blendMode: 'normal' }, { canvas: px(), blendMode: 'pass through' }, { name: 'E1' }, { name: 'E1' }] });
    expect(plan.warnings).toHaveLength(1);
  });
  it('names unnamed layers and normalises 0-255 opacity', () => {
    const plan = planPsdImport({ width: 1, height: 1, children: [{ canvas: px(), opacity: 128 }] });
    expect(plan.layers[0]!.name).toBe('Layer 1');
    expect(plan.layers[0]!.opacity).toBeCloseTo(128 / 255, 6);
  });
});
