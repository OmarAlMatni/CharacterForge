/** Stable, URL/filename-safe IDs. Prefix makes IDs self-describing in JSON. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function newId(prefix: string): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const raw =
    c?.randomUUID?.() ??
    Array.from({ length: 4 }, () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')).join('');
  return `${prefix}_${raw.replace(/-/g, '').slice(0, 16)}`;
}
