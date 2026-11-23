import { useState } from 'react';
import type { ReactNode } from 'react';
import { descendantJointIds } from '../core/doc.ts';
import { ikChainFor } from '../core/ik.ts';
import { isRestPose } from '../core/types.ts';
import type { DocState, ID, Joint } from '../core/types.ts';
import { store } from '../app/store.ts';
import { useApp } from '../app/useApp.ts';
import { NumberField, Section, TextField } from './controls.tsx';

function JointTree(props: { doc: DocState; selected: ID | null }) {
  const rows: ReactNode[] = [];
  const walk = (parentId: ID | null, depth: number) => {
    for (const j of props.doc.joints.filter((x) => x.parentId === parentId)) {
      rows.push(
        <li key={j.id} className={`joint-row${props.selected === j.id ? ' sel' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => store.selectJoint(j.id)}>
          <span className="dot" />
          <span className="lname">{j.name}</span>
          {props.doc.layers.some((l) => l.jointId === j.id) && <span className="tag blue">{props.doc.layers.filter((l) => l.jointId === j.id).length} layer(s)</span>}
        </li>,
      );
      walk(j.id, depth + 1);
    }
  };
  walk(null, 0);
  return <ul className="joints">{rows}</ul>;
}

function JointProps({ doc, joint }: { doc: DocState; joint: Joint }) {
  const { ui } = useApp();
  const blocked = new Set([joint.id, ...descendantJointIds(doc.joints, joint.id)]);
  const attached = doc.layers.filter((l) => l.jointId === joint.id);
  const lim = joint.limits;
  return (
    <Section title="Selected joint">
      <TextField className="wide" value={joint.name} onCommit={(v) => store.updateJointProps(joint.id, { name: v })} />
      <label className="field">
        <span>Parent</span>
        <select value={joint.parentId ?? ''} onChange={(e) => store.reparentJoint(joint.id, e.target.value || null)}>
          <option value="">(root)</option>
          {doc.joints.filter((j) => !blocked.has(j.id)).map((j) => (
            <option key={j.id} value={j.id}>
              {j.name}
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={!!lim} onChange={(e) => store.updateJointProps(joint.id, { limits: e.target.checked ? { min: -90, max: 90 } : null })} />
        Limit rotation
      </label>
      {lim && (
        <div className="row">
          <NumberField label="Min" value={lim.min} max={lim.max} onCommit={(v) => store.updateJointProps(joint.id, { limits: { min: v, max: lim.max } })} suffix="°" />
          <NumberField label="Max" value={lim.max} min={lim.min} onCommit={(v) => store.updateJointProps(joint.id, { limits: { min: lim.min, max: v } })} suffix="°" />
        </div>
      )}
      <label className="field" title="Which way an arm/leg bends when this joint is the elbow or knee of an IK chain">
        <span>Bend</span>
        <select value={joint.bend} onChange={(e) => store.updateJointProps(joint.id, { bend: Number(e.target.value) as -1 | 0 | 1 })}>
          <option value={0}>Keep current side</option>
          <option value={1}>Side A</option>
          <option value={-1}>Side B</option>
        </select>
      </label>
      <p className="hint">If an elbow or knee bends the wrong way, switch between Side A and Side B.</p>
      <div className="row">
        <button disabled={ui.selectedLayerIds.length === 0} onClick={() => store.attachSelectedLayers(joint.id)} title="Layers follow this joint when posing">
          Attach selected layer
        </button>
        <button disabled={ui.selectedLayerIds.length === 0} onClick={() => store.attachSelectedLayers(null)}>
          Detach
        </button>
      </div>
      {attached.length > 0 && <p className="hint">Moves: {attached.map((l) => l.name).join(', ')}</p>}
      <button className="danger" onClick={() => store.deleteJoint(joint.id)}>
        Delete joint
      </button>
    </Section>
  );
}

export function RigInspector() {
  const { doc, ui } = useApp();
  if (!doc) return <p className="muted pad">Open a project to begin.</p>;
  const joint = doc.joints.find((j) => j.id === ui.selectedJointId);
  return (
    <>
      <Section title="Skeleton" hint="Rig mode shows the rest pose. Add joints along the limbs, parent first, then attach layers to the joints they should move with.">
        <div className="row">
          <button className={ui.rigTool === 'add' ? 'primary' : ''} onClick={() => store.setRigTool(ui.rigTool === 'add' ? 'select' : 'add')} title="J">
            {ui.rigTool === 'add' ? 'Click canvas to add…' : 'Add joint'}
          </button>
          <button disabled={doc.joints.length > 0} onClick={() => store.applyHumanoidTemplate()} title="Starting point you then adjust by hand">
            Humanoid template
          </button>
        </div>
        {ui.rigTool === 'add' && <p className="hint">New joints attach to the selected joint. Alt+click starts a new root.</p>}
        {doc.joints.length === 0 ? (
          <p className="muted">No joints yet.</p>
        ) : (
          <>
            <JointTree doc={doc} selected={ui.selectedJointId} />
            <button className="danger" onClick={() => window.confirm('Remove all joints, attachments and saved poses? You can undo this.') && store.clearSkeleton()}>
              Clear skeleton
            </button>
          </>
        )}
      </Section>
      {joint && <JointProps doc={doc} joint={joint} />}
      <p className="hint pad">Drag a joint to move it (children stay put; hold Shift to carry them). Arms and legs deform rigidly — layers are not bent, so overlap seams may show.</p>
    </>
  );
}

export function PoseInspector() {
  const { doc, ui } = useApp();
  const [name, setName] = useState('');
  if (!doc) return <p className="muted pad">Open a project to begin.</p>;
  const joint = doc.joints.find((j) => j.id === ui.selectedJointId);
  const chain = joint ? ikChainFor(doc.joints, joint.id) : null;
  const rot = joint ? (doc.pose.rotations[joint.id] ?? 0) : 0;
  const rest = isRestPose(doc.pose);
  const save = () => {
    store.savePose(name || `Pose ${doc.poses.length + 1}`);
    setName('');
  };
  return (
    <>
      <Section title="Pose" hint="Drag a joint on the canvas. Dragging a wrist or ankle uses two-bone IK; Alt flips between IK and FK.">
        <label className="check">
          <input type="checkbox" checked={ui.ik} onChange={(e) => store.setIk(e.target.checked)} />
          Inverse kinematics (hands &amp; feet)
        </label>
        {joint && ui.ik && chain && <p className="hint">IK chain: {[chain.rootId, chain.midId, chain.endId].map((id) => doc.joints.find((j) => j.id === id)?.name).join(' → ')}</p>}
        {joint ? (
          <label className="field">
            <span>{joint.name}</span>
            <input type="range" min={joint.limits?.min ?? -180} max={joint.limits?.max ?? 180} step={0.5} value={rot} onChange={(e) => store.setJointRotation(joint.id, Number(e.target.value))} />
            <NumberField value={rot} onCommit={(v) => store.setJointRotation(joint.id, v)} suffix="°" width={52} />
          </label>
        ) : (
          <p className="muted">Select a joint to set its rotation numerically.</p>
        )}
        <div className="row">
          <NumberField label="Move X" value={doc.pose.rootOffset.x} onCommit={(v) => store.setRootOffset({ ...doc.pose.rootOffset, x: v })} />
          <NumberField label="Y" value={doc.pose.rootOffset.y} onCommit={(v) => store.setRootOffset({ ...doc.pose.rootOffset, y: v })} />
        </div>
        <button disabled={rest} onClick={() => store.resetCurrentPose()}>
          Reset to rest pose
        </button>
      </Section>
      <Section title="Saved poses">
        {doc.poses.length === 0 && <p className="muted">No saved poses yet.</p>}
        <ul className="poses">
          {doc.poses.map((p) => (
            <li key={p.id}>
              <TextField value={p.name} onCommit={(v) => store.renameSavedPose(p.id, v)} />
              <div className="row">
                <button onClick={() => store.applyPose(p.id)}>Apply</button>
                <button onClick={() => store.overwritePose(p.id)} title="Replace this saved pose with the current pose">
                  Update
                </button>
                <button className="danger" onClick={() => store.deleteSavedPose(p.id)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
        <div className="row">
          <input type="text" placeholder="Pose name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
          <button className="primary" onClick={save}>
            Save current
          </button>
        </div>
      </Section>
    </>
  );
}
