import type { PublicApiTransaction } from "../public-api/public-api.types";
import { ForbiddenException } from "@nestjs/common";
import { INVENTORY_CHZ_STATUSES } from "@markiro/domain";
import { z } from "zod";
import type { PublicApiOwnerRequest } from "../public-api/public-api-request.service";
import { INVENTORY_LIFECYCLE_STATUSES, fixInventorySnapshotSchema } from "./dto";
export type InventoryActor =
  { domain: "cabinet"; userId: string } | { domain: "api_key"; keyId: string };
export function inventoryActor(
  input: string | InventoryActor,
  request?: PublicApiOwnerRequest,
): InventoryActor {
  const actor = typeof input === "string" ? { domain: "cabinet" as const, userId: input } : input;
  if (actor.domain === "api_key" && (!request || request.actor.keyId !== actor.keyId))
    throw new ForbiddenException("Public actor requires owner admission");
  if (actor.domain === "cabinet" && request)
    throw new ForbiddenException("Public request cannot impersonate cabinet");
  return actor;
}
export const actorUserId = (actor: InventoryActor) =>
  actor.domain === "cabinet" ? actor.userId : null;
export const actorKeyId = (actor: InventoryActor) =>
  actor.domain === "api_key" ? actor.keyId : null;
export const actorAudit = (actor: InventoryActor) =>
  actor.domain === "cabinet"
    ? { actorUserId: actor.userId }
    : { actorUserId: null, actorDomain: "api_key", actorId: actor.keyId };
export const inventoryReceiptSchema = z
  .object({
    id: z.string(),
    number: z.string(),
    status: z.enum(INVENTORY_LIFECYCLE_STATUSES),
    mode: z.enum(["check", "repack"]),
    productId: z.string(),
    gtin14: z.string(),
    productName: z.string(),
    lineId: z.string(),
    lineName: z.string(),
    productionDateFrom: z.string(),
    productionDateTo: z.string(),
    boxLabelTemplateId: z.string().nullable(),
    boxLabelTemplate: z.object({ id: z.string(), name: z.string() }).nullable(),
    activeSnapshotId: z.string().nullable(),
    resultRevision: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export const importReceiptSchema = z
  .object({
    id: z.string(),
    declaredStatus: z.enum(INVENTORY_CHZ_STATUSES),
    parsedStatus: z.enum(INVENTORY_CHZ_STATUSES).nullable(),
    result: z.enum(["succeeded", "failed"]),
    rowCount: z.number(),
    errorCount: z.number(),
    duplicateCount: z.number(),
    sha256: z.string(),
    diagnostics: z.array(
      z
        .object({ code: z.string(), rowNumber: z.number().optional() })
        .transform((v) =>
          v.rowNumber === undefined ? { code: v.code } : { code: v.code, rowNumber: v.rowNumber },
        ),
    ),
  })
  .strict();
export const snapshotReceiptSchema = z
  .object({
    id: z.string(),
    inventoryId: z.string(),
    revision: z.number(),
    combinedDigest: z.string(),
    fixedAt: z.string(),
    inputs: fixInventorySnapshotSchema.shape.imports,
    counts: z.object({
      emitted: z.number(),
      introduced: z.number(),
      applied: z.number(),
      retired: z.number(),
      writtenOff: z.number(),
      disaggregation: z.number(),
      protected: z.number(),
      expected: z.number(),
      packages: z.number(),
      loose: z.number(),
    }),
  })
  .strict();

export function runInventoryOwner<T>(
  tx: PublicApiTransaction,
  request: PublicApiOwnerRequest | undefined,
  parse: (value: unknown) => T,
  action: () => Promise<T>,
): Promise<T> {
  return request ? request.run(tx, parse, action) : action();
}
