import {
  PALLET_REPRINT_PROTOCOL,
  palletLabelSourceSchema,
  palletProductionDeliverySchema,
  palletSourcesReceiptSchema,
} from "@markiro/domain";
import type { SqlExecutor } from "../mirror.js";
import type { StationClient } from "../api-client.js";
import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";

/** Resend an existing pending receipt; never invent a successful production outcome. */
export async function syncWarehousePalletEvidence(
  client: Pick<StationClient, "post">,
  exec: SqlExecutor,
  owner: string,
  sscc: string,
): Promise<boolean> {
  const [row] = await exec.all<{
    owner: string;
    value_json: string;
    production_delivery_json: string;
  }>(
    `SELECT owner,value_json,production_delivery_json FROM warehouse_pallet_sources
     WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND sscc=?
       AND eligibility_denied=0 AND receive_status<>'conflict'
       AND production_delivery_json IS NOT NULL
       AND COALESCE(json_extract(production_delivery_json,'$.sequence'),0)>production_delivery_acked_sequence
     ORDER BY rowid ASC LIMIT 1`,
    [owner, sscc],
  );
  if (!row) return false;
  const source = palletLabelSourceSchema.parse(JSON.parse(row.value_json));
  const evidence = palletProductionDeliverySchema.parse(JSON.parse(row.production_delivery_json));
  if (evidence.state !== "sent" || evidence.sourceRevision !== source.revision) return false;
  const receipt = palletSourcesReceiptSchema.parse(
    await client.post("/station/warehouse-reprint/pallet-sources", {
      protocol: PALLET_REPRINT_PROTOCOL,
      entries: [source],
      productionDelivery: evidence,
    }),
  );
  if (receipt.results.length !== 1 || receipt.results[0]?.revision !== source.revision)
    throw new Error("WAREHOUSE_PALLET_RECEIPT_MISMATCH");
  const status = receipt.results[0].status;
  if (status === "retryable") return false;
  await exec.run(
    `UPDATE warehouse_pallet_sources SET receive_status=?,
       production_delivery_acked_sequence=CASE WHEN production_delivery_json IS ? AND ?='accepted'
         THEN ? ELSE production_delivery_acked_sequence END
     WHERE owner=? AND sscc=? AND revision=? AND receive_status<>'conflict'`,
    [
      status,
      row.production_delivery_json,
      status,
      evidence.sequence,
      row.owner,
      sscc,
      source.revision,
    ],
  );
  return status === "accepted";
}
