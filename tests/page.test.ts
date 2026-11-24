import { describe, expect, it } from 'vitest';
import {
  PAGE_LIMITS, PAGE_PRESETS, addBubble, addPanel, addPlacement, bubbleOutline, bubbleTextBox, coverScale, defaultPage, deletePanel, emptyPage,
  hitTestPage, insetPolygon, mmToPx, movePlacement, pageExportSize, pagePixelSize, pagePrintInfo, panelContentPolygon, panelLayout, pointInPolygon,
  polygonArea, polygonBounds, polygonCentroid, pxToMm, rectToPolygon, relinkPlacement, resizePage, signedArea, skewPolygon, thoughtTrail, updateBubble,
  updatePlacement, wrapText,
} from '../src/core/page.ts';
import type { Bubble, PageState, Placement } from '../src/core/page.ts';
import { CURRENT_SCHEMA_VERSION, migrateProjectData, MIGRATIONS } from '../src/core/migrations.ts';
import { validateProjectFile } from '../src/core/schema.ts';
import { validProject } from './helpers.ts';

const placement = (over: Partial<Placement> = {}): Placement => ({
  id: 'place_1',
  panelId: null,
  assetId: 'asset_l1',
  width: 600,
  height: 900,
  x: 100,
  y: 100,
  scale: 1,
  rotation: 0,
  flipX: false,
  opacity: 1,
  source: null,
  ...over,
});

const bubble = (over: Partial<Bubble> = {}): Bubble => ({
  id: 'bubble_1',
  kind: 'speech',
  text: 'Hello',
  x: 100,
  y: 100,
  width: 120,
  height: 80,
  tail: 90,
  fontSize: 16,
  ...over,
});

describe('page units and print size', () => {
  it('converts millimetres to pixels at the page DPI', () => {
    expect(mmToPx(25.4, 300)).toBeCloseTo(300, 6);
    expect(mmToPx(182, 300)).toBeCloseTo(2149.6, 1);
    expect(pxToMm(300, 300)).toBeCloseTo(25.4, 6);
  });

  it('B5 at 300 dpi is the expected trim size in pixels', () => {
    const p = { ...emptyPage(), size: { width: 182, height: 257 }, dpi: 300 };
    const s = pagePixelSize(p);
    expect(s.width).toBe(2150);
    expect(s.height).toBe(3035);
  });

  it('adds bleed on all four sides for the export', () => {
    const p = { ...emptyPage(), size: { width: 182, height: 257 }, dpi: 300, bleed: 3 };
    const trim = pagePixelSize(p);
    const out = pageExportSize(p);
    const bleed = Math.round(mmToPx(3, 300));
    expect(out.bleed).toBe(bleed);
    expect(out.width).toBe(trim.width + bleed * 2);
    expect(out.height).toBe(trim.height + bleed * 2);
  });

  it('reports the print resolution and megapixels', () => {
    const p = { ...emptyPage(), size: { width: 182, height: 257 }, dpi: 300, bleed: 3 };
    const info = pagePrintInfo(p);
    expect(info.dpi).toBe(300);
    expect(info.width).toBeGreaterThan(2100);
    expect(info.megapixels).toBeGreaterThan(6);
    expect(info.mm).toContain('182 × 257 mm');
  });

  it('every preset is a sane, exportable size', () => {
    for (const preset of PAGE_PRESETS) {
      const p = { ...emptyPage(), size: { width: preset.width, height: preset.height }, dpi: preset.dpi };
      const out = pageExportSize(p);
      expect(out.width).toBeGreaterThan(100);
      expect(out.height).toBeGreaterThan(100);
      expect(out.width * out.height).toBeLessThan(PAGE_LIMITS.maxPixels);
    }
  });
});

