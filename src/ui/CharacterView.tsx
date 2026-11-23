import { useState } from 'react';
import { REFERENCE_ROLES } from '../core/character.ts';
import type { ReferenceImage, ReferenceRole } from '../core/character.ts';
import { store } from '../app/store.ts';
import { useApp } from '../app/useApp.ts';
import { Section, TextField } from './controls.tsx';

const fmtBytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function ImagePicker(props: { label: string; primary?: boolean; multiple?: boolean; onFiles: (f: File[]) => void; testId?: string }) {
  return (
    <label className={`button${props.primary ? ' primary' : ''}`}>
      {props.label}
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        multiple={props.multiple}
        hidden
        data-testid={props.testId}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) props.onFiles(files);
        }}
      />
    </label>
  );
}

function ReferenceCard({ r }: { r: ReferenceImage }) {
  const url = store.assetUrl(r.assetId);
  return (
    <li className={`ref-card${r.approved ? '' : ' off'}`} data-testid="reference-card">
      <div className="ref-thumb checker">{url && <img src={url} alt={r.label} />}</div>
      <div className="ref-body">
        <TextField value={r.label} onCommit={(v) => store.updateRef(r.id, { label: v })} />
        <select value={r.role} aria-label="Reference type" onChange={(e) => store.updateRef(r.id, { role: e.target.value as ReferenceRole })}>
          {REFERENCE_ROLES.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
        <textarea rows={2} placeholder="Notes (what this shows, what must stay the same)" value={r.notes} onChange={(e) => store.updateRef(r.id, { notes: e.target.value })} />
        <div className="row">
          <label className="check" title="Approved references are sent to the generation backend with every request">
            <input type="checkbox" checked={r.approved} onChange={(e) => store.updateRef(r.id, { approved: e.target.checked })} />
            Use for generation
          </label>
          <span className="spacer" />
          <button className="danger" onClick={() => window.confirm(`Remove reference "${r.label}" from this character?`) && store.removeRef(r.id)}>
            Remove
          </button>
        </div>
      </div>
    </li>
  );
}

export function CharacterView() {
  const { character: c, project } = useApp();
  const [color, setColor] = useState('#e8b4a0');
  if (!c || !project) return null;
  const origUrl = store.assetUrl(c.originalAssetId);
  const origInfo = store.assetInfo(c.originalAssetId);
  const counts = { accepted: 0, candidate: 0, rejected: 0 };
  c.generations.forEach((g) => counts[g.status]++);
  const approvedRefs = c.references.filter((r) => r.approved).length;

  return (
    <div className="page character-page" data-testid="character-view">
      <div className="page-grid">
        <div className="col">
          <Section title="Original artwork" hint="Your full-body drawing of this character. It is stored byte-for-byte and is never overwritten — generated images are saved separately.">
            <div className="orig-box checker" data-testid="original-box">
              {origUrl ? <img src={origUrl} alt="Original artwork" /> : <p className="muted pad">No original artwork yet.</p>}
              {origUrl && <span className="chip original">ORIGINAL</span>}
            </div>
            {origInfo && (
              <p className="hint">
                {origInfo.width}×{origInfo.height}px · {origInfo.mime.replace('image/', '').toUpperCase()} · {fmtBytes(origInfo.bytes)}
              </p>
            )}
            <div className="row wrap">
              <ImagePicker
                label={c.originalAssetId ? 'Replace original…' : 'Import original artwork…'}
                primary={!c.originalAssetId}
                testId="import-original"
                onFiles={(f) => {
                  if (c.originalAssetId && !window.confirm('Replace the original artwork? The current original stays stored in this profile and can still be found in the bundle, but new generations will use the new image.')) return;
                  void store.importOriginal(f[0]!);
                }}
              />
            </div>
            {c.previousOriginals.length > 0 && <p className="hint">{c.previousOriginals.length} earlier original{c.previousOriginals.length === 1 ? '' : 's'} kept in this profile.</p>}
            <p className="hint">PNG, JPEG or WebP. For layered PSD files use the 2D canvas tab.</p>
          </Section>

          <Section title="Next steps">
            <div className="row wrap">
              <button className="primary" disabled={!c.originalAssetId} onClick={() => store.setWorkspace('studio')} title={c.originalAssetId ? '' : 'Import the original artwork first'}>
                Open pose studio →
              </button>
              <button disabled={!c.originalAssetId} onClick={() => store.setWorkspace('generate')}>
                Generate & review →
              </button>
            </div>
            <ul className="plain stats">
              <li>{c.studio.poses.length} saved pose{c.studio.poses.length === 1 ? '' : 's'}</li>
              <li>
                {approvedRefs} of {c.references.length} reference{c.references.length === 1 ? '' : 's'} approved for generation
              </li>
              <li>
                Results: {counts.accepted} accepted · {counts.candidate} awaiting review · {counts.rejected} rejected
              </li>
            </ul>
          </Section>
        </div>

        <div className="col wide-col">
          <Section title="Reference images" hint="Face close-ups, other views, clothing details. Reference images — not the text below — are what keep the character consistent, so approved ones travel with every generation request.">
            <div className="row">
              <ImagePicker label="Add references…" multiple testId="import-references" onFiles={(f) => void store.importReferences(f)} />
            </div>
            {c.references.length === 0 ? <p className="muted">No references yet. They are optional, but a face close-up and a back view help a lot.</p> : (
              <ul className="ref-grid">
                {c.references.map((r) => (
                  <ReferenceCard key={r.id} r={r} />
                ))}
              </ul>
            )}
          </Section>

          <Section title="Appearance notes" hint="Optional descriptive metadata. It is passed to the generation backend as text hints only — it does not guarantee consistency.">
            <div className="palette row wrap">
              {c.appearance.palette.map((p, i) => (
                <button key={p + i} className="swatch" style={{ background: p }} title={`${p} — click to remove`} aria-label={`Remove colour ${p}`} onClick={() => store.setAppearance({ palette: c.appearance.palette.filter((_, j) => j !== i) })} />
              ))}
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Palette colour" />
              <button disabled={c.appearance.palette.length >= 16} onClick={() => store.setAppearance({ palette: [...c.appearance.palette, color] })}>
                Add colour
              </button>
            </div>
            <div className="grid2">
              {(['hair', 'eyes', 'clothing', 'accessories'] as const).map((k) => (
                <label key={k} className="field col-field">
                  <span>{k[0]!.toUpperCase() + k.slice(1)}</span>
                  <input type="text" value={c.appearance[k]} maxLength={4000} onChange={(e) => store.setAppearance({ [k]: e.target.value })} />
                </label>
              ))}
            </div>
            <label className="field col-field">
              <span>Other notes</span>
              <textarea rows={3} value={c.appearance.notes} maxLength={4000} onChange={(e) => store.setAppearance({ notes: e.target.value })} />
            </label>
          </Section>
        </div>
      </div>
    </div>
  );
}
