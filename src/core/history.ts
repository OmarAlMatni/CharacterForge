interface Entry<T> {
  state: T;
  label: string;
  key?: string;
}

/**
 * Snapshot-based undo/redo. States are treated as immutable, so snapshots share structure.
 * - commit(): a discrete edit
 * - beginTransient()/preview()/endTransient(): a continuous gesture (drag) that becomes ONE undo step
 */
export class History<T> {
  present: T;
  private past: Entry<T>[] = [];
  private future: Entry<T>[] = [];
  private baseline: T | null = null;
  private lastKey: string | undefined;
  private readonly limit: number;
  constructor(initial: T, limit = 200) {
    this.present = initial;
    this.limit = limit;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  get undoLabel(): string | undefined {
    return this.past[this.past.length - 1]?.label;
  }
  get redoLabel(): string | undefined {
    return this.future[this.future.length - 1]?.label;
  }
  get inTransient(): boolean {
    return this.baseline !== null;
  }

  /** Replace the current state as a single undoable step. `coalesceKey` merges consecutive edits (e.g. typing). */
  commit(next: T, label: string, coalesceKey?: string): void {
    if (next === this.present) return;
    this.endTransient(label);
    const merge = coalesceKey !== undefined && coalesceKey === this.lastKey && this.past.length > 0;
    if (!merge) {
      this.past.push({ state: this.present, label, key: coalesceKey });
      if (this.past.length > this.limit) this.past.shift();
    }
    this.lastKey = coalesceKey;
    this.future = [];
    this.present = next;
  }

  beginTransient(): void {
    if (this.baseline === null) this.baseline = this.present;
  }

  /** Update the visible state without creating history entries (call between begin/endTransient). */
  preview(next: T): void {
    this.present = next;
  }

  endTransient(label: string): void {
    if (this.baseline === null) return;
    const base = this.baseline;
    this.baseline = null;
    if (base !== this.present) {
      this.past.push({ state: base, label });
      if (this.past.length > this.limit) this.past.shift();
      this.future = [];
      this.lastKey = undefined;
    }
  }

  cancelTransient(): void {
    if (this.baseline === null) return;
    this.present = this.baseline;
    this.baseline = null;
  }

  undo(): boolean {
    this.cancelTransient();
    const e = this.past.pop();
    if (!e) return false;
    this.future.push({ state: this.present, label: e.label });
    this.present = e.state;
    this.lastKey = undefined;
    return true;
  }

  redo(): boolean {
    const e = this.future.pop();
    if (!e) return false;
    this.past.push({ state: this.present, label: e.label });
    this.present = e.state;
    this.lastKey = undefined;
    return true;
  }

  reset(initial: T): void {
    this.present = initial;
    this.past = [];
    this.future = [];
    this.baseline = null;
    this.lastKey = undefined;
  }
}
