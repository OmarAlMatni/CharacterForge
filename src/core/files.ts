/** Cheap byte-level sniffing so unsupported/corrupt files are rejected with clear messages before decoding. */
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export const isPng = (b: Uint8Array): boolean => b.length >= 33 && PNG_SIG.every((v, i) => b[i] === v);
export const isPsd = (b: Uint8Array): boolean => b.length >= 26 && b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0x53; // "8BPS"

/** Width/height from the PNG IHDR chunk without decoding the image. */
export function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (!isPng(b)) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

export type DetectedKind = 'png' | 'psd' | 'unknown';
export const detectKind = (b: Uint8Array): DetectedKind => (isPng(b) ? 'png' : isPsd(b) ? 'psd' : 'unknown');

export function mimeFor(kind: 'png' | 'psd'): string {
  return kind === 'png' ? 'image/png' : 'image/vnd.adobe.photoshop';
}

export const isJpeg = (b: Uint8Array): boolean => b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
export const isWebp = (b: Uint8Array): boolean =>
  b.length >= 16 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50; // "RIFF....WEBP"

export type ImageKind = 'png' | 'jpeg' | 'webp' | 'unknown';
/** Raster formats accepted for character artwork and references. */
export const detectImageKind = (b: Uint8Array): ImageKind => (isPng(b) ? 'png' : isJpeg(b) ? 'jpeg' : isWebp(b) ? 'webp' : 'unknown');
export const imageMime = (k: Exclude<ImageKind, 'unknown'>): string => (k === 'png' ? 'image/png' : k === 'jpeg' ? 'image/jpeg' : 'image/webp');

/** Cheap structural check per mime type, used when reading bundles. */
export function looksLikeMime(bytes: Uint8Array, mime: string): boolean {
  if (mime === 'image/png') return isPng(bytes);
  if (mime === 'image/jpeg') return isJpeg(bytes);
  if (mime === 'image/webp') return isWebp(bytes);
  if (mime === 'image/vnd.adobe.photoshop') return isPsd(bytes);
  return false;
}

/**
 * Pixel size read from the file header (PNG, JPEG, WebP) without decoding. Used to check what a file CLAIMS against what a project
 * says about it, and to refuse absurd sizes before anything is decoded. Returns null when the header cannot be understood.
 */
export function imageSize(b: Uint8Array, mime: string): { width: number; height: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (mime === 'image/png') return pngSize(b);
  if (mime === 'image/jpeg') {
    if (!isJpeg(b)) return null;
    let o = 2;
    for (let guard = 0; guard < 4096 && o + 9 < b.length; guard++) {
      if (b[o] !== 0xff) return null;
      const m = b[o + 1]!;
      if (m === 0xff) { o++; continue; } // fill byte
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: v.getUint16(o + 5), width: v.getUint16(o + 7) };
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { o += 2; continue; } // markers without a length
      o += 2 + v.getUint16(o + 2);
    }
    return null;
  }
  if (mime === 'image/webp') {
    if (!isWebp(b) || b.length < 30) return null;
    const tag = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (tag === 'VP8 ') return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
    if (tag === 'VP8L' && b[20] === 0x2f) {
      const bits = v.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (tag === 'VP8X') return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    return null;
  }
  return null;
}
