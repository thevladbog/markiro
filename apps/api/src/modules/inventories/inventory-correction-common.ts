import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import type { schema, Db } from "@markiro/db";

export type CorrectionTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type CodeResultProjectionInput = Pick<
  typeof schema.inventoryCodeResults.$inferSelect,
  "id" | "classification" | "observedProductionDate" | "updatedAt"
>;
export type InventoryProgressResult = Pick<
  typeof schema.inventoryCodeResults.$inferSelect,
  | "codeHash"
  | "classification"
  | "observedProductionDate"
  | "firstAcceptedEventId"
  | "winningDeviceId"
  | "winningScannedAt"
>;

export function inventoryProjectionDigest(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function inventoryCorrectionUuid(
  namespace: "single" | "batch" | "batch-child",
  ...parts: readonly string[]
): string {
  const prefix =
    namespace === "single"
      ? "markiro:inventory-correction:v1\0"
      : `markiro:inventory-correction-${namespace}:v1\0`;
  const hash = createHash("sha256").update(prefix, "utf8");
  parts.forEach((part, index) => {
    if (index > 0) hash.update("\0", "utf8");
    hash.update(part, "utf8");
  });
  const bytes = hash.digest().subarray(0, 16);
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error("Correction identity digest is shorter than a UUID");
  }
  bytes[6] = (versionByte & 0x0f) | 0x50;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function codeResultProjection(result: CodeResultProjectionInput): Record<string, unknown> {
  return {
    kind: "code_result",
    id: result.id,
    classification: result.classification,
    observedProductionDate: result.observedProductionDate,
    updatedAt: result.updatedAt.toISOString(),
  };
}

export async function readCorrectionTimestamp(tx: CorrectionTransaction): Promise<Date> {
  const result = await tx.execute(sql`select clock_timestamp() as "changedAt"`);
  const row = result.rows[0];
  const rawChangedAt =
    typeof row === "object" && row !== null ? Reflect.get(row, "changedAt") : undefined;
  const changedAt =
    rawChangedAt instanceof Date
      ? rawChangedAt
      : typeof rawChangedAt === "string"
        ? new Date(rawChangedAt)
        : new Date(Number.NaN);
  if (Number.isNaN(changedAt.getTime())) {
    throw new Error("Database did not return a correction timestamp");
  }
  return changedAt;
}

export function inventoryProgressChangeRow(input: {
  tenantId: string;
  inventoryId: string;
  snapshotId: string;
  resultRevision: number;
  result: InventoryProgressResult;
  changedAt: Date;
}): typeof schema.inventoryProgressChanges.$inferInsert {
  return {
    tenantId: input.tenantId,
    inventoryId: input.inventoryId,
    snapshotId: input.snapshotId,
    resultRevision: input.resultRevision,
    kind: "correction",
    codeHash: input.result.codeHash,
    classification: input.result.classification,
    observedProductionDate: input.result.observedProductionDate,
    winningEventId: input.result.firstAcceptedEventId,
    winningDeviceId: input.result.winningDeviceId,
    winningScannedAt: input.result.winningScannedAt,
    changedAt: input.changedAt,
  };
}
