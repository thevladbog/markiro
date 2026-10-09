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
import { purgeWarehouseLookupCache, warehouseLookupCacheBefore } from "./retention.js";
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
    "INSERT INTO warehouse_reprint_cache(owner,kind,identity,value_json,cached_at) VALUES(?,?,?,?,?) ON CONFLICT(owner,kind,identity) DO UPDATE SET value_json=excluded.value_json,cached_at=excluded.cached_at",
    [owner, source.kind, source.identity, JSON.stringify(source), new Date().toISOString()],
  );
  await purgeWarehouseLookupCache(exec, owner, warehouseLookupCacheBefore());
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
  const local = await readLocalClosedBox(exec, owner, scan);
  if (local) {
    if (local.denied) throw new Error("WAREHOUSE_SOURCE_ELIGIBILITY_DENIED");
    return local.source;
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
        chzProductGroupCode: await localProductGroup(exec, job.shiftId),
        fields: { ...job.fields, "km.code": job.canonicalRaw, sscc: "" },
        unavailableFields: [],
        payloadDigest: productLabelBytesDigest(new TextEncoder().encode(job.canonicalRaw)),
        sourceShiftId: job.shiftId,
      };
      return warehouseSourceSchema.parse({ ...value, revision: productLabelValueDigest(value) });
    }
  }
  const [cached] = await exec.all<{ value_json: string }>(
    `SELECT value_json FROM warehouse_reprint_cache WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND kind=? AND identity=? AND cached_at>=? ORDER BY cached_at DESC,rowid DESC LIMIT 1`,
    [owner, scan.kind, identity, warehouseLookupCacheBefore()],
  );
  return cached ? parseSource(cached.value_json, scan) : null;
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
  let local: WarehouseReprintSource | null = null;
  let eligibilityDenied = false;
  try {
    local = await findWarehouseSource(exec, owner, scan);
  } catch (error) {
    if (error instanceof Error && error.message === "WAREHOUSE_SOURCE_NOT_PRINTABLE")
      return { status: "unavailable" as const, code: "source_not_printable" as const };
    if (error instanceof Error && error.message === "WAREHOUSE_SOURCE_ELIGIBILITY_DENIED") {
      eligibilityDenied = true;
      local = (await readLocalClosedBox(exec, owner, scan))?.source ?? null;
    } else throw error;
  }
  const offline = () =>
    eligibilityDenied
      ? { status: "unavailable" as const, code: "source_not_printable" as const }
      : local
        ? {
            status: "found" as const,
            source: local,
            repair: scan.kind === "box" ? scan.repair : null,
          }
        : { status: "network_required" as const };
  let response: unknown;
  if (typeof navigator !== "undefined" && !navigator.onLine) return offline();
  try {
    response = await client.post("/station/warehouse-reprint/lookup", {
      protocol: WAREHOUSE_REPRINT_PROTOCOL,
      raw,
      operatorId,
    });
  } catch (error) {
    if (warehouseNetworkUnavailable(error)) return offline();
    throw error;
  }
  const originalLocal =
    scan.kind === "box"
      ? await readLocalClosedBox(exec, owner, scan)
      : (
          await exec.all(
            `SELECT 1 FROM product_label_accept_commands WHERE credential_ownership IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND code_hash=? LIMIT 1`,
            [owner, scan.codeHash],
          )
        ).length > 0;
  const result = warehouseLookupResultSchema.parse(response);
  if (result.status === "found") {
    if (
      result.source.kind !== scan.kind ||
      result.source.identity !== (scan.kind === "box" ? scan.sscc : scan.codeHash) ||
      result.repair !== (scan.kind === "box" ? scan.repair : null)
    )
      throw new Error("WAREHOUSE_SOURCE_MISMATCH");
    if (result.source.sourceShiftId !== null)
      await exec.run(
        "UPDATE product_mirror SET chz_product_group_code=? WHERE id IN (SELECT product_id FROM shift_mirror WHERE id=?)",
        [result.source.chzProductGroupCode, result.source.sourceShiftId],
      );
    if (scan.kind === "box")
      await exec.run(
        `UPDATE warehouse_reprint_local_boxes SET eligibility_denied=0,group_override_json=? WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND identity=?`,
        [JSON.stringify(result.source.chzProductGroupCode), owner, scan.sscc],
      );
    // A local print snapshot retains its historical fields; the online read validates
    // current eligibility and supplies the current group, never recalculates its dates.
    if (
      originalLocal &&
      local &&
      local.unavailableFields.length === 0 &&
      local.sourceShiftId === result.source.sourceShiftId
    ) {
      const source = withSourceGroup(local, result.source.chzProductGroupCode);
      await cacheWarehouseSource(exec, owner, source);
      return { ...result, source };
    }
    await cacheWarehouseSource(exec, owner, result.source);
  } else {
    if (scan.kind === "box" && result.status === "unavailable")
      await exec.run(
        `UPDATE warehouse_reprint_local_boxes SET eligibility_denied=1 WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND identity=?`,
        [owner, scan.sscc],
      );
    await exec.run(
      `DELETE FROM warehouse_reprint_cache WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND kind=? AND identity=?`,
      [owner, scan.kind, scan.kind === "box" ? scan.sscc : scan.codeHash],
    );
    if (result.status === "not_found" && originalLocal) return offline();
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
    chzProductGroupCode?: number | null;
  },
): Promise<void> {
  const value = {
    kind: "box" as const,
    sourceId: input.sourceId,
    sourceShiftId: input.sourceShiftId,
    identity: input.fields.sscc,
    productName: input.fields["product.name"],
    chzProductGroupCode:
      input.chzProductGroupCode === undefined
        ? input.sourceShiftId === null
          ? null
          : await localProductGroup(exec, input.sourceShiftId)
        : input.chzProductGroupCode,
    fields: input.fields,
    unavailableFields: [],
    payloadDigest: productLabelBytesDigest(new TextEncoder().encode(input.fields.sscc)),
  };
  const source = warehouseSourceSchema.parse({
    ...value,
    revision: productLabelValueDigest(value),
  });
  await exec.run(
    "INSERT INTO warehouse_reprint_local_boxes(owner,identity,value_json) VALUES(?,?,?) ON CONFLICT(owner,identity) DO NOTHING",
    [owner, source.identity, JSON.stringify(source)],
  );
}

