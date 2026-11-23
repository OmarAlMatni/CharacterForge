import type { GenerationProvider } from './types.ts';
import { LocalHttpProvider } from './localHttp.ts';

export const MANUAL_IMPORT_ID = 'manual-import';

export interface ProviderInfo {
  id: string;
  name: string;
  description: string;
}

/**
 * Providers the app can offer. Today there is exactly one real adapter (a local HTTP server); there is deliberately no
 * built-in "demo" or "placeholder" provider, because a fake generator would pass off non-generated pictures as AI output.
 */
export function createProvider(id: string | null, localUrl: string, fetchImpl?: ConstructorParameters<typeof LocalHttpProvider>[1]): GenerationProvider | null {
  if (id === 'local-http' || id === null) return new LocalHttpProvider(localUrl, fetchImpl);
  return null;
}

export const PROVIDER_INFOS: ProviderInfo[] = [
  { id: 'local-http', name: 'Local generation server', description: 'A backend on this computer, reached over localhost.' },
];
