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
): Promise<ProductLabelJobView | null> {
  const [row] = await exec.all<{ job_id: string }>(
    "SELECT job_id FROM product_label_jobs WHERE credential_ownership=? AND status<>'completed' LIMIT 1",
    [credentialOwnership],
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
