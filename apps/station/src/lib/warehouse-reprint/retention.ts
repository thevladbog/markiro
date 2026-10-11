import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
import type { SqlExecutor } from "../mirror.js";
import { PRODUCT_LABEL_BATCH_KEY } from "../product-labels/sync-batch.js";
/** Session deduplication facts and every unresolved/quarantined event survive cleanup. */
export async function purgeWarehouseJobs(
  exec: SqlExecutor,
  owner: string,
  before: string,
): Promise<void> {
  await exec.run(
    `DELETE FROM warehouse_reprint_jobs WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND state IN ('sent','verified') AND updated_at<?
 AND session_id IN (SELECT session_id FROM warehouse_reprint_sessions WHERE owner=warehouse_reprint_jobs.owner AND status='paused' AND rowid<(SELECT MAX(rowid) FROM warehouse_reprint_sessions WHERE owner=warehouse_reprint_jobs.owner))
 AND NOT EXISTS(SELECT 1 FROM printer_deliveries d WHERE d.scope=warehouse_reprint_jobs.owner AND d.job_id=warehouse_reprint_jobs.job_id AND d.resolved_at IS NULL AND d.state IN ('prepared','sending','delivery_unknown'))
 AND NOT EXISTS(SELECT 1 FROM warehouse_reprint_events e WHERE e.owner=warehouse_reprint_jobs.owner AND e.job_id=warehouse_reprint_jobs.job_id AND e.receive_status<>'accepted')`,
    [owner, before],
  );
  await purgeWarehouseLookupCache(exec, owner, before);
  await purgeWarehouseLocalBoxes(exec, owner, before);
}

