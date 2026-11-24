import {
  addGeneration, addReference, applyStudioPose, deleteGeneration, deleteStudioPose, overwriteStudioPose, removeReference, renameStudioPose, saveStudioPose, setGenerationNote,
  setGenerationStatus, setOriginal, updateAppearance, updateReference, updateStudio,
} from '../core/character.ts';
import type { Appearance, CharacterState, GenerationRecord, GuideKind, ProjectedView, ReferenceImage } from '../core/character.ts';
import { detectImageKind, imageMime } from '../core/files.ts';
import { GUIDE_KINDS, artworkViews, withViews } from '../core/character.ts';
import { makeRasterLayer } from '../core/layers.ts';
import { assertGenuineResult } from '../generation/guard.ts';
import { buildProvenance, importedProvider, makeRecord } from '../generation/provenance.ts';
import { MANUAL_IMPORT_ID, createProvider } from '../generation/registry.ts';
import { buildGenerationRequest } from '../generation/request.ts';
import { DEFAULT_LOCAL_URL } from '../generation/localHttp.ts';
import { GenerationError } from '../generation/types.ts';
import type { ProviderStatus } from '../generation/types.ts';
import { GUIDE_DEFAULT_TRANSPARENT, disposeGuideRenderer, renderGuideCanvas, renderGuidePng } from '../render/poseGuideImages.ts';
import type { ArtworkFit, BodyShape, CameraState, JointId, Pose3D, Proportions } from '../pose/index.ts';
import {
  BODY_PRESETS, CAMERA_LIMITS, DEFAULT_SHAPE, POSE_PRESETS, PROPORTION_PRESETS, VIEW_PRESETS, applyPreset, buildRestSkeleton, clampCamera, clampEuler, clampProportions, frameCamera, framingPoints, projectPoint,
  alignFit, alignFitExtent, boundsXY, buildCharacterMesh, clampShape, computePoseGuide, distinctViews, fitBodyToArtwork, forwardKinematics, getRot, mirrorPose, normalizeAngle, normalizePose, posedPositions, posesEqual, restPose, restoreStandingHeight, skinBody, snapToGround, viewCoverage, viewExtent, viewWeights,
} from '../pose/index.ts';
import { ArtworkCache } from './artwork.ts';
import { loadBodyModel } from '../render/loadBodyModel.ts';
import type { BodyArtwork } from '../render/characterBody.ts';
import { addJointAt, applyNamedPose, attachLayers, deleteNamedPose, removeJoint, renamePose, resetPose, saveNamedPose, setJointParent, setPose, updateJoint, updateNamedPose } from '../core/doc.ts';
import { detectKind } from '../core/files.ts';
import { contentBounds } from '../core/hit.ts';
import { History } from '../core/history.ts';
import { newId } from '../core/ids.ts';
import { deleteLayerTree, duplicateLayerTree, groupLayers, moveIntoGroup, moveLayer, setPivotKeepingPlacement, ungroupLayer, updateLayer } from '../core/layers.ts';
import type { MoveDir } from '../core/layers.ts';
import { fitView } from '../core/math.ts';
import type { Transform, Vec2, View } from '../core/math.ts';
import { ProjectFormatError } from '../core/migrations.ts';
import { addAssetInfo, createProject, pruneUnusedAssets, unusedAssetIds } from '../core/project.ts';
import {
  addBubble as addBubbleOp, addPanel as addPanelOp, addPlacement as addPlacementOp, deleteBubble as deleteBubbleOp, deletePanel as deletePanelOp,
  deletePlacement as deletePlacementOp, emptyPage, movePlacement as movePlacementOp, pageAssetIds, pageExportSize, pagePixelSize, panelLayout, panelContentPolygon,
  polygonBounds, polygonCentroid, relinkPlacement as relinkPlacementOp, resizePage as resizePageOp, updateBubble as updateBubbleOp, updatePanel as updatePanelOp,
  updatePlacement as updatePlacementOp,
} from '../core/page.ts';
import type { Bubble, BubbleKind, LayoutKind, PageState, Panel, PanelShape, Placement, PlacementSource } from '../core/page.ts';
import { PageImageCache } from '../render/pageImages.ts';
import { renderPage } from '../render/pageRender.ts';
import { LIMITS } from '../core/schema.ts';
import { humanoidJoints } from '../core/templates.ts';
import type { DocState, ID, Joint, Layer, ProjectFile } from '../core/types.ts';
import { SegmentationError } from '../ai/segmentation.ts';
import { importPng } from '../import/png.ts';
import { importPsd } from '../import/psd.ts';
import { ImportError } from '../import/types.ts';
import { BitmapStore } from '../render/bitmaps.ts';
import { exportPngBlob, renderExportCanvas } from '../render/export.ts';
import type { RenderedExport } from '../render/export.ts';
import { canvasToBlob, canvasToPngBytes, ctx2d, decodeToCanvas, newCanvas } from '../render/pngEncode.ts';
import { exportBundle, importBundle } from '../storage/bundle.ts';
import { getDb } from '../storage/db.ts';
import { deleteAssets, deleteProject, duplicateProject, saveProject, storeImportedProject, loadProject } from '../storage/projectService.ts';
import type { AssetData } from '../storage/projectService.ts';

export const APP_VERSION = '0.4.1';

const LAST_PROJECT_KEY = 'characterforge.lastProject';
const LOCAL_URL_KEY = 'characterforge.localGenerationUrl';
function readLocalUrl(): string {
  try {
    return localStorage.getItem(LOCAL_URL_KEY) || DEFAULT_LOCAL_URL;
  } catch {
    return DEFAULT_LOCAL_URL;
  }
}

export type Mode = 'layout' | 'rig' | 'pose';
/** Top-level screens. 'canvas' is the 2D layer editor (layout / rig / 2D pose) kept as a secondary tool. */
export type Workspace = 'character' | 'studio' | 'generate' | 'page' | 'canvas';
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';
export type Dialog =
  | null
  | { kind: 'projects' }
  | { kind: 'export' }
  | { kind: 'mask'; layerId: ID }
  | { kind: 'report'; title: string; lines: string[] }
  | { kind: 'help' };

export interface Toast {
  id: number;
  kind: 'ok' | 'info' | 'warn' | 'error';
  text: string;
  details?: string[];
}

export interface GenerationUi {
  running: boolean;
  stage: string;
  checking: boolean;
  provider: ProviderStatus | null;
  /** null = pick a random seed each run (the seed used is recorded with the result). */
  seed: number | null;
  localUrl: string;
  selectedResultId: ID | null;
}

export interface StudioUi {
  pinFeet: boolean;
  showHandles: boolean;
  showGrid: boolean;
  notice: string | null;
  /** Bumped when a decoded artwork image becomes available, so the viewport re-reads it. */
  artRev: number;
  /** Progress of "Fit body to artwork". */
  fit: { running: boolean; fraction: number; iou: number | null; message: string | null };
  /** The bundled character model (loaded on first use). */
  model: 'idle' | 'loading' | 'ready' | 'error';
  modelError: string | null;
}

export interface PageUi {
  /** What the page canvas has selected. */
  selection: { kind: 'panel' | 'placement' | 'bubble'; id: ID } | null;
  /** Draw panel frames and borders in the preview. */
  showBorders: boolean;
  /** Draw lettering in the preview. */
  showBubbles: boolean;
  /** Bumped when a decoded page image becomes available, so the canvas re-reads it. */
  imageRev: number;
}

export interface UIState {
  workspace: Workspace;
  selectedJoint3d: JointId | null;
  studio: StudioUi;
  generation: GenerationUi;
  page: PageUi;
  mode: Mode;
  rigTool: 'select' | 'add';
  layoutTool: 'select' | 'pivot';
  /** Pose mode: drag end joints with two-bone IK (hold Alt to use FK instead). */
  ik: boolean;
  selectedLayerIds: ID[];
  selectedJointId: ID | null;
  view: View;
  viewport: { w: number; h: number };
  dialog: Dialog;
  toasts: Toast[];
  busy: string | null;
  saveState: SaveState;
}

export interface Snapshot {
  project: ProjectFile | null;
  doc: DocState | null;
  character: CharacterState | null;
  page: PageState | null;
  ui: UIState;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | undefined;
  redoLabel: string | undefined;
  rev: number;
}

export function friendlyError(e: unknown): { text: string; details?: string[] } {
  if (e instanceof ProjectFormatError) return { text: e.message, details: e.details.length ? e.details : undefined };
  if (e instanceof ImportError || e instanceof SegmentationError || e instanceof GenerationError) return { text: e.message };
  if (e instanceof DOMException && e.name === 'QuotaExceededError') return { text: 'The browser has no storage space left. Export a bundle as a backup and delete old projects.' };
  return { text: e instanceof Error ? e.message : String(e) };
}

export class AppStore {
  readonly bitmaps = new BitmapStore();
  private listeners = new Set<() => void>();
  private snap: Snapshot;
  private pending = false;
  private rev = 0;
  private docRev = 0;
  private project: ProjectFile | null = null;
  private history: History<DocState> | null = null;
  private charHistory: History<CharacterState> | null = null;
  private pageHistory: History<PageState> | null = null;
  private urls = new Map<ID, string>();
  private genAbort: AbortController | null = null;
  private liveCamera: CameraState | null = null;
  private assets = new Map<ID, AssetData>();
  private artCache = new ArtworkCache();
  private pageImages = new PageImageCache();
  private fitStop = false;
  private unsaved = new Set<ID>();
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private toastSeq = 0;
  private viewportKnown = false;
  private ui: UIState = {
    workspace: 'character',
    selectedJoint3d: null,
    studio: { pinFeet: false, showHandles: true, showGrid: true, notice: null, artRev: 0, fit: { running: false, fraction: 0, iou: null, message: null }, model: 'idle', modelError: null },
    generation: { running: false, stage: '', checking: false, provider: null, seed: null, localUrl: readLocalUrl(), selectedResultId: null },
    page: { selection: null, showBorders: true, showBubbles: true, imageRev: 0 },
    mode: 'layout',
    rigTool: 'select',
    layoutTool: 'select',
    ik: true,
    selectedLayerIds: [],
    selectedJointId: null,
    view: { zoom: 1, panX: 0, panY: 0 },
    viewport: { w: 800, h: 600 },
    dialog: null,
    toasts: [],
    busy: null,
    saveState: 'saved',
  };

  constructor() {
    this.snap = this.build();
  }

  // ---------- subscription ----------
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  getSnapshot = (): Snapshot => this.snap;

