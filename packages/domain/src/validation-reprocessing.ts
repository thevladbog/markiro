import { z } from "zod";

export const VALIDATION_REPROCESSING_PROTOCOL = "validation-reprocessing-v1";
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const id = z.uuid().toLowerCase();
const validationOccurrenceFields = z.strictObject({
  shiftId: id,
  codeHash: hash,
  scannedAt: z.iso.datetime(),
  outcome: z.enum(["first_accepted", "reprocessed", "conflict"]),
  ownership: z.literal("released").optional(),
});
const validReceiptOwnership = (receipt: { outcome: string; ownership?: "released" | undefined }) =>
  receipt.ownership === undefined || receipt.outcome === "first_accepted";
export const validationOccurrenceOutcomeSchema = validationOccurrenceFields.refine(
  validReceiptOwnership,
  {
    message: "Released ownership requires an ordinary historical acceptance",
  },
);
export type ValidationOccurrenceOutcome = z.infer<typeof validationOccurrenceOutcomeSchema>;
export const validationCodeHistoryQuerySchema = z
  .strictObject({
    cursor: z.string().max(200).optional(),
    snapshot: hash.optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
  })
  .refine((value) => !value.cursor || !!value.snapshot, { message: "Cursor requires snapshot" });
export const validationCodeHistorySchema = z.strictObject({
  protocol: z.literal(VALIDATION_REPROCESSING_PROTOCOL),
  shiftId: id,
  productId: id,
  snapshot: hash,
  fetchedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  nextCursor: z.string().nullable(),
  complete: z.boolean(),
  items: z.array(
    z.strictObject({
      codeHash: hash,
      kind: z.enum(["original", "reprocessing"]),
      shiftId: id,
      shiftNumber: z.string(),
      shiftStatus: z.enum(["planned", "active", "closed"]),
      scannedAt: z.iso.datetime(),
    }),
  ),
});
export type ValidationCodeHistory = z.infer<typeof validationCodeHistorySchema>;
export type ValidationCodeHistoryQuery = z.infer<typeof validationCodeHistoryQuerySchema>;

export const validationOccurrenceStatusQuerySchema = z.strictObject({
  occurrences: z
    .array(z.strictObject({ shiftId: id, codeHash: hash, scannedAt: z.iso.datetime() }))
    .max(500),
});
export const validationOccurrenceStatusSchema = z.strictObject({
  protocol: z.literal(VALIDATION_REPROCESSING_PROTOCOL),
  occurrences: z
    .array(
      validationOccurrenceFields
        .extend({
          outcome: z.enum(["first_accepted", "reprocessed", "conflict", "pending"]),
        })
        .refine(validReceiptOwnership, {
          message: "Released ownership requires an ordinary historical acceptance",
        }),
    )
    .max(500),
});
export type ValidationOccurrenceStatusQuery = z.infer<typeof validationOccurrenceStatusQuerySchema>;
export type ValidationOccurrenceStatus = z.infer<typeof validationOccurrenceStatusSchema>;

export const validationReprocessingDetailsQuerySchema = z.strictObject({
  cursor: hash.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const validationReprocessingDetailsSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      codeHash: hash,
      canonicalRaw: z.string(),
      sourceShift: z.strictObject({
        id,
        number: z.string(),
        productName: z.string(),
        date: z.string().nullable(),
      }),
      occurrence: z.strictObject({
        shiftId: id,
        deviceId: id,
        operatorId: id.nullable(),
        scannedAt: z.iso.datetime(),
      }),
    }),
  ),
  nextCursor: hash.nullable(),
});
export type ValidationReprocessingDetailsQuery = z.infer<
  typeof validationReprocessingDetailsQuerySchema
>;
