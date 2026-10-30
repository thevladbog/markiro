import { afterAll } from "vitest";

// Loaded before test/setup.ts: React's scheduler binds setImmediate when it first loads.
// Keep the deliberate delay, but own both stages so no callback outlives this window.
const real = globalThis.setImmediate;
const clearReal = globalThis.clearImmediate;
const timeout = globalThis.setTimeout;
const clearDelay = globalThis.clearTimeout;
const immediates = new Set<ReturnType<typeof real>>();
const delays = new Set<ReturnType<typeof timeout>>();
let active = true;

globalThis.setImmediate = ((fn: (...args: unknown[]) => void, ...args: unknown[]) => {
  const immediate = real(() => {
    immediates.delete(immediate);
    if (!active) return;
    const delay = timeout(() => {
      delays.delete(delay);
      if (active) fn(...args);
    }, 25);
    delays.add(delay);
  });
  immediates.add(immediate);
  return immediate;
}) as typeof setImmediate;

afterAll(() => {
  active = false;
  for (const immediate of immediates) clearReal(immediate);
  for (const delay of delays) clearDelay(delay);
  immediates.clear();
  delays.clear();
  globalThis.setImmediate = real;
});