describe('polygon geometry', () => {
  it('computes area and orientation', () => {
    const r = rectToPolygon(0, 0, 100, 50);
    expect(polygonArea(r)).toBeCloseTo(5000, 6);
    expect(signedArea(r)).toBeGreaterThan(0); // clockwise in screen coordinates
  });

  it('reverses a counter-clockwise polygon', () => {
    const ccw = [...rectToPolygon(0, 0, 10, 10)].reverse();
    expect(signedArea(ccw)).toBeLessThan(0);
  });

  it('finds the bounds and centroid of a rectangle', () => {
    const r = rectToPolygon(10, 20, 100, 50);
    expect(polygonBounds(r)).toEqual({ x0: 10, y0: 20, x1: 110, y1: 70 });
    const c = polygonCentroid(r);
    expect(c.x).toBeCloseTo(60, 6);
    expect(c.y).toBeCloseTo(45, 6);
  });

  it('hit-tests points inside and outside', () => {
    const r = rectToPolygon(0, 0, 100, 100);
    expect(pointInPolygon({ x: 50, y: 50 }, r)).toBe(true);
    expect(pointInPolygon({ x: 150, y: 50 }, r)).toBe(false);
  });

  it('insets a rectangle by exactly d on every side', () => {
    const r = rectToPolygon(0, 0, 100, 100);
    const inner = insetPolygon(r, 10);
    const b = polygonBounds(inner);
    expect(b.x0).toBeCloseTo(10, 6);
    expect(b.y0).toBeCloseTo(10, 6);
    expect(b.x1).toBeCloseTo(90, 6);
    expect(b.y1).toBeCloseTo(90, 6);
  });

  it('insets a skewed parallelogram without collapsing it', () => {
    const skew = skewPolygon(rectToPolygon(0, 0, 100, 100), 0.2);
    const inner = insetPolygon(skew, 5);
    expect(inner).toHaveLength(4);
    expect(polygonArea(inner)).toBeGreaterThan(0);
    expect(polygonArea(inner)).toBeLessThan(polygonArea(skew));
  });

  it('leaves a polygon alone when the inset would destroy it', () => {
    const r = rectToPolygon(0, 0, 10, 10);
    expect(insetPolygon(r, 50)).toEqual(r);
  });

  it('skew slides the top edge by a fraction of the width', () => {
    const s = skewPolygon(rectToPolygon(0, 0, 100, 100), 0.25);
    expect(s[0]!.x).toBeCloseTo(25, 6);
    expect(s[1]!.x).toBeCloseTo(125, 6);
    expect(s[2]!.x).toBeCloseTo(100, 6);
  });
});

describe('gutters', () => {
  it('two panels sharing an edge end up exactly one gutter apart', () => {
    const p = { ...emptyPage(), size: { width: 200, height: 200 }, dpi: 100, gutter: 10 };
    const s = pagePixelSize(p);
    const top = { id: 'a', name: 'A', shape: 'rect' as const, points: rectToPolygon(0, 0, s.width, s.height / 2) };
    const bottom = { id: 'b', name: 'B', shape: 'rect' as const, points: rectToPolygon(0, s.height / 2, s.width, s.height / 2) };
    const a = polygonBounds(panelContentPolygon(top, p));
    const b = polygonBounds(panelContentPolygon(bottom, p));
    const gap = b.y0 - a.y1;
    expect(gap).toBeCloseTo(mmToPx(10, 100), 4);
  });

  it('a zero gutter leaves the panels touching', () => {
    const p = { ...emptyPage(), size: { width: 200, height: 200 }, dpi: 100, gutter: 0 };
    const s = pagePixelSize(p);
    const top = { id: 'a', name: 'A', shape: 'rect' as const, points: rectToPolygon(0, 0, s.width, s.height / 2) };
    const a = polygonBounds(panelContentPolygon(top, p));
    expect(a.y1).toBeCloseTo(s.height / 2, 4);
  });
});

