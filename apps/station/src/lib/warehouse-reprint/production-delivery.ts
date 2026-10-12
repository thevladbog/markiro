import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
import { palletProductionDeliverySchema } from "@markiro/domain";
import type { SqlExecutor } from "../mirror.js";
type Evidence = ReturnType<typeof palletProductionDeliverySchema.parse>;
/** Atomic monotonic claim. Unknown is durable before transport, independent of immutable source revision. */
export async function beginProductionPalletDelivery(
  exec: SqlExecutor,
  owner: string,
  sscc: string,
  attemptId: string,
  bytesDigest: string,
): Promise<Evidence | null> {
  const [row] = await exec.all<{ production_delivery_json: string }>(
    `UPDATE warehouse_pallet_sources SET production_delivery_json=json_object('sourceRevision',revision,'sequence',COALESCE(json_extract(production_delivery_json,'$.sequence'),0)+1,'attemptId',?,'bytesDigest',?,'state','delivery_unknown','occurredAt',?)
     WHERE rowid=(SELECT rowid FROM warehouse_pallet_sources WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND sscc=? ORDER BY rowid ASC LIMIT 1) AND receive_status<>'conflict' AND eligibility_denied=0
     AND COALESCE(json_extract(production_delivery_json,'$.sequence'),0)<? RETURNING production_delivery_json`,
    [attemptId, bytesDigest, new Date().toISOString(), owner, sscc, Number.MAX_SAFE_INTEGER - 1],
  );
  return row
    ? palletProductionDeliverySchema.parse(JSON.parse(row.production_delivery_json))
    : null;
}
/** A late transport response cannot replace a newer attempt or a newer source revision. */
export async function finishProductionPalletDelivery(
  exec: SqlExecutor,
  owner: string,
  sscc: string,
  claim: Evidence | null,
  state: Evidence["state"],
) {
  if (!claim) return;
  const next = palletProductionDeliverySchema.parse({
    ...claim,
    sequence: claim.sequence + 1,
    state,
    occurredAt: new Date().toISOString(),
  });
  await exec.run(
    `UPDATE warehouse_pallet_sources SET production_delivery_json=? WHERE rowid=(SELECT rowid FROM warehouse_pallet_sources WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND sscc=? ORDER BY rowid ASC LIMIT 1) AND revision=? AND production_delivery_json=?`,
    [JSON.stringify(next), owner, sscc, claim.sourceRevision, JSON.stringify(claim)],
  );
}

/** Recover a legacy send only from the latest exact driver attempt; never infer it from closure. */
export async function recoverLegacyProductionPalletDeliveries(
  exec: SqlExecutor,
  owner: string,
  sscc: string | null = null,
) {
  await exec.run(
    `WITH legacy AS (
      SELECT s.rowid source_id,json_object('sourceRevision',s.revision,'sequence',1,
        'attemptId',d.attempt_id,'bytesDigest',d.artifact_digest,'state','sent',
        'occurredAt',d.updated_at) value_json
      FROM warehouse_pallet_sources s
      JOIN pallets_mirror p ON p.sscc=s.sscc AND p.shift_id=json_extract(s.value_json,'$.shiftId')
      JOIN printer_deliveries d ON d.rowid=(
        SELECT rowid FROM printer_deliveries
        WHERE scope=json_extract(s.value_json,'$.originalAttempt.scope')
          AND purpose='pallet' AND job_id=s.sscc
        ORDER BY updated_at DESC,rowid DESC LIMIT 1)
      WHERE s.owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL})
        AND (? IS NULL OR s.sscc=?) AND s.production_delivery_json IS NULL
        AND s.receive_status<>'conflict' AND s.eligibility_denied=0
        AND p.closed_at IS NOT NULL AND p.disassembled_at IS NULL
        AND json_extract(s.value_json,'$.originalAttempt.scope')=json_array(p.shift_id,p.terminal_id)
        AND d.state='sent'
        AND d.attempt_id=json_extract(s.value_json,'$.originalAttempt.attemptId')
        AND d.artifact_digest=json_extract(s.value_json,'$.originalAttempt.bytesDigest')
    ) UPDATE warehouse_pallet_sources
      SET production_delivery_json=(SELECT value_json FROM legacy WHERE source_id=warehouse_pallet_sources.rowid)
      WHERE rowid IN (SELECT source_id FROM legacy) AND production_delivery_json IS NULL`,
    [owner, sscc, sscc],
  );
}
