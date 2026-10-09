import { bindPrintDestination } from "../print-destinations.js";
import { compareWarehouseReprintLabel, type WarehouseReprintEvent } from "@markiro/domain";
import type { PrintTarget } from "../hardware.js";
import type { SqlExecutor } from "../mirror.js";
import {
  printerTargetKey,
  serializePrinterOutput,
  type PrinterProfile,
} from "../printer-routing.js";
import { appendWarehouseEvent, listWarehouseJobs, readWarehouseJob } from "./store.js";
import type { WarehouseJob } from "./types.js";
export interface WarehousePrintingDeps {
  exec: SqlExecutor;
  owner: string;
  operatorId: string;
  profile: PrinterProfile | null;
  print(target: PrintTarget, bytes: Uint8Array): Promise<void>;
  isCurrent(): boolean;
}
function base(job: WarehouseJob, operatorId: string) {
  return {
    eventId: crypto.randomUUID(),
    jobId: job.jobId,
    sessionId: job.sessionId,
    attemptId: job.projection.attemptId,
    operatorId,
    sequence: job.projection.latestSequence + 1,
    occurredAt: new Date().toISOString(),
  };
}
export async function printWarehouseJob(deps: WarehousePrintingDeps, jobId: string): Promise<void> {
  const profile = deps.profile;
  const before = await readWarehouseJob(deps.exec, deps.owner, jobId);
  if (before.projection.state !== "prepared") return;
  if (!deps.isCurrent()) throw new Error("WAREHOUSE_OWNER_CHANGED");
  if (
    !profile ||
    profile.language !== before.printer.language ||
    profile.dpi !== before.printer.dpi ||
    printerTargetKey(profile.target) !== printerTargetKey(before.printer.target)
  ) {
    await appendWarehouseEvent(deps.exec, deps.owner, {
      ...base(before, deps.operatorId),
      kind: "failed_before_send",
      errorCode: profile ? "printer_changed" : "printer_unconfigured",
    });
    return;
  }
  await serializePrinterOutput(profile.target, async () => {
    if (!deps.isCurrent()) throw new Error("WAREHOUSE_OWNER_CHANGED");
    const job = await readWarehouseJob(deps.exec, deps.owner, jobId);
    if (job.projection.state !== "prepared") return;
    await bindPrintDestination(
      deps.exec,
      {
        scope: job.owner,
        purpose: job.source.kind === "box" ? "box" : "duplicate",
        jobId,
        attemptId: job.projection.attemptId,
      },
      profile,
    );
    await appendWarehouseEvent(deps.exec, deps.owner, {
      ...base(job, deps.operatorId),
      kind: "sending",
    });
    const sending = await readWarehouseJob(deps.exec, deps.owner, jobId);
    let outcome: Extract<WarehouseReprintEvent, { kind: "sent" | "delivery_unknown" }>;
    try {
      if (!deps.isCurrent()) throw new Error("owner changed");
      await deps.print(
        profile.target,
        Uint8Array.from(atob(job.bytesBase64), (c) => c.charCodeAt(0)),
      );
      outcome = { ...base(sending, deps.operatorId), kind: "sent" };
    } catch {
      outcome = {
        ...base(sending, deps.operatorId),
        kind: "delivery_unknown",
        errorCode: "transport_failed",
      };
    }
    // Result belongs to the original owner even if intake closed while transport ran.
    await appendWarehouseEvent(deps.exec, deps.owner, outcome);
  });
}
export async function recoverWarehouseJobs(
  exec: SqlExecutor,
  owner: string,
  operatorId: string,
): Promise<void> {
  for (const job of await listWarehouseJobs(exec, owner))
    if (job.projection.state === "sending")
      await appendWarehouseEvent(exec, owner, {
        ...base(job, operatorId),
        kind: "delivery_unknown",
        errorCode: "interrupted",
      });
}
export async function verifyWarehouseJob(
  exec: SqlExecutor,
  owner: string,
  jobId: string,
  operatorId: string,
  raw: string,
): Promise<boolean> {
  const job = await readWarehouseJob(exec, owner, jobId);
  const expected =
    job.source.kind === "box"
      ? { kind: "box" as const, sscc: job.source.identity }
      : { kind: "unit" as const, canonicalRaw: job.source.fields["km.code"] };
  if (compareWarehouseReprintLabel(expected, raw) !== "match") return false;
  await appendWarehouseEvent(exec, owner, { ...base(job, operatorId), kind: "verified" });
  return true;
}
export async function reprintWarehouseJob(
  deps: WarehousePrintingDeps,
  jobId: string,
  reason: "not_printed" | "damaged" | "lost",
): Promise<void> {
  if (!deps.isCurrent()) throw new Error("WAREHOUSE_OWNER_CHANGED");
  const job = await readWarehouseJob(deps.exec, deps.owner, jobId);
  if (
    !deps.profile ||
    deps.profile.language !== job.printer.language ||
    deps.profile.dpi !== job.printer.dpi
  )
    throw new Error("WAREHOUSE_PRINTER_CHANGED");
  const attemptId = crypto.randomUUID();
  await bindPrintDestination(
    deps.exec,
    {
      scope: job.owner,
      purpose: job.source.kind === "box" ? "box" : "duplicate",
      jobId,
      attemptId,
    },
    deps.profile,
  );
  await appendWarehouseEvent(deps.exec, deps.owner, {
    ...base(job, deps.operatorId),
    kind: "reprint_prepared",
    attemptId,
    attemptNo: job.projection.attemptNo + 1,
    reason,
  });
  await printWarehouseJob(deps, jobId);
}
