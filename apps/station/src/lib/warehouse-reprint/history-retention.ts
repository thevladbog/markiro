import type { SqlExecutor } from "../mirror.js";
import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
import { PRODUCT_LABEL_BATCH_KEY } from "../product-labels/sync-batch.js";
const unpinned = `NOT EXISTS(SELECT 1 FROM station_meta WHERE key IN ('sync_pending_batch_id','${PRODUCT_LABEL_BATCH_KEY}'))`;
// Terminal fact receipts are processed; unresolved business conflicts remain guarded below.
function closedShift(shift: string) {
  return `EXISTS(SELECT 1 FROM shift_mirror s WHERE s.id=${shift} AND s.status='closed')
 AND NOT EXISTS(SELECT 1 FROM outbox o WHERE o.shift_id=${shift})
 AND NOT EXISTS(SELECT 1 FROM shift_close_outbox o WHERE o.shift_id=${shift})
 AND NOT EXISTS(SELECT 1 FROM boxes_mirror b WHERE b.shift_id=${shift} AND (b.acked_at IS NULL OR b.confirmed_revision<b.reconciliation_revision))
 AND NOT EXISTS(SELECT 1 FROM pallets_mirror p WHERE p.shift_id=${shift} AND p.acked_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM box_exceptions_mirror e WHERE e.shift_id=${shift})
 AND NOT EXISTS(SELECT 1 FROM pallet_exceptions_mirror e WHERE e.shift_id=${shift})
 AND NOT EXISTS(SELECT 1 FROM box_reconciliation_issues i WHERE i.shift_id=${shift})
 AND NOT EXISTS(SELECT 1 FROM codes_mirror c JOIN conflicts_mirror x ON x.code_hash=c.code_hash WHERE c.shift_id=${shift})
 AND NOT EXISTS(SELECT 1 FROM unit_label_facts f JOIN conflicts_mirror x ON x.code_hash=f.code_hash WHERE f.shift_id=${shift})
 AND NOT EXISTS(SELECT 1 FROM station_meta m WHERE m.key='sync_recovery_denied_shift:'||${shift})
 AND NOT EXISTS(SELECT 1 FROM station_meta m,json_each(CASE WHEN json_valid(m.value) THEN m.value ELSE '{}' END,'$.denied') q WHERE m.key='sync_last_recovery_denied' AND q.type='object' AND json_extract(q.value,'$.shiftId')=${shift})
 AND NOT EXISTS(SELECT 1 FROM validation_occurrences v WHERE v.shift_id=${shift} AND v.outcome IN ('pending','conflict'))
 AND NOT EXISTS(SELECT 1 FROM product_label_jobs j WHERE j.shift_id=${shift})
 AND NOT EXISTS(SELECT 1 FROM unit_label_facts f WHERE f.shift_id=${shift} AND f.receive_status='pending')
 AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_production_resolutions r JOIN warehouse_pallet_sources src ON src.sscc=r.sscc AND src.owner=r.owner WHERE json_extract(src.value_json,'$.shiftId')=${shift} AND r.receive_status<>'accepted')
 AND NOT EXISTS(SELECT 1 FROM printer_deliveries d WHERE d.state IN ('prepared','sending','delivery_unknown') AND d.resolved_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_production_resolutions r JOIN warehouse_pallet_sources src ON src.owner=r.owner AND src.sscc=r.sscc AND src.revision=r.source_revision WHERE r.receive_status='accepted' AND r.sscc=d.job_id AND r.attempt_id=d.attempt_id AND r.attempt_id=json_extract(src.production_delivery_json,'$.attemptId') AND json_extract(r.value_json,'$.productionSequence')=json_extract(src.production_delivery_json,'$.sequence'))
   AND d.purpose IN ('box','pallet') AND CASE WHEN json_valid(d.scope) THEN json_extract(d.scope,'$[0]') END=${shift})`;
}
const palletHistory = `EXISTS(SELECT 1 FROM pallets_mirror p WHERE p.sscc=history.sscc AND p.closed_at IS NOT NULL AND p.acked_at IS NOT NULL AND ${closedShift("p.shift_id")})`;
const knownPallet = `(${palletHistory} OR NOT EXISTS(SELECT 1 FROM pallets_mirror p WHERE p.sscc=history.sscc))`;
/** User-authorised 30-day local history cleanup; each statement rechecks acknowledgement and recovery guards. */
export async function purgeWarehousePalletHistory(
  exec: SqlExecutor,
  owner: string,
  before: string,
) {
  await exec.run(
    `DELETE FROM warehouse_pallet_jobs AS history WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL})
 AND state IN ('sent','verified','skipped') AND json_extract(event_json,'$.occurredAt')<? AND ${unpinned} AND ${knownPallet}
 AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_sources s WHERE s.sscc=history.sscc AND (s.receive_status<>'accepted' OR s.eligibility_denied<>0 OR (s.production_delivery_json IS NOT NULL AND json_extract(s.production_delivery_json,'$.state')<>'sent' AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_production_resolutions r WHERE r.owner=s.owner AND r.sscc=s.sscc AND r.source_revision=s.revision AND r.attempt_id=json_extract(s.production_delivery_json,'$.attemptId') AND json_extract(r.value_json,'$.productionSequence')=json_extract(s.production_delivery_json,'$.sequence') AND r.receive_status='accepted')) OR COALESCE(json_extract(s.production_delivery_json,'$.sequence'),0)>s.production_delivery_acked_sequence))
 AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_renderings r WHERE r.owner=history.owner AND r.job_id=history.job_id AND r.receive_status<>'accepted')
 AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_production_resolutions r WHERE r.sscc=history.sscc AND r.receive_status<>'accepted')
 AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_events e WHERE e.owner=history.owner AND json_extract(e.value_json,'$.jobId')=history.job_id AND e.receive_status<>'accepted')
 AND NOT EXISTS(SELECT 1 FROM printer_deliveries d WHERE d.scope=json_array('warehouse-pallet',history.owner,history.job_id) AND d.resolved_at IS NULL AND d.state IN ('prepared','sending','delivery_unknown'))`,
    [owner, before],
  );
  await exec.run(
    `DELETE FROM warehouse_pallet_sources AS history WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL})
 AND receive_status='accepted' AND eligibility_denied=0 AND json_extract(value_json,'$.closedAt')<? AND ${unpinned} AND ${knownPallet}
 AND COALESCE(json_extract(production_delivery_json,'$.sequence'),0)<=production_delivery_acked_sequence
 AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_production_resolutions r WHERE r.sscc=history.sscc AND r.receive_status<>'accepted')
 AND (production_delivery_json IS NULL OR json_extract(production_delivery_json,'$.state')='sent' OR EXISTS(SELECT 1 FROM warehouse_pallet_production_resolutions r WHERE r.owner=history.owner AND r.sscc=history.sscc AND r.source_revision=history.revision AND r.attempt_id=json_extract(history.production_delivery_json,'$.attemptId') AND json_extract(r.value_json,'$.productionSequence')=json_extract(history.production_delivery_json,'$.sequence') AND r.receive_status='accepted'))
 AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_jobs j WHERE j.sscc=history.sscc)
 AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_events e WHERE json_extract(e.value_json,'$.sscc')=history.sscc AND e.receive_status<>'accepted')`,
    [owner, before],
  );
  await exec.run(
    `DELETE FROM warehouse_pallet_closures AS history WHERE closed_at<? AND ${unpinned} AND ${palletHistory}
 AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_sources s WHERE s.sscc=history.sscc)
 AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_jobs j WHERE j.sscc=history.sscc)
 AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_events e WHERE json_extract(e.value_json,'$.sscc')=history.sscc AND e.receive_status<>'accepted')
 AND (NOT EXISTS(SELECT 1 FROM station_device_recovery) OR EXISTS(SELECT 1 FROM station_device_recovery WHERE active_hash IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL})))`,
    [before, owner],
  );
  await exec.run(
    `DELETE FROM warehouse_pallet_events AS history WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND receive_status='accepted'
 AND json_extract(value_json,'$.occurredAt')<? AND ${unpinned}
 AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_jobs j WHERE j.owner=history.owner AND j.job_id=json_extract(history.value_json,'$.jobId'))
 AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_sources s WHERE s.sscc=json_extract(history.value_json,'$.sscc'))
 AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_closures c WHERE c.sscc=json_extract(history.value_json,'$.sscc'))`,
    [owner, before],
  );
  await exec.run(
    `DELETE FROM warehouse_pallet_renderings AS history WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND receive_status='accepted' AND ${unpinned} AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_jobs j WHERE j.owner=history.owner AND j.job_id=history.job_id) AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_events e WHERE e.owner=history.owner AND json_extract(e.value_json,'$.jobId')=history.job_id)`,
    [owner],
  );
  await exec.run(
    `DELETE FROM warehouse_pallet_production_resolutions AS history WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND receive_status='accepted' AND json_extract(value_json,'$.occurredAt')<? AND ${unpinned} AND ${knownPallet} AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_sources s WHERE s.sscc=history.sscc) AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_jobs j WHERE j.sscc=history.sscc)`,
    [owner, before],
  );
  await exec.run(
    `DELETE FROM warehouse_pallet_session_sends AS history WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND ${unpinned} AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_jobs j WHERE j.owner=history.owner AND j.job_id=history.job_id) AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_settings s WHERE s.owner=history.owner AND s.session_id=history.session_id AND s.session_status='active')`,
    [owner],
  );
}
export async function purgeUnitLabelFacts(exec: SqlExecutor, owner: string, before: string) {
  await exec.run(
    `DELETE FROM unit_label_facts AS history WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND receive_status IN ('accepted','conflict') AND accepted_at<? AND ${unpinned} AND ${closedShift("history.shift_id")}
 AND NOT EXISTS(SELECT 1 FROM warehouse_reprint_jobs j WHERE j.identity=history.code_hash)
 AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_jobs j WHERE json_extract(j.source_json,'$.shiftId')=history.shift_id)
 AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_events e JOIN warehouse_pallet_closures c ON c.sscc=json_extract(e.value_json,'$.sscc') WHERE c.shift_id=history.shift_id AND e.receive_status<>'accepted')
 AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_sources s WHERE json_extract(s.value_json,'$.shiftId')=history.shift_id AND (s.receive_status<>'accepted' OR (s.production_delivery_json IS NOT NULL AND json_extract(s.production_delivery_json,'$.state')<>'sent' AND NOT EXISTS(SELECT 1 FROM warehouse_pallet_production_resolutions r WHERE r.owner=s.owner AND r.sscc=s.sscc AND r.source_revision=s.revision AND r.attempt_id=json_extract(s.production_delivery_json,'$.attemptId') AND json_extract(r.value_json,'$.productionSequence')=json_extract(s.production_delivery_json,'$.sequence') AND r.receive_status='accepted')) OR COALESCE(json_extract(s.production_delivery_json,'$.sequence'),0)>s.production_delivery_acked_sequence))`,
    [owner, before],
  );
}
