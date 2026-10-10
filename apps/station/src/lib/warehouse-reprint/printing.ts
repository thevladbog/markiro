import { renderWarehouseLabel } from "./prepare.js";
import { rasterizeDriverText, rasterizeText } from "../rasterizer.js";
import type { RasterizeTextFn } from "@markiro/domain";
import {
  dispatchWindowsDelivery,
  resolvePrintDelivery,
  PrintDeliveryBeforeSendError,
} from "../print-deliveries.js";
import { bindPrintDestination } from "../print-destinations.js";
import { compareWarehouseReprintLabel, type WarehouseReprintEvent } from "@markiro/domain";
import type { PrintTarget } from "../hardware.js";
import type { SqlExecutor } from "../mirror.js";
import {
  printerFormat,
  printerTargetKey,
  serializePrinterOutput,
  type PrinterProfile,
} from "../printer-routing.js";
import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
import { appendWarehouseEvent, readWarehouseJob } from "./store.js";
import type { WarehouseJob } from "./types.js";
// A remount is not a process restart. Keep live sends discoverable until their
// original owner's result is durable, independently of controller lifetime.
const livePrints = new Map<string, Set<Promise<void>>>();
function livePrintKey(job: WarehouseJob): string {
  return JSON.stringify([job.owner, job.deviceId, job.jobId]);
}
async function trackLivePrint(job: WarehouseJob, send: () => Promise<void>): Promise<void> {
  const key = livePrintKey(job);
  let complete: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const active = livePrints.get(key) ?? new Set<Promise<void>>();
  active.add(settled);
  livePrints.set(key, active);
  try {
    await send();
  } finally {
    active.delete(settled);
    if (active.size === 0) livePrints.delete(key);
    complete();
  }
}
export interface WarehousePrintingDeps {
  exec: SqlExecutor;
  owner: string;
  operatorId: string;
  profile: PrinterProfile | null;
  print(target: PrintTarget, bytes: Uint8Array): Promise<void>;
  isCurrent(): boolean;
  rasterizeText?: RasterizeTextFn;
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
    printerFormat(profile) !== printerFormat(before.printer) ||
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
  await trackLivePrint(before, () =>
    serializePrinterOutput(profile.target, async () => {
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
      const bytes = Uint8Array.from(atob(job.bytesBase64), (c) => c.charCodeAt(0));
      let outcome: Extract<
        WarehouseReprintEvent,
        { kind: "sent" | "delivery_unknown" | "failed_before_send" }
      >;
      if (!deps.isCurrent()) {
        await appendWarehouseEvent(deps.exec, deps.owner, {
          ...base(sending, deps.operatorId),
          kind: "failed_before_send",
          errorCode: "owner_changed",
        });
        return;
      }
      // No async boundary between the final ownership check and hardware dispatch.
      try {
        if (printerFormat(profile) === "mono-raster-v1")
          await dispatchWindowsDelivery(
            deps.exec,
            {
              scope: job.owner,
              purpose: job.source.kind === "box" ? "box" : "duplicate",
              jobId,
              attemptId: job.projection.attemptId,
            },
            profile,
            bytes,
            undefined,
            () => deps.isCurrent(),
          );
        else await deps.print(profile.target, bytes);
        outcome = { ...base(sending, deps.operatorId), kind: "sent" };
      } catch (error) {
        const beforeSend = error instanceof PrintDeliveryBeforeSendError;
        outcome = {
          ...base(sending, deps.operatorId),
          ...(beforeSend
            ? ({
                kind: "failed_before_send",
                errorCode: error.message === "owner_changed" ? "owner_changed" : "driver_rejected",
              } as const)
            : ({ kind: "delivery_unknown", errorCode: "transport_failed" } as const)),
        };
      }
      // Result belongs to the original owner even if intake closed while transport ran.
      await appendWarehouseEvent(deps.exec, deps.owner, outcome);
    }),
  );
}
export async function recoverWarehouseJobs(
  exec: SqlExecutor,
  owner: string,
  operatorId: string,
): Promise<void> {
  const rows = await exec.all<{ job_id: string }>(
    `SELECT job_id FROM warehouse_reprint_jobs WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND state='sending'`,
    [owner],
  );
  for (const row of rows) {
    const candidate = await readWarehouseJob(exec, owner, row.job_id);
    if (candidate.projection.state !== "sending") continue;
    const active = livePrints.get(livePrintKey(candidate));
    if (active) await Promise.all([...active]);
    const job = await readWarehouseJob(exec, owner, candidate.jobId);
    if (job.projection.state === "sending")
      await appendWarehouseEvent(exec, owner, {
        ...base(job, operatorId),
        kind: "delivery_unknown",
        errorCode: "interrupted",
      });
  }
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
  await resolvePrintDelivery(exec, {
    scope: job.owner,
    purpose: job.source.kind === "box" ? "box" : "duplicate",
    jobId,
    attemptId: job.projection.attemptId,
  });
  return true;
}
export async function reprintWarehouseJob(
  deps: WarehousePrintingDeps,
  jobId: string,
  reason: "not_printed" | "damaged" | "lost",
): Promise<void> {
  if (!deps.isCurrent()) throw new Error("WAREHOUSE_OWNER_CHANGED");
  const job = await readWarehouseJob(deps.exec, deps.owner, jobId);
  const profile = deps.profile;
  const rerender =
    job.projection.state === "failed_before_send" &&
    profile &&
    profile.dpi !== null &&
    (printerFormat(profile) !== printerFormat(job.printer) || profile.dpi !== job.printer.dpi);
  if (
    !profile ||
    (!rerender &&
      (printerFormat(profile) !== printerFormat(job.printer) || profile.dpi !== job.printer.dpi))
  )
    throw new Error("WAREHOUSE_PRINTER_CHANGED");
  const replacement =
    rerender && profile.dpi
      ? {
          ...(await renderWarehouseLabel(
            job.source,
            job.template,
            profile,
            deps.rasterizeText ??
              (printerFormat(profile) === "mono-raster-v1" ? rasterizeDriverText : rasterizeText),
          )),
          dpi: profile.dpi,
          ...(printerFormat(profile) === "mono-raster-v1"
            ? { printFormat: "mono-raster-v1" as const }
            : { language: profile.language }),
        }
      : undefined;
  if (!deps.isCurrent()) throw new Error("WAREHOUSE_OWNER_CHANGED");
  const attemptId = crypto.randomUUID();
  await bindPrintDestination(
    deps.exec,
    {
      scope: job.owner,
      purpose: job.source.kind === "box" ? "box" : "duplicate",
      jobId,
      attemptId,
    },
    profile,
  );
  await appendWarehouseEvent(
    deps.exec,
    deps.owner,
    {
      ...base(job, deps.operatorId),
      kind: "reprint_prepared",
      attemptId,
      attemptNo: job.projection.attemptNo + 1,
      reason,
      ...(replacement
        ? {
            rerender: {
              bytesDigest: replacement.bytesDigest,
              dpi: replacement.dpi,
              ...("language" in replacement
                ? { language: replacement.language }
                : { printFormat: "mono-raster-v1" as const }),
            },
          }
        : {}),
    },
    replacement
      ? {
          bytesBase64: replacement.bytesBase64,
          bytesDigest: replacement.bytesDigest,
          dpi: replacement.dpi,
          ...("language" in replacement
            ? { language: replacement.language }
            : { printFormat: "mono-raster-v1" as const }),
        }
      : undefined,
  );
  await resolvePrintDelivery(deps.exec, {
    scope: job.owner,
    purpose: job.source.kind === "box" ? "box" : "duplicate",
    jobId,
    attemptId: job.projection.attemptId,
  });
  await printWarehouseJob(deps, jobId);
}
