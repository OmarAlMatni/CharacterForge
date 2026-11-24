import type { BodyMesh } from './bodyMesh.ts';
import { skinBody } from './bodyMesh.ts';
import type { Box, Mask, Rgba } from './silhouette.ts';
import { rasterizeTriangles } from './silhouette.ts';
import type { Pose3D } from './pose.ts';
import { forwardKinematics } from './pose.ts';
import type { RestSkeleton } from './skeleton.ts';

/**
 * Artwork projection: the drawing is projected straight onto the body from the front (an orthographic projection along the Z axis,
 * in the pose the artwork shows). The projected coordinates are then stored per vertex, so the drawing follows the body when it moves.
 * `ArtworkFit` is the mapping from model metres to image pixels.
 */
export interface ArtworkFit {
  /** Image pixels per model metre. */
  ppm: number;
  /** Image x (pixels) of model x = 0. */
  ox: number;
  /** Image y (pixels) of model y = 0 (the ground). */
  oy: number;
}

export interface Bounds2 {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export function boundsXY(positions: Float32Array | Float64Array, count = positions.length / 3): Bounds2 {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3]!, y = positions[i * 3 + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Scale and place the model so its silhouette box coincides with the artwork's figure box:
 * the same height, centred horizontally. `mirror` is for a back-view image (x is flipped).
 */
export function alignFit(model: Bounds2, art: Box, mirror = false): ArtworkFit {
  const h = Math.max(1e-6, model.maxY - model.minY);
  const ppm = (art.y1 + 1 - art.y0) / h;
  const cx = (model.minX + model.maxX) / 2;
  const artCx = (art.x0 + art.x1 + 1) / 2;
  return { ppm, ox: artCx - (mirror ? -cx : cx) * ppm, oy: art.y1 + 1 + model.minY * ppm };
}

/** Pixel position of every vertex under a fit (2 floats per vertex). */
export function projectXY(positions: Float32Array | Float64Array, count: number, fit: ArtworkFit, mirror = false): Float32Array {
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3]!, y = positions[i * 3 + 1]!;
    out[i * 2] = fit.ox + (mirror ? -x : x) * fit.ppm;
    out[i * 2 + 1] = fit.oy - y * fit.ppm;
  }
  return out;
}

/** Texture coordinates (0..1, origin at the image's top-left) for the vertices under a fit. */
export function bakeUv(positions: Float32Array | Float64Array, count: number, fit: ArtworkFit, imgW: number, imgH: number, mirror = false): Float32Array {
  const xy = projectXY(positions, count, fit, mirror);
  for (let i = 0; i < count; i++) {
    xy[i * 2] = xy[i * 2]! / imgW;
    xy[i * 2 + 1] = xy[i * 2 + 1]! / imgH;
  }
  return xy;
}

/** Posed vertex positions of a body mesh (convenience for the projection and the fitting code). */
export function posedPositions(mesh: BodyMesh, rest: RestSkeleton, pose: Pose3D): Float32Array {
  const out = new Float32Array(mesh.vertexCount * 3);
  skinBody(mesh, forwardKinematics(rest, pose), out);
  return out;
}

/** The silhouette the posed body makes in an image of `w`×`h` pixels under a fit. */
export function bodySilhouette(positions: Float32Array, mesh: BodyMesh, fit: ArtworkFit, w: number, h: number, mirror = false): Mask {
  return rasterizeTriangles(projectXY(positions, mesh.vertexCount, fit, mirror), mesh.indices, w, h);
}

/** Mean colour of the figure's pixels (for the default fill colour of surfaces the drawing does not cover). */
export function averageFigureColor(img: Rgba, mask: Mask): string {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < mask.data.length; i += 3) {
    if (!mask.data[i] || (img.data[i * 4 + 3] ?? 255) < 200) continue;
    r += img.data[i * 4]!; g += img.data[i * 4 + 1]!; b += img.data[i * 4 + 2]!;
    n++;
  }
  if (!n) return '#c9ced8';
  const hex = (v: number): string => Math.round(v / n).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * The silhouette of only the triangles of one winding (front-facing or back-facing) in the projected image.
 *
 * v0.4.1's `bodySilhouette` rasterised every triangle, so the "front" silhouette included the back of the body and the
 * boundary it produced was the union of both shells. The UV relaxation needs the front shell's own outline, so it can
 * pin the drawing's outline to the surface that is actually seen from the front.
 *
 * `front` = true keeps triangles whose projected winding is counter-clockwise (the front shell of a closed mesh seen
 * from +Z); false keeps the other winding.
 */
export function facingSilhouette(xy: Float32Array, indices: Uint32Array, w: number, h: number, front: boolean): Mask {
  const keep = new Uint32Array(indices.length);
  let k = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 2, b = indices[t + 1]! * 2, c = indices[t + 2]! * 2;
    const area = (xy[b]! - xy[a]!) * (xy[c + 1]! - xy[a + 1]!) - (xy[c]! - xy[a]!) * (xy[b + 1]! - xy[a + 1]!);
    if ((area > 0) === front) {
      keep[k++] = indices[t]!;
      keep[k++] = indices[t + 1]!;
      keep[k++] = indices[t + 2]!;
    }
  }
  return rasterizeTriangles(xy, keep.subarray(0, k), w, h);
}
