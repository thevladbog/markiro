// Loaded before test/setup.ts: React's scheduler binds setImmediate when it first loads, so a
// late setImmediate has to exist by then.
const real = globalThis.setImmediate;
globalThis.setImmediate = ((fn: (...args: unknown[]) => void, ...args: unknown[]) =>
  real(() => {
    setTimeout(() => fn(...args), 25);
  })) as typeof setImmediate;
