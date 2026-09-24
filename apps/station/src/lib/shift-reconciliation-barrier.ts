import type { SyncEngine } from "./sync.js";

type AuditEngine = Pick<SyncEngine, "requestFullShiftAudit" | "reconcileNow">;
type AuditSummary = { pending: number; issues: number };

/** The audit intent must be durable before navigation; the whole wait has one deadline. */
export async function runShiftReconciliationBarrier(
  shiftId: string,
  engine: AuditEngine,
  readSummary: () => Promise<AuditSummary>,
  deadlineMs = 10_000,
): Promise<{ complete: boolean; hardIssues: number }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("timed-out");
  try {
    const deadline = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), deadlineMs);
    });
    const persisted = await Promise.race([
      engine.requestFullShiftAudit(shiftId).then(() => true),
      deadline,
    ]);
    if (persisted === timedOut) throw new Error("Box reconciliation audit intent timed out");
    const result = await Promise.race([
      engine
        .reconcileNow()
        .then(readSummary)
        .then((summary) => ({
          complete: summary.pending === 0 && summary.issues === 0,
          hardIssues: summary.issues,
        }))
        .catch(() => ({ complete: false, hardIssues: 0 })),
      deadline,
    ]);
    return result === timedOut ? { complete: false, hardIssues: 0 } : result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
