import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
import {
  productLabelBytesDigest,
  productLabelValueDigest,
  warehouseLookupResultSchema,
  warehouseSourceSchema,
  type WarehouseReprintSource,
  type WarehouseReprintScan,
  WAREHOUSE_REPRINT_PROTOCOL,
  resolveWarehouseReprintScan,
} from "@markiro/domain";
import { StationApiError, type StationClient } from "../api-client.js";
import type { SqlExecutor } from "../mirror.js";
import { readProductLabelJob } from "../product-labels/store.js";
export function warehouseNetworkUnavailable(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof StationApiError && [502, 503, 504].includes(error.status))
  );
}
export async function cacheWarehouseSource(
  exec: SqlExecutor,
  owner: string,
  value: WarehouseReprintSource,
) {
  const source = warehouseSourceSchema.parse(value);
  await exec.run(
    "INSERT INTO warehouse_reprint_cache(owner,kind,identity,value_json) VALUES(?,?,?,?) ON CONFLICT(owner,kind,identity) DO UPDATE SET value_json=excluded.value_json",
    [owner, source.kind, source.identity, JSON.stringify(source)],
  );
}
export async function findWarehouseSource(
  exec: SqlExecutor,
  owner: string,
  scan: WarehouseReprintScan,
): Promise<WarehouseReprintSource | null> {
  if (scan.kind === "invalid") return null;
  const identity = scan.kind === "unit" ? scan.codeHash : scan.sscc;
  if (scan.kind === "box") {
    const [retired] = await exec.all(
      `SELECT 1 FROM boxes_mirror WHERE sscc=? AND (disassembled_at IS NOT NULL OR closed_at IS NULL)
      UNION ALL SELECT 1 FROM inventory_repack_boxes_mirror WHERE new_sscc=? AND (invalidated_at IS NOT NULL OR state<>'closed') LIMIT 1`,
      [identity, identity],
    );
    if (retired) throw new Error("WAREHOUSE_SOURCE_NOT_PRINTABLE");
  }
  const [cached] = await exec.all<{ value_json: string }>(
    `SELECT value_json FROM warehouse_reprint_cache WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND kind=? AND identity=? ORDER BY rowid DESC LIMIT 1`,
    [owner, scan.kind, identity],
  );
  if (cached) {
    const source = warehouseSourceSchema.parse(JSON.parse(cached.value_json));
    if (source.identity !== identity || source.kind !== scan.kind)
      throw new Error("WAREHOUSE_SOURCE_CORRUPT");
    return source;
  }
  if (scan.kind === "unit") {
    const [row] = await exec.all<{ job_id: string }>(
      `SELECT job_id FROM product_label_accept_commands WHERE credential_ownership IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND code_hash=? ORDER BY accepted_at DESC LIMIT 1`,
      [owner, identity],
    );
    if (row) {
      const job = await readProductLabelJob(exec, owner, row.job_id);
      if (!job || job.ownershipConflict) throw new Error("WAREHOUSE_SOURCE_CORRUPT");
      const value = {
        kind: "unit" as const,
        sourceId: identity,
        identity,
        productName: job.fields["product.name"],
        chzProductGroupCode: null,
        fields: { ...job.fields, "km.code": job.canonicalRaw, sscc: "" },
        unavailableFields: [],
        payloadDigest: productLabelBytesDigest(new TextEncoder().encode(job.canonicalRaw)),
        sourceShiftId: job.shiftId,
      };
      return warehouseSourceSchema.parse({ ...value, revision: productLabelValueDigest(value) });
    }
  }
  return null;
}
export async function resolveWarehouseSource(
  client: StationClient,
  exec: SqlExecutor,
  owner: string,
  raw: string,
  operatorId: string,
) {
  const scan = resolveWarehouseReprintScan(raw);
  if (scan.kind === "invalid") throw new Error("WAREHOUSE_SCAN_INVALID");
  let local: WarehouseReprintSource | null;
  try {
    local = await findWarehouseSource(exec, owner, scan);
  } catch (error) {
    if (error instanceof Error && error.message === "WAREHOUSE_SOURCE_NOT_PRINTABLE")
      return { status: "unavailable" as const, code: "source_not_printable" as const };
    throw error;
  }
  if (local)
    return {
      status: "found" as const,
      source: local,
      repair: scan.kind === "box" ? scan.repair : null,
    };
  let response: unknown;
  try {
    response = await client.post("/station/warehouse-reprint/lookup", {
      protocol: WAREHOUSE_REPRINT_PROTOCOL,
      raw,
      operatorId,
    });
  } catch (error) {
    if (warehouseNetworkUnavailable(error)) return { status: "network_required" as const };
    throw error;
  }
  const result = warehouseLookupResultSchema.parse(response);
  if (result.status === "found") {
    if (
      result.source.kind !== scan.kind ||
      result.source.identity !== (scan.kind === "box" ? scan.sscc : scan.codeHash) ||
      result.repair !== (scan.kind === "box" ? scan.repair : null)
    )
      throw new Error("WAREHOUSE_SOURCE_MISMATCH");
    await cacheWarehouseSource(exec, owner, result.source);
  }
  return result;
}
/** Cache the original closed-box model once, before an existing print path can replay it. */
export async function cacheWarehouseClosedBox(
  exec: SqlExecutor,
  owner: string,
  input: {
    sourceId: string;
    sourceShiftId: string | null;
    fields: WarehouseReprintSource["fields"];
  },
): Promise<void> {
  const value = {
    kind: "box" as const,
    sourceId: input.sourceId,
    sourceShiftId: input.sourceShiftId,
    identity: input.fields.sscc,
    productName: input.fields["product.name"],
    chzProductGroupCode: null,
    fields: input.fields,
    unavailableFields: [],
    payloadDigest: productLabelBytesDigest(new TextEncoder().encode(input.fields.sscc)),
  };
  const source = warehouseSourceSchema.parse({
    ...value,
    revision: productLabelValueDigest(value),
  });
  await exec.run(
    "INSERT INTO warehouse_reprint_cache(owner,kind,identity,value_json) VALUES(?,'box',?,?) ON CONFLICT(owner,kind,identity) DO NOTHING",
    [owner, source.identity, JSON.stringify(source)],
  );
}
