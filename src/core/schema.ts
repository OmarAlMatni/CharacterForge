import { validateShape } from '../pose/bodyShape.ts';
import { validateCamera, validateProportions } from '../pose/validate.ts';
import { validatePose } from '../pose/pose.ts';
import { CHARACTER_LIMITS } from './character.ts';
import { ID_PATTERN } from './ids.ts';
import { PAGE_LIMITS } from './page.ts';
import { ASSET_KINDS } from './types.ts';
import type { ProjectFile } from './types.ts';

export const LIMITS = { maxCanvas: 16384, maxLayers: 5000, maxJoints: 500, maxPoses: 500, maxPixels: 100_000_000 } as const;

export type ValidationResult = { ok: true; value: ProjectFile } | { ok: false; errors: string[] };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isId = (v: unknown): v is string => isStr(v) && ID_PATTERN.test(v);

function vec(v: unknown): boolean {
  return isRec(v) && isNum(v.x) && isNum(v.y);
}

function checkPose(p: unknown, where: string, jointIds: Set<string>, errors: string[]): void {
  if (!isRec(p)) return void errors.push(`${where}: must be an object.`);
  if (!vec(p.rootOffset)) errors.push(`${where}.rootOffset: must be {x, y}.`);
  if (!isRec(p.rotations)) return void errors.push(`${where}.rotations: must be an object.`);
  for (const [k, v] of Object.entries(p.rotations)) {
    if (!jointIds.has(k)) errors.push(`${where}.rotations: unknown joint "${k}".`);
    if (!isNum(v)) errors.push(`${where}.rotations["${k}"]: must be a number.`);
  }
}

