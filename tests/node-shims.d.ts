// Minimal typing for the one Node API the tests use (reading the bundled model file); avoids a @types/node dependency.
declare module 'node:fs' {
  export function readFileSync(path: URL | string): Uint8Array;
}
