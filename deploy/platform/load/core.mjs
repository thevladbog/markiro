import assert from "node:assert/strict";
export function localDockerEndpoint(endpoint) {
  assert.ok(
    typeof endpoint === "string" && endpoint.startsWith("unix://"),
    "Local Docker Unix socket required",
  );
  return true;
}
export function summarize(rows) {
  const sorted = rows.map((r) => r.ms).sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
  return {
    count: rows.length,
    failures: rows.filter((r) => !r.ok).length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    statuses: rows.reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {}),
  };
}
export async function runBoundedPhase({ durationMs, users, paceMs = 100, signal, operation }) {
  assert.ok(Number.isInteger(users) && users >= 1 && users <= 10);
  assert.ok(durationMs > 0 && durationMs <= 180000);
  const end = performance.now() + durationMs;
  let failure;
  await Promise.all(
    Array.from({ length: users }, async (_, user) => {
      while (performance.now() < end && !signal?.aborted && !failure) {
        try {
          await operation(user);
        } catch (error) {
          failure ??= error;
        }
        if (paceMs && !failure) await new Promise((r) => setTimeout(r, paceMs));
      }
    }),
  );
  if (failure) throw failure;
}
export function assess({ phases, reportsComplete, oom, restarts }) {
  const errors = [];
  for (const [phase, summary] of Object.entries(phases)) {
    if (!(summary.interactive.count > 0)) errors.push(`${phase}: no completed requests`);
    if (summary.interactive.failures) errors.push(`${phase}: correctness/status errors`);
    if (
      (phase === "steady" && summary.interactive.p95 > 1000) ||
      (phase === "burst" && summary.interactive.p95 > 2000)
    )
      errors.push(`${phase}: latency budget exceeded`);
  }
  if (!reportsComplete) errors.push("reports incomplete");
  if (oom) errors.push("OOM");
  if (restarts) errors.push("container restarts");
  return errors;
}

export function hasOomEvent(oomKilled, events) {
  const counters = new Map();
  for (const line of events.trim().split("\n")) {
    const match = /^(\w+)\s+(\d+)$/.exec(line);
    assert.ok(match, "Malformed cgroup memory event");
    assert.ok(!counters.has(match[1]), "Duplicate cgroup memory event");
    counters.set(match[1], BigInt(match[2]));
  }
  assert.ok(counters.has("oom") && counters.has("oom_kill"), "Missing cgroup OOM counters");
  return (
    Boolean(oomKilled) ||
    ["oom", "oom_kill", "oom_group_kill"].some((key) => (counters.get(key) ?? 0n) > 0n)
  );
}
