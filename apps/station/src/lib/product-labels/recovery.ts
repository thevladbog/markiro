import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
import { readReplacementEvidenceRecovery } from "../replacement-evidence-recovery.js";
import type { SqlExecutor } from "../mirror.js";
import { isProductLabelSendActive } from "./printing.js";
import {
  appendProductLabelEvent,
  nextProductLabelEventBase,
  presentProductLabelJob,
  requireProductLabelJob,
} from "./store.js";
import type { ProductLabelActor, ProductLabelJobView } from "./types.js";

export async function restoreProductLabelWork(
  exec: SqlExecutor,
  credentialOwnership: string,
  actor: ProductLabelActor,
  jobId?: string,
): Promise<ProductLabelJobView | null> {
  const [row] = await exec.all<{ job_id: string }>(
    `SELECT job_id FROM product_label_jobs WHERE credential_ownership IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND status<>'completed'${jobId ? " AND job_id=?" : ""} LIMIT 1`,
    jobId ? [credentialOwnership, jobId] : [credentialOwnership],
  );
  if (!row) return null;
  const job = await requireProductLabelJob(exec, credentialOwnership, row.job_id);
  if (
    job.projection.attemptState === "sending" &&
    !isProductLabelSendActive(credentialOwnership, job.jobId)
  ) {
    await appendProductLabelEvent(exec, credentialOwnership, {
      ...nextProductLabelEventBase(job, actor),
      kind: "delivery_unknown",
      errorCode: "interrupted",
    });
    return presentProductLabelJob(
      await requireProductLabelJob(exec, credentialOwnership, job.jobId),
    );
  }
  return presentProductLabelJob(job);
}

/** Startup gate uses only the current credential; remotely closed shifts remain recoverable. */
export async function readProductLabelRecoveryShift(
  exec: SqlExecutor,
  owner: string,
): Promise<{ id: string; status: string; mode: string; jobId: string } | null> {
  const [pending] = await exec.all<{ job_id: string; shift_id: string }>(
    `SELECT job_id,shift_id FROM product_label_jobs WHERE credential_ownership IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND status<>'completed' LIMIT 1`,
    [owner],
  );
  if (!pending) return null;
  await requireProductLabelJob(exec, owner, pending.job_id);
  const [shift] = await exec.all<{ id: string; status: string; mode: string }>(
    "SELECT id,status,mode FROM shift_mirror WHERE id=?",
    [pending.shift_id],
  );
  if (!shift || shift.mode !== "validation") throw new Error("PRODUCT_LABEL_CONTEXT_MISSING");
  return { ...shift, jobId: pending.job_id };
}

/** Recovery grants access to one retained unresolved job, never to its production shift. */
export async function requireReplacementLabelRecovery(
  exec: SqlExecutor,
  owner: string,
  shiftId: string,
  jobId: string,
) {
  const recovery = await readReplacementEvidenceRecovery(exec);
  const job = await requireProductLabelJob(exec, owner, jobId);
  if (
    !recovery ||
    recovery.completed ||
    recovery.credentialOwnership !== owner ||
    recovery.deviceId !== job.deviceId ||
    job.shiftId !== shiftId ||
    job.projection.status === "completed"
  )
    throw new Error("PRODUCT_LABEL_RECOVERY_UNAVAILABLE");
  return job;
}
