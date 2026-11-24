import type { CameraState } from '../pose/camera.ts';
import { DEFAULT_CAMERA } from '../pose/camera.ts';
import type { Pose3D } from '../pose/pose.ts';
import { restPose } from '../pose/pose.ts';
import type { BodyShape } from '../pose/bodyShape.ts';
import { DEFAULT_SHAPE } from '../pose/bodyShape.ts';
import type { ArtworkFit } from '../pose/projection.ts';
import type { Proportions } from '../pose/skeleton.ts';
import { DEFAULT_PROPORTIONS } from '../pose/skeleton.ts';
import type { ID } from './types.ts';

/**
 * Character profile data: everything that makes up "this character" apart from the 2D layer canvas.
 * It references binary images by asset id only; the images themselves live in the project's asset store.
 */
export type ReferenceRole = 'face' | 'alt-view' | 'clothing' | 'accessory' | 'expression' | 'other';
export const REFERENCE_ROLES: { id: ReferenceRole; label: string }[] = [
  { id: 'face', label: 'Face close-up' },
  { id: 'alt-view', label: 'Alternate view' },
  { id: 'clothing', label: 'Clothing detail' },
  { id: 'accessory', label: 'Accessory' },
  { id: 'expression', label: 'Expression' },
  { id: 'other', label: 'Other' },
];

export interface ReferenceImage {
  id: ID;
  assetId: ID;
  label: string;
  role: ReferenceRole;
  notes: string;
  fileName: string;
  /** Approved references are sent to the generation adapter; unapproved ones are only stored. */
  approved: boolean;
  addedAt: number;
}

/** Descriptive metadata. Text alone does NOT guarantee consistency — reference images are what generation adapters receive. */
export interface Appearance {
  palette: string[];
  hair: string;
  eyes: string;
  clothing: string;
  accessories: string;
  notes: string;
}

export interface SavedPose3D {
  id: ID;
  name: string;
  createdAt: number;
  pose: Pose3D;
  camera: CameraState;
}

/** One drawing projected onto the body (front view, or an optional back view). */
export interface ProjectedImage {
  assetId: ID;
  /** Pixel size of the image, so the texture coordinates can be rebuilt without decoding it. */
  width: number;
  height: number;
  /** Mapping from model metres to this image's pixels. */
  fit: ArtworkFit;
}

/**
 * One drawing supplied for a view of the character (schema v4+). `angle` is degrees around Y: 0 = front, +90 = the
 * character's left side, 180 = back. The renderer blends the views by how much each surface faces each one, so a side
 * drawing paints the flank instead of the front drawing being stretched around it.
 */
export interface ProjectedView extends ProjectedImage {
  angle: number;
}

/**
 * The character's artwork as it appears on the 3D body. The drawing is projected from the front in the pose the drawing shows
 * (`bakedPose`); the coordinates stay attached to the body, so the drawing follows it when it moves.
 *
 * `views` (schema v4+) is the multi-view set. `front`/`back` are kept as the v3 representation and stay in sync with the
 * 0° and 180° entries of `views`, so a project written by an older build still opens and a project written here still
 * opens in one.
 */
export interface ArtworkProjection {
  front: ProjectedImage | null;
  back: ProjectedImage | null;
  /** Multi-view drawings, at most `MAX_VIEWS`. Empty means "use front/back only" (a v3 project). */
  views: ProjectedView[];
  /** Pose the body had when the artwork was aligned and projected. */
  bakedPose: Pose3D | null;
  /** Show the projected artwork on the model (otherwise the plain clay model). */
  show: boolean;
  /** Colour of surfaces the drawing does not cover (sides, and the back when there is no back view). #rrggbb */
  fill: string;
  /** 0 = flat artwork colours, 1 = fully lit by the scene light. */
  shading: number;
  /** A translucent copy of the drawing in the viewport to line the body up with it. */
  overlay: { show: boolean; opacity: number };
}

export interface StudioState {
  proportions: Proportions;
  /** How thick the body is (see `BodyShape`). Together with `proportions` this sizes the model to match the character. */
  shape: BodyShape;
  pose: Pose3D;
  camera: CameraState;
  output: { width: number; height: number };
  poses: SavedPose3D[];
  artwork: ArtworkProjection;
}

export type GuideKind = 'mannequin' | 'textured' | 'pose' | 'depth' | 'silhouette';
export const GUIDE_KINDS: { id: GuideKind; label: string; description: string }[] = [
  { id: 'mannequin', label: 'Clay model', description: 'Shaded grey render of the character model in this pose.' },
  { id: 'textured', label: 'Character render', description: 'The model with your artwork projected onto it. Needs the artwork to be projected first.' },
  { id: 'pose', label: 'Pose map', description: 'OpenPose-style coloured skeleton on black, for pose-conditioned models.' },
  { id: 'depth', label: 'Depth', description: 'Near = white, far = black.' },
  { id: 'silhouette', label: 'Silhouette', description: 'White figure on black.' },
];

export type GenerationStatus = 'candidate' | 'accepted' | 'rejected';
export type GenerationOrigin = 'generated' | 'imported';

