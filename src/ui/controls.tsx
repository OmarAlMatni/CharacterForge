import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

/** Numeric input that edits freely and commits on Enter/blur. Invalid text reverts. */
export function NumberField(props: { value: number; onCommit: (v: number) => void; step?: number; min?: number; max?: number; width?: number; label?: string; suffix?: string; digits?: number }) {
  const digits = props.digits ?? 2;
  const fmt = (v: number) => String(Number(v.toFixed(digits)));
  const [text, setText] = useState(fmt(props.value));
  useEffect(() => setText(fmt(props.value)), [props.value, digits]);
  const commit = () => {
    const v = Number(text);
    if (text.trim() === '' || !Number.isFinite(v)) return setText(fmt(props.value));
    const clamped = Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, v));
    if (clamped !== props.value) props.onCommit(clamped);
    else setText(fmt(props.value));
  };
  return (
    <label className="num">
      {props.label && <span>{props.label}</span>}
      <input
        type="text"
        inputMode="decimal"
        value={text}
        style={props.width ? { width: props.width } : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setText(fmt(props.value));
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const v = Number(text) + (e.key === 'ArrowUp' ? 1 : -1) * (props.step ?? 1) * (e.shiftKey ? 10 : 1);
            if (Number.isFinite(v)) props.onCommit(Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, v)));
          }
        }}
      />
      {props.suffix && <em>{props.suffix}</em>}
    </label>
  );
}

export function TextField(props: { value: string; onCommit: (v: string) => void; placeholder?: string; className?: string; onDone?: () => void; autoFocus?: boolean }) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  return (
    <input
      className={props.className}
      type="text"
      value={text}
      placeholder={props.placeholder}
      onChange={(e) => setText(e.target.value)}
      autoFocus={props.autoFocus}
      onBlur={() => {
        if (text.trim() && text !== props.value) props.onCommit(text.trim());
        props.onDone?.();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(props.value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

export function Section(props: { title: string; children?: ReactNode; hint?: string }) {
  return (
    <section className="sec">
      <h3>{props.title}</h3>
      {props.hint && <p className="hint">{props.hint}</p>}
      {props.children}
    </section>
  );
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [props.onClose]);
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal${props.wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.title}>
        <header>
          <h2>{props.title}</h2>
          <button className="ghost" onClick={props.onClose} aria-label="Close">
            Close
          </button>
        </header>
        <div className="body">{props.children}</div>
        {props.footer && <footer>{props.footer}</footer>}
      </div>
    </div>
  );
}

export function download(blob: Blob | Uint8Array, fileName: string, mime = 'application/octet-stream'): void {
  const b = blob instanceof Blob ? blob : new Blob([blob as BlobPart], { type: mime });
  const url = URL.createObjectURL(b);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
