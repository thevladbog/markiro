export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 0 before `from`, 1 after `to`, linear in between. */
export function ramp(value: number, from: number, to: number): number {
  return clamp01((value - from) / (to - from));
}