/** Structural validation of a (current-version) project file. Never throws. */
export function validateProjectFile(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRec(data)) return { ok: false, errors: ['Project data is not an object.'] };
  if (!isId(data.id)) errors.push('id: missing or invalid.');
  if (!isStr(data.name)) errors.push('name: must be a string.');
  if (!isNum(data.createdAt) || !isNum(data.updatedAt)) errors.push('createdAt/updatedAt: must be numbers.');

  // assets
  const assetIds = new Set<string>();
  if (!Array.isArray(data.assets)) errors.push('assets: must be an array.');
  else {
    data.assets.forEach((a, i) => {
      if (!isRec(a) || !isId(a.id)) return void errors.push(`assets[${i}]: invalid id.`);
      if (assetIds.has(a.id)) errors.push(`assets[${i}]: duplicate id "${a.id}".`);
      assetIds.add(a.id);
      if (!(ASSET_KINDS as readonly unknown[]).includes(a.kind)) errors.push(`assets[${i}].kind: invalid.`);
      if (!isStr(a.mime)) errors.push(`assets[${i}].mime: must be a string.`);
      if (!isNum(a.width) || !isNum(a.height) || !isNum(a.size)) errors.push(`assets[${i}]: width/height/size must be numbers.`);
    });
  }

  // sources
  if (!Array.isArray(data.sources)) errors.push('sources: must be an array.');
  else
    data.sources.forEach((s, i) => {
      if (!isRec(s) || !isStr(s.assetId) || !assetIds.has(s.assetId)) errors.push(`sources[${i}]: unknown asset.`);
      else if (s.kind !== 'png' && s.kind !== 'psd' && s.kind !== 'jpeg' && s.kind !== 'webp') errors.push(`sources[${i}].kind: invalid.`);
    });

  const doc = data.doc;
  if (!isRec(doc)) return { ok: false, errors: [...errors, 'doc: must be an object.'] };

  // canvas
  const canvas = doc.canvas;
  if (!isRec(canvas) || !isNum(canvas.width) || !isNum(canvas.height)) errors.push('doc.canvas: width/height required.');
  else if (
    !Number.isInteger(canvas.width) ||
    !Number.isInteger(canvas.height) ||
    canvas.width < 1 ||
    canvas.height < 1 ||
    canvas.width > LIMITS.maxCanvas ||
    canvas.height > LIMITS.maxCanvas
  )
    errors.push(`doc.canvas: size must be whole numbers between 1 and ${LIMITS.maxCanvas}.`);

  // joints
  const jointIds = new Set<string>();
  const joints = Array.isArray(doc.joints) ? doc.joints : (errors.push('doc.joints: must be an array.'), []);
  if (joints.length > LIMITS.maxJoints) errors.push(`doc.joints: more than ${LIMITS.maxJoints}.`);
  joints.forEach((j: unknown, i: number) => {
    if (!isRec(j) || !isId(j.id)) return void errors.push(`doc.joints[${i}]: invalid id.`);
    if (jointIds.has(j.id)) errors.push(`doc.joints[${i}]: duplicate id.`);
    jointIds.add(j.id);
  });
  const jointParent = new Map<string, string | null>();
  joints.forEach((j: unknown, i: number) => {
    if (!isRec(j) || !isId(j.id)) return;
    if (!isStr(j.name)) errors.push(`doc.joints[${i}].name: must be a string.`);
    if (!vec(j.offset)) errors.push(`doc.joints[${i}].offset: must be {x, y}.`);
    if (j.bend !== -1 && j.bend !== 0 && j.bend !== 1) errors.push(`doc.joints[${i}].bend: must be -1, 0 or 1.`);
    if (j.limits !== null && !(isRec(j.limits) && isNum(j.limits.min) && isNum(j.limits.max) && j.limits.min <= j.limits.max))
      errors.push(`doc.joints[${i}].limits: must be null or {min <= max}.`);
    if (j.parentId !== null && !(isStr(j.parentId) && jointIds.has(j.parentId))) errors.push(`doc.joints[${i}].parentId: unknown joint.`);
    jointParent.set(j.id, isStr(j.parentId) ? j.parentId : null);
  });
  for (const id of jointParent.keys()) {
    let cur: string | null | undefined = id;
    for (let n = 0; cur && n <= jointParent.size; n++) cur = jointParent.get(cur);
    if (cur) {
      errors.push('doc.joints: hierarchy contains a cycle.');
      break;
    }
  }

  // layers
  const layerKind = new Map<string, string>();
  const layers = Array.isArray(doc.layers) ? doc.layers : (errors.push('doc.layers: must be an array.'), []);
  if (layers.length > LIMITS.maxLayers) errors.push(`doc.layers: more than ${LIMITS.maxLayers}.`);
  layers.forEach((l: unknown, i: number) => {
    if (!isRec(l) || !isId(l.id)) return void errors.push(`doc.layers[${i}]: invalid id.`);
    if (layerKind.has(l.id)) errors.push(`doc.layers[${i}]: duplicate id.`);
    layerKind.set(l.id, isStr(l.kind) ? l.kind : '');
  });
  const layerParent = new Map<string, string | null>();
  layers.forEach((l: unknown, i: number) => {
    if (!isRec(l) || !isId(l.id)) return;
    const w = `doc.layers[${i}]`;
    if (l.kind !== 'raster' && l.kind !== 'group') errors.push(`${w}.kind: must be "raster" or "group".`);
    if (!isStr(l.name)) errors.push(`${w}.name: must be a string.`);
    if (typeof l.visible !== 'boolean' || typeof l.locked !== 'boolean') errors.push(`${w}: visible/locked must be booleans.`);
    if (!isNum(l.opacity) || l.opacity < 0 || l.opacity > 1) errors.push(`${w}.opacity: must be between 0 and 1.`);
    if (!isRec(l.transform) || !isNum(l.transform.x) || !isNum(l.transform.y) || !isNum(l.transform.rotation) || !isNum(l.transform.scaleX) || !isNum(l.transform.scaleY))
      errors.push(`${w}.transform: invalid.`);
    else if (l.transform.scaleX === 0 || l.transform.scaleY === 0) errors.push(`${w}.transform: scale cannot be 0.`);
    if (!vec(l.pivot)) errors.push(`${w}.pivot: must be {x, y}.`);
    if (l.parentId !== null && !(isStr(l.parentId) && layerKind.get(l.parentId) === 'group')) errors.push(`${w}.parentId: must be null or an existing group.`);
    layerParent.set(l.id, isStr(l.parentId) ? l.parentId : null);
    if (l.jointId !== null && !(isStr(l.jointId) && jointIds.has(l.jointId))) errors.push(`${w}.jointId: unknown joint.`);
    if (l.kind === 'raster') {
      if (!isStr(l.assetId) || !assetIds.has(l.assetId)) errors.push(`${w}.assetId: unknown asset.`);
      if (l.maskAssetId !== null && !(isStr(l.maskAssetId) && assetIds.has(l.maskAssetId))) errors.push(`${w}.maskAssetId: unknown asset.`);
      if (!isNum(l.width) || !isNum(l.height) || l.width < 1 || l.height < 1) errors.push(`${w}: width/height must be positive.`);
      else if (l.width * l.height > LIMITS.maxPixels) errors.push(`${w}: image is larger than ${LIMITS.maxPixels / 1e6} megapixels.`);
    }
  });
  for (const id of layerParent.keys()) {
    let cur: string | null | undefined = id;
    for (let n = 0; cur && n <= layerParent.size; n++) cur = layerParent.get(cur);
    if (cur) {
      errors.push('doc.layers: hierarchy contains a cycle.');
      break;
    }
  }

  // poses
  checkPose(doc.pose, 'doc.pose', jointIds, errors);
  const poses = Array.isArray(doc.poses) ? doc.poses : (errors.push('doc.poses: must be an array.'), []);
  if (poses.length > LIMITS.maxPoses) errors.push(`doc.poses: more than ${LIMITS.maxPoses}.`);
  poses.forEach((p: unknown, i: number) => {
    checkPose(p, `doc.poses[${i}]`, jointIds, errors);
    if (isRec(p) && (!isId(p.id) || !isStr(p.name) || !isNum(p.createdAt))) errors.push(`doc.poses[${i}]: id/name/createdAt invalid.`);
  });

  validateCharacter(data.character, assetIds, errors);
  validatePage(data.page, assetIds, errors);

  if (errors.length) return { ok: false, errors: errors.slice(0, 50) };
  return { ok: true, value: data as unknown as ProjectFile };
}

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const STATUSES = ['candidate', 'accepted', 'rejected'];
const ROLES = ['face', 'alt-view', 'clothing', 'accessory', 'expression', 'other'];
const GUIDES = ['mannequin', 'textured', 'pose', 'depth', 'silhouette'];

