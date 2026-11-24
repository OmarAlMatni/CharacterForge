import {
  bubbleOutline,
  bubbleTextBox,
  mmToPx,
  pageExportSize,
  panelContentPolygon,
  thoughtTrail,
  wrapText,
} from '../core/page.ts';
import type { Bubble, PageState, Panel, Placement } from '../core/page.ts';
import type { Vec2 } from '../core/math.ts';
import { ctx2d, newCanvas } from './pngEncode.ts';

/**
 * Paints a manga page. The same function draws the on-screen preview and the print export — the only difference is the
 * scale factor — so what the artist sees is what gets printed.
 *
 * Draw order: paper → panels (clipped, with their placed images) → free placements → panel borders → lettering.
 * Borders are drawn after the images so a character that overflows its frame is still bounded by the panel line.
 */

export interface PageRenderOptions {
  /** Page pixels → output pixels. 1 = the page's own DPI. */
  scale?: number;
  /** Draw the panel frames and borders. Off for a "clean" preview. */
  borders?: boolean;
  /** Draw the paper colour. Off to export a transparent page. */
  paper?: boolean;
  /** Draw lettering. */
  bubbles?: boolean;
  /** Draw the bleed area (only meaningful for the export). */
  bleed?: boolean;
  /** Resolve a placement's decoded image. */
  image: (assetId: string) => CanvasImageSource | null;
  /** Measure a string in the bubble font, in page pixels. Defaults to a character-count estimate. */
  measure?: (text: string, fontSize: number) => number;
}

export interface PageRenderResult {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** Page pixels → output pixels. */
  scale: number;
  /** Offset of the trim area inside the canvas (the bleed). */
  offset: number;
}

const DEFAULT_MEASURE = (text: string, fontSize: number): number => text.length * fontSize * 0.55;

function pathPolygon(ctx: CanvasRenderingContext2D, points: Vec2[], offset: number, scale: number): void {
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = (p.x + offset) * scale;
    const y = (p.y + offset) * scale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
}

function drawPlacement(ctx: CanvasRenderingContext2D, pl: Placement, img: CanvasImageSource, offset: number, scale: number): void {
  const w = pl.width * pl.scale;
  const h = pl.height * pl.scale;
  ctx.save();
  ctx.globalAlpha = pl.opacity;
  ctx.translate((pl.x + offset) * scale, (pl.y + offset) * scale);
  ctx.rotate((pl.rotation * Math.PI) / 180);
  ctx.scale(pl.flipX ? -1 : 1, 1);
  ctx.drawImage(img, (-w / 2) * scale, (-h / 2) * scale, w * scale, h * scale);
  ctx.restore();
}

function drawBubble(ctx: CanvasRenderingContext2D, b: Bubble, offset: number, scale: number, measure: (t: string, f: number) => number): void {
  const outline = bubbleOutline(b);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, b.fontSize * 0.09 * scale);
  ctx.strokeStyle = '#111111';
  ctx.fillStyle = b.kind === 'caption' ? '#ffffff' : '#ffffff';

  // thought bubbles get their trailing circles first, so the main body overlaps them cleanly
  for (const t of thoughtTrail(b)) {
    ctx.beginPath();
    ctx.arc((t.x + offset) * scale, (t.y + offset) * scale, t.r * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  pathPolygon(ctx, outline, offset, scale);
  ctx.fill();
  ctx.stroke();

  // text
  const box = bubbleTextBox(b);
  const fontSize = b.fontSize * scale;
  ctx.font = `600 ${fontSize}px 'Segoe UI', 'Hiragino Sans', 'Yu Gothic UI', system-ui, sans-serif`;
  ctx.fillStyle = '#111111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = wrapText(b.text, box.width, (s) => measure(s, b.fontSize));
  const lineHeight = fontSize * 1.22;
  const total = lines.length * lineHeight;
  const startY = (box.y + offset) * scale + (box.height * scale - total) / 2 + lineHeight / 2;
  lines.forEach((line, i) => {
    ctx.fillText(line, (box.x + box.width / 2 + offset) * scale, startY + i * lineHeight);
  });
  ctx.restore();
}

/** Paint the page onto a fresh canvas. */
export function renderPage(page: PageState, opts: PageRenderOptions): PageRenderResult {
  const scale = opts.scale ?? 1;
  const size = pageExportSize(page);
  const offset = opts.bleed === false ? 0 : size.bleed;
  const width = Math.max(1, Math.round((size.width - (opts.bleed === false ? size.bleed * 2 : 0)) * scale));
  const height = Math.max(1, Math.round((size.height - (opts.bleed === false ? size.bleed * 2 : 0)) * scale));
  const canvas = newCanvas(width, height);
  const ctx = ctx2d(canvas);
  const measure = opts.measure ?? DEFAULT_MEASURE;

  if (opts.paper !== false) {
    ctx.fillStyle = page.background;
    ctx.fillRect(0, 0, width, height);
  }

  const byPanel = new Map<string, Placement[]>();
  const free: Placement[] = [];
  for (const pl of page.placements) {
    if (pl.panelId) {
      const list = byPanel.get(pl.panelId) ?? [];
      list.push(pl);
      byPanel.set(pl.panelId, list);
    } else free.push(pl);
  }

  // panels: clip to the content polygon (frame inset by half the gutter), then paint the images inside
  for (const panel of page.panels) {
    const content = panelContentPolygon(panel, page);
    ctx.save();
    pathPolygon(ctx, content, offset, scale);
    ctx.clip();
    for (const pl of byPanel.get(panel.id) ?? []) {
      const img = opts.image(pl.assetId);
      if (img) drawPlacement(ctx, pl, img, offset, scale);
    }
    ctx.restore();
  }

  for (const pl of free) {
    const img = opts.image(pl.assetId);
    if (img) drawPlacement(ctx, pl, img, offset, scale);
  }

  if (opts.borders !== false) {
    const bw = Math.max(0, mmToPx(page.borderWidth, page.dpi));
    if (bw > 0) {
      ctx.save();
      ctx.strokeStyle = page.borderColor;
      ctx.lineWidth = bw * scale;
      ctx.lineJoin = 'miter';
      for (const panel of page.panels) {
        pathPolygon(ctx, panel.points, offset, scale);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  if (opts.bubbles !== false) {
    for (const b of page.bubbles) drawBubble(ctx, b, offset, scale, measure);
  }

  return { canvas, width, height, scale, offset };
}

/** Convenience: the page at its own print resolution (1 page pixel = 1 output pixel). */
export function renderPageAtPrintSize(page: PageState, opts: Omit<PageRenderOptions, 'scale'>): PageRenderResult {
  return renderPage(page, { ...opts, scale: 1 });
}

/** A panel's content polygon in page pixels, for the UI to draw selection outlines. */
export const panelContent = (panel: Panel, page: PageState): Vec2[] => panelContentPolygon(panel, page);
