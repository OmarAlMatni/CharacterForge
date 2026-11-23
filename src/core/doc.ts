import { len, sub } from './math.ts';
import type { Vec2 } from './math.ts';
import { sanitizePose, restFrames, REST } from './rig.ts';
import type { DocState, ID, Joint, NamedPose, PoseState } from './types.ts';

const clonePose = (p: PoseState): PoseState => ({ rotations: { ...p.rotations }, rootOffset: { ...p.rootOffset } });

export function descendantJointIds(joints: Joint[], id: ID): ID[] {
  const out: ID[] = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const j of joints) if (j.parentId === cur && !out.includes(j.id)) (out.push(j.id), stack.push(j.id));
  }
  return out;
}

/** Add a joint at a canvas position (in the rest pose). Its parent may be null (root). */
export function addJointAt(doc: DocState, id: ID, name: string, parentId: ID | null, worldPos: Vec2): DocState {
  if (parentId && !doc.joints.some((j) => j.id === parentId)) throw new Error('Parent joint not found.');
  const rest = restFrames(doc.joints);
  const base = parentId ? rest.get(parentId)!.pos : { x: 0, y: 0 };
  const joint: Joint = { id, name, parentId, offset: sub(worldPos, base), limits: null, bend: 0 };
  return { ...doc, joints: [...doc.joints, joint] };
}

/** Move a joint's rest position. Children keep their world position unless `subtree` is true. */
export function moveJointRest(doc: DocState, id: ID, worldPos: Vec2, subtree = false): DocState {
  const j = doc.joints.find((x) => x.id === id);
  if (!j) return doc;
  const rest = restFrames(doc.joints);
  const base = j.parentId ? (rest.get(j.parentId)?.pos ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
  const newOffset = sub(worldPos, base);
  const delta = sub(newOffset, j.offset);
  return {
    ...doc,
    joints: doc.joints.map((x) => {
      if (x.id === id) return { ...x, offset: newOffset };
      if (!subtree && x.parentId === id) return { ...x, offset: sub(x.offset, delta) };
      return x;
    }),
  };
}

/** Re-parent a joint, keeping every joint at its rest world position. */
export function setJointParent(doc: DocState, id: ID, parentId: ID | null): DocState {
  const j = doc.joints.find((x) => x.id === id);
  if (!j) return doc;
  if (parentId === id || (parentId && descendantJointIds(doc.joints, id).includes(parentId))) {
    throw new Error('A joint cannot be parented to itself or one of its descendants.');
  }
  if (parentId && !doc.joints.some((x) => x.id === parentId)) throw new Error('Parent joint not found.');
  const rest = restFrames(doc.joints);
  const base = parentId ? rest.get(parentId)!.pos : { x: 0, y: 0 };
  const offset = sub(rest.get(id)!.pos, base);
  return { ...doc, joints: doc.joints.map((x) => (x.id === id ? { ...x, parentId, offset } : x)) };
}

export function updateJoint(doc: DocState, id: ID, patch: Partial<Pick<Joint, 'name' | 'limits' | 'bend'>>): DocState {
  const joints = doc.joints.map((j) => (j.id === id ? { ...j, ...patch } : j));
  return { ...doc, joints, pose: sanitizePose(joints, doc.pose) };
}

/** Remove a joint. Its children are re-parented to its parent; attached layers follow the parent joint. */
export function removeJoint(doc: DocState, id: ID): DocState {
  const j = doc.joints.find((x) => x.id === id);
  if (!j) return doc;
  const rest = restFrames(doc.joints);
  const base = j.parentId ? (rest.get(j.parentId)?.pos ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
  const joints = doc.joints
    .filter((x) => x.id !== id)
    .map((x) => (x.parentId === id ? { ...x, parentId: j.parentId, offset: sub(rest.get(x.id)!.pos, base) } : x));
  const layers = doc.layers.map((l) => (l.jointId === id ? { ...l, jointId: j.parentId } : l));
  const { [id]: _removed, ...rotations } = doc.pose.rotations;
  void _removed;
  return {
    ...doc,
    joints,
    layers,
    pose: { ...doc.pose, rotations },
    poses: doc.poses.map((p) => {
      const { [id]: _r, ...rot } = p.rotations;
      void _r;
      return { ...p, rotations: rot };
    }),
  };
}

export function attachLayers(doc: DocState, layerIds: ID[], jointId: ID | null): DocState {
  if (jointId && !doc.joints.some((j) => j.id === jointId)) throw new Error('Joint not found.');
  return {
    ...doc,
    layers: doc.layers.map((l) => (layerIds.includes(l.id) && l.kind === 'raster' ? { ...l, jointId } : l)),
  };
}

export const setPose = (doc: DocState, pose: PoseState): DocState => ({ ...doc, pose: sanitizePose(doc.joints, pose) });
export const resetPose = (doc: DocState): DocState => ({ ...doc, pose: clonePose(REST) });

export function saveNamedPose(doc: DocState, id: ID, name: string, now: number): DocState {
  const pose: NamedPose = { ...clonePose(doc.pose), id, name: name.trim() || 'Pose', createdAt: now };
  return { ...doc, poses: [...doc.poses, pose] };
}

/** Overwrite an existing named pose with the current pose. */
export function updateNamedPose(doc: DocState, id: ID): DocState {
  return { ...doc, poses: doc.poses.map((p) => (p.id === id ? { ...p, ...clonePose(doc.pose) } : p)) };
}

export function applyNamedPose(doc: DocState, id: ID): DocState {
  const p = doc.poses.find((x) => x.id === id);
  if (!p) throw new Error('Pose not found.');
  return setPose(doc, p);
}

export const renamePose = (doc: DocState, id: ID, name: string): DocState => ({
  ...doc,
  poses: doc.poses.map((p) => (p.id === id ? { ...p, name } : p)),
});

export const deleteNamedPose = (doc: DocState, id: ID): DocState => ({ ...doc, poses: doc.poses.filter((p) => p.id !== id) });

export function jointBoneLength(doc: DocState, id: ID): number {
  const j = doc.joints.find((x) => x.id === id);
  return j ? len(j.offset) : 0;
}
