# Multi-view projection — technical spec (upgrade 04, v0.6.0)

## The problem this solves

v0.5.0 fixed the projection for a front view: silhouette-conforming UV relaxation, directional side-fill, occlusion-aware
blending. What it could not fix is that **a front drawing contains no information about the side of a torso**. The
side-fill extends the silhouette's colour around the curve; it does not invent detail. So the flank of the body is a
plausible wash rather than the character's actual clothing, and any pose that is not dead-on front-facing shows it.

The artist usually has more than one drawing: a turnaround sheet, a side reference, a back view. The data model already
had a `back` slot and a mirrored back fit. This upgrade generalises that to **N views**, each with an angle, blended by
how much each surface faces each view.

## Approach

**1. A view is an angle, not a slot.** A view is `{ assetId, angle }` where `angle` is degrees around Y: 0 = front,
+90 = the character's left side, 180 = back. `viewRight(angle)` and `viewDirection(angle)` give the view's horizontal
axis and its projection axis. At 0° these are exactly `(1,0,0)` and `(0,0,1)`, so a front view projects identically to
v0.5.0 — the generalisation is a strict superset, not a replacement.

**2. Each view is projected along its own axis and fitted to its own extent.** `projectView` replaces `projectXY` for
non-front views: the horizontal coordinate is the vertex's position along that view's right axis. A side view's
horizontal axis is the body's **depth**, so `alignFitExtent` fits the side drawing to the depth extent rather than the
width. Fitting a side drawing to the width would stretch it across the body and defeat the purpose.

**3. The relaxation machinery is reused per view, unchanged.** For each view, `facingSilhouette` rasterises only the
shell facing that view, and `relaxUvToSilhouette` pins the mesh's silhouette boundary to that drawing's outline and
relaxes the interior. The v0.5.0 solve is not modified — it is called once per view instead of once for front and once
for back.

**4. Blending is by surface orientation, not by a front/back smoothstep.** `viewWeights` computes, per vertex,
`max(0, n·d)^power` for each view's direction `d`, normalised so the row sums to 1. A surface looking at the front camera
is painted by the front drawing; a flank is painted by the side drawing; the back by the back drawing. Because the
weights are continuous in the normal, the transition between two views is a smooth band rather than a seam. A vertex
that faces no view at all (exactly at a silhouette, or a view set that does not cover that side) is given entirely to
the nearest view, so no vertex is ever left to the flat fill colour.

**5. The shader blends four texture slots.** The fragment shader samples up to four textures with per-vertex weights and
multiplies each by that sample's alpha (the side-fill's confidence), so a surface just outside a drawing still shows
that drawing's edge colour. `MAX_VIEWS = 4` matches the four slots.

## Files touched

| File | Change |
|---|---|
| `src/pose/projection.ts` | `alignFitExtent` (general fit), `viewRight`, `viewDirection`, `viewHorizontal`, `projectView`, `facingWeight`, `dominantView`, `MAX_VIEWS`. `alignFit`/`projectXY` kept and now delegate. |
| `src/pose/multiView.ts` | **New.** `ViewInput`, `normalizeAngle`, `distinctViews`, `viewWeights`, `dominantViewPerVertex`, `viewCoverage`, `viewExtent`. |
| `src/pose/index.ts` | Re-exports `multiView.ts`. |
| `src/render/characterBody.ts` | `BodyArtwork` takes `views: ArtworkView[]`; four UV/weight attribute pairs; shader blends N textures; `setArtwork` bakes each view and computes weights from the posed normals. |
| `src/core/character.ts` | `ProjectedView` type, `views` field on `ArtworkProjection`, `artworkViews()` (v3 fallback), `withViews()` (keeps `front`/`back` in sync), asset collection includes views. |
| `src/core/schema.ts` | Validates `views` (array, ≤4, each with a 0–360 angle); `hasAny` includes views. |
| `src/core/migrations.ts` | `CURRENT_SCHEMA_VERSION = 4`; v3→v4 seeds `views` from `front`/`back` at 0°/180°. |
| `src/app/store.ts` | `projectArtwork` builds the view set with per-view fits; `addView`, `removeView`, `viewCoverageReport`; `bodyArtwork` maps all views. |
| `src/ui/StudioView.tsx` | View list with angle, name, **share of body painted**, remove; add-view picker (reference + angle). |
| `tests/multiView.test.ts` | **New.** 26 tests. |

## Acceptance criteria

1. `tsc --noEmit` clean.
2. The existing vitest suite still passes; new tests cover the view axes, the fit, the weights and the coverage.
3. A 0° view projects identically to v0.5.0 (asserted: `projectView` at 0° equals `projectXY`).
4. A side view projects the body's depth, not its width (asserted).
5. A flank surface is driven by the side view, a back surface by the back view (asserted).
6. Every vertex's weights sum to 1, and no vertex is left unpainted (asserted).
7. A v3 project opens and renders unchanged (migration seeds views from front/back).
8. Before/after renders of the same character and pose, one view vs three, show the flank painted by the side drawing.
