/**
 * Privacy guard: artwork may only be sent to a segmentation server on this machine unless the
 * person explicitly approves a remote URL.
 */
export function isLoopbackUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
  } catch {
    return false;
  }
}

export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}
