# Projection rewrite — technical spec (v0.5, Phase 1)

Status: implemented in this run. Supersedes the v0.4.1 projection described in `docs/` and in the v0.4.1 assessment.

## 1. The defect, precisely

v0.4.1 bakes texture coordinates with `bakeUv()` (`src/pose/projection.ts`): every vertex is projected
straight along Z, in the pose the drawing was made in, and its `(x, y)` becomes the image pixel it samples.
The fragment shader (`src/render/characterBody.ts`) then decides front vs back from the **model-space normal's
Z component**:

```glsl
base = mix(base, f.rgb, f.a * smoothstep(0.12, 0.55, vFacing));   // front
base = mix(base, b.rgb, b.a * smoothstep(0.12, 0.55, -vFacing));  // back
```

Three independent failures follow from that, and they are failures of *method*, not of tuning:

1. **The sides have no data and no colour.** `vFacing` is the normal's Z. On the flank of the torso and the
   outer arm, `|vFacing| < 0.12`, so both weights are zero and the fragment is pure `uFill` — one flat colour.
   Between 0.12 and 0.55 it is a linear mix of drawing and flat colour. That is the pale, streaky band.
2. **The drawing's outline and the mesh's outline do not coincide.** The drawing's figure is a different
   silhouette from the posed mesh (different proportions, different limb placement, different hair). Where the
   mesh is wider than the drawing, the extra surface samples the padded background; where it is narrower, the
   drawing's outline is cut off. The visible result is a doubled / ghost edge.
3. **The front/back split is a normal test, not a visibility test.** At the silhouette the normal is
   perpendicular to the view, so the split degenerates exactly where the two textures should meet. Nothing
   decides which shell is actually in front.

## 2. Approach

Three changes, each addressing one failure. All the geometry work stays in pure TypeScript so it is testable
in Node, matching the existing architecture (the pose engine and the silhouette rasteriser are already pure).

### 2.1 Silhouette-conforming UV relaxation (fixes 2, and most of 3)

Instead of `uv = orthographic projection of the vertex`, solve for UVs that make the **mesh's silhouette
coincide with the drawing's figure outline**:

1. Rasterise the mesh's silhouette in the baked pose, at working resolution, using only **front-facing**
   triangles for the front texture and only **back-facing** triangles for the back texture. (v0.4.1 used the
   union of all triangles, which is why the front silhouette included the back of the body.)
2. Mark the **boundary vertices** of that silhouette: vertices whose projected pixel is inside the silhouette
   and has at least one outside 4-neighbour.
3. For each boundary vertex, find the **nearest boundary pixel of the drawing's figure mask** (a chamfer
   distance transform that stores the nearest boundary pixel, not just the distance) and use that pixel as the
   vertex's target UV.
4. Relax the interior: iterate `uv_i ← mean(uv of edge-neighbours)` with the boundary vertices pinned, for a
   fixed number of Gauss–Seidel sweeps. This is a Laplacian solve with Dirichlet boundary conditions; it is
   smooth, it cannot fold (the boundary is convex-ish per limb and the initial field is a projection), and it
   converges in a few hundred sweeps on a 40k-vertex mesh.

The result: the drawing's outline lands on the mesh's outline. The face's jaw and hair line land on the head's
outline, which is what stops the features sliding toward the silhouette.

**Depth-aware** in the sense that matters here: the front solve only sees front-facing triangles and the back
solve only sees back-facing ones, so a vertex on the back of the torso is never pulled onto the front
silhouette.

### 2.2 Directional side-fill (fixes 1)

`padFigureTexture` (v0.4.1) replaces the background with the **nearest figure pixel** for 4% of the image and
fades to transparent. Nearest-pixel propagation produces radial streaks and, at 4%, runs out long before the
flank of a wide body.

Replace it with a **directional extrusion**: for every boundary pixel of the figure mask, walk outward along
the outward normal of the silhouette for `band` pixels, writing that boundary pixel's colour with a linear
alpha falloff. Where several boundary pixels reach the same outside pixel, the nearest one wins. The colour
therefore wraps *around the curve* — a sleeve's colour continues around the arm, a trouser leg's colour
continues around the thigh — instead of smearing the nearest pixel radially.

The band is now a fraction of the figure's own size (default 12% of the figure's larger dimension, clamped),
not 4% of the whole image, so it covers the flank of a body that is wider than the drawing.

### 2.3 Occlusion-aware front/back blending (fixes 3)

Replace the `smoothstep(0.12, 0.55, vFacing)` test with a **visibility** test computed from a depth pass:

1. Rasterise the posed mesh into a CPU depth buffer at working resolution (the same rasteriser that already
   produces silhouettes, extended to interpolate and keep the nearest depth per pixel).
