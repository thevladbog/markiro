import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
import type { SqlExecutor } from "../mirror.js";
import { PRODUCT_LABEL_BATCH_KEY } from "./sync-batch.js";

/** One SQLite statement rechecks every acknowledgement boundary before cascading print-only copies. */
export async function purgeCompletedProductLabelJobs(
  exec: SqlExecutor,
  credentialOwnership: string,
): Promise<number> {
  if (!credentialOwnership) return 0;
  const deleted = await exec.all<{ job_id: string }>(
    `
   DELETE FROM product_label_accept_commands
   WHERE credential_ownership IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND job_id IN (
     SELECT job.job_id FROM product_label_jobs job
     JOIN shift_mirror shift ON shift.id=job.shift_id
     WHERE job.credential_ownership IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND job.status='completed' AND job.ownership_conflict=0 AND shift.status='closed'
       AND NOT EXISTS (SELECT 1 FROM product_label_outbox pending JOIN product_label_events event ON event.credential_ownership=pending.credential_ownership AND event.event_id=pending.event_id WHERE event.credential_ownership=job.credential_ownership AND event.job_id=job.job_id)
       AND NOT EXISTS (SELECT 1 FROM product_label_receipts receipt JOIN product_label_events event ON event.credential_ownership=receipt.credential_ownership AND event.event_id=receipt.event_id WHERE event.credential_ownership=job.credential_ownership AND event.job_id=job.job_id AND receipt.outcome='quarantined')
       AND NOT EXISTS (SELECT 1 FROM product_label_events event WHERE event.credential_ownership=job.credential_ownership AND event.job_id=job.job_id AND NOT EXISTS (SELECT 1 FROM product_label_receipts receipt WHERE receipt.credential_ownership=event.credential_ownership AND receipt.event_id=event.event_id AND receipt.outcome='accepted'))
       AND NOT EXISTS (SELECT 1 FROM outbox pending WHERE pending.shift_id=job.shift_id AND pending.code_hash=json_extract(job.projection_json,'$.codeHash'))
       AND NOT EXISTS (SELECT 1 FROM conflicts_mirror conflict WHERE conflict.code_hash=json_extract(job.projection_json,'$.codeHash'))
       AND NOT EXISTS (SELECT 1 FROM validation_occurrences occurrence WHERE occurrence.shift_id=job.shift_id AND occurrence.code_hash=json_extract(job.projection_json,'$.codeHash') AND occurrence.outcome IN ('pending','conflict'))
       AND NOT EXISTS (SELECT 1 FROM shift_close_outbox closing WHERE closing.shift_id=job.shift_id)
       AND NOT EXISTS (SELECT 1 FROM station_meta WHERE key=?)
   ) RETURNING job_id`,
    [credentialOwnership, credentialOwnership, PRODUCT_LABEL_BATCH_KEY],
  );
  return deleted.length;
}
