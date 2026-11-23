import { describe, expect, it } from 'vitest';
import { isLoopbackUrl, normalizeBaseUrl } from '../src/ai/endpoint.ts';
import { alphaCoverage, intersectAlpha, invertAlpha, transparentFraction } from '../src/core/maskMath.ts';
import { detectKind, pngSize } from '../src/core/files.ts';

describe('AI endpoint privacy guard', () => {
  it('allows only loopback servers', () => {
    for (const u of ['http://127.0.0.1:8765', 'http://localhost:8000', 'http://[::1]:8000', 'https://localhost', 'http://127.0.0.2:1']) expect(isLoopbackUrl(u)).toBe(true);
    for (const u of ['https://example.com', 'http://127.0.0.1.evil.com', 'http://192.168.1.5:8000', 'ftp://localhost', 'not a url', '', 'http://localhost.evil.com']) expect(isLoopbackUrl(u)).toBe(false);
  });
  it('normalises trailing slashes', () => {
    expect(normalizeBaseUrl(' http://localhost:8765/// ')).toBe('http://localhost:8765');
  });
});

describe('mask maths', () => {
  const px = (...a: number[]) => new Uint8ClampedArray(a.flatMap((v) => [0, 0, 0, v]));
  it('inverts alpha', () => {
    const d = px(0, 255, 100);
    invertAlpha(d);
    expect([d[3], d[7], d[11]]).toEqual([255, 0, 155]);
  });
  it('intersects by multiplying alpha', () => {
    const r = intersectAlpha(px(255, 255, 0, 128), px(255, 0, 255, 128));
    expect([r[3], r[7], r[11], r[15]]).toEqual([255, 0, 0, 64]);
    expect(() => intersectAlpha(px(1), px(1, 2))).toThrow('same size');
  });
  it('measures coverage and transparency', () => {
    expect(alphaCoverage(px(0, 255, 255, 0))).toBe(0.5);
    expect(transparentFraction(px(0, 0, 5, 255))).toBe(0.5);
    expect(alphaCoverage(new Uint8ClampedArray(0))).toBe(0);
  });
});

describe('file sniffing', () => {
  const png = new Uint8Array(33);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(png.buffer).setUint32(16, 640);
  new DataView(png.buffer).setUint32(20, 480);
  it('detects PNG and reads its size without decoding', () => {
    expect(detectKind(png)).toBe('png');
    expect(pngSize(png)).toEqual({ width: 640, height: 480 });
  });
  it('detects PSD and rejects others', () => {
    const psd = new Uint8Array(30);
    psd.set([0x38, 0x42, 0x50, 0x53]);
    expect(detectKind(psd)).toBe('psd');
    expect(detectKind(new Uint8Array(40))).toBe('unknown');
    expect(pngSize(new Uint8Array(40))).toBeNull();
  });
});
