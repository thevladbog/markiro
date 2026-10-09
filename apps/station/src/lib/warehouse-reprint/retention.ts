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
  await purgeWarehouseLookupCache(exec, owner, before);
}

const LOOKUP_CACHE_DAYS = 30;
const LOOKUP_CACHE_LIMIT = 1000;
export function warehouseLookupCacheBefore(): string {
  return new Date(Date.now() - LOOKUP_CACHE_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
/** Frozen local snapshots and every retained source job are outside disposable lookup retention. */
export async function purgeWarehouseLookupCache(
  exec: SqlExecutor,
  owner: string,
  before: string,
): Promise<void> {
  await exec.run(
    `WITH disposable AS (
      SELECT c.rowid,c.cached_at,ROW_NUMBER() OVER(PARTITION BY c.owner ORDER BY c.cached_at DESC,c.rowid DESC) AS rank
      FROM warehouse_reprint_cache c WHERE c.owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND c.kind IN ('unit','box') AND c.cached_at<>''
      AND NOT EXISTS(SELECT 1 FROM warehouse_reprint_jobs j WHERE j.owner=c.owner AND j.source_kind=c.kind AND j.identity=c.identity)
    ) DELETE FROM warehouse_reprint_cache WHERE rowid IN (SELECT rowid FROM disposable WHERE cached_at<? OR rank>?)`,
    [owner, before, LOOKUP_CACHE_LIMIT],
  );
}