function validateCharacter(c: unknown, assetIds: Set<string>, errors: string[]): void {
  if (!isRec(c)) return void errors.push('character: must be an object.');
  const asset = (v: unknown, where: string) => {
    if (!isStr(v) || !assetIds.has(v)) errors.push(`${where}: unknown asset.`);
  };
  if (c.originalAssetId !== null) asset(c.originalAssetId, 'character.originalAssetId');

  if (!Array.isArray(c.previousOriginals)) errors.push('character.previousOriginals: must be an array.');
  else if (c.previousOriginals.length > CHARACTER_LIMITS.previousOriginals) errors.push('character.previousOriginals: too many.');
  else c.previousOriginals.forEach((p: unknown, i: number) => (isRec(p) && isNum(p.replacedAt) ? asset(p.assetId, `character.previousOriginals[${i}].assetId`) : errors.push(`character.previousOriginals[${i}]: invalid.`)));

  const refIds = new Set<string>();
  if (!Array.isArray(c.references)) errors.push('character.references: must be an array.');
  else {
    if (c.references.length > CHARACTER_LIMITS.references) errors.push(`character.references: more than ${CHARACTER_LIMITS.references}.`);
    c.references.forEach((r: unknown, i: number) => {
      const w = `character.references[${i}]`;
      if (!isRec(r) || !isId(r.id)) return void errors.push(`${w}: invalid id.`);
      if (refIds.has(r.id)) errors.push(`${w}: duplicate id.`);
      refIds.add(r.id);
      asset(r.assetId, `${w}.assetId`);
      if (!isStr(r.label) || !isStr(r.notes) || !isStr(r.fileName)) errors.push(`${w}: label/notes/fileName must be strings.`);
      if (!isStr(r.role) || !ROLES.includes(r.role)) errors.push(`${w}.role: invalid.`);
      if (!isBool(r.approved) || !isNum(r.addedAt)) errors.push(`${w}: approved/addedAt invalid.`);
    });
  }

  const a = c.appearance;
  if (!isRec(a) || !Array.isArray(a.palette) || !a.palette.every((x: unknown) => isStr(x) && /^#[0-9a-fA-F]{6}$/.test(x)) || a.palette.length > CHARACTER_LIMITS.palette) errors.push('character.appearance.palette: must be up to 16 #rrggbb colours.');
  else for (const k of ['hair', 'eyes', 'clothing', 'accessories', 'notes']) if (!isStr(a[k])) errors.push(`character.appearance.${k}: must be a string.`);

  const s = c.studio;
  const poseIds = new Set<string>();
  if (!isRec(s)) errors.push('character.studio: must be an object.');
  else {
    errors.push(...validateProportions(s.proportions, 'character.studio.proportions'));
    errors.push(...validateShape(s.shape, 'character.studio.shape'));
    errors.push(...validateArtwork(s.artwork, assetIds, 'character.studio.artwork'));
    errors.push(...validatePose(s.pose, 'character.studio.pose'));
    errors.push(...validateCamera(s.camera, 'character.studio.camera'));
    const o = s.output;
    if (!isRec(o) || !Number.isInteger(o.width) || !Number.isInteger(o.height) || (o.width as number) < 64 || (o.height as number) < 64 || (o.width as number) > 4096 || (o.height as number) > 4096) errors.push('character.studio.output: width/height must be whole numbers from 64 to 4096.');
    if (!Array.isArray(s.poses)) errors.push('character.studio.poses: must be an array.');
    else {
      if (s.poses.length > CHARACTER_LIMITS.poses) errors.push(`character.studio.poses: more than ${CHARACTER_LIMITS.poses}.`);
      s.poses.forEach((p: unknown, i: number) => {
        const w = `character.studio.poses[${i}]`;
        if (!isRec(p) || !isId(p.id) || !isStr(p.name) || !isNum(p.createdAt)) return void errors.push(`${w}: id/name/createdAt invalid.`);
        if (poseIds.has(p.id)) errors.push(`${w}: duplicate id.`);
        poseIds.add(p.id);
        errors.push(...validatePose(p.pose, `${w}.pose`), ...validateCamera(p.camera, `${w}.camera`));
      });
    }
  }

  if (!isStr(c.instructions)) errors.push('character.instructions: must be a string.');
  if (c.providerId !== null && !isStr(c.providerId)) errors.push('character.providerId: must be a string or null.');

  const genIds = new Set<string>();
  if (!Array.isArray(c.generations)) return void errors.push('character.generations: must be an array.');
  if (c.generations.length > CHARACTER_LIMITS.generations) errors.push(`character.generations: more than ${CHARACTER_LIMITS.generations}.`);
  c.generations.forEach((g: unknown, i: number) => {
    const w = `character.generations[${i}]`;
    if (!isRec(g) || !isId(g.id)) return void errors.push(`${w}: invalid id.`);
    if (genIds.has(g.id)) errors.push(`${w}: duplicate id.`);
    genIds.add(g.id);
    if (!isStr(g.status) || !STATUSES.includes(g.status)) errors.push(`${w}.status: invalid.`);
    if (g.origin !== 'generated' && g.origin !== 'imported') errors.push(`${w}.origin: must be "generated" or "imported".`);
    if (!isNum(g.createdAt) || !(g.decidedAt === null || isNum(g.decidedAt)) || !isStr(g.note)) errors.push(`${w}: createdAt/decidedAt/note invalid.`);
    asset(g.outputAssetId, `${w}.outputAssetId`);
    const p = g.provenance;
    if (!isRec(p)) return void errors.push(`${w}.provenance: must be an object.`);
    if (!isStr(p.providerId) || !isStr(p.providerName) || !(p.model === null || isStr(p.model)) || !isNum(p.requestedAt) || !isNum(p.completedAt)) errors.push(`${w}.provenance: provider fields invalid.`);
    const st = p.settings;
    if (!isRec(st) || !isNum(st.width) || !isNum(st.height) || !isStr(st.instructions) || !(st.seed === null || isNum(st.seed))) errors.push(`${w}.provenance.settings: invalid.`);
    if (p.originalAssetId !== null) asset(p.originalAssetId, `${w}.provenance.originalAssetId`);
    if (!Array.isArray(p.referenceAssetIds)) errors.push(`${w}.provenance.referenceAssetIds: must be an array.`);
    else p.referenceAssetIds.forEach((id: unknown, j: number) => asset(id, `${w}.provenance.referenceAssetIds[${j}]`));
    if (!isRec(p.guideAssetIds)) errors.push(`${w}.provenance.guideAssetIds: must be an object.`);
    else for (const [k, id] of Object.entries(p.guideAssetIds)) GUIDES.includes(k) ? asset(id, `${w}.provenance.guideAssetIds.${k}`) : errors.push(`${w}.provenance.guideAssetIds: unknown guide "${k}".`);
    errors.push(...validatePose(p.pose, `${w}.provenance.pose`), ...validateCamera(p.camera, `${w}.provenance.camera`), ...validateProportions(p.proportions, `${w}.provenance.proportions`));
    if (p.shape !== undefined) errors.push(...validateShape(p.shape, `${w}.provenance.shape`));
    if (!(p.poseId === null || isStr(p.poseId)) || !(p.poseName === null || isStr(p.poseName)) || !(p.parentId === null || isStr(p.parentId))) errors.push(`${w}.provenance: poseId/poseName/parentId invalid.`);
  });
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function validateProjected(v: unknown, assetIds: Set<string>, where: string): string[] {
  if (v === null) return [];
  if (!isRec(v)) return [`${where}: must be an object or null.`];
  const errors: string[] = [];
  if (!isStr(v.assetId) || !assetIds.has(v.assetId)) errors.push(`${where}.assetId: unknown asset.`);
  if (!Number.isInteger(v.width) || !Number.isInteger(v.height) || (v.width as number) < 1 || (v.height as number) < 1 || (v.width as number) > 16384 || (v.height as number) > 16384) errors.push(`${where}: width/height must be whole numbers from 1 to 16384.`);
  const f = v.fit;
  if (!isRec(f) || !isNum(f.ppm) || f.ppm <= 0 || f.ppm > 1e7 || !isNum(f.ox) || !isNum(f.oy) || Math.abs(f.ox) > 1e8 || Math.abs(f.oy) > 1e8) errors.push(`${where}.fit: ppm must be a positive number and ox/oy numbers.`);
  return errors;
}

function validateArtwork(a: unknown, assetIds: Set<string>, where: string): string[] {
  if (!isRec(a)) return [`${where}: must be an object.`];
  const errors = [...validateProjected(a.front, assetIds, `${where}.front`), ...validateProjected(a.back, assetIds, `${where}.back`)];
  if (a.bakedPose !== null) errors.push(...validatePose(a.bakedPose, `${where}.bakedPose`));
  if ((a.front !== null || a.back !== null) && a.bakedPose === null) errors.push(`${where}.bakedPose: required when artwork is projected.`);
  if (!isBool(a.show)) errors.push(`${where}.show: must be true or false.`);
  if (!isStr(a.fill) || !HEX.test(a.fill)) errors.push(`${where}.fill: must be a #rrggbb colour.`);
  if (!isNum(a.shading) || a.shading < 0 || a.shading > 1) errors.push(`${where}.shading: must be a number from 0 to 1.`);
  const o = a.overlay;
  if (!isRec(o) || !isBool(o.show) || !isNum(o.opacity) || o.opacity < 0 || o.opacity > 1) errors.push(`${where}.overlay: show must be true/false and opacity a number from 0 to 1.`);
  return errors;
}

// ---------------------------------------------------------------- page (schema v4)

const PANEL_SHAPES = ['rect', 'skewed', 'free'];
const BUBBLE_KINDS = ['speech', 'thought', 'caption', 'shout'];
const PLACEMENT_KINDS = ['result', 'canvas', 'imported'];

function validatePage(v: unknown, assetIds: Set<string>, errors: string[]): void {
  // Additive field: a project saved before v4 has no page, and that is valid (the migration adds one on load).
  if (v === undefined) return;
  if (!isRec(v)) return void errors.push('page: must be an object.');

  const size = v.size;
  if (!isRec(size) || !isNum(size.width) || !isNum(size.height)) errors.push('page.size: width/height must be numbers.');
  else if (size.width < PAGE_LIMITS.minSideMm || size.height < PAGE_LIMITS.minSideMm || size.width > PAGE_LIMITS.maxSideMm || size.height > PAGE_LIMITS.maxSideMm)
    errors.push(`page.size: each side must be between ${PAGE_LIMITS.minSideMm} and ${PAGE_LIMITS.maxSideMm} mm.`);

  if (!isNum(v.dpi) || !Number.isInteger(v.dpi) || v.dpi < PAGE_LIMITS.minDpi || v.dpi > PAGE_LIMITS.maxDpi) errors.push(`page.dpi: must be a whole number from ${PAGE_LIMITS.minDpi} to ${PAGE_LIMITS.maxDpi}.`);
  if (!isNum(v.bleed) || v.bleed < 0 || v.bleed > 20) errors.push('page.bleed: must be a number from 0 to 20 mm.');
  if (!isNum(v.gutter) || v.gutter < 0 || v.gutter > 40) errors.push('page.gutter: must be a number from 0 to 40 mm.');
  if (!isNum(v.borderWidth) || v.borderWidth < 0 || v.borderWidth > 10) errors.push('page.borderWidth: must be a number from 0 to 10 mm.');
  if (!isStr(v.background) || !HEX.test(v.background)) errors.push('page.background: must be a #rrggbb colour.');
  if (!isStr(v.borderColor) || !HEX.test(v.borderColor)) errors.push('page.borderColor: must be a #rrggbb colour.');

  const panelIds = new Set<string>();
  const panels = Array.isArray(v.panels) ? v.panels : (errors.push('page.panels: must be an array.'), []);
  if (panels.length > PAGE_LIMITS.panels) errors.push(`page.panels: more than ${PAGE_LIMITS.panels}.`);
  panels.forEach((p: unknown, i: number) => {
    const w = `page.panels[${i}]`;
    if (!isRec(p) || !isId(p.id)) return void errors.push(`${w}: invalid id.`);
    if (panelIds.has(p.id)) errors.push(`${w}: duplicate id.`);
    panelIds.add(p.id);
    if (!isStr(p.name)) errors.push(`${w}.name: must be a string.`);
    if (!isStr(p.shape) || !PANEL_SHAPES.includes(p.shape)) errors.push(`${w}.shape: must be rect, skewed or free.`);
    if (!Array.isArray(p.points) || p.points.length < 3) errors.push(`${w}.points: must be at least 3 points.`);
    else if (p.points.length > 64) errors.push(`${w}.points: more than 64 points.`);
    else p.points.forEach((pt: unknown, j: number) => vec(pt) || errors.push(`${w}.points[${j}]: must be {x, y}.`));
  });

  const placementIds = new Set<string>();
  const placements = Array.isArray(v.placements) ? v.placements : (errors.push('page.placements: must be an array.'), []);
  if (placements.length > PAGE_LIMITS.placements) errors.push(`page.placements: more than ${PAGE_LIMITS.placements}.`);
  placements.forEach((p: unknown, i: number) => {
    const w = `page.placements[${i}]`;
    if (!isRec(p) || !isId(p.id)) return void errors.push(`${w}: invalid id.`);
    if (placementIds.has(p.id)) errors.push(`${w}: duplicate id.`);
    placementIds.add(p.id);
    if (p.panelId !== null && !(isStr(p.panelId) && panelIds.has(p.panelId))) errors.push(`${w}.panelId: must be null or an existing panel.`);
    if (!isStr(p.assetId) || !assetIds.has(p.assetId)) errors.push(`${w}.assetId: unknown asset.`);
    if (!isNum(p.width) || !isNum(p.height) || p.width < 1 || p.height < 1) errors.push(`${w}: width/height must be positive.`);
    if (!isNum(p.x) || !isNum(p.y)) errors.push(`${w}: x/y must be numbers.`);
    if (!isNum(p.scale) || p.scale <= 0) errors.push(`${w}.scale: must be a positive number.`);
    if (!isNum(p.rotation)) errors.push(`${w}.rotation: must be a number.`);
    if (!isBool(p.flipX)) errors.push(`${w}.flipX: must be true or false.`);
    if (!isNum(p.opacity) || p.opacity < 0 || p.opacity > 1) errors.push(`${w}.opacity: must be between 0 and 1.`);
    if (p.source !== null) {
      const s = p.source;
      if (!isRec(s)) errors.push(`${w}.source: must be an object or null.`);
      else {
        if (!isStr(s.kind) || !PLACEMENT_KINDS.includes(s.kind)) errors.push(`${w}.source.kind: must be result, canvas or imported.`);
        if (!(s.generationId === null || isStr(s.generationId))) errors.push(`${w}.source.generationId: must be a string or null.`);
        if (!(s.poseId === null || isStr(s.poseId))) errors.push(`${w}.source.poseId: must be a string or null.`);
        if (!(s.poseName === null || isStr(s.poseName))) errors.push(`${w}.source.poseName: must be a string or null.`);
        if (!isNum(s.capturedAt)) errors.push(`${w}.source.capturedAt: must be a number.`);
        if (s.pose !== null) errors.push(...validatePose(s.pose, `${w}.source.pose`));
        if (s.camera !== null) errors.push(...validateCamera(s.camera, `${w}.source.camera`));
      }
    }
  });

  const bubbleIds = new Set<string>();
  const bubbles = Array.isArray(v.bubbles) ? v.bubbles : (errors.push('page.bubbles: must be an array.'), []);
  if (bubbles.length > PAGE_LIMITS.bubbles) errors.push(`page.bubbles: more than ${PAGE_LIMITS.bubbles}.`);
  bubbles.forEach((b: unknown, i: number) => {
    const w = `page.bubbles[${i}]`;
    if (!isRec(b) || !isId(b.id)) return void errors.push(`${w}: invalid id.`);
    if (bubbleIds.has(b.id)) errors.push(`${w}: duplicate id.`);
    bubbleIds.add(b.id);
    if (!isStr(b.kind) || !BUBBLE_KINDS.includes(b.kind)) errors.push(`${w}.kind: must be speech, thought, caption or shout.`);
    if (!isStr(b.text) || b.text.length > PAGE_LIMITS.text) errors.push(`${w}.text: must be a string of at most ${PAGE_LIMITS.text} characters.`);
    if (!isNum(b.x) || !isNum(b.y)) errors.push(`${w}: x/y must be numbers.`);
    if (!isNum(b.width) || !isNum(b.height) || b.width < 8 || b.height < 8) errors.push(`${w}: width/height must be at least 8.`);
    if (!(b.tail === null || isNum(b.tail))) errors.push(`${w}.tail: must be a number or null.`);
    if (!isNum(b.fontSize) || b.fontSize < 4) errors.push(`${w}.fontSize: must be at least 4.`);
  });
}
