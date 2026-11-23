export function canvasToBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed. The image may be too large for this browser.'))), 'image/png');
  });
}

export async function canvasToPngBytes(c: HTMLCanvasElement): Promise<Uint8Array> {
  return new Uint8Array(await (await canvasToBlob(c)).arrayBuffer());
}

export function newCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser could not create a 2D canvas.');
  return ctx;
}

/** Decode image bytes without colour-space conversion or alpha premultiplication, into a canvas. */
export async function decodeToCanvas(bytes: Uint8Array, mime: string): Promise<HTMLCanvasElement> {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    bmp = await createImageBitmap(blob);
  }
  const c = newCanvas(bmp.width, bmp.height);
  ctx2d(c).drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}