async function localProductGroup(exec: SqlExecutor, shiftId: string): Promise<number | null> {
  const [row] = await exec.all<{ code: number | null }>(
    "SELECT p.chz_product_group_code AS code FROM shift_mirror s JOIN product_mirror p ON p.id=s.product_id WHERE s.id=?",
    [shiftId],
  );
  return row?.code ?? null;
}
function withSourceGroup(
  source: WarehouseReprintSource,
  chzProductGroupCode: number | null,
): WarehouseReprintSource {
  const { revision, ...snapshot } = source;
  void revision;
  const value = { ...snapshot, chzProductGroupCode };
  return warehouseSourceSchema.parse({ ...value, revision: productLabelValueDigest(value) });
}

function parseSource(value: string, scan: WarehouseReprintScan): WarehouseReprintSource {
  if (scan.kind === "invalid") throw new Error("WAREHOUSE_SCAN_INVALID");
  const source = warehouseSourceSchema.parse(JSON.parse(value));
  if (
    source.kind !== scan.kind ||
    source.identity !== (scan.kind === "box" ? scan.sscc : scan.codeHash)
  )
    throw new Error("WAREHOUSE_SOURCE_CORRUPT");
  return source;
}
async function readLocalClosedBox(exec: SqlExecutor, owner: string, scan: WarehouseReprintScan) {
  if (scan.kind !== "box") return null;
  const [row] = await exec.all<{
    value_json: string;
    eligibility_denied: number;
    group_override_json: string | null;
  }>(
    `SELECT value_json,eligibility_denied,group_override_json FROM warehouse_reprint_local_boxes WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND identity=? ORDER BY rowid ASC LIMIT 1`,
    [owner, scan.sscc],
  );
  if (!row) return null;
  let source = parseSource(row.value_json, scan);
  if (row.group_override_json !== null) {
    const group = warehouseSourceSchema.shape.chzProductGroupCode.parse(
      JSON.parse(row.group_override_json),
    );
    source = withSourceGroup(source, group);
  } else if (source.chzProductGroupCode === null && source.sourceShiftId !== null) {
    const group = await localProductGroup(exec, source.sourceShiftId);
    if (group !== null) source = withSourceGroup(source, group);
  }
  return { source, denied: row.eligibility_denied !== 0 };
}