export interface GenerationProvenance {
  providerId: string;
  providerName: string;
  model: string | null;
  requestedAt: number;
  completedAt: number;
  settings: { width: number; height: number; instructions: string; seed: number | null };
  originalAssetId: ID | null;
  referenceAssetIds: ID[];
  guideAssetIds: Partial<Record<GuideKind, ID>>;
  pose: Pose3D;
  camera: CameraState;
  proportions: Proportions;
  /** Body shape at the time (absent in results saved before body shapes existed). */
  shape?: BodyShape;
  poseId: ID | null;
  poseName: string | null;
  /** Result this one was a retry of, if any. */
  parentId: ID | null;
}

export interface GenerationRecord {
  id: ID;
  createdAt: number;
  /** 'generated' = produced by a provider; 'imported' = made elsewhere and imported by the user (never labelled as generated). */
  origin: GenerationOrigin;
  status: GenerationStatus;
  outputAssetId: ID;
  note: string;
  decidedAt: number | null;
  provenance: GenerationProvenance;
}

export interface CharacterState {
  /** The original full-body drawing. Never overwritten silently: replacing it keeps the old one in `previousOriginals`. */
  originalAssetId: ID | null;
  previousOriginals: { assetId: ID; replacedAt: number }[];
  references: ReferenceImage[];
  appearance: Appearance;
  studio: StudioState;
  generations: GenerationRecord[];
  /** Last-used generation settings. */
  instructions: string;
  providerId: string | null;
}

export const CHARACTER_LIMITS = { references: 64, generations: 2000, poses: 500, text: 4000, palette: 16, previousOriginals: 50 } as const;

export const DEFAULT_OUTPUT = { width: 768, height: 1152 } as const;

export const emptyAppearance = (): Appearance => ({ palette: [], hair: '', eyes: '', clothing: '', accessories: '', notes: '' });

export const DEFAULT_FILL = '#c9ced8';

export function emptyArtwork(): ArtworkProjection {
  return { front: null, back: null, views: [], bakedPose: null, show: true, fill: DEFAULT_FILL, shading: 0.35, overlay: { show: false, opacity: 0.5 } };
}

/**
 * The views to render, derived from the stored state. A v3 project has only `front`/`back`; a v4 project has `views`.
 * This is the single place that decides, so the renderer never has to know which schema wrote the project.
 */
export function artworkViews(a: ArtworkProjection): ProjectedView[] {
  if (a.views.length > 0) return a.views;
  const out: ProjectedView[] = [];
  if (a.front) out.push({ ...a.front, angle: 0 });
  if (a.back) out.push({ ...a.back, angle: 180 });
  return out;
}

/**
 * Write a multi-view set back into the v3-compatible `front`/`back` slots, so an older build (and the bundle format)
 * still sees a usable projection. The 0° view becomes `front`, the 180° view becomes `back`.
 */
export function withViews(a: ArtworkProjection, views: ProjectedView[]): ArtworkProjection {
  const at = (deg: number): ProjectedImage | null => {
    const v = views.find((x) => Math.abs(((x.angle % 360) + 360) % 360 - deg) < 1e-6);
    return v ? { assetId: v.assetId, width: v.width, height: v.height, fit: v.fit } : null;
  };
  return { ...a, views, front: at(0), back: at(180) };
}

export function emptyStudio(): StudioState {
  return {
    proportions: { ...DEFAULT_PROPORTIONS },
    shape: { ...DEFAULT_SHAPE },
    artwork: emptyArtwork(),
    pose: restPose(),
    camera: { ...DEFAULT_CAMERA, target: { ...DEFAULT_CAMERA.target } },
    output: { ...DEFAULT_OUTPUT },
    poses: [],
  };
}

export function emptyCharacter(originalAssetId: ID | null = null): CharacterState {
  return {
    originalAssetId,
    previousOriginals: [],
    references: [],
    appearance: emptyAppearance(),
    studio: emptyStudio(),
    generations: [],
    instructions: '',
    providerId: null,
  };
}

// ---------------------------------------------------------------- pure operations (all return new state)

const trimText = (s: string): string => s.slice(0, CHARACTER_LIMITS.text);

export function setOriginal(c: CharacterState, assetId: ID, now: number): CharacterState {
  if (c.originalAssetId === assetId) return c;
  // Never drop an earlier original to make room: that would silently discard the artist's artwork (it would be pruned as unused).
  if (c.originalAssetId && c.previousOriginals.length >= CHARACTER_LIMITS.previousOriginals) {
    throw new Error(`This profile already keeps ${CHARACTER_LIMITS.previousOriginals} earlier originals and will not discard any. Export a bundle and start a new profile, or duplicate this one, before replacing the original again.`);
  }
  const prev = c.originalAssetId ? [...c.previousOriginals, { assetId: c.originalAssetId, replacedAt: now }] : c.previousOriginals;
  return { ...c, originalAssetId: assetId, previousOriginals: prev };
}

export function addReference(c: CharacterState, r: ReferenceImage): CharacterState {
  if (c.references.length >= CHARACTER_LIMITS.references) throw new Error(`A character can have at most ${CHARACTER_LIMITS.references} reference images.`);
  return { ...c, references: [...c.references, r] };
}

