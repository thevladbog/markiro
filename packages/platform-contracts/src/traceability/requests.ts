import { isTlcSourceReferenceUrl } from "@markiro/domain";
import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { traceabilityCivilDateSchema } from "./event-values.js";
import { preservedTlcSchema } from "./lots.js";
import { cTextOrder } from "./search-lot-card.js";

const boundedText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value === value.trim() && !/[\p{Cc}\p{Cs}]/u.test(value));
const requestNumber = boundedText(80);
const distinct = (items: readonly string[]) => new Set(items).size === items.length;
// Preserve the supplied representation, but never permit Date to truncate its instant.
const requestInstantSchema = z.iso.datetime({ offset: true }).refine(
  (value) => {
    const fraction = /\.(\d+)/.exec(value)?.[1];
    return fraction === undefined || !/[1-9]/.test(fraction.slice(3));
  },
  { message: "Instant must be exactly representable in milliseconds" },
);

export const usTraceRequestScopeV1Schema = z
  .object({
    productId: platformUuidSchema.optional(),
    productText: boundedText(200).optional(),
    tlc: preservedTlcSchema.optional(),
    tlcs: z.array(preservedTlcSchema).min(1).max(50).optional(),
    tlcFrom: preservedTlcSchema.optional(),
    tlcTo: preservedTlcSchema.optional(),
    lotId: platformUuidSchema.optional(),
    locationIds: z.array(platformUuidSchema).min(1).max(50).optional(),
    sourceReferenceValue: boundedText(1024).refine(isTlcSourceReferenceUrl).optional(),
    documentNumber: boundedText(128).optional(),
    eventDateFrom: traceabilityCivilDateSchema.optional(),
    eventDateTo: traceabilityCivilDateSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.values(value).every((field) => field === undefined))
      context.addIssue({ code: "custom", path: [], message: "At least one selector required" });
    if (value.tlcs && !distinct(value.tlcs))
      context.addIssue({ code: "custom", path: ["tlcs"], message: "Duplicate TLC" });
    if (value.locationIds && !distinct(value.locationIds))
      context.addIssue({ code: "custom", path: ["locationIds"], message: "Duplicate location" });
    if (value.tlcFrom && value.tlcTo && cTextOrder(value.tlcFrom, value.tlcTo) > 0)
      context.addIssue({ code: "custom", path: ["tlcTo"], message: "Reversed TLC range" });
    if (value.eventDateFrom && value.eventDateTo && value.eventDateFrom > value.eventDateTo)
      context.addIssue({ code: "custom", path: ["eventDateTo"], message: "Reversed date range" });
  });

/** Shape only: the server command boundary resolves the deadline policy. */
export const usTraceRequestCreateBodySchema = z
  .object({
    requestNumber,
    requesterName: boundedText(200),
    requesterOrganization: boundedText(200).nullable(),
    requesterContact: boundedText(500).nullable(),
    receivedAt: requestInstantSchema,
    dueAt: requestInstantSchema.optional(),
    alternateDeadlineReason: boundedText(2000).nullable().optional(),
    scope: usTraceRequestScopeV1Schema.nullable(),
  })
  .strict();
export const usTraceRequestUpdateBodySchema = usTraceRequestCreateBodySchema
  .partial()
  .extend({ expectedRevision: z.number().int().positive() })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== "expectedRevision"));
export const usTraceRequestCloseBodySchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();
export const usTraceRequestPrepareBodySchema = z
  .object({
    mode: z.enum(["export_ready", "available_records_incomplete"]),
    idempotencyKey: platformUuidSchema,
  })
  .strict();

export type UsTraceRequestScopeV1 = z.infer<typeof usTraceRequestScopeV1Schema>;
export type UsTraceRequestCreateBody = z.infer<typeof usTraceRequestCreateBodySchema>;
export type UsTraceRequestUpdateBody = z.infer<typeof usTraceRequestUpdateBodySchema>;
export type UsTraceRequestCloseBody = z.infer<typeof usTraceRequestCloseBodySchema>;
export type UsTraceRequestPrepareBody = z.infer<typeof usTraceRequestPrepareBodySchema>;