  private build(): Snapshot {
    const h = this.activeHistory();
    return { project: this.project, doc: this.history ? this.history.present : null, character: this.charHistory ? this.charHistory.present : null, page: this.pageHistory ? this.pageHistory.present : null, ui: this.ui, canUndo: !!h?.canUndo, canRedo: !!h?.canRedo, undoLabel: h?.undoLabel, redoLabel: h?.redoLabel, rev: this.rev };
  }
  /** Undo/redo applies to the screen you are on: the 2D canvas and the page each have their own history, everything else edits the character profile. */
  private activeHistory(): { canUndo: boolean; canRedo: boolean; undoLabel: string | undefined; redoLabel: string | undefined } | null {
    if (this.ui.workspace === 'canvas') return this.history;
    if (this.ui.workspace === 'page') return this.pageHistory;
    return this.charHistory;
  }
  private emit(): void {
    this.rev++;
    this.snap = this.build();
    for (const l of [...this.listeners]) l();
  }
  private schedule(): void {
    if (this.pending) return;
    this.pending = true;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f: () => void) => setTimeout(f, 16);
    raf(() => {
      this.pending = false;
      this.emit();
    });
  }
  private setUi(patch: Partial<UIState>): void {
    this.ui = { ...this.ui, ...patch };
    this.emit();
  }

  // ---------- helpers ----------
  get doc(): DocState | null {
    return this.history ? this.history.present : null;
  }
  private need(): DocState {
    if (!this.history) throw new Error('Open or create a project first.');
    return this.history.present;
  }
  get hasProject(): boolean {
    return this.project !== null;
  }
  getAsset(id: ID): AssetData | undefined {
    return this.assets.get(id);
  }

  toast(kind: Toast['kind'], text: string, details?: string[]): void {
    const id = ++this.toastSeq;
    this.ui = { ...this.ui, toasts: [...this.ui.toasts, { id, kind, text, details }].slice(-4) };
    this.emit();
    setTimeout(() => this.dismissToast(id), kind === 'error' ? 12000 : 5000);
  }
  dismissToast(id: number): void {
    if (this.ui.toasts.some((t) => t.id === id)) this.setUi({ toasts: this.ui.toasts.filter((t) => t.id !== id) });
  }
  fail(e: unknown): void {
    const f = friendlyError(e);
    this.toast('error', f.text, f.details);
  }
  /** Run an async action with a busy indicator and uniform error reporting. */
  async run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    this.setUi({ busy: label });
    try {
      return await fn();
    } catch (e) {
      this.fail(e);
      return undefined;
    } finally {
      this.setUi({ busy: null });
    }
  }

  private markDirty(): void {
    this.docRev++;
    this.ui = { ...this.ui, saveState: 'dirty' };
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => void this.save(false), 1500);
  }
  private commit(next: DocState, label: string, key?: string): void {
    if (!this.history) return;
    this.history.commit(next, label, key);
    this.markDirty();
    this.emit();
    void this.refreshBitmaps();
  }
  private async refreshBitmaps(): Promise<void> {
    const h = this.history;
    if (!h) return;
    try {
      const changed = await this.bitmaps.ensure(h.present.layers, this.assets);
      this.bitmaps.prune(h.present.layers);
      if (changed) this.emit();
    } catch (e) {
      this.fail(e);
    }
  }
  private addAsset(a: AssetData): void {
    this.assets.set(a.id, a);
    this.unsaved.add(a.id);
    if (this.project) this.project = addAssetInfo(this.project, { id: a.id, kind: a.kind, mime: a.mime, width: a.width, height: a.height, size: a.bytes.byteLength });
  }
  private currentFile(now: number): ProjectFile {
    if (!this.project || !this.history || !this.charHistory || !this.pageHistory) throw new Error('No project is open.');
    return { ...this.project, updatedAt: now, doc: this.history.present, character: this.charHistory.present, page: this.pageHistory.present };
  }

  // ---------- view ----------
  setView(view: View): void {
    this.setUi({ view });
  }
  setViewport(w: number, h: number): void {
    const first = !this.viewportKnown;
    this.viewportKnown = true;
    this.ui = { ...this.ui, viewport: { w, h } };
    if (first && this.doc) this.fitToCanvas();
    else this.emit();
  }
  fitToCanvas(): void {
    const d = this.doc;
    if (!d) return;
    this.setUi({ view: fitView(d.canvas.width, d.canvas.height, this.ui.viewport.w, this.ui.viewport.h) });
  }
  setDialog(dialog: Dialog): void {
    this.setUi({ dialog });
  }
  setMode(mode: Mode): void {
    this.setUi({ mode, rigTool: 'select', layoutTool: 'select' });
  }
  setRigTool(rigTool: UIState['rigTool']): void {
    this.setUi({ rigTool });
  }
  setLayoutTool(layoutTool: UIState['layoutTool']): void {
    this.setUi({ layoutTool });
  }
  setIk(ik: boolean): void {
    this.setUi({ ik });
  }
  selectLayers(ids: ID[]): void {
    this.setUi({ selectedLayerIds: ids });
  }
  selectJoint(id: ID | null): void {
    this.setUi({ selectedJointId: id });
  }

  // ---------- projects ----------
  async newProject(name: string): Promise<void> {
    await this.run('Creating project…', async () => {
      await this.save(false);
      const p = createProject(name, { width: 1024, height: 1024 }, Date.now());
      await saveProject(getDb(), p);
      this.attach(p, new Map());
    });
  }

  private rememberLast(id: ID | null): void {
    try {
      if (id) localStorage.setItem(LAST_PROJECT_KEY, id);
      else localStorage.removeItem(LAST_PROJECT_KEY);
    } catch {
      /* storage may be blocked; reopening the last character is only a convenience */
    }
  }

  /** On startup, reopen the character that was open last time (silently does nothing if it is gone). */
  async restoreLast(): Promise<void> {
    if (this.project) return;
    let id: string | null = null;
    try {
      id = localStorage.getItem(LAST_PROJECT_KEY);
    } catch {
      return;
    }
    if (!id) return;
    try {
      const { project, assets, migratedFrom } = await loadProject(getDb(), id);
      if (this.project) return;
      this.attach(project, assets);
      if (migratedFrom !== null) {
        this.markDirty();
        this.toast('info', `Character upgraded from format ${migratedFrom}. It will be saved in the new format.`);
        this.emit();
      }
    } catch {
      this.rememberLast(null);
    }
  }

  private attach(project: ProjectFile, assets: Map<ID, AssetData>): void {
    this.rememberLast(project.id);
    this.project = project;
    this.history = new History(project.doc);
    this.charHistory = new History(project.character);
    this.pageHistory = new History(project.page);
    this.assets = assets;
    this.artCache.clear();
    this.unsaved = new Set();
    this.bitmaps.clear();
    this.revokeUrls();
    this.ui = {
      ...this.ui,
      selectedLayerIds: [],
      selectedJointId: null,
      selectedJoint3d: null,
      mode: 'layout',
      rigTool: 'select',
      layoutTool: 'select',
      saveState: 'saved',
      dialog: null,
      workspace: project.character.originalAssetId ? 'studio' : 'character',
      generation: { ...this.ui.generation, running: false, stage: '', selectedResultId: null },
      studio: { ...this.ui.studio, notice: null },
    };
    this.emit();
    this.fitToCanvas();
    void this.refreshBitmaps();
  }

  async openProject(id: ID): Promise<void> {
    await this.run('Opening project…', async () => {
      await this.save(false);
      const { project, assets, migratedFrom } = await loadProject(getDb(), id);
      this.attach(project, assets);
      if (migratedFrom !== null) {
        this.markDirty();
        this.toast('info', `Project upgraded from format ${migratedFrom}. It will be saved in the new format.`);
        this.emit();
      }
    });
  }

  async closeProject(): Promise<void> {
    await this.save(false);
    this.rememberLast(null);
    this.project = null;
    this.history = null;
    this.charHistory = null;
    this.assets = new Map();
    this.artCache.clear();
    this.unsaved = new Set();
    this.bitmaps.clear();
    this.revokeUrls();
    this.ui = { ...this.ui, selectedLayerIds: [], selectedJointId: null, selectedJoint3d: null, saveState: 'saved' };
    this.emit();
  }

  async duplicateProjectById(id: ID): Promise<void> {
    await this.run('Duplicating…', async () => {
      await this.save(false);
      await duplicateProject(getDb(), id, Date.now());
      this.toast('ok', 'Project duplicated.');
    });
  }

  async deleteProjectById(id: ID): Promise<void> {
    await this.run('Deleting…', async () => {
      if (this.project?.id === id) {
        if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
        this.project = null;
        this.history = null;
        this.charHistory = null;
        this.assets = new Map();
        this.artCache.clear();
        this.unsaved = new Set();
        this.bitmaps.clear();
        this.revokeUrls();
        this.ui = { ...this.ui, selectedLayerIds: [], selectedJointId: null, selectedJoint3d: null, saveState: 'saved' };
      }
      await deleteProject(getDb(), id);
      this.emit();
    });
  }

  renameProject(name: string): void {
    if (!this.project || !name.trim()) return;
    this.project = { ...this.project, name: name.trim() };
    this.markDirty();
    this.emit();
  }

  async save(manual: boolean): Promise<void> {
    if (!this.project || !this.history) return;
    if (this.history.inTransient || this.charHistory?.inTransient) {
      this.autosaveTimer = setTimeout(() => void this.save(manual), 800);
      return;
    }
    if (this.ui.saveState === 'saved' && this.unsaved.size === 0) {
      if (manual) this.toast('ok', 'Everything is already saved.');
      return;
    }
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    const rev = this.docRev;
    this.setUi({ saveState: 'saving' });
    const file = this.currentFile(Date.now());
    const batch = [...this.unsaved].map((id) => this.assets.get(id)).filter((a): a is AssetData => !!a);
    try {
      await saveProject(getDb(), file, batch);
      if (!this.project) return;
      this.project = { ...this.project, updatedAt: file.updatedAt };
      batch.forEach((a) => this.unsaved.delete(a.id));
      if (rev === this.docRev) {
        this.setUi({ saveState: 'saved' });
        if (manual) this.toast('ok', 'Saved to this browser.');
      } else {
        this.markDirty();
        this.emit();
      }
    } catch (e) {
      this.setUi({ saveState: 'error' });
      this.fail(e);
    }
  }

  exportBundleFile(): { bytes: Uint8Array; fileName: string } {
    const file = this.currentFile(Date.now());
    const safe = file.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'character';
    return { bytes: exportBundle(file, this.assets, APP_VERSION, Date.now()), fileName: `${safe}.cfbundle` };
  }

  async importBundleBytes(bytes: Uint8Array): Promise<void> {
    await this.run('Importing bundle…', async () => {
      await this.save(false);
      const { project, assets } = importBundle(bytes);
      const stored = await storeImportedProject(getDb(), project, assets, Date.now());
      const loaded = await loadProject(getDb(), stored.id);
      this.attach(loaded.project, loaded.assets);
      this.toast('ok', `Imported "${loaded.project.name}".`);
    });
  }

  /** Drop images that no layer, mask or preserved source uses. Clears undo history (it may reference them). */
  async compactUnused(): Promise<void> {
    await this.run('Cleaning up…', async () => {
      if (!this.project || !this.history) return;
      const file = this.currentFile(Date.now());
      const unused = unusedAssetIds(file);
      if (!unused.length) return void this.toast('info', 'There is no unused image data.');
      this.project = pruneUnusedAssets(this.project);
      this.history.reset(this.history.present);
      this.charHistory?.reset(this.charHistory.present);
      this.markDirty();
      await this.save(false);
      unused.forEach((id) => {
        this.assets.delete(id);
        this.unsaved.delete(id);
      });
      await deleteAssets(getDb(), file.id, unused);
      this.bitmaps.prune(this.history.present.layers);
      this.toast('ok', `Removed ${unused.length} unused image${unused.length === 1 ? '' : 's'}. Undo history was cleared.`);
      this.emit();
    });
  }

  // ---------- import ----------
  async importFiles(files: File[]): Promise<void> {
    if (!files.length) return;
    await this.run('Importing…', async () => {
      const reports: string[] = [];
      let imported = 0;
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const kind = detectKind(bytes);
        if (kind === 'unknown') {
          this.toast('error', `"${file.name}" is not a PNG or PSD file. Convert it to PNG (or save as PSD) and try again.`);
          continue;
        }
        if (!this.project) {
          const p = createProject(file.name.replace(/\.[^.]+$/, ''), { width: 1024, height: 1024 }, Date.now());
          await saveProject(getDb(), p);
          this.attach(p, new Map());
        }
        const d = this.need();
        const common = { fileName: file.name, bytes, makeId: newId, now: Date.now(), targetCanvas: d.layers.length ? d.canvas : undefined };
        let result;
        try {
          result = kind === 'png' ? await importPng(common) : await importPsd(common);
        } catch (e) {
          this.fail(e);
          continue;
        }
        result.assets.forEach((a) => this.addAsset(a));
        if (this.project) this.project = { ...this.project, sources: [...this.project.sources, result.source] };
        const first = d.layers.length === 0;
        const next: DocState = { ...d, canvas: first ? result.canvas : d.canvas, layers: [...d.layers, ...result.layers] };
        this.commit(next, `Import ${file.name}`);
        this.ui = { ...this.ui, selectedLayerIds: result.layers.filter((l) => l.kind === 'raster').map((l) => l.id).slice(-1) };
        if (first) this.fitToCanvas();
        imported++;
        result.warnings.forEach((w) => reports.push(`${file.name}: ${w}`));
      }
      if (reports.length) this.setDialog({ kind: 'report', title: 'Imported with limitations', lines: reports });
      else if (imported) this.toast('ok', `Imported ${imported} file${imported === 1 ? '' : 's'}. The original file is kept in the project.`);
      this.emit();
    });
  }

  // ---------- undo / redo / gestures ----------
  undo(): void {
    if (this.ui.workspace === 'canvas') {
      if (this.history?.undo()) this.afterTimeTravel();
    } else if (this.charHistory?.undo()) this.afterCharTimeTravel();
  }
  redo(): void {
    if (this.ui.workspace === 'canvas') {
      if (this.history?.redo()) this.afterTimeTravel();
    } else if (this.charHistory?.redo()) this.afterCharTimeTravel();
  }
  private afterCharTimeTravel(): void {
    const h = this.charHistory;
    if (!h) return;
    // The camera is a view setting, not an edit: it is not undone with the pose.
    const cam = this.liveCamera;
    if (cam) h.preview({ ...h.present, studio: { ...h.present.studio, camera: cam } });
    const c = h.present;
    this.ui = {
      ...this.ui,
      generation: { ...this.ui.generation, selectedResultId: c.generations.some((g) => g.id === this.ui.generation.selectedResultId) ? this.ui.generation.selectedResultId : null },
    };
    this.markDirty();
    this.emit();
  }
  private afterTimeTravel(): void {
    const d = this.need();
    this.ui = {
      ...this.ui,
      selectedLayerIds: this.ui.selectedLayerIds.filter((id) => d.layers.some((l) => l.id === id)),
      selectedJointId: this.ui.selectedJointId && d.joints.some((j) => j.id === this.ui.selectedJointId) ? this.ui.selectedJointId : null,
    };
    this.markDirty();
    this.emit();
    void this.refreshBitmaps();
  }
  beginGesture(): void {
    this.history?.beginTransient();
  }
  previewDoc(next: DocState): void {
    this.history?.preview(next);
    this.schedule();
  }
  endGesture(label: string): void {
    if (!this.history) return;
    const before = this.history.canUndo;
    this.history.endTransient(label);
    if (this.history.canUndo !== before || this.history.undoLabel === label) this.markDirty();
    this.emit();
  }
  cancelGesture(): void {
    this.history?.cancelTransient();
    this.emit();
  }

  // ---------- layers ----------
  private editLayers(fn: (d: DocState) => DocState, label: string, key?: string): void {
    try {
      this.commit(fn(this.need()), label, key);
    } catch (e) {
      this.fail(e);
    }
  }
  renameLayer(id: ID, name: string): void {
    this.editLayers((d) => ({ ...d, layers: updateLayer(d.layers, id, { name }) }), 'Rename layer', `rename:${id}`);
  }
  setLayerVisible(id: ID, visible: boolean): void {
    this.editLayers((d) => ({ ...d, layers: updateLayer(d.layers, id, { visible }) }), visible ? 'Show layer' : 'Hide layer');
  }
  setLayerLocked(id: ID, locked: boolean): void {
    this.editLayers((d) => ({ ...d, layers: updateLayer(d.layers, id, { locked }) }), locked ? 'Lock layer' : 'Unlock layer');
  }
  setLayerOpacity(id: ID, opacity: number): void {
    this.editLayers((d) => ({ ...d, layers: updateLayer(d.layers, id, { opacity: Math.min(1, Math.max(0, opacity)) }) }), 'Layer opacity', `opacity:${id}`);
  }
  setLayerTransform(id: ID, patch: Partial<Transform>): void {
    this.editLayers((d) => {
      const l = d.layers.find((x) => x.id === id);
      if (!l) return d;
      const t = { ...l.transform, ...patch };
      if (!Object.values(t).every(Number.isFinite) || t.scaleX === 0 || t.scaleY === 0) throw new Error('Enter valid numbers (scale cannot be 0).');
      return { ...d, layers: updateLayer(d.layers, id, { transform: t }) };
    }, 'Transform layer', `transform:${id}`);
  }
  setLayerPivot(id: ID, pivotLocal: Vec2): void {
    this.editLayers((d) => {
      const l = d.layers.find((x) => x.id === id);
      return l && l.kind === 'raster' ? { ...d, layers: d.layers.map((x) => (x.id === id ? setPivotKeepingPlacement(x, pivotLocal) : x)) } : d;
    }, 'Move pivot');
  }
  moveLayerOrder(id: ID, dir: MoveDir): void {
    this.editLayers((d) => ({ ...d, layers: moveLayer(d.layers, id, dir) }), 'Reorder layer');
  }
  groupSelected(): void {
    const ids = this.ui.selectedLayerIds;
    if (!ids.length) return;
    const gid = newId('group');
    this.editLayers((d) => ({ ...d, layers: groupLayers(d.layers, ids, gid, 'Group') }), 'Group layers');
    this.setUi({ selectedLayerIds: [gid] });
  }
  ungroup(id: ID): void {
    this.editLayers((d) => ({ ...d, layers: ungroupLayer(d.layers, id) }), 'Ungroup');
    this.setUi({ selectedLayerIds: [] });
  }
  moveToGroup(id: ID, groupId: ID | null): void {
    this.editLayers((d) => ({ ...d, layers: moveIntoGroup(d.layers, id, groupId) }), 'Move layer');
  }
  deleteLayers(ids: ID[]): void {
    this.editLayers((d) => ({ ...d, layers: ids.reduce((ls, id) => deleteLayerTree(ls, id).layers, d.layers) }), ids.length > 1 ? 'Delete layers' : 'Delete layer');
    this.setUi({ selectedLayerIds: [] });
  }
  duplicateLayer(id: ID): void {
    const d = this.need();
    const r = duplicateLayerTree(d.layers, id, () => newId('layer'));
    if (!r) return;
    this.commit({ ...d, layers: r.layers }, 'Duplicate layer');
    this.setUi({ selectedLayerIds: [r.newRootId] });
  }
  setCanvasSize(width: number, height: number): void {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > LIMITS.maxCanvas || height > LIMITS.maxCanvas) {
      return this.toast('error', `Canvas size must be whole numbers from 1 to ${LIMITS.maxCanvas}.`);
    }
    this.editLayers((d) => ({ ...d, canvas: { width, height } }), 'Resize canvas');
    this.fitToCanvas();
  }

  // ---------- masks ----------
  /** A working copy of the layer's mask (or a fully visible mask), plus its pixel source, for the mask editor. */
  async maskEditorInputs(layerId: ID): Promise<{ layer: Layer; base: HTMLCanvasElement; mask: HTMLCanvasElement } | null> {
    const layer = this.need().layers.find((l) => l.id === layerId);
    if (!layer || layer.kind !== 'raster' || !layer.assetId) return null;
    await this.refreshBitmaps();
    const base = this.bitmaps.getRaw(layer.assetId);
    if (!base) return null;
    const mask = newCanvas(base.width, base.height);
    const c = ctx2d(mask);
    const existing = layer.maskAssetId ? this.bitmaps.getRaw(layer.maskAssetId) : null;
    if (existing) c.drawImage(existing, 0, 0, base.width, base.height);
    else {
      c.fillStyle = '#fff';
      c.fillRect(0, 0, base.width, base.height);
    }
    return { layer, base, mask };
  }

  async commitMask(layerId: ID, mask: HTMLCanvasElement): Promise<void> {
    await this.run('Saving mask…', async () => {
      const copy = newCanvas(mask.width, mask.height);
      ctx2d(copy).drawImage(mask, 0, 0);
      const bytes = await canvasToPngBytes(copy);
      const id = newId('mask');
      this.addAsset({ id, kind: 'mask', mime: 'image/png', width: copy.width, height: copy.height, bytes });
      this.bitmaps.put(id, copy);
      this.commit({ ...this.need(), layers: updateLayer(this.need().layers, layerId, { maskAssetId: id }) }, 'Edit mask');
    });
  }

  removeMask(layerId: ID): void {
    this.editLayers((d) => ({ ...d, layers: updateLayer(d.layers, layerId, { maskAssetId: null }) }), 'Remove mask');
  }

  /**
   * Turn accepted AI mask proposals into new layers. Each new layer reuses the source layer's
   * original pixels and adds a mask — nothing is cut out of the source, so it is fully reversible.
   */
  async acceptProposals(sourceLayerId: ID, proposals: { label: string; png: Uint8Array }[], hideSource: boolean): Promise<void> {
    await this.run('Creating layers…', async () => {
      const d = this.need();
      const src = d.layers.find((l) => l.id === sourceLayerId);
      if (!src || src.kind !== 'raster') throw new Error('Select a pixel layer first.');
      const existing = src.maskAssetId ? this.bitmaps.getRaw(src.maskAssetId) : null;
      const created: Layer[] = [];
      for (const p of proposals) {
        const m = await decodeToCanvas(p.png, 'image/png');
        if (m.width !== src.width || m.height !== src.height) throw new Error(`The proposed mask for "${p.label}" does not match the layer size.`);
        if (existing) {
          const c = ctx2d(m);
          c.globalCompositeOperation = 'destination-in';
          c.drawImage(existing, 0, 0, m.width, m.height);
        }
        const bytes = await canvasToPngBytes(m);
        const maskId = newId('mask');
        this.addAsset({ id: maskId, kind: 'mask', mime: 'image/png', width: m.width, height: m.height, bytes });
        this.bitmaps.put(maskId, m);
        created.push({ ...src, id: newId('layer'), name: p.label, maskAssetId: maskId, visible: true, locked: false, transform: { ...src.transform }, pivot: { ...src.pivot } });
      }
      const idx = d.layers.findIndex((l) => l.id === sourceLayerId);
      let layers = [...d.layers.slice(0, idx + 1), ...created, ...d.layers.slice(idx + 1)];
      if (hideSource) layers = updateLayer(layers, sourceLayerId, { visible: false });
      this.commit({ ...d, layers }, `Add ${created.length} AI-proposed layer${created.length === 1 ? '' : 's'}`);
      this.ui = { ...this.ui, selectedLayerIds: created.map((l) => l.id) };
      this.emit();
    });
  }

  // ---------- rig ----------
  addJoint(parentId: ID | null, pos: Vec2): ID | null {
    const d = this.need();
    const id = newId('joint');
    try {
      this.commit(addJointAt(d, id, `Joint ${d.joints.length + 1}`, parentId, pos), 'Add joint');
    } catch (e) {
      this.fail(e);
      return null;
    }
    this.setUi({ selectedJointId: id });
    return id;
  }
  deleteJoint(id: ID): void {
    this.editLayersDoc((d) => removeJoint(d, id), 'Delete joint');
    this.setUi({ selectedJointId: null });
  }
  private editLayersDoc(fn: (d: DocState) => DocState, label: string, key?: string): void {
    this.editLayers(fn, label, key);
  }
  updateJointProps(id: ID, patch: Partial<Pick<Joint, 'name' | 'limits' | 'bend'>>): void {
    this.editLayersDoc((d) => updateJoint(d, id, patch), 'Edit joint', `joint:${id}:${Object.keys(patch).join(',')}`);
  }
  reparentJoint(id: ID, parentId: ID | null): void {
    this.editLayersDoc((d) => setJointParent(d, id, parentId), 'Re-parent joint');
  }
  attachSelectedLayers(jointId: ID | null): void {
    const ids = this.expandToRaster(this.ui.selectedLayerIds);
    if (!ids.length) return this.toast('info', 'Select a layer first.');
    this.editLayersDoc((d) => attachLayers(d, ids, jointId), jointId ? 'Attach layers to joint' : 'Detach layers');
  }
  /** Expand a selection (layers and groups) to the raster layers inside it. */
  expandToRaster(ids: ID[]): ID[] {
    const d = this.need();
    const out = new Set<ID>();
    const add = (id: ID) => {
      const l = d.layers.find((x) => x.id === id);
      if (!l) return;
      if (l.kind === 'raster') out.add(l.id);
      else d.layers.filter((c) => c.parentId === id).forEach((c) => add(c.id));
    };
    ids.forEach(add);
    return [...out];
  }
  applyHumanoidTemplate(): void {
    const d = this.need();
    if (d.joints.length) return this.toast('error', 'Delete the current skeleton first (Clear skeleton), then add the template.');
    const b = contentBounds(d) ?? { x: 0, y: 0, width: d.canvas.width, height: d.canvas.height };
    const joints = humanoidJoints(b, () => newId('joint'));
    this.commit({ ...d, joints }, 'Add humanoid skeleton');
    this.setUi({ selectedJointId: joints[0]!.id, mode: 'rig' });
    this.toast('info', 'Template added. Drag each joint onto the matching spot in your artwork.');
  }
  clearSkeleton(): void {
    this.editLayersDoc(
      (d) => ({ ...d, joints: [], layers: d.layers.map((l) => (l.jointId ? { ...l, jointId: null } : l)), pose: { rotations: {}, rootOffset: { x: 0, y: 0 } }, poses: [] }),
      'Clear skeleton',
    );
    this.setUi({ selectedJointId: null });
  }

  // ---------- poses ----------
  setJointRotation(id: ID, deg: number): void {
    if (!Number.isFinite(deg)) return;
    this.editLayersDoc((d) => setPose(d, { ...d.pose, rotations: { ...d.pose.rotations, [id]: deg } }), 'Rotate joint', `rot:${id}`);
  }
  setRootOffset(p: Vec2): void {
    this.editLayersDoc((d) => setPose(d, { ...d.pose, rootOffset: p }), 'Move character', 'rootoffset');
  }
  resetCurrentPose(): void {
    this.editLayersDoc((d) => resetPose(d), 'Reset pose');
  }
  savePose(name: string): void {
    this.editLayersDoc((d) => saveNamedPose(d, newId('pose'), name, Date.now()), 'Save pose');
  }
  applyPose(id: ID): void {
    this.editLayersDoc((d) => applyNamedPose(d, id), 'Apply pose');
  }
  overwritePose(id: ID): void {
    this.editLayersDoc((d) => updateNamedPose(d, id), 'Update pose');
  }
  renameSavedPose(id: ID, name: string): void {
    this.editLayersDoc((d) => renamePose(d, id, name), 'Rename pose', `posename:${id}`);
  }
  deleteSavedPose(id: ID): void {
    this.editLayersDoc((d) => deleteNamedPose(d, id), 'Delete pose');
  }

  // ======================================================================
  // Character profile, 3D pose studio and generation
  // ======================================================================

  get character(): CharacterState | null {
    return this.charHistory ? this.charHistory.present : null;
  }
  private needChar(): CharacterState {
    if (!this.charHistory) throw new Error('Open or create a project first.');
    return this.charHistory.present;
  }

  setWorkspace(workspace: Workspace): void {
    if (workspace !== 'studio') disposeGuideRenderer();
    this.setUi({ workspace });
    if (workspace === 'canvas') this.fitToCanvas();
  }

  private commitChar(fn: (c: CharacterState) => CharacterState, label: string, key?: string): boolean {
    if (!this.charHistory) return false;
    try {
      const next = fn(this.charHistory.present);
      if (next === this.charHistory.present) return false;
      this.charHistory.commit(next, label, key);
      this.liveCamera = next.studio.camera;
      this.markDirty();
      this.emit();
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  // ---------- images (object URLs for display) ----------
  assetUrl(id: ID | null | undefined): string | null {
    if (!id) return null;
    const hit = this.urls.get(id);
    if (hit) return hit;
    const a = this.assets.get(id);
    if (!a) return null;
    const url = URL.createObjectURL(new Blob([a.bytes as BlobPart], { type: a.mime }));
    this.urls.set(id, url);
    return url;
  }
  private revokeUrls(): void {
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls.clear();
  }
  assetInfo(id: ID | null | undefined): { width: number; height: number; mime: string; bytes: number } | null {
    const a = id ? this.assets.get(id) : undefined;
    return a ? { width: a.width, height: a.height, mime: a.mime, bytes: a.bytes.byteLength } : null;
  }

  /** Validate and decode an image file for use as character artwork/reference. Original bytes are stored untouched. */
  private async ingestImage(file: File, kind: 'source' | 'reference' | 'generated'): Promise<AssetData & { imageKind: 'png' | 'jpeg' | 'webp' }> {
    if (file.size > 80 * 1024 * 1024) throw new ImportError(`"${file.name}" is larger than 80 MB.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const k = detectImageKind(bytes);
    if (k === 'unknown') throw new ImportError(`"${file.name}" is not a PNG, JPEG or WebP image. Convert it first (PSD files can be opened in the 2D Canvas tab).`);
    let c: HTMLCanvasElement;
    try {
      c = await decodeToCanvas(bytes, imageMime(k));
    } catch {
      throw new ImportError(`"${file.name}" could not be decoded. The file may be damaged.`);
    }
    if (c.width > LIMITS.maxCanvas || c.height > LIMITS.maxCanvas || c.width * c.height > LIMITS.maxPixels) {
      throw new ImportError(`"${file.name}" is ${c.width}×${c.height}px, larger than the supported maximum (${LIMITS.maxCanvas}px per side, ${LIMITS.maxPixels / 1e6} megapixels).`);
    }
    return { id: newId('asset'), kind, mime: imageMime(k), width: c.width, height: c.height, bytes, imageKind: k };
  }

  /** Set (or replace) the original full-body artwork. The previous original is kept in the profile, never discarded. */
  async importOriginal(file: File): Promise<void> {
    await this.run('Importing original artwork…', async () => {
      this.needChar();
      const a = await this.ingestImage(file, 'source');
      const { imageKind, ...asset } = a;
      this.addAsset(asset);
      if (this.project) this.project = { ...this.project, sources: [...this.project.sources, { assetId: asset.id, fileName: file.name, mime: asset.mime, kind: imageKind, importedAt: Date.now() }] };
      const had = !!this.character?.originalAssetId;
      this.commitChar((c) => setOriginal(c, asset.id, Date.now()), had ? 'Replace original artwork' : 'Import original artwork');
      this.toast('ok', had ? 'Original artwork replaced. The previous original is still stored in this profile.' : 'Original artwork imported. The file is stored unchanged.');
    });
  }

  async importReferences(files: File[]): Promise<void> {
    await this.run('Importing references…', async () => {
      this.needChar();
      let n = 0;
      for (const f of files) {
        try {
          const a = await this.ingestImage(f, 'reference');
          const { imageKind: _k, ...asset } = a;
          void _k;
          this.addAsset(asset);
          const r: ReferenceImage = { id: newId('ref'), assetId: asset.id, label: f.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Reference', role: 'other', notes: '', fileName: f.name, approved: true, addedAt: Date.now() };
          if (this.commitChar((c) => addReference(c, r), `Add reference ${r.label}`)) n++;
        } catch (e) {
          this.fail(e);
        }
      }
      if (n) this.toast('ok', `Added ${n} reference image${n === 1 ? '' : 's'}.`);
    });
  }
  updateRef(id: ID, patch: Partial<Pick<ReferenceImage, 'label' | 'role' | 'notes' | 'approved'>>): void {
    this.commitChar((c) => updateReference(c, id, patch), 'Edit reference', `ref:${id}:${Object.keys(patch).join(',')}`);
  }
  removeRef(id: ID): void {
    this.commitChar((c) => removeReference(c, id), 'Remove reference');
  }
  setAppearance(patch: Partial<Appearance>): void {
    this.commitChar((c) => updateAppearance(c, patch), 'Edit appearance', `appearance:${Object.keys(patch).join(',')}`);
  }
  setInstructions(text: string): void {
    this.commitChar((c) => (c.instructions === text ? c : { ...c, instructions: text.slice(0, 4000) }), 'Edit instructions', 'instructions');
  }

  // ---------- 3D pose studio ----------
  get restSkeleton() {
    return buildRestSkeleton(this.needChar().studio.proportions);
  }
  selectJoint3d(id: JointId | null): void {
    this.setUi({ selectedJoint3d: id });
  }
  setStudioFlag(patch: Partial<Pick<StudioUi, 'pinFeet' | 'showHandles' | 'showGrid'>>): void {
    this.setUi({ studio: { ...this.ui.studio, ...patch } });
  }
  studioNotice(message: string | null): void {
    if (this.ui.studio.notice === message) return;
    this.ui = { ...this.ui, studio: { ...this.ui.studio, notice: message } };
    this.emit();
    if (message) setTimeout(() => this.ui.studio.notice === message && this.studioNotice(null), 2500);
  }
  private withPose(c: CharacterState, pose: Pose3D): CharacterState {
    return updateStudio(c, { pose: normalizePose(pose) });
  }
  setStudioPose(pose: Pose3D, label = 'Edit pose', key?: string): void {
    this.commitChar((c) => this.withPose(c, pose), label, key);
  }
  /** Live pose edits during a drag: previewed, then committed as ONE undo step. */
  beginStudioGesture(): void {
    this.charHistory?.beginTransient();
  }
  previewStudioPose(pose: Pose3D): void {
    const h = this.charHistory;
    if (!h) return;
    h.preview(updateStudio(h.present, { pose }));
    this.schedule();
  }
  endStudioGesture(label: string): void {
    const h = this.charHistory;
    if (!h) return;
    if (h.present.studio.pose) h.preview(updateStudio(h.present, { pose: normalizePose(h.present.studio.pose) }));
    h.endTransient(label);
    this.markDirty();
    this.emit();
  }
  setJointEuler(id: JointId, patch: Partial<{ x: number; y: number; z: number }>): void {
    if (Object.values(patch).some((v) => !Number.isFinite(v))) return;
    const c = this.needChar();
    const cur = getRot(c.studio.pose, id);
    const e = clampEuler(id, { ...cur, ...patch });
    this.setStudioPose({ ...c.studio.pose, rotations: { ...c.studio.pose.rotations, [id]: e } }, 'Rotate joint', `rot:${id}`);
  }
  setRootPosition(patch: Partial<{ x: number; y: number; z: number }>): void {
    const c = this.needChar();
    if (Object.values(patch).some((v) => !Number.isFinite(v))) return;
    this.setStudioPose({ ...c.studio.pose, root: { ...c.studio.pose.root, ...patch } }, 'Move body', 'root');
  }
  applyPosePreset(id: string): void {
    const preset = POSE_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    const c = this.needChar();
    const rest = buildRestSkeleton(c.studio.proportions);
    const pose = applyPreset(rest, preset);
    // Poses such as T-pose or Jump can leave the current frame; re-frame only in that case, in the same undo step,
    // so a deliberate composition is not disturbed by presets that already fit.
    const { width, height } = c.studio.output;
    const pts = framingPoints(rest, pose);
    const inFrame = pts.every((p) => {
      const q = projectPoint(c.studio.camera, width, height, p);
      return q.depth > 0.05 && Math.abs(q.ndcX) <= 0.97 && Math.abs(q.ndcY) <= 0.97;
    });
    const camera = inFrame ? c.studio.camera : frameCamera(c.studio.camera, pts, width / height, 0.07);
    this.commitChar((x) => updateStudio(this.withPose(x, pose), { camera }), `Pose: ${preset.label}`);
  }
  resetStudioPose(): void {
    this.setStudioPose(restPose(), 'Reset pose');
  }
  mirrorStudioPose(): void {
    this.setStudioPose(mirrorPose(this.needChar().studio.pose), 'Mirror pose');
  }
  groundStudioPose(): void {
    const c = this.needChar();
    this.setStudioPose(snapToGround(buildRestSkeleton(c.studio.proportions), c.studio.pose), 'Place on ground');
  }
  setProportions(patch: Partial<Proportions>): void {
    this.commitChar((c) => updateStudio(c, { proportions: clampProportions({ ...c.studio.proportions, ...patch }) }), 'Change proportions', `prop:${Object.keys(patch).join(',')}`);
  }
  applyProportionPreset(id: string): void {
    const p = PROPORTION_PRESETS.find((x) => x.id === id);
    if (p) this.commitChar((c) => updateStudio(c, { proportions: { ...p.value } }), `Body: ${p.label}`);
  }
  /** Body shape (thickness of chest, waist, limbs …) complements the proportions: together they size the character to match the artwork. */
  setShape(patch: Partial<BodyShape>): void {
    if (Object.values(patch).some((v) => !Number.isFinite(v))) return;
    this.commitChar((c) => updateStudio(c, { shape: clampShape({ ...c.studio.shape, ...patch }) }), 'Change body shape', `shape:${Object.keys(patch).join(',')}`);
  }
  applyBodyPreset(id: string): void {
    const p = BODY_PRESETS.find((x) => x.id === id);
    if (p) this.commitChar((c) => updateStudio(c, { proportions: { ...p.proportions }, shape: { ...p.shape } }), `Body: ${p.label}`);
  }
  resetBodyShape(): void {
    this.commitChar((c) => updateStudio(c, { shape: { ...DEFAULT_SHAPE } }), 'Reset body shape');
  }

  /** Load the character model (once). Safe to call repeatedly; resolves when it is ready, rejects with a readable error. */
  async ensureModel(): Promise<void> {
    if (this.ui.studio.model === 'ready') return;
    this.setUi({ studio: { ...this.ui.studio, model: 'loading', modelError: null } });
    try {
      await loadBodyModel();
      this.setUi({ studio: { ...this.ui.studio, model: 'ready', modelError: null } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'The character model could not be loaded.';
      this.setUi({ studio: { ...this.ui.studio, model: 'error', modelError: msg } });
      throw new Error(msg);
    }
  }

  // ---------- artwork on the model ----------
  /** Decode the images the studio needs (original, projected front/back). Resolves when they are ready to be shown. */
  async ensureArtwork(): Promise<void> {
    const c = this.character;
    if (!c) return;
    const ids = [c.originalAssetId, ...artworkViews(c.studio.artwork).map((v) => v.assetId)].filter((x): x is ID => !!x);
    let added = false;
    for (const id of ids) {
      if (this.artCache.get(id)) continue;
      const a = this.assets.get(id);
      if (!a) continue;
      try {
        await this.artCache.load(id, a.bytes, a.mime);
        added = true;
      } catch {
        this.toast('error', 'An artwork image could not be decoded for the 3D view.');
      }
    }
    if (added) this.setUi({ studio: { ...this.ui.studio, artRev: this.ui.studio.artRev + 1 } });
  }
  /**
   * How much of the body each view paints, as a fraction (0..1, summing to 1), in the same order as `artworkViews`.
   * This is what the UI shows the artist: a side drawing that reports 2% is mis-angled or the body is too thin, and the
   * artist can see that before rendering. Returns null when nothing is projected.
   */
  viewCoverageReport(c: CharacterState = this.needChar()): number[] | null {
    const views = artworkViews(c.studio.artwork);
    if (views.length === 0) return null;
    const rest = buildRestSkeleton(c.studio.proportions);
    const mesh = buildCharacterMesh(rest, c.studio.shape, 'normal');
    const pos = new Float32Array(mesh.vertexCount * 3);
    const nor = new Float32Array(mesh.vertexCount * 3);
    skinBody(mesh, forwardKinematics(rest, c.studio.pose), pos, nor);
    const w = viewWeights(nor, mesh.vertexCount, views.map((v) => v.angle));
    return viewCoverage(w, mesh.vertexCount, views.length);
  }

  /** What the viewport and the "character render" guide need to show the artwork on the body (null when none is projected). */
  bodyArtwork(c: CharacterState = this.needChar()): BodyArtwork | null {
    const a = c.studio.artwork;
    const views = artworkViews(a)
      .map((v) => {
        const hit = this.artCache.get(v.assetId);
        return hit ? { image: hit.projection as TexImageSource, fit: v.fit, width: v.width, height: v.height, mask: hit.mask, maskScale: hit.maskScale, angle: v.angle } : null;
      })
      .filter((v): v is NonNullable<typeof v> => !!v)
      .sort((p, q) => p.angle - q.angle);
    if (views.length === 0) return null;
    return { views, bakedPose: a.bakedPose, show: a.show, fill: a.fill, shading: a.shading };
  }
  /** The translucent drawing laid over the viewport to line the body up with it. */
  overlayState(c: CharacterState = this.needChar()) {
    const o = c.studio.artwork.overlay;
    const img = this.artCache.get(c.originalAssetId);
    return { show: o.show && !!img?.box, opacity: o.opacity, image: (img?.canvas ?? null) as TexImageSource | null, width: img?.width ?? 0, height: img?.height ?? 0, box: img?.box ?? null };
  }
  setArtworkOptions(patch: Partial<{ show: boolean; fill: string; shading: number }>): void {
    if (patch.fill !== undefined && !/^#[0-9a-fA-F]{6}$/.test(patch.fill)) return;
    if (patch.shading !== undefined && !Number.isFinite(patch.shading)) return;
    const shading = patch.shading === undefined ? undefined : Math.min(1, Math.max(0, patch.shading));
    this.commitChar((c) => updateStudio(c, { artwork: { ...c.studio.artwork, ...patch, ...(shading === undefined ? {} : { shading }) } }), 'Artwork display', `art:${Object.keys(patch).join(',')}`);
  }
  setOverlay(patch: Partial<{ show: boolean; opacity: number }>): void {
    if (patch.opacity !== undefined && !Number.isFinite(patch.opacity)) return;
    const o = { ...this.needChar().studio.artwork.overlay, ...patch };
    o.opacity = Math.min(1, Math.max(0.05, o.opacity));
    this.commitChar((c) => updateStudio(c, { artwork: { ...c.studio.artwork, overlay: o } }), 'Artwork overlay', 'art-overlay');
    if (patch.show) void this.ensureArtwork();
  }
  /** Front view with a narrow field of view, so the model lines up with a front-facing drawing with little perspective distortion. */
  matchView(): void {
    const c = this.needChar();
    const rest = buildRestSkeleton(c.studio.proportions);
    const cam = frameCamera({ ...c.studio.camera, azimuth: 0, elevation: 0, fov: 12 }, framingPoints(rest, c.studio.pose), c.studio.output.width / c.studio.output.height, 0.07);
    this.commitChar((x) => updateStudio(x, { camera: clampCamera({ ...cam, azimuth: 0, elevation: 0 }) }), 'Match view');
  }
  /**
   * Project the artwork onto the model in the CURRENT pose (which should resemble the drawings, usually a standing or
   * A-pose). Every supplied view is projected along its own axis and fitted to the body's extent along that axis, so a
   * side drawing is fitted to the body's depth rather than to its width. The projection is stored on the body, so the
   * drawings follow every later pose.
   *
   * `backAssetId` is the v3 entry point (a single back view); it is folded into the view set at 180°.
   */
  async projectArtwork(backAssetId: ID | null = null): Promise<void> {
    const c0 = this.needChar();
    if (!c0.originalAssetId) return void this.toast('error', 'Import the original artwork first (Character tab).');
    await this.run('Projecting artwork onto the model…', async () => {
      await this.ensureModel();
      await this.ensureArtwork();
      const c = this.needChar();
      const front = this.artCache.get(c.originalAssetId);
      if (!front?.box) throw new Error('No figure was found in the artwork. Use an image with a transparent or plain background.');
      const rest = buildRestSkeleton(c.studio.proportions);
      const mesh = buildCharacterMesh(rest, c.studio.shape, 'normal');
      const pos = posedPositions(mesh, rest, c.studio.pose);
      const bounds = boundsXY(pos, mesh.vertexCount);
      // the view set: whatever the artist added, plus the v3 back slot if it was passed in
      const existing = artworkViews(c.studio.artwork).filter((v) => v.angle !== 0);
      const wanted = backAssetId ? [...existing.filter((v) => v.angle !== 180), { assetId: backAssetId, angle: 180 }] : existing;
      const views: ProjectedView[] = [];
      // the front view is always the original artwork, at 0°
      views.push({ assetId: c.originalAssetId!, width: front.width, height: front.height, fit: alignFit(bounds, front.box), angle: 0 });
      for (const w of distinctViews(wanted)) {
        // a view may be a reference image, which ensureArtwork does not decode: decode it here
        let img = this.artCache.get(w.assetId);
        if (!img) {
          const asset = this.assets.get(w.assetId);
          if (!asset) continue;
          try {
            img = await this.artCache.load(w.assetId, asset.bytes, asset.mime);
          } catch {
            continue;
          }
        }
        if (!img?.box) continue; // a view whose image has no figure is skipped rather than failing the whole projection
        // fit this view's drawing to the body's extent along ITS axis (a side view's horizontal axis is the depth)
        const ext = viewExtent(pos, mesh.vertexCount, w.angle);
        views.push({ assetId: w.assetId, width: img.width, height: img.height, fit: alignFitExtent(ext.min, ext.max, bounds.minY, bounds.maxY, img.box), angle: w.angle });
      }
      this.commitChar((x) => updateStudio(x, {
        artwork: withViews({ ...x.studio.artwork, bakedPose: structuredClone(x.studio.pose), show: true, fill: x.studio.artwork.front ? x.studio.artwork.fill : front.avgColor }, views),
      }), 'Project artwork onto model');
      const n = views.length;
      this.toast('ok', n > 1
        ? `Artwork projected from ${n} views. Pose the model: the drawings follow the body.`
        : 'Artwork projected onto the model. Pose the model: the drawing follows the body. Add a side or back view to stop the sides being invented.');
    });
  }
  async setBackView(assetId: ID | null): Promise<void> {
    const a = this.needChar().studio.artwork;
    if (!a.front) return void this.toast('info', 'Project the front artwork first.');
    await this.projectArtwork(assetId);
  }
  /** Add (or replace) a drawing for a view at `angle` degrees, then re-project. */
  async addView(assetId: ID, angle: number): Promise<void> {
    const a = this.needChar().studio.artwork;
    if (!a.front) return void this.toast('info', 'Project the front artwork first.');
    await this.ensureArtwork();
    // a reference image is not decoded by ensureArtwork (that only loads the original and the current views), so decode it
    // here before reading its figure box
    let img = this.artCache.get(assetId);
    if (!img) {
      const asset = this.assets.get(assetId);
      if (!asset) return void this.toast('error', 'That image is no longer in this project.');
      try {
        img = await this.artCache.load(assetId, asset.bytes, asset.mime);
      } catch {
        return void this.toast('error', 'That image could not be decoded.');
      }
    }
    if (!img?.box) return void this.toast('error', 'No figure was found in that image. Use a drawing with a transparent or plain background.');
    const kept = artworkViews(a).filter((v) => Math.abs(normalizeAngle(v.angle) - normalizeAngle(angle)) >= 12);
    // the fit is a placeholder: projectArtwork recomputes it against the body's extent along this view's axis
    const placeholder: ProjectedView = { assetId, width: img.width, height: img.height, fit: { ppm: 1, ox: 0, oy: 0 }, angle: normalizeAngle(angle) };
    const next = distinctViews([...kept, placeholder]);
    this.commitChar((c) => updateStudio(c, { artwork: withViews(c.studio.artwork, next.map((v) => ({ ...v, angle: normalizeAngle(v.angle) }))) }), 'Add artwork view');
    await this.projectArtwork(null);
  }
  /** Remove the drawing for a view at `angle` degrees, then re-project. The 0° view cannot be removed. */
  async removeView(angle: number): Promise<void> {
    const a = this.needChar().studio.artwork;
    if (normalizeAngle(angle) === 0) return void this.toast('info', 'The front view is the original artwork and cannot be removed.');
    const kept = artworkViews(a).filter((v) => Math.abs(normalizeAngle(v.angle) - normalizeAngle(angle)) >= 1e-6);
    this.commitChar((c) => updateStudio(c, { artwork: withViews(c.studio.artwork, kept) }), 'Remove artwork view');
    await this.projectArtwork(null);
  }
  clearProjection(): void {
    this.commitChar((c) => updateStudio(c, { artwork: { ...c.studio.artwork, front: null, back: null, views: [], bakedPose: null } }), 'Remove projected artwork');
  }
  /**
   * Fit proportions and shape to the drawing's silhouette, assuming the current pose matches the drawing (front-facing).
   * Standing height is kept. Runs in the background with progress; the result is ONE undo step.
   */
  async fitToArtwork(): Promise<void> {
    if (this.ui.studio.fit.running) return;
    const c0 = this.needChar();
    if (!c0.originalAssetId) return void this.toast('error', 'Import the original artwork first (Character tab).');
    this.fitStop = false;
    this.setUi({ studio: { ...this.ui.studio, fit: { running: true, fraction: 0, iou: null, message: 'Reading the artwork…' } } });
    try {
      await this.ensureModel();
      await this.ensureArtwork();
      const img = this.artCache.get(c0.originalAssetId);
      if (!img?.box) throw new Error('No figure was found in the artwork. Use an image with a transparent or plain background.');
      const result = await fitBodyToArtwork({
        proportions: c0.studio.proportions, shape: c0.studio.shape, pose: c0.studio.pose, mask: img.mask,
        onProgress: (p) => this.setUi({ studio: { ...this.ui.studio, fit: { running: true, fraction: p.fraction, iou: p.iou, message: 'Fitting the body…' } } }),
        shouldStop: () => this.fitStop,
        yieldFn: () => new Promise((r) => setTimeout(r, 0)),
      });
      const target = buildRestSkeleton(c0.studio.proportions).restHeight;
      const proportions = restoreStandingHeight(result.proportions, target);
      this.commitChar((c) => updateStudio(c, { proportions, shape: result.shape }), 'Fit body to artwork');
      this.setUi({ studio: { ...this.ui.studio, fit: { running: false, fraction: 1, iou: result.iou, message: `${result.stopped ? 'Stopped. ' : ''}Silhouette match ${(result.iouBefore * 100).toFixed(0)}% → ${(result.iou * 100).toFixed(0)}%.` } } });
    } catch (e) {
      this.setUi({ studio: { ...this.ui.studio, fit: { running: false, fraction: 0, iou: null, message: null } } });
      this.toast('error', e instanceof Error ? e.message : 'The body could not be fitted to the artwork.');
    }
  }
  cancelFit(): void {
    this.fitStop = true;
  }

  /** Camera changes are saved with the profile but are not undo steps (orbiting should never get in the way of undoing a pose edit). */
  setStudioCamera(camera: CameraState): void {
    const h = this.charHistory;
    if (!h) return;
    const cam = clampCamera(camera);
    this.liveCamera = cam;
    h.preview(updateStudio(h.present, { camera: cam }));
    this.markDirty();
    this.schedule();
  }
  setCameraView(id: string): void {
    const v = VIEW_PRESETS.find((x) => x.id === id);
    if (!v) return;
    const cam = this.needChar().studio.camera;
    this.commitChar((c) => updateStudio(c, { camera: clampCamera({ ...cam, azimuth: v.azimuth, elevation: v.elevation }) }), `View: ${v.label}`);
  }
  /** Frame the whole figure with a margin, keeping the current viewing angle. */
  frameStudioCamera(): void {
    const c = this.needChar();
    const rest = buildRestSkeleton(c.studio.proportions);
    const cam = frameCamera(c.studio.camera, framingPoints(rest, c.studio.pose), c.studio.output.width / c.studio.output.height, 0.07);
    this.commitChar((x) => updateStudio(x, { camera: cam }), 'Frame figure');
  }
  setCameraField(field: 'fov' | 'distance' | 'elevation' | 'azimuth', v: number): void {
    if (!Number.isFinite(v)) return;
    const cam = this.needChar().studio.camera;
    this.commitChar((c) => updateStudio(c, { camera: clampCamera({ ...cam, [field]: v }) }), 'Camera', `camera:${field}`);
  }
  setOutputSize(width: number, height: number): void {
    if (![width, height].every((n) => Number.isInteger(n) && n >= 64 && n <= 4096)) return void this.toast('error', 'Output size must be whole numbers from 64 to 4096 px.');
    this.commitChar((c) => updateStudio(c, { output: { width, height } }), 'Output size', 'output');
  }
  saveStudioPoseAs(name: string): void {
    this.commitChar((c) => saveStudioPose(c, newId('pose'), name, Date.now()), 'Save pose');
  }
  applySavedStudioPose(id: ID): void {
    this.commitChar((c) => applyStudioPose(c, id), 'Apply saved pose');
  }
  overwriteSavedStudioPose(id: ID): void {
    this.commitChar((c) => overwriteStudioPose(c, id), 'Update saved pose');
  }
  renameSavedStudioPose(id: ID, name: string): void {
    this.commitChar((c) => renameStudioPose(c, id, name), 'Rename pose', `posename:${id}`);
  }
  deleteSavedStudioPose(id: ID): void {
    this.commitChar((c) => deleteStudioPose(c, id), 'Delete pose');
  }

  // ---------- pose-guide images ----------
  private guideRequest(kind: GuideKind, transparent: boolean, scale = 1) {
    const c = this.needChar();
    if (kind === 'textured') {
      const a = this.bodyArtwork(c);
      if (!a || !a.bakedPose || a.views.length === 0) throw new Error('Project the artwork onto the model first (Pose studio → Match to artwork), then render the character render.');
    }
    return {
      kind, rest: buildRestSkeleton(c.studio.proportions), shape: c.studio.shape, artwork: kind === 'textured' ? this.bodyArtwork(c) : null,
      pose: c.studio.pose, camera: c.studio.camera, width: Math.round(c.studio.output.width * scale), height: Math.round(c.studio.output.height * scale), transparent,
    };
  }
  /** Render a guide image canvas for preview. */
  renderGuidePreview(kind: GuideKind, transparent: boolean): HTMLCanvasElement {
    return renderGuideCanvas(this.guideRequest(kind, transparent));
  }
  async renderGuideFile(kind: GuideKind, transparent: boolean, scale = 1): Promise<{ bytes: Uint8Array; fileName: string; width: number; height: number }> {
    await this.ensureModel();
    await this.ensureArtwork();
    const req = this.guideRequest(kind, transparent, scale);
    const bytes = await renderGuidePng(req);
    const safe = (this.project?.name ?? 'character').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'character';
    return { bytes, fileName: `${safe}-${kind}${scale > 1 ? `@${scale}x` : ''}.png`, width: req.width, height: req.height };
  }

  /** Structured pose data (joints, keypoints, camera, facing) for external tools — same data adapters receive. */
  poseGuideJson(): string {
    const c = this.needChar();
    return JSON.stringify(computePoseGuide(buildRestSkeleton(c.studio.proportions), c.studio.pose, c.studio.camera, c.studio.output.width, c.studio.output.height), null, 2);
  }

  // ---------- generation ----------
  setLocalUrl(url: string): void {
    try {
      localStorage.setItem(LOCAL_URL_KEY, url);
    } catch {
      /* private mode: keep it for this session only */
    }
    this.setUi({ generation: { ...this.ui.generation, localUrl: url, provider: null } });
  }
  setSeed(seed: number | null): void {
    this.setUi({ generation: { ...this.ui.generation, seed } });
  }
  selectResult(id: ID | null): void {
    this.setUi({ generation: { ...this.ui.generation, selectedResultId: id } });
  }
  async checkProvider(): Promise<ProviderStatus | null> {
    const g = this.ui.generation;
    const provider = createProvider(this.character?.providerId ?? null, g.localUrl);
    if (!provider) return null;
    this.setUi({ generation: { ...g, checking: true } });
    const status = await provider.status();
    this.setUi({ generation: { ...this.ui.generation, checking: false, provider: status } });
    return status;
  }
  cancelGeneration(): void {
    this.genAbort?.abort();
  }

  /** Run the configured provider. If none is ready this reports exactly what is missing and produces nothing. */
  async generate(parentId: ID | null = null): Promise<void> {
    if (this.ui.generation.running) return;
    const c0 = this.needChar();
    if (!c0.originalAssetId) return void this.toast('error', 'Import the original character artwork first (Character tab).');
    const provider = createProvider(c0.providerId, this.ui.generation.localUrl);
    if (!provider) return void this.toast('error', 'No generation provider is selected.');
    const setStage = (stage: string) => this.setUi({ generation: { ...this.ui.generation, stage } });
    this.setUi({ generation: { ...this.ui.generation, running: true, stage: 'Checking the generation server…' } });
    this.genAbort = new AbortController();
    const signal = this.genAbort.signal;
    try {
      const status = await provider.status(signal);
      this.setUi({ generation: { ...this.ui.generation, provider: status } });
      if (status.state !== 'ready') throw new GenerationError('unavailable', status.message);
      const requestedAt = Date.now();
      setStage('Rendering pose guides…');
      const wanted = (status.capabilities?.guides.length ? status.capabilities.guides : ['pose']) as GuideKind[];
      const guideBytes: Partial<Record<GuideKind, Uint8Array>> = {};
      const payloads: Partial<Record<GuideKind, { bytes: Uint8Array; mime: string; width: number; height: number }>> = {};
      await this.ensureModel();
      await this.ensureArtwork();
      for (const kind of wanted) {
        // the character render only exists once the artwork has been projected onto the model; otherwise it is simply not sent
        if (kind === 'textured' && !this.bodyArtwork()) continue;
        const req = this.guideRequest(kind, GUIDE_DEFAULT_TRANSPARENT[kind]);
        const bytes = await renderGuidePng(req);
        guideBytes[kind] = bytes;
        payloads[kind] = { bytes, mime: 'image/png', width: req.width, height: req.height };
      }
      const seed = this.ui.generation.seed ?? Math.floor(Math.random() * 2 ** 31);
      const request = buildGenerationRequest(this.needChar(), (id) => this.assets.get(id), payloads, seed);
      if (status.capabilities && request.references.length > status.capabilities.maxReferences) {
        throw new GenerationError('invalid-request', `This backend accepts at most ${status.capabilities.maxReferences} reference images; ${request.references.length} are approved. Un-approve some in the Character tab.`);
      }
      const out = await provider.generate(request, { signal, onProgress: (p) => setStage(p.stage) });
      assertGenuineResult(out, request);
      setStage('Saving the result…');
      const decoded = await decodeToCanvas(out.bytes, out.mime);
      if (decoded.width > LIMITS.maxCanvas || decoded.height > LIMITS.maxCanvas || decoded.width * decoded.height > LIMITS.maxPixels) {
        throw new GenerationError('too-large', `The backend returned a ${decoded.width}×${decoded.height}px image, larger than the supported maximum. It was discarded.`);
      }
      const outAsset: AssetData = { id: newId('asset'), kind: 'generated', mime: out.mime, width: decoded.width, height: decoded.height, bytes: out.bytes };
      this.addAsset(outAsset);
      const guideIds: Partial<Record<GuideKind, ID>> = {};
      for (const [kind, bytes] of Object.entries(guideBytes) as [GuideKind, Uint8Array][]) {
        const p = payloads[kind]!;
        const a: AssetData = { id: newId('asset'), kind: 'guide', mime: 'image/png', width: p.width, height: p.height, bytes };
        this.addAsset(a);
        guideIds[kind] = a.id;
      }
      const cur = this.needChar();
      const savedMatch = cur.studio.poses.find((p) => posesEqual(p.pose, cur.studio.pose));
      const prov = buildProvenance({ character: cur, providerId: provider.id, providerName: provider.name, model: out.model, seed: out.seed ?? seed, requestedAt, completedAt: Date.now(), guideAssetIds: guideIds, parentId, poseId: savedMatch?.id ?? null });
      const rec = makeRecord(newId('gen'), outAsset.id, 'generated', prov, Date.now());
      this.commitChar((c) => addGeneration(c, rec), 'New generated result');
      this.setUi({ generation: { ...this.ui.generation, selectedResultId: rec.id } });
      this.toast('ok', 'New result added for review. Nothing has been accepted yet.');
    } catch (e) {
      if (e instanceof GenerationError && e.code === 'cancelled') this.toast('info', 'Generation cancelled.');
      else this.fail(e);
    } finally {
      this.genAbort = null;
      this.setUi({ generation: { ...this.ui.generation, running: false, stage: '' } });
    }
  }

  /** Apply a result's pose/camera/body to the studio, then generate again (the new result links back via parentId). */
  async retryResult(id: ID): Promise<void> {
    const g = this.needChar().generations.find((x) => x.id === id);
    if (!g) return;
    if (g.origin !== 'generated') return void this.toast('info', 'Imported images cannot be regenerated. Use "Generate" with the current pose instead.');
    this.commitChar((c) => updateStudio(c, { pose: structuredClone(g.provenance.pose), camera: structuredClone(g.provenance.camera), proportions: structuredClone(g.provenance.proportions), ...(g.provenance.shape ? { shape: structuredClone(g.provenance.shape) } : {}) }), 'Restore pose of result');
    this.setUi({ generation: { ...this.ui.generation, seed: null } });
    await this.generate(id);
  }

  /** Import an image made outside CharacterForge (e.g. with your own ComfyUI/Krita workflow) for review. Always labelled as imported. */
  async importResult(file: File): Promise<void> {
    await this.run('Importing result…', async () => {
      const c0 = this.needChar();
      const a = await this.ingestImage(file, 'generated');
      const { imageKind: _k, ...asset } = a;
      void _k;
      this.addAsset(asset);
      const now = Date.now();
      const savedMatch = c0.studio.poses.find((p) => posesEqual(p.pose, c0.studio.pose));
      const prov = buildProvenance({ character: c0, providerId: MANUAL_IMPORT_ID, providerName: importedProvider.name, model: null, seed: null, requestedAt: now, completedAt: now, guideAssetIds: {}, parentId: null, poseId: savedMatch?.id ?? null });
      const rec = makeRecord(newId('gen'), asset.id, 'imported', prov, now);
      this.commitChar((c) => addGeneration(c, rec), 'Import result');
      this.setUi({ generation: { ...this.ui.generation, selectedResultId: rec.id } });
      this.toast('ok', 'Imported for review. It is labelled “imported” and is not claimed to be generated by CharacterForge.');
    });
  }
  decideResult(id: ID, status: 'accepted' | 'rejected' | 'candidate'): void {
    this.commitChar((c) => setGenerationStatus(c, id, status, Date.now()), status === 'accepted' ? 'Accept result' : status === 'rejected' ? 'Reject result' : 'Reset result to candidate');
  }
  setResultNote(id: ID, note: string): void {
    this.commitChar((c) => setGenerationNote(c, id, note), 'Result note', `note:${id}`);
  }
  removeResult(id: ID): void {
    if (this.commitChar((c) => deleteGeneration(c, id), 'Delete result') && this.ui.generation.selectedResultId === id) this.selectResult(null);
  }
  /** Explicit, separate step: add an accepted result to the references (it never replaces the original). */
  addResultAsReference(id: ID): void {
    const g = this.needChar().generations.find((x) => x.id === id);
    if (!g) return;
    const r: ReferenceImage = { id: newId('ref'), assetId: g.outputAssetId, label: `Result ${new Date(g.createdAt).toLocaleDateString()}`, role: 'alt-view', notes: g.origin === 'generated' ? 'Generated result added as a reference.' : 'Imported result added as a reference.', fileName: 'result', approved: true, addedAt: Date.now() };
    if (this.commitChar((c) => addReference(c, r), 'Use result as reference')) this.toast('ok', 'Added to the references. The original artwork is unchanged.');
  }
  /** Copy a result into the 2D canvas as a NEW layer for manual correction. The result and the original are not modified. */
  sendResultToCanvas(id: ID): void {
    const g = this.needChar().generations.find((x) => x.id === id);
    const info = g && this.assets.get(g.outputAssetId);
    if (!g || !info || !this.history) return;
    const d = this.history.present;
    const first = d.layers.length === 0;
    const canvas = first ? { width: info.width, height: info.height } : d.canvas;
    const layer = makeRasterLayer({ id: newId('layer'), name: `Result ${new Date(g.createdAt).toLocaleTimeString()}`, assetId: info.id, width: info.width, height: info.height, x: canvas.width / 2, y: canvas.height / 2 });
    this.commit({ ...d, canvas, layers: [...d.layers, layer] }, 'Add result to canvas');
    this.ui = { ...this.ui, selectedLayerIds: [layer.id] };
    this.toast('ok', 'Added as a new layer in the 2D Canvas tab, where you can crop, transform, mask and export it.');
    this.emit();
  }
  /** Assets for downloading a result or its provenance. */
  resultFile(id: ID): { bytes: Uint8Array; mime: string; fileName: string } | null {
    const g = this.needChar().generations.find((x) => x.id === id);
    const a = g && this.assets.get(g.outputAssetId);
    if (!g || !a) return null;
    const safe = (this.project?.name ?? 'character').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'character';
    return { bytes: a.bytes, mime: a.mime, fileName: `${safe}-${g.status}-${id.slice(-6)}.${a.mime === 'image/png' ? 'png' : a.mime === 'image/jpeg' ? 'jpg' : 'webp'}` };
  }

  // ======================================================================
  // The manga page
  // ======================================================================

  get page(): PageState | null {
    return this.pageHistory ? this.pageHistory.present : null;
  }
  private needPage(): PageState {
    if (!this.pageHistory) throw new Error('Open or create a character first.');
    return this.pageHistory.present;
  }

  private commitPage(fn: (p: PageState) => PageState, label: string, key?: string): boolean {
    if (!this.pageHistory) return false;
    try {
      const next = fn(this.pageHistory.present);
      if (next === this.pageHistory.present) return false;
      this.pageHistory.commit(next, label, key);
      this.markDirty();
      this.emit();
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  selectPageItem(selection: PageUi['selection']): void {
    this.setUi({ page: { ...this.ui.page, selection } });
  }
  setPageOption(patch: Partial<Pick<PageUi, 'showBorders' | 'showBubbles'>>): void {
    this.setUi({ page: { ...this.ui.page, ...patch } });
  }

  /** Replace the whole panel layout with a named preset. Placements are kept and re-homed to the nearest panel. */
  applyPageLayout(kind: LayoutKind): void {
    this.commitPage((p) => {
      const panels = panelLayout(kind, p);
      const ids = new Set(panels.map((x) => x.id));
      return {
        ...p,
        panels,
        placements: p.placements.map((pl) => (pl.panelId && !ids.has(pl.panelId) ? { ...pl, panelId: null } : pl)),
      };
    }, 'Page layout');
  }

  setPageSize(size: { width: number; height: number }, dpi: number): void {
    this.commitPage((p) => resizePageOp(p, size, dpi), 'Page size');
  }

  setPageSettings(patch: Partial<Pick<PageState, 'gutter' | 'bleed' | 'borderWidth' | 'background' | 'borderColor'>>): void {
    this.commitPage((p) => ({ ...p, ...patch }), 'Page settings', 'page-settings');
  }

  addPanel(shape: PanelShape = 'rect'): void {
    const p = this.needPage();
    const s = pagePixelSize(p);
    const w = s.width * 0.42;
    const h = s.height * 0.3;
    const n = p.panels.length;
    const x = s.width * 0.06 + (n % 2) * (s.width * 0.5);
    const y = s.height * 0.06 + Math.floor(n / 2) * (s.height * 0.34);
    const rect = [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ];
    const points = shape === 'skewed' ? [{ x: x + w * 0.12, y }, { x: x + w * 1.12, y }, { x: x + w, y: y + h }, { x, y: y + h }] : rect;
    const panel: Panel = { id: newId('panel'), name: `Panel ${n + 1}`, shape, points };
    if (this.commitPage((pg) => addPanelOp(pg, panel), 'Add panel')) this.selectPageItem({ kind: 'panel', id: panel.id });
  }

  updatePanel(id: ID, patch: Partial<Omit<Panel, 'id'>>): void {
    this.commitPage((p) => updatePanelOp(p, id, patch), 'Edit panel', `panel:${id}`);
  }

  deletePanel(id: ID): void {
    if (this.commitPage((p) => deletePanelOp(p, id), 'Delete panel') && this.ui.page.selection?.id === id) this.selectPageItem(null);
  }

  /** Place an image on the page. With a panel it is scaled to cover the frame and centred in it. */
  placeImage(assetId: ID, panelId: ID | null, source: PlacementSource | null): void {
    const info = this.assets.get(assetId);
    if (!info) return;
    const p = this.needPage();
    const panel = panelId ? p.panels.find((x) => x.id === panelId) : null;
    const base: Placement = {
      id: newId('place'),
      panelId: panel ? panel.id : null,
      assetId,
      width: info.width,
      height: info.height,
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      flipX: false,
      opacity: 1,
      source,
    };
    if (panel) {
      // A character dropped into a panel is fitted to the panel's height and stood on its floor, centred horizontally —
      // the composition a manga artist wants for a standing figure. They can scale up to crop deliberately.
      const content = panelContentPolygon(panel, p);
      const b = polygonBounds(content);
      const c = polygonCentroid(content);
      const fit = Math.min((b.x1 - b.x0) / info.width, (b.y1 - b.y0) / info.height);
      base.scale = fit;
      base.x = c.x;
      base.y = b.y1 - (info.height * fit) / 2;
    } else {
      const s = pagePixelSize(p);
      base.x = s.width / 2;
      base.y = s.height / 2;
      base.scale = Math.min(s.width / info.width, s.height / info.height) * 0.6;
    }
    if (this.commitPage((pg) => addPlacementOp(pg, base), 'Place image')) {
      this.selectPageItem({ kind: 'placement', id: base.id });
      void this.refreshPageImages();
    }
  }

  /** Place an accepted result (or any result) on the page, keeping the link back to its profile and pose. */
  placeResult(generationId: ID, panelId: ID | null): void {
    const c = this.needChar();
    const g = c.generations.find((x) => x.id === generationId);
    if (!g) return;
    const saved = c.studio.poses.find((p) => p.id === g.provenance.poseId);
    const source: PlacementSource = {
      kind: 'result',
      generationId: g.id,
      poseId: g.provenance.poseId,
      poseName: g.provenance.poseName ?? saved?.name ?? null,
      pose: structuredClone(g.provenance.pose),
      camera: structuredClone(g.provenance.camera),
      capturedAt: g.createdAt,
    };
    this.placeImage(g.outputAssetId, panelId, source);
  }

  /** Place the 2D canvas as it currently looks (its layers composited) onto the page. */
  async placeCanvas(panelId: ID | null): Promise<void> {
    await this.run('Placing the 2D canvas…', async () => {
      await this.refreshBitmaps();
      const d = this.need();
      const r = renderExportCanvas(d, this.bitmaps, 1);
      const bytes = await canvasToPngBytes(r.canvas);
      const asset: AssetData = { id: newId('asset'), kind: 'generated', mime: 'image/png', width: r.width, height: r.height, bytes };
      this.addAsset(asset);
      this.placeImage(asset.id, panelId, { kind: 'canvas', generationId: null, poseId: null, poseName: null, pose: null, camera: null, capturedAt: Date.now() });
    });
  }

  updatePlacement(id: ID, patch: Partial<Omit<Placement, 'id'>>): void {
    this.commitPage((p) => updatePlacementOp(p, id, patch), 'Edit placement', `place:${id}`);
  }

  deletePlacement(id: ID): void {
    if (this.commitPage((p) => deletePlacementOp(p, id), 'Delete placement') && this.ui.page.selection?.id === id) this.selectPageItem(null);
  }

  movePlacement(id: ID, dir: 'up' | 'down' | 'top' | 'bottom'): void {
    this.commitPage((p) => movePlacementOp(p, id, dir), 'Reorder placement');
  }

  /** Point an existing placement at a newer result, keeping its position and scale — this is how re-posing updates a panel. */
  relinkPlacement(placementId: ID, generationId: ID): void {
    const c = this.needChar();
    const g = c.generations.find((x) => x.id === generationId);
    const info = g && this.assets.get(g.outputAssetId);
    if (!g || !info) return;
    const source: PlacementSource = {
      kind: 'result',
      generationId: g.id,
      poseId: g.provenance.poseId,
      poseName: g.provenance.poseName,
      pose: structuredClone(g.provenance.pose),
      camera: structuredClone(g.provenance.camera),
      capturedAt: g.createdAt,
    };
    if (this.commitPage((p) => relinkPlacementOp(p, placementId, g.outputAssetId, info.width, info.height, source), 'Update panel image')) {
      this.toast('ok', 'The panel now shows the newer result. Its position and size are unchanged.');
      void this.refreshPageImages();
    }
  }

  addBubble(kind: BubbleKind = 'speech'): void {
    const p = this.needPage();
    const s = pagePixelSize(p);
    const n = p.bubbles.length;
    const bubble: Bubble = {
      id: newId('bubble'),
      kind,
      text: kind === 'caption' ? 'Caption' : 'Say something…',
      x: s.width * (0.3 + (n % 3) * 0.2),
      y: s.height * (0.12 + Math.floor(n / 3) * 0.1),
      width: kind === 'caption' ? s.width * 0.3 : s.width * 0.22,
      height: kind === 'caption' ? s.height * 0.07 : s.height * 0.1,
      tail: kind === 'caption' ? null : 90,
      fontSize: Math.max(8, Math.round(s.width * 0.022)),
    };
    if (this.commitPage((pg) => addBubbleOp(pg, bubble), 'Add bubble')) this.selectPageItem({ kind: 'bubble', id: bubble.id });
  }

  updateBubble(id: ID, patch: Partial<Omit<Bubble, 'id'>>): void {
    this.commitPage((p) => updateBubbleOp(p, id, patch), 'Edit bubble', `bubble:${id}`);
  }

  deleteBubble(id: ID): void {
    if (this.commitPage((p) => deleteBubbleOp(p, id), 'Delete bubble') && this.ui.page.selection?.id === id) this.selectPageItem(null);
  }

  /** Decode any page images that are not ready yet, then re-render. */
  async refreshPageImages(): Promise<void> {
    const p = this.page;
    if (!p) return;
    const changed = await this.pageImages.ensure(pageAssetIds(p), this.assets);
    if (changed) this.setUi({ page: { ...this.ui.page, imageRev: this.ui.page.imageRev + 1 } });
  }

  /** The decoded image for a placement, or null while it is still loading. */
  pageImage(assetId: ID): HTMLCanvasElement | null {
    return this.pageImages.get(assetId);
  }

  /** Render the page at print resolution (its own DPI, plus bleed). */
  renderPageCanvas(opts: { scale?: number; paper?: boolean; borders?: boolean; bubbles?: boolean; bleed?: boolean } = {}): HTMLCanvasElement | null {
    const p = this.page;
    if (!p) return null;
    return renderPage(p, {
      scale: opts.scale ?? 1,
      paper: opts.paper,
      borders: opts.borders,
      bubbles: opts.bubbles,
      bleed: opts.bleed,
      image: (id) => this.pageImages.get(id),
    }).canvas;
  }

  async exportPagePng(): Promise<{ blob: Blob; width: number; height: number; dpi: number } | undefined> {
    return this.run('Rendering the page…', async () => {
      await this.refreshPageImages();
      const p = this.needPage();
      const size = pageExportSize(p);
      if (size.width * size.height > 100_000_000) throw new Error(`The page would be ${size.width}×${size.height}px, which is too large to export. Lower the DPI.`);
      const canvas = this.renderPageCanvas({ scale: 1 });
      if (!canvas) throw new Error('There is no page to export.');
      const blob = await canvasToBlob(canvas);
      return { blob, width: canvas.width, height: canvas.height, dpi: p.dpi };
    });
  }

  // ---------- export ----------
  /** Render the current pose exactly as it will be exported (used by the export preview). */
  async renderExportPreview(scale: number): Promise<RenderedExport> {
    await this.refreshBitmaps();
    return renderExportCanvas(this.need(), this.bitmaps, scale);
  }

  async renderPng(scale: number): Promise<{ blob: Blob; width: number; height: number } | undefined> {
    return this.run('Rendering PNG…', async () => {
      await this.refreshBitmaps();
      return exportPngBlob(this.need(), this.bitmaps, scale);
    });
  }
}

export const store = new AppStore();
