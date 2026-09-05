import { isTlcSourceReferenceUrl } from "@markiro/domain";
import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { listUsPartiesQuerySchema } from "./master-data.js";
import {
  changeLotStatusSchema,
  preservedTlcSchema,
  tlcAssignmentBasisSchema,
  tlcSchema,
  traceabilityLotStatusSchema,
} from "./lots.js";

export const traceabilityLotSourceSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("location"), locationId: platformUuidSchema }).strict(),
    z
      .object({
        kind: z.literal("reference"),
        referenceKind: z.literal("web_url"),
        referenceValue: z.string().max(1024).refine(isTlcSourceReferenceUrl),
        resolvedLocationId: platformUuidSchema,
      })
      .strict(),
  ])
  .nullable();

export const createTraceabilityLotSchema = z
  .object({
    productId: platformUuidSchema,
    tlc: tlcSchema,
    source: traceabilityLotSourceSchema,
    // Recognize vocabulary here; the service rejects reserved/other-operation bases with 422.
    assignmentBasis: tlcAssignmentBasisSchema.default("imported"),
  })
  .strict();

const actor = z
  .string()
  .max(128)
  .refine((value) => value.trim().length > 0);
export const traceabilityLotSchema = z
  .object({
    id: platformUuidSchema,
    productId: platformUuidSchema,
    tlc: preservedTlcSchema,
    source: traceabilityLotSourceSchema,
    assignmentBasis: tlcAssignmentBasisSchema,
    status: traceabilityLotStatusSchema,
    revision: z.number().int().min(1).max(2147483647),
    createdBy: actor,
    updatedBy: actor,
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const postLotStatusSchema = changeLotStatusSchema.safeExtend({
  expectedRevision: z.number().int().min(1).max(2147483646),
});

export const listTraceabilityLotsQuerySchema = listUsPartiesQuerySchema
  .pick({ limit: true, offset: true, search: true })
  .extend({
    productId: platformUuidSchema.optional(),
    tlc: tlcSchema.optional(),
    sourceLocationId: platformUuidSchema.optional(),
    assignmentBasis: tlcAssignmentBasisSchema.optional(),
    status: traceabilityLotStatusSchema.optional(),
  })
  .strict();

export const traceabilityLotListSchema = z
  .object({
    items: z.array(traceabilityLotSchema).max(100),
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0).max(100000),
  })
  .strict()
  .refine((value) => value.items.length <= value.limit, "Item count exceeds response limit");

export type TraceabilityLotSource = z.infer<typeof traceabilityLotSourceSchema>;
export type TraceabilityLot = z.infer<typeof traceabilityLotSchema>;
export type TraceabilityLotList = z.infer<typeof traceabilityLotListSchema>;
export type CreateTraceabilityLotInput = z.infer<typeof createTraceabilityLotSchema>;
export type PostLotStatusInput = z.infer<typeof postLotStatusSchema>;
export type ListTraceabilityLotsQuery = z.infer<typeof listTraceabilityLotsQuerySchema>;