2. For each vertex, compare its own view depth to the depth buffer at its projected pixel. A vertex within a
   small epsilon of the front-most depth is **front**; anything behind it is **back**.
3. Smooth the resulting 0/1 field over the mesh with a few Laplacian sweeps, so the transition is a band a few
   vertices wide rather than a hard seam.
4. Upload it as `aFront` and use it directly: `w_front = aFront`, `w_back = 1 - aFront`.

At the silhouette the front-most surface wins, so the front drawing now reaches the outline instead of fading
into `uFill`. The flat fill colour survives only as the fallback for surfaces the drawing genuinely does not
cover (the back when no back view was supplied).

## 3. Files

| File | Change |
|---|---|
| `src/pose/uvRelax.ts` | **new** — boundary detection, nearest-boundary field, Laplacian UV relaxation, CPU depth buffer, visibility field. Pure TS. |
| `src/pose/sideFill.ts` | **new** — directional silhouette extrusion (`extrudeSilhouetteColor`). Pure TS. |
| `src/pose/projection.ts` | add `facingSilhouette()` (rasterise only triangles of one winding) and `depthBuffer()`. |
| `src/pose/texturePad.ts` | keep `padFigureTexture` (still used, still tested); it is no longer the projection texture. |
| `src/pose/index.ts` | export the two new modules. |
| `src/render/characterBody.ts` | new attributes `aFront`; new sampler `uSide`; fragment shader uses `aFront` and the side-fill texture; `setArtwork` runs the relaxation and the visibility pass. |
| `src/app/artwork.ts` | build the side-fill texture with `extrudeSilhouetteColor`; expose the figure mask and its boundary to the body. |
| `src/app/store.ts` | pass the mask through `BodyArtwork`. |
| `tests/uvRelax.test.ts` | **new** — boundary, nearest-boundary, relaxation convergence, depth buffer, visibility. |
| `tests/sideFill.test.ts` | **new** — extrusion direction, colour, alpha falloff, no background leak. |

Untouched, by requirement: `src/pose/pose.ts`, `src/pose/fk.ts`, `src/pose/limbIk.ts`, `src/pose/skeleton.ts`,
`src/pose/bodyMesh.ts`, `src/pose/bodyShape.ts`, `src/core/character.ts`, `src/core/schema.ts`,
`src/core/migrations.ts`. The data model and the pose engine are not modified.

## 4. Acceptance criteria

Machine-checkable, in `tests/uvRelax.test.ts` and `tests/sideFill.test.ts`:

- **AC1** — `silhouetteBoundary` marks exactly the inside pixels with an outside 4-neighbour; a solid rectangle
  of `w×h` yields a 1-pixel ring of `2(w+h)-4` pixels.
- **AC2** — `nearestBoundaryField` returns distance 0 on boundary pixels and the true Euclidean distance
  (±1 px) elsewhere; the stored index is a boundary pixel.
- **AC3** — after relaxation, every pinned boundary vertex's UV is within 1 px of the drawing's outline, and
  the mean displacement of interior vertices is finite and bounded (no fold: the UV field stays monotone along
  each scanline within a limb).
- **AC4** — relaxation is idempotent to within tolerance when re-run on its own output.
- **AC5** — `depthBuffer` keeps the nearest depth per pixel; a vertex on the front shell is classified front,
  a vertex on the back shell at the same pixel is classified back.
- **AC6** — `extrudeSilhouetteColor` never writes a background colour into the band; the band's colour at a
  given outward step equals the boundary colour it came from; alpha decreases monotonically with distance.
- **AC7** — `tsc --noEmit` clean; the existing 280 tests still pass.

Visual, in the before/after render:

- **AC8** — no flat `uFill` band on the flanks of the torso or the outer arms: the side of the body carries the
  drawing's own edge colour.
- **AC9** — no doubled silhouette edge: the drawing's outline and the mesh's outline coincide within ~2 px at
  the shoulders, hips and outer legs.
- **AC10** — face features stay inside the head silhouette at 0° and at 40° azimuth.

## 5. What this does not fix

- A front drawing still contains no information about the side of the body. The side-fill extends the
  silhouette's colour around the curve; it does not invent shading or detail. Multi-view projection (upgrade 04
  in the assessment) is the real answer and is out of scope here.
- Hair is still not 3D. The relaxation makes the hair line land on the head's outline, which is a large
  improvement, but a ponytail still cannot swing (upgrade 05).
- Hands and feet remain flat cutouts on 3D forms (upgrade 05/06).
- Shading is still multiplied over already-shaded artwork. The default is unchanged; the slider still exists.
