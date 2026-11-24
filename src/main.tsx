import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { store } from './app/store.ts';
import './styles.css';

// The e2e harness drives the real UI; this hook lets it also read and set state that has no direct control
// (bubble positions, panel geometry) without adding test-only buttons to the product.
if (new URLSearchParams(location.search).has('e2e')) (window as unknown as Record<string, unknown>).__cfStore = store;

createRoot(document.getElementById('root')!).render(<App />);