describe('layouts', () => {
  it('every layout fills the page and produces non-degenerate panels', () => {
    const p = { ...emptyPage(), size: { width: 182, height: 257 }, dpi: 300 };
    const s = pagePixelSize(p);
    for (const layout of ['single', 'two-rows', 'three-rows', 'four-grid', 'classic-6', 'splash', 'action-3', 'webtoon-strip'] as const) {
      const panels = panelLayout(layout, p);
      expect(panels.length).toBeGreaterThan(0);
      for (const panel of panels) {
        expect(polygonArea(panel.points)).toBeGreaterThan(0);
        const b = polygonBounds(panel.points);
        expect(b.x0).toBeGreaterThanOrEqual(-0.001);
        expect(b.y0).toBeGreaterThanOrEqual(-0.001);
        expect(b.x1).toBeLessThanOrEqual(s.width + 0.001);
        expect(b.y1).toBeLessThanOrEqual(s.height + 0.001);
      }
    }
  });

  it('the classic 6-panel layout has six panels', () => {
    expect(panelLayout('classic-6', emptyPage())).toHaveLength(6);
  });

  it('a new page starts with a usable layout', () => {
    expect(defaultPage().panels.length).toBe(6);
  });
});

describe('placements', () => {
  it('cover scale fills the panel', () => {
    const p = { ...emptyPage(), size: { width: 200, height: 200 }, dpi: 100, gutter: 0 };
    const panel = { id: 'p', name: 'P', shape: 'rect' as const, points: rectToPolygon(0, 0, 200, 200) };
    const pl = placement({ width: 100, height: 100 });
    expect(coverScale(pl, panel, p)).toBeCloseTo(2, 4);
  });

  it('adds, updates and clamps a placement', () => {
    let p: PageState = emptyPage();
    p = addPlacement(p, placement());
    expect(p.placements).toHaveLength(1);
    p = updatePlacement(p, 'place_1', { opacity: 5, scale: -3 });
    expect(p.placements[0]!.opacity).toBe(1);
    expect(p.placements[0]!.scale).toBeGreaterThan(0);
  });

  it('reorders placements', () => {
    let p: PageState = emptyPage();
    p = addPlacement(p, placement({ id: 'a' }));
    p = addPlacement(p, placement({ id: 'b' }));
    p = movePlacement(p, 'a', 'top');
    expect(p.placements.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('relinking swaps the image but keeps position and scale', () => {
    let p: PageState = emptyPage();
    p = addPlacement(p, placement({ x: 42, y: 77, scale: 1.5 }));
    p = relinkPlacement(p, 'place_1', 'asset_new', 800, 1200, null);
    const pl = p.placements[0]!;
    expect(pl.assetId).toBe('asset_new');
    expect(pl.width).toBe(800);
    expect(pl.x).toBe(42);
    expect(pl.scale).toBe(1.5);
  });

  it('deleting a panel keeps its images, freed onto the page', () => {
    let p: PageState = emptyPage();
    p = addPanel(p, { id: 'panel_x', name: 'X', shape: 'rect', points: rectToPolygon(0, 0, 100, 100) });
    p = addPlacement(p, placement({ panelId: 'panel_x' }));
    p = deletePanel(p, 'panel_x');
    expect(p.panels).toHaveLength(0);
    expect(p.placements).toHaveLength(1);
    expect(p.placements[0]!.panelId).toBeNull();
  });
});

describe('bubbles', () => {
  it('a speech bubble outline is a closed polygon with a tail', () => {
    const b = bubble({ tail: 90 });
    const outline = bubbleOutline(b);
    expect(outline.length).toBeGreaterThan(10);
    // the tail tip reaches further down than the ellipse
    const maxY = Math.max(...outline.map((p) => p.y));
    expect(maxY).toBeGreaterThan(b.y + b.height / 2);
  });

  it('a caption is a rectangle', () => {
    const outline = bubbleOutline(bubble({ kind: 'caption', tail: null }));
    expect(outline).toHaveLength(4);
  });

  it('a thought bubble has trailing circles', () => {
    const trail = thoughtTrail(bubble({ kind: 'thought', tail: 90 }));
    expect(trail).toHaveLength(2);
    expect(trail[0]!.r).toBeGreaterThan(trail[1]!.r);
  });

  it('a shout bubble is spiky', () => {
    const outline = bubbleOutline(bubble({ kind: 'shout' }));
    const radii = outline.map((p) => Math.hypot(p.x - 100, p.y - 100));
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(5);
  });

  it('the text box sits inside the bubble', () => {
    const b = bubble();
    const box = bubbleTextBox(b);
    expect(box.x).toBeGreaterThan(b.x - b.width / 2);
    expect(box.x + box.width).toBeLessThan(b.x + b.width / 2);
  });

  it('updates clamp the size and truncate the text', () => {
    let p: PageState = emptyPage();
    p = addBubble(p, bubble());
    p = updateBubble(p, 'bubble_1', { width: 1, height: 1, text: 'x'.repeat(PAGE_LIMITS.text + 50) });
    expect(p.bubbles[0]!.width).toBeGreaterThanOrEqual(8);
    expect(p.bubbles[0]!.text.length).toBe(PAGE_LIMITS.text);
  });
});

describe('text wrapping', () => {
  const measure = (s: string) => s.length * 10;

  it('wraps on word boundaries', () => {
    const lines = wrapText('one two three four', 90, measure);
    expect(lines).toEqual(['one two', 'three', 'four']);
  });

  it('keeps explicit newlines', () => {
    expect(wrapText('a\nb', 100, measure)).toEqual(['a', 'b']);
  });

  it('breaks a word that is wider than the box', () => {
    const lines = wrapText('abcdefghij', 30, measure);
    expect(lines).toEqual(['abc', 'def', 'ghi', 'j']);
  });
});

describe('hit testing', () => {
  it('finds the topmost thing under a point', () => {
    let p: PageState = emptyPage();
    p = addPanel(p, { id: 'panel_a', name: 'A', shape: 'rect', points: rectToPolygon(0, 0, 200, 200) });
    p = addPlacement(p, placement({ id: 'pl', x: 100, y: 100, width: 100, height: 100, panelId: 'panel_a' }));
    p = addBubble(p, bubble({ id: 'bb', x: 100, y: 100, width: 40, height: 40 }));
    expect(hitTestPage(p, { x: 100, y: 100 })).toEqual({ kind: 'bubble', id: 'bb' });
    expect(hitTestPage(p, { x: 100, y: 140 })).toEqual({ kind: 'placement', id: 'pl' });
    expect(hitTestPage(p, { x: 10, y: 10 })).toEqual({ kind: 'panel', id: 'panel_a' });
    expect(hitTestPage(p, { x: 500, y: 500 })).toBeNull();
  });
});

describe('resizing the page', () => {
  it('rescales panels, placements and bubbles so the layout survives', () => {
    let p: PageState = { ...emptyPage(), size: { width: 100, height: 100 }, dpi: 100 };
    p = addPanel(p, { id: 'panel_a', name: 'A', shape: 'rect', points: rectToPolygon(0, 0, 100, 100) });
    p = addPlacement(p, placement({ x: 50, y: 50, scale: 1 }));
    p = addBubble(p, bubble({ x: 50, y: 50, width: 20, height: 20, fontSize: 10 }));
    const before = pagePixelSize(p);
    const next = resizePage(p, { width: 200, height: 200 }, 100);
    const after = pagePixelSize(next);
    // rounding is per-size, so compare against the target size rather than doubling the rounded source
    expect(after.width).toBe(pagePixelSize({ ...p, size: { width: 200, height: 200 } }).width);
    expect(after.width).toBeGreaterThan(before.width * 1.9);
    // the scale factor is derived from the rounded pixel sizes, so allow sub-pixel drift
    expect(next.placements[0]!.x).toBeCloseTo(100, 0);
    expect(next.placements[0]!.scale).toBeCloseTo(2, 1);
    expect(next.bubbles[0]!.fontSize).toBeCloseTo(20, 0);
    expect(polygonBounds(next.panels[0]!.points).x1).toBeCloseTo(200, 0);
  });

  it('clamps the DPI to the supported range', () => {
    const p = resizePage(emptyPage(), { width: 100, height: 100 }, 5000);
    expect(p.dpi).toBe(PAGE_LIMITS.maxDpi);
  });
});

describe('schema v4 migration (additive only)', () => {
  it('is the current version', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(5);
  });

  it('adds a page to a v3 project and changes nothing else', () => {
    const v3 = { ...validProject(), schemaVersion: 3 } as Record<string, unknown>;
    delete v3.page;
    const before = structuredClone(v3);
    // target 4 explicitly: this test is about the v3 -> v4 page step, not about whatever version is current
    const { data, migratedFrom } = migrateProjectData(v3, MIGRATIONS, 4);
    expect(migratedFrom).toBe(3);
    expect(data.schemaVersion).toBe(4);
    expect(data.page).toBeDefined();
    // every pre-existing field is byte-identical
    for (const key of Object.keys(before)) {
      if (key === 'schemaVersion') continue;
      expect(JSON.stringify(data[key])).toBe(JSON.stringify(before[key]));
    }
  });

  it('leaves an existing page untouched', () => {
    const p = validProject();
    const withPage = { ...p, page: { ...p.page, gutter: 9 } };
    const { data } = migrateProjectData({ ...withPage, schemaVersion: 3 });
    expect((data.page as { gutter: number }).gutter).toBe(9);
  });

  it('is idempotent', () => {
    const v3 = { ...validProject(), schemaVersion: 3 } as Record<string, unknown>;
    delete v3.page;
    const once = MIGRATIONS[3]!(v3);
    const twice = MIGRATIONS[3]!(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('a migrated v3 project validates', () => {
    const v3 = { ...validProject(), schemaVersion: 3 } as Record<string, unknown>;
    delete v3.page;
    const { data } = migrateProjectData(v3);
    const res = validateProjectFile(data);
    expect(res.ok).toBe(true);
  });
});

describe('page validation', () => {
  it('accepts a valid page', () => {
    const res = validateProjectFile(validProject());
    expect(res.ok).toBe(true);
  });

  it('rejects a bad DPI', () => {
    const p = validProject();
    const res = validateProjectFile({ ...p, page: { ...p.page, dpi: 5000 } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(' ')).toContain('page.dpi');
  });

  it('rejects a placement pointing at a missing asset', () => {
    const p = validProject();
    const res = validateProjectFile({ ...p, page: { ...p.page, placements: [placement({ assetId: 'asset_nope' })] } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(' ')).toContain('unknown asset');
  });

  it('rejects a placement in a panel that does not exist', () => {
    const p = validProject();
    const res = validateProjectFile({ ...p, page: { ...p.page, placements: [placement({ panelId: 'panel_ghost' })] } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(' ')).toContain('panelId');
  });

  it('rejects a panel with fewer than three points', () => {
    const p = validProject();
    const res = validateProjectFile({ ...p, page: { ...p.page, panels: [{ id: 'panel_a', name: 'A', shape: 'rect', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] } });
    expect(res.ok).toBe(false);
  });

  it('rejects an unknown bubble kind', () => {
    const p = validProject();
    const res = validateProjectFile({ ...p, page: { ...p.page, bubbles: [{ ...bubble(), kind: 'whisper' }] } });
    expect(res.ok).toBe(false);
  });

  it('accepts a project with no page at all (pre-v4 data)', () => {
    const p = validProject() as unknown as Record<string, unknown>;
    delete p.page;
    const res = validateProjectFile(p);
    expect(res.ok).toBe(true);
  });
});
