import { z } from "zod";
import {
  boxLabelFields,
  unitLabelFactsUnavailableFields,
  makeUnitLabelFacts,
  LABEL_FACTS_PROTOCOL,
  labelFactsReceiptSchema,
  productLabelValueDigest,
  warehouseSourceSchema,
  parseDuplicateKm,
  resolveWarehouseReprintScan,
  productLabelBytesDigest,
  type UnitLabelFactsV1,
} from "@markiro/domain";
import type { SqlExecutor } from "../mirror.js";
import type { StationClient } from "../api-client.js";
import { StationApiError } from "../api-client.js";
import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
const contextSchema = z.strictObject({
  productName: z.string(),
  productPrintName: z.string().nullable(),
  gtin14: z.string(),
  egaisCode: z.string().nullable(),
  shelfLifeDays: z.number().int().nonnegative().nullable(),
  productionDate: z.iso.date().nullable(),
  acceptedLocalDate: z.iso.date(),
  shiftNumber: z.string().nullable(),
  counterpartyName: z.string().nullable(),
  operatorName: z.string().nullable(),
});
interface Row {
  owner: string;
  shift_id: string;
  code_hash: string;
  accepted_at: string;
  fields_json: string | null;
  context_json: string | null;
  canonical_raw: string;
}
export function parseUnitLabelFacts(row: Row): UnitLabelFactsV1 {
  const fields =
    row.fields_json !== null
      ? warehouseSourceSchema.shape.fields.parse({
          "qty.boxes": "", // Older unit jobs predate this pallet-only field.
          ...z.record(z.string(), z.unknown()).parse(JSON.parse(row.fields_json)),
        })
      : (() => {
          const c = contextSchema.parse(JSON.parse(row.context_json ?? "null"));
          return boxLabelFields({
            ...c,
            sscc: "",
            itemCount: 1,
            closedAt: row.accepted_at,
            productionDate: c.productionDate ?? c.acceptedLocalDate,
          });
        })();
  return makeUnitLabelFacts({
    version: 1,
    shiftId: row.shift_id,
    codeHash: row.code_hash,
    acceptedAt: row.accepted_at,
    fields: { ...fields, "km.code": "", sscc: "", qty: "1" },
    dateProvenance: row.fields_json !== null ? "saved_print_job" : "accepted_context",
  });
}
export async function readUnitLabelFacts(exec: SqlExecutor, owner: string, codeHash: string) {
  const [row] = await exec.all<Row>(
    `SELECT f.* FROM unit_label_facts f JOIN codes_mirror c ON c.code_hash=f.code_hash AND c.shift_id=f.shift_id AND c.scanned_at=f.accepted_at
   WHERE f.code_hash=? AND (f.owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) OR (f.owner='' AND NOT EXISTS(SELECT 1 FROM station_device_recovery))) ORDER BY f.accepted_at DESC LIMIT 1`,
    [codeHash, owner],
  );
  return row ? parseUnitLabelFacts(row) : null;
}
export async function syncUnitLabelFacts(
  exec: SqlExecutor,
  client: Pick<StationClient, "post"> & Partial<Pick<StationClient, "get">>,
  owner: string,
  isCurrent: () => boolean,
) {
  const rows = await exec.all<Row>(
    `SELECT * FROM unit_label_facts WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND receive_status='pending' AND NOT EXISTS(SELECT 1 FROM outbox) ORDER BY last_tried_at,rowid LIMIT 100`,
    [owner],
  );
  if (!rows.length || !isCurrent() || !client.get) return 0;
  // Old servers never receive unsupported fact uploads.
  try {
    const caps = z
      .strictObject({ protocols: z.array(z.string()) })
      .parse(await client.get("/station/warehouse-reprint/source-capabilities"));
    if (!caps.protocols.includes(LABEL_FACTS_PROTOCOL)) return 0;
  } catch (error) {
    if (error instanceof StationApiError && error.status === 404) return 0;
    throw error;
  }
  if (!isCurrent()) return 0;
  const entries: UnitLabelFactsV1[] = [];
  let bodyBytes = 0;
  for (const row of rows) {
    const entry = parseUnitLabelFacts(row);
    const size = new TextEncoder().encode(JSON.stringify(entry)).length;
    if (entries.length && bodyBytes + size > 700000) break;
    entries.push(entry);
    bodyBytes += size;
  }
  const batchRows = rows.slice(0, entries.length);
  const result = labelFactsReceiptSchema.parse(
    await client.post("/station/warehouse-reprint/label-facts", {
      protocol: LABEL_FACTS_PROTOCOL,
      operatorId: null,
      entries,
    }),
  );
  if (
    result.results.length !== entries.length ||
    new Set(result.results.map((r) => r.digest)).size !== entries.length ||
    result.results.some((r) => !entries.some((e) => e.digest === r.digest))
  )
    throw new Error("WAREHOUSE_FACT_RECEIPT_MISMATCH");
  for (const [index, row] of batchRows.entries()) {
    if (!isCurrent()) return 0;
    const entry = entries[index];
    if (!entry) throw new Error("WAREHOUSE_FACT_RECEIPT_MISMATCH");
    const receipt = result.results.find((r) => r.digest === entry.digest);
    if (!receipt) continue;
    if (receipt.status === "retryable") {
      await exec.run(
        "UPDATE unit_label_facts SET last_tried_at=? WHERE owner=? AND shift_id=? AND code_hash=? AND accepted_at=? AND receive_status='pending'",
        [new Date().toISOString(), row.owner, row.shift_id, row.code_hash, row.accepted_at],
      );
      continue;
    }
    await exec.run(
      "UPDATE unit_label_facts SET receive_status=? WHERE owner=? AND shift_id=? AND code_hash=? AND accepted_at=? AND receive_status='pending'",
      [receipt.status, row.owner, row.shift_id, row.code_hash, row.accepted_at],
    );
  }
  return result.results.filter((r) => r.status !== "retryable").length;
}
export async function frozenUnitSource(
  exec: SqlExecutor,
  owner: string,
  codeHash: string,
  group: number | null,
) {
  const fact = await readUnitLabelFacts(exec, owner, codeHash);
  if (!fact) return null;
  // New facts contain no raw copy. Existing protected sources retain exact crypto bytes.
  const candidates = await exec.all<{ raw: string }>(
    `SELECT raw FROM product_label_accept_commands WHERE shift_id=? AND code_hash=? AND accepted_at=? AND credential_ownership IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL})
     UNION ALL SELECT raw FROM scan_events_mirror WHERE shift_id=? AND scanned_at=? AND verdict='ok'`,
    [fact.shiftId, codeHash, fact.acceptedAt, owner, fact.shiftId, fact.acceptedAt],
  );
  const matching = candidates.filter((row) => {
    const scan = resolveWarehouseReprintScan(row.raw);
    return scan.kind === "unit" && scan.codeHash === codeHash;
  });
  let storedRaw = matching[0]?.raw;
  if (new Set(matching.map((row) => row.raw)).size > 1) return null;
  if (!storedRaw) {
    // A pre-correction fact may be the last surviving original; retain it until safe history cleanup.
    const [legacy] = await exec.all<{ canonical_raw: string }>(
      `SELECT canonical_raw FROM unit_label_facts WHERE code_hash=? AND shift_id=? AND accepted_at=? AND (owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) OR (owner='' AND NOT EXISTS(SELECT 1 FROM station_device_recovery))) LIMIT 1`,
      [codeHash, fact.shiftId, fact.acceptedAt, owner],
    );
    if (!legacy?.canonical_raw) return null;
    const scan = resolveWarehouseReprintScan(legacy.canonical_raw);
    if (scan.kind !== "unit" || scan.codeHash !== codeHash) return null;
    storedRaw = legacy.canonical_raw;
  }
  const raw = parseDuplicateKm(storedRaw).raw;
  const value = {
    kind: "unit" as const,
    sourceId: codeHash,
    identity: codeHash,
    productName: fact.fields["product.name"],
    chzProductGroupCode: group,
    fields: { ...fact.fields, "km.code": raw },
    unavailableFields: unitLabelFactsUnavailableFields(fact),
    payloadDigest: productLabelBytesDigest(new TextEncoder().encode(raw)),
    sourceShiftId: fact.shiftId,
  };
  return warehouseSourceSchema.parse({ ...value, revision: productLabelValueDigest(value) });
}
