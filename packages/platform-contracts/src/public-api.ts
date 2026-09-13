import { z } from "zod";

export const PUBLIC_API_SCOPES = [
  "catalog.products.read",
  "inventory.read",
  "inventory.prepare",
  "inventory.start",
] as const;
export type PublicApiScope = (typeof PUBLIC_API_SCOPES)[number];
export const publicApiScopesSchema = z
  .array(z.enum(PUBLIC_API_SCOPES))
  .refine((scopes) => new Set(scopes).size === scopes.length, "Scopes must be unique");
export const publicApiKeyCreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    scopes: publicApiScopesSchema.default([]),
  })
  .strict();
export const publicApiKeyUpdateSchema = z.object({ scopes: publicApiScopesSchema }).strict();

const uuid = z.string().uuid();
const count = z.number().int().nonnegative();
export const publicInventoryStatusSchema = z.enum([
  "draft",
  "preparing",
  "ready",
  "cancelled",
  "running",
  "closed",
  "completed",
]);
export const publicInventorySchema = z
  .object({
    id: uuid,
    number: z.string(),
    status: publicInventoryStatusSchema,
    mode: z.enum(["check", "repack"]),
    productId: uuid,
    lineId: uuid,
    productionDateFrom: z.string(),
    productionDateTo: z.string(),
    activeSnapshotId: uuid.nullable(),
    resultRevision: count,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export const publicInventoriesSchema = z.object({ items: z.array(publicInventorySchema) }).strict();
export const publicProductSchema = z
  .object({
    id: uuid,
    gtin14: z.string(),
    name: z.string(),
    status: z.enum(["draft", "active"]),
    boxCapacity: count.nullable(),
  })
  .strict();
export const publicProductsSchema = z.object({ items: z.array(publicProductSchema) }).strict();
export const publicImportSchema = z
  .object({
    id: uuid,
    declaredStatus: z.string(),
    parsedStatus: z.string().nullable(),
    result: z.enum(["succeeded", "failed"]),
    rowCount: count,
    errorCount: count,
    duplicateCount: count,
    sha256: z.string(),
    diagnostics: z.array(z.object({ code: z.string(), rowNumber: count.optional() }).strict()),
  })
  .strict();
export const publicSnapshotSchema = z
  .object({
    id: uuid,
    inventoryId: uuid,
    revision: count,
    combinedDigest: z.string(),
    fixedAt: z.string(),
    counts: z
      .object({
        emitted: count,
        introduced: count,
        applied: count,
        retired: count,
        writtenOff: count,
        disaggregation: count,
        protected: count,
        expected: count,
        packages: count,
        loose: count,
      })
      .strict(),
  })
  .strict();
export const publicInventoryStartSchema = z
  .object({ inventoryId: uuid, snapshotId: uuid, status: z.literal("running") })
  .strict();
export const publicInventoryProgressSchema = z
  .object({
    inventoryId: uuid,
    snapshotId: uuid,
    status: publicInventoryStatusSchema,
    resultRevision: count,
    expectedCount: count,
    verifiedCount: count,
    missingCount: count,
    protectedCount: count,
    protectedFoundCount: count,
    ineligibleCount: count,
    unknownCount: count,
    dateMismatchCount: count,
    voidedCount: count,
    oldBoxCount: count,
    newBoxCount: count,
    invalidatedBoxCount: count,
    pendingEventCount: count,
    openBoxCount: count,
  })
  .strict();
export const publicResultClassificationSchema = z.enum([
  "expected",
  "protected",
  "ineligible",
  "unknown",
  "voided",
]);
export const publicInventoryResultSchema = z
  .object({
    eventId: uuid,
    kind: z.enum(["item", "known_box", "old_box"]),
    displayIdentity: z.string(),
    authoritativeVerdict: z.string(),
    scannedAt: z.string(),
    classification: publicResultClassificationSchema.nullable(),
    observedProductionDate: z.string().nullable(),
    affectedCodeCount: count,
  })
  .strict();
export const publicInventoryResultsSchema = z
  .object({ items: z.array(publicInventoryResultSchema), nextCursor: z.string().nullable() })
  .strict();