const LOOKUP_CACHE_DAYS = 30;
const LOOKUP_CACHE_LIMIT = 1000;
export function warehouseLookupCacheBefore(): string {
  return new Date(Date.now() - LOOKUP_CACHE_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
/** Retained jobs and legacy local evidence without a recovered snapshot survive cache cleanup. */
export async function purgeWarehouseLookupCache(
  exec: SqlExecutor,
  owner: string,
  before: string,
): Promise<void> {
  await exec.run(
    `WITH authorized(owner) AS (${AUTHORIZED_CREDENTIAL_OWNERS_SQL})
    DELETE FROM warehouse_reprint_cache AS c WHERE c.owner IN (SELECT owner FROM authorized)
      AND c.kind IN ('unit','box') AND c.cached_at=''
      AND NOT EXISTS(SELECT 1 FROM warehouse_reprint_jobs j WHERE j.owner IN (SELECT owner FROM authorized) AND j.source_kind=c.kind AND j.identity=c.identity)
      AND (c.kind='unit' OR EXISTS(SELECT 1 FROM warehouse_reprint_local_boxes local WHERE local.owner=c.owner AND local.identity=c.identity)
        OR (NOT EXISTS(SELECT 1 FROM boxes_mirror b WHERE b.sscc=c.identity AND b.closed_at IS NOT NULL)
          AND NOT EXISTS(SELECT 1 FROM inventory_repack_boxes_mirror b WHERE b.new_sscc=c.identity AND b.closed_at IS NOT NULL)))`,
    [owner],
  );
  await exec.run(
    `WITH authorized(owner) AS (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}), disposable AS (
      SELECT c.rowid,c.cached_at,ROW_NUMBER() OVER(PARTITION BY c.owner ORDER BY c.cached_at DESC,c.rowid DESC) AS rank
      FROM warehouse_reprint_cache c WHERE c.owner IN (SELECT owner FROM authorized) AND c.kind IN ('unit','box') AND c.cached_at<>''
      AND NOT EXISTS(SELECT 1 FROM warehouse_reprint_jobs j WHERE j.owner IN (SELECT owner FROM authorized) AND j.source_kind=c.kind AND j.identity=c.identity)
    ) DELETE FROM warehouse_reprint_cache WHERE rowid IN (SELECT rowid FROM disposable WHERE cached_at<? OR rank>?)`,
    [owner, before, LOOKUP_CACHE_LIMIT],
  );
}

/** Only acknowledged closures expire; a closed shift alone is not server acceptance. */
export async function purgeWarehouseLocalBoxes(
  exec: SqlExecutor,
  owner: string,
  before: string,
): Promise<void> {
  await exec.run(
    `WITH authorized(owner) AS (${AUTHORIZED_CREDENTIAL_OWNERS_SQL})
    DELETE FROM warehouse_reprint_local_boxes AS local
    WHERE local.owner IN (SELECT owner FROM authorized) AND local.cached_at<>'' AND local.cached_at<? AND local.eligibility_denied=0
      AND NOT EXISTS(SELECT 1 FROM warehouse_reprint_jobs j WHERE j.owner IN (SELECT owner FROM authorized) AND j.source_kind='box' AND j.identity=local.identity)
      AND (EXISTS(SELECT 1 FROM boxes_mirror b
        WHERE b.box_id=json_extract(local.value_json,'$.sourceId') AND b.sscc=local.identity AND b.shift_id=json_extract(local.value_json,'$.sourceShiftId') AND b.closed_at IS NOT NULL AND b.acked_at IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM outbox pending WHERE pending.box_id=b.box_id)
          AND NOT EXISTS(SELECT 1 FROM box_exceptions_mirror pending WHERE pending.box_id=b.box_id)
          AND NOT EXISTS(SELECT 1 FROM shift_close_outbox pending WHERE pending.shift_id=b.shift_id)
          AND NOT EXISTS(SELECT 1 FROM box_reconciliation_issues issue WHERE issue.box_id=b.box_id)
          AND NOT EXISTS(SELECT 1 FROM codes_mirror code JOIN conflicts_mirror conflict ON conflict.code_hash=code.code_hash WHERE code.box_id=b.box_id)
          AND NOT EXISTS(SELECT 1 FROM station_meta WHERE key IN ('sync_pending_batch_id',?)))
      OR EXISTS(SELECT 1 FROM inventory_repack_boxes_mirror b
        JOIN inventory_scan_events_mirror closure ON closure.inventory_id=b.inventory_id AND closure.snapshot_id=b.snapshot_id AND closure.event_id=b.closed_event_id
        WHERE b.box_id=json_extract(local.value_json,'$.sourceId') AND b.new_sscc=local.identity AND b.closed_at IS NOT NULL AND b.invalidated_at IS NULL AND b.print_state='printed' AND closure.authoritative_verdict='accepted'
          AND NOT EXISTS(SELECT 1 FROM inventory_outbox pending WHERE pending.inventory_id=b.inventory_id AND pending.snapshot_id=b.snapshot_id)
          AND NOT EXISTS(SELECT 1 FROM inventory_repack_journal event LEFT JOIN inventory_scan_events_mirror accepted
            ON accepted.inventory_id=event.inventory_id AND accepted.snapshot_id=event.snapshot_id AND accepted.event_id=event.event_id
            WHERE event.inventory_id=b.inventory_id AND event.snapshot_id=b.snapshot_id AND event.box_id=b.box_id AND (accepted.authoritative_verdict IS NULL OR accepted.authoritative_verdict<>'accepted'))
          AND NOT EXISTS(SELECT 1 FROM inventory_repack_items_mirror item JOIN inventory_conflicts_mirror conflict
            ON conflict.inventory_id=item.inventory_id AND conflict.snapshot_id=item.snapshot_id AND conflict.code_hash=item.code_hash
            WHERE item.inventory_id=b.inventory_id AND item.snapshot_id=b.snapshot_id AND item.box_id=b.box_id AND conflict.state<>'resolved')
          AND NOT EXISTS(SELECT 1 FROM station_meta WHERE key='inventory_sync_batch_v1:'||b.inventory_id||':'||b.snapshot_id)))`,
    [owner, before, PRODUCT_LABEL_BATCH_KEY],
  );
}