export function updateReference(c: CharacterState, id: ID, patch: Partial<Pick<ReferenceImage, 'label' | 'role' | 'notes' | 'approved'>>): CharacterState {
  return { ...c, references: c.references.map((r) => (r.id === id ? { ...r, ...patch, notes: patch.notes !== undefined ? trimText(patch.notes) : r.notes } : r)) };
}

export function removeReference(c: CharacterState, id: ID): CharacterState {
  return { ...c, references: c.references.filter((r) => r.id !== id) };
}

export function updateAppearance(c: CharacterState, patch: Partial<Appearance>): CharacterState {
  const a = { ...c.appearance, ...patch };
  for (const k of ['hair', 'eyes', 'clothing', 'accessories', 'notes'] as const) a[k] = trimText(a[k]);
  a.palette = a.palette.filter((x) => /^#[0-9a-fA-F]{6}$/.test(x)).slice(0, CHARACTER_LIMITS.palette);
  return { ...c, appearance: a };
}

export function updateStudio(c: CharacterState, patch: Partial<StudioState>): CharacterState {
  return { ...c, studio: { ...c.studio, ...patch } };
}

export function saveStudioPose(c: CharacterState, id: ID, name: string, now: number): CharacterState {
  if (c.studio.poses.length >= CHARACTER_LIMITS.poses) throw new Error(`At most ${CHARACTER_LIMITS.poses} saved poses are supported.`);
  const p: SavedPose3D = {
    id,
    name: name.trim() || `Pose ${c.studio.poses.length + 1}`,
    createdAt: now,
    pose: structuredClone(c.studio.pose),
    camera: structuredClone(c.studio.camera),
  };
  return updateStudio(c, { poses: [...c.studio.poses, p] });
}

export function applyStudioPose(c: CharacterState, id: ID): CharacterState {
  const p = c.studio.poses.find((x) => x.id === id);
  if (!p) return c;
  return updateStudio(c, { pose: structuredClone(p.pose), camera: structuredClone(p.camera) });
}

export function overwriteStudioPose(c: CharacterState, id: ID): CharacterState {
  return updateStudio(c, { poses: c.studio.poses.map((p) => (p.id === id ? { ...p, pose: structuredClone(c.studio.pose), camera: structuredClone(c.studio.camera) } : p)) });
}

export function renameStudioPose(c: CharacterState, id: ID, name: string): CharacterState {
  if (!name.trim()) return c;
  return updateStudio(c, { poses: c.studio.poses.map((p) => (p.id === id ? { ...p, name: name.trim() } : p)) });
}

export function deleteStudioPose(c: CharacterState, id: ID): CharacterState {
  return updateStudio(c, { poses: c.studio.poses.filter((p) => p.id !== id) });
}

export function addGeneration(c: CharacterState, g: GenerationRecord): CharacterState {
  if (c.generations.length >= CHARACTER_LIMITS.generations) throw new Error('Too many stored results. Delete rejected results first.');
  return { ...c, generations: [...c.generations, g] };
}

/** Accept or reject a result. Only the status changes: the source artwork and the image itself are never touched. */
export function setGenerationStatus(c: CharacterState, id: ID, status: GenerationStatus, now: number): CharacterState {
  return { ...c, generations: c.generations.map((g) => (g.id === id ? { ...g, status, decidedAt: status === 'candidate' ? null : now } : g)) };
}

export function setGenerationNote(c: CharacterState, id: ID, note: string): CharacterState {
  return { ...c, generations: c.generations.map((g) => (g.id === id ? { ...g, note: trimText(note) } : g)) };
}

/** Delete a result. Accepted results must be un-accepted first, so approved work is never removed by accident. */
export function deleteGeneration(c: CharacterState, id: ID): CharacterState {
  const g = c.generations.find((x) => x.id === id);
  if (!g) return c;
  if (g.status === 'accepted') throw new Error('Un-accept this result before deleting it.');
  return { ...c, generations: c.generations.filter((x) => x.id !== id) };
}

/** Every asset id the character refers to (for pruning, bundle export and integrity checks). */
export function characterAssetIds(c: CharacterState): Set<ID> {
  const s = new Set<ID>();
  if (c.originalAssetId) s.add(c.originalAssetId);
  c.previousOriginals.forEach((p) => s.add(p.assetId));
  if (c.studio.artwork.front) s.add(c.studio.artwork.front.assetId);
  if (c.studio.artwork.back) s.add(c.studio.artwork.back.assetId);
  c.studio.artwork.views.forEach((v) => s.add(v.assetId));
  c.references.forEach((r) => s.add(r.assetId));
  for (const g of c.generations) {
    s.add(g.outputAssetId);
    if (g.provenance.originalAssetId) s.add(g.provenance.originalAssetId);
    g.provenance.referenceAssetIds.forEach((a) => s.add(a));
    Object.values(g.provenance.guideAssetIds).forEach((a) => a && s.add(a));
  }
  return s;
}

/** References that should be passed to a generation adapter. */
export const approvedReferences = (c: CharacterState): ReferenceImage[] => c.references.filter((r) => r.approved);
