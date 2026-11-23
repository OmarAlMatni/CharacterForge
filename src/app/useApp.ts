import { useSyncExternalStore } from 'react';
import { store } from './store.ts';
import type { Snapshot } from './store.ts';

export function useApp(): Snapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
