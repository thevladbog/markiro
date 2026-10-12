import {
  palletProductionResolutionSchema,
  productLabelValueDigest,
  type PalletProductionResolution,
} from "@markiro/domain";
import type { SqlExecutor } from "../mirror.js";
import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
import { z } from "zod";
const status = z.enum(["pending", "accepted", "conflict"]);
/** One statement commits the original-attempt decision and its pending synchronization record. */
export async function recordPalletProductionResolution(
  exec: SqlExecutor,
  owner: string,
  input: PalletProductionResolution,
): Promise<void> {
  const value = palletProductionResolutionSchema.parse(input);
  await exec.run(
    `INSERT INTO warehouse_pallet_production_resolutions(owner,event_id,sscc,source_revision,attempt_id,value_json,digest)
     SELECT ?,?,?,?,?,?,? FROM warehouse_pallet_sources s
     WHERE s.rowid=(SELECT rowid FROM warehouse_pallet_sources WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND sscc=? ORDER BY rowid ASC LIMIT 1)
       AND s.revision=? AND s.eligibility_denied=0 AND s.receive_status<>'conflict'
       AND json_extract(s.production_delivery_json,'$.sourceRevision')=s.revision
       AND json_extract(s.production_delivery_json,'$.attemptId')=?
       AND json_extract(s.production_delivery_json,'$.state') IN ('delivery_unknown','sent','failed_before_send')
       AND (?='skipped' OR json_extract(s.production_delivery_json,'$.state')<>'failed_before_send')
     ON CONFLICT(owner,event_id) DO UPDATE SET value_json=excluded.value_json,digest=excluded.digest`,
    [
      owner,
      value.eventId,
      value.sscc,
      value.sourceRevision,
      value.attemptId,
      JSON.stringify(value),
      productLabelValueDigest(value),
      owner,
      value.sscc,
      value.sourceRevision,
      value.attemptId,
      value.outcome,
    ],
  );
  const [recorded] = await exec.all<{ digest: string }>(
    "SELECT digest FROM warehouse_pallet_production_resolutions WHERE owner=? AND event_id=?",
    [owner, value.eventId],
  );
  if (recorded?.digest !== productLabelValueDigest(value))
    throw new Error("WAREHOUSE_PALLET_SOURCE_CHANGED");
}
export async function readPalletProductionResolution(
  exec: SqlExecutor,
  owner: string,
  sscc: string,
  attemptId: string,
) {
  const [row] = await exec.all<{ value_json: string; digest: string; receive_status: string }>(
    `SELECT value_json,digest,receive_status FROM warehouse_pallet_production_resolutions
     WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND sscc=? AND attempt_id=? ORDER BY rowid DESC LIMIT 1`,
    [owner, sscc, attemptId],
  );
  if (!row) return null;
  const resolution = palletProductionResolutionSchema.parse(JSON.parse(row.value_json));
  if (productLabelValueDigest(resolution) !== row.digest)
    throw new Error("WAREHOUSE_PALLET_SOURCE_CORRUPT");
  return { resolution, receiveStatus: status.parse(row.receive_status) };
}
