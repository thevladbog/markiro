import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
import type { SqlExecutor } from "../mirror.js";
/** Session deduplication facts and every unresolved/quarantined event survive cleanup. */
export async function purgeWarehouseJobs(
  exec: SqlExecutor,
  owner: string,
  before: string,
): Promise<void> {
  await exec.run(
    `DELETE FROM warehouse_reprint_jobs WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND state IN ('sent','verified') AND updated_at<?
 AND session_id IN (SELECT session_id FROM warehouse_reprint_sessions WHERE owner=warehouse_reprint_jobs.owner AND status='paused' AND rowid<(SELECT MAX(rowid) FROM warehouse_reprint_sessions WHERE owner=warehouse_reprint_jobs.owner))
 AND NOT EXISTS(SELECT 1 FROM warehouse_reprint_events e WHERE e.owner=warehouse_reprint_jobs.owner AND e.job_id=warehouse_reprint_jobs.job_id AND e.receive_status<>'accepted')`,
    [owner, before],
  );
}
