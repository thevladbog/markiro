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
