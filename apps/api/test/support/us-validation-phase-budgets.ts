export function assertUsValidationPhaseBudgets(
  totalMs: number,
  performanceWindowsMs: readonly number[],
  performanceCapMs: number,
  correctnessCapMs: number,
) {
  const performanceMs = performanceWindowsMs[0];
  if (
    !Number.isFinite(totalMs) ||
    totalMs < 0 ||
    performanceWindowsMs.length !== 1 ||
    performanceMs === undefined ||
    !Number.isFinite(performanceMs) ||
    performanceMs < 0 ||
    performanceMs > totalMs ||
    !Number.isFinite(performanceCapMs) ||
    performanceCapMs <= 0 ||
    !Number.isFinite(correctnessCapMs) ||
    correctnessCapMs <= 0
  )
    throw new Error("Invalid validation phase measurement or caps");
  const phases = {
    performanceMs,
    correctnessMs: totalMs - performanceMs,
    performanceCapMs,
    correctnessCapMs,
  };
  if (phases.performanceMs > performanceCapMs)
    throw new Error(`performance budget exceeded: ${JSON.stringify(phases)}`);
  if (phases.correctnessMs > correctnessCapMs)
    throw new Error(`correctness budget exceeded: ${JSON.stringify(phases)}`);
  return phases;
}
