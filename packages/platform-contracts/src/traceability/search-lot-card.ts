import { isTlcSourceReferenceUrl, isValidSscc, UOM_CODES_V1 } from "@markiro/domain";
import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { caseUnlinkCommandSchema } from "./case-bridge.js";
import { referenceDocumentTypeSchema } from "./documents.js";
import { traceabilityCivilDateSchema } from "./event-values.js";
import { traceabilityLotSourceSchema } from "./lot-records.js";
import { preservedTlcSchema, traceabilityLotStatusSchema } from "./lots.js";
import { shippingBalanceResponseSchema } from "./shipping-http.js";
import { productDescriptionSnapshotSchema } from "./products.js";

const boundedLimit = (maximum: number) =>
  z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(maximum));
const text = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));
const instant = z.iso.datetime({ offset: true });
const utcInstant = z.iso.datetime();
const cursorText = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(512);
const eventType = z.enum(["receiving", "transformation", "shipping"]);
const quantity = z.string().regex(/^(?:0|[1-9]\d{0,14})(?:\.\d{1,3})?$/);
const positiveEvidenceQuantity = quantity.refine((value) => /[1-9]/.test(value));
const uom = z.enum(UOM_CODES_V1);
/** Transformation/Shipping snapshots freeze custom `other` labels as the document type. */
const frozenDocumentType = z.union([referenceDocumentTypeSchema, text(2000)]);
const savedCaseUnlinkReason = z
  .string()
  .refine((value) => value === value.trim())
  .pipe(caseUnlinkCommandSchema.shape.reason);

const tlcList = z
  .string()
  .max(8192)
  .refine((raw) => new TextEncoder().encode(raw).length <= 8192, "TLC list exceeds 8 KiB")
  .transform((raw, context): string[] => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      context.addIssue({ code: "custom", message: "Expected a JSON TLC array" });
      return z.NEVER;
    }
    if (!Array.isArray(decoded) || decoded.length < 1 || decoded.length > 50) {
      context.addIssue({ code: "custom", message: "Expected 1–50 TLCs" });
      return z.NEVER;
    }
    const parsed = z.array(preservedTlcSchema).safeParse(decoded);
    if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
      context.addIssue({ code: "custom", message: "Expected distinct canonical TLCs" });
      return z.NEVER;
    }
    return parsed.data;
  })
  .optional()
  .transform((value) => value ?? null);

function cTextOrder(left: string, right: string): number {
  const first = new TextEncoder().encode(left);
  const second = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(first.length, second.length); index++) {
    const difference = (first[index] ?? 0) - (second[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return first.length - second.length;
}

const searchFilterFields = {
  q: text(200).optional(),
  tlc: preservedTlcSchema.optional(),
  tlcList,
  tlcFrom: preservedTlcSchema.optional(),
  tlcTo: preservedTlcSchema.optional(),
  lotId: platformUuidSchema.optional(),
  productId: platformUuidSchema.optional(),
  productText: text(200).optional(),
  sourceLocationId: platformUuidSchema.optional(),
  sourceReferenceValue: text(1024).refine(isTlcSourceReferenceUrl).optional(),
  eventType: eventType.optional(),
  eventDateFrom: traceabilityCivilDateSchema.optional(),
  eventDateTo: traceabilityCivilDateSchema.optional(),
  locationId: platformUuidSchema.optional(),
  documentType: frozenDocumentType.optional(),
  documentNumber: text(128).optional(),
  sscc: z.string().refine(isValidSscc, "Expected a bare valid SSCC").optional(),
  status: traceabilityLotStatusSchema.optional(),
  limit: boundedLimit(100).default(50),
};

function orderedFilters(
  value: {
    tlcFrom?: string | undefined;
    tlcTo?: string | undefined;
    eventDateFrom?: string | undefined;
    eventDateTo?: string | undefined;
  },
  context: z.RefinementCtx,
) {
  if (
    value.tlcFrom !== undefined &&
    value.tlcTo !== undefined &&
    cTextOrder(value.tlcFrom, value.tlcTo) > 0
  )
    context.addIssue({ code: "custom", path: ["tlcTo"], message: "Reversed lexical TLC range" });
  if (
    value.eventDateFrom !== undefined &&
    value.eventDateTo !== undefined &&
    value.eventDateFrom > value.eventDateTo
  )
    context.addIssue({
      code: "custom",
      path: ["eventDateTo"],
      message: "Reversed event-date range",
    });
}

/** Raw HTTP query values become typed filters; duplicate URL keys are rejected by the controller. */
export const usTraceSearchQuerySchema = z
  .object({ ...searchFilterFields, cursor: cursorText.optional() })
  .strict()
  .superRefine(orderedFilters);
export const usTraceSearchCursorSchema = z
  .object({ createdAt: utcInstant, lotId: platformUuidSchema })
  .strict();
export type UsTraceSearchQuery = Omit<z.output<typeof usTraceSearchQuerySchema>, "cursor"> & {
  cursor: z.infer<typeof usTraceSearchCursorSchema> | null;
};

export const usLotCardEvidenceQuerySchema = z
  .object({ limit: boundedLimit(50).default(20), cursor: cursorText.optional() })
  .strict();
export const usLotCardEvidenceCursorSchema = z
  .object({ eventDate: traceabilityCivilDateSchema, eventId: platformUuidSchema })
  .strict();
export type UsLotCardEvidenceQuery = Omit<
  z.output<typeof usLotCardEvidenceQuerySchema>,
  "cursor"
> & {
  cursor: z.infer<typeof usLotCardEvidenceCursorSchema> | null;
};

export const usTraceSearchAppliedFiltersSchema = z
  .object({
    ...searchFilterFields,
    tlcList: z.array(preservedTlcSchema).min(1).max(50).nullable(),
    limit: z.number().int().min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    orderedFilters(value, context);
    if (value.tlcList !== null && new Set(value.tlcList).size !== value.tlcList.length)
      context.addIssue({ code: "custom", path: ["tlcList"], message: "Duplicate TLC filter" });
  });

const matchedBy = z.enum([
  "tlc",
  "lot_id",
  "product_id",
  "product_text_current",
  "source_location",
  "source_reference",
  "event_type",
  "event_date",
  "location",
  "document_type",
  "document_number",
  "sscc_current",
  "sscc_historical",
  "status",
]);
export const usTraceSearchSsccLinkSchema = z
  .object({
    linkId: platformUuidSchema,
    boxId: platformUuidSchema,
    ssccAtLink: z.string().refine(isValidSscc),
    state: z.enum(["current", "historical"]),
    provenance: z.enum(["synthetic_demo", "existing_record"]),
    linkedAt: instant,
    unlinkedAt: instant.nullable(),
    unlinkReason: savedCaseUnlinkReason.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.state === "current"
        ? value.unlinkedAt !== null || value.unlinkReason !== null
        : value.unlinkedAt === null || value.unlinkReason === null
    )
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "SSCC link state contradicts unlink evidence",
      });
  });

const dateSpan = {
  currentCteCount: z.number().int().nonnegative(),
  firstEventDate: traceabilityCivilDateSchema.nullable(),
  lastEventDate: traceabilityCivilDateSchema.nullable(),
};
function validDateSpan(
  value: { currentCteCount: number; firstEventDate: string | null; lastEventDate: string | null },
  context: z.RefinementCtx,
) {
  if (
    (value.firstEventDate === null) !== (value.lastEventDate === null) ||
    (value.currentCteCount === 0) !== (value.firstEventDate === null) ||
    (value.firstEventDate !== null &&
      value.lastEventDate !== null &&
      value.firstEventDate > value.lastEventDate)
  )
    context.addIssue({
      code: "custom",
      path: ["firstEventDate"],
      message: "Invalid current CTE date span",
    });
}

export const usTraceSearchHitSchema = z
  .object({
    lotId: platformUuidSchema,
    tlc: preservedTlcSchema,
    productId: platformUuidSchema,
    source: traceabilityLotSourceSchema,
    status: traceabilityLotStatusSchema,
    matchedBy: z.array(matchedBy).max(14),
    ...dateSpan,
    ssccLinks: z.array(usTraceSearchSsccLinkSchema).max(20),
    moreCaseHistory: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    validDateSpan(value, context);
    if (new Set(value.matchedBy).size !== value.matchedBy.length)
      context.addIssue({
        code: "custom",
        path: ["matchedBy"],
        message: "Duplicate match evidence",
      });
    if (
      value.matchedBy.includes("sscc_current") &&
      !value.ssccLinks.some((link) => link.state === "current")
    )
      context.addIssue({
        code: "custom",
        path: ["matchedBy"],
        message: "Current SSCC match lacks current link evidence",
      });
    if (
      value.matchedBy.includes("sscc_historical") &&
      !value.ssccLinks.some((link) => link.state === "historical")
    )
      context.addIssue({
        code: "custom",
        path: ["matchedBy"],
        message: "Historical SSCC match lacks historical link evidence",
      });
  });

export const usTraceSearchPageSchema = z
  .object({
    items: z.array(usTraceSearchHitSchema).max(100),
    nextCursor: cursorText.nullable(),
    appliedFilters: usTraceSearchAppliedFiltersSchema,
    rangeOrder: z.literal("lexical_c"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.items.length > value.appliedFilters.limit)
      context.addIssue({ code: "custom", path: ["items"], message: "Search page exceeds limit" });
    if (new Set(value.items.map((item) => item.lotId)).size !== value.items.length)
      context.addIssue({ code: "custom", path: ["items"], message: "Duplicate lot identity" });
    const searchedSsccs = [
      value.appliedFilters.sscc,
      value.appliedFilters.q !== undefined && isValidSscc(value.appliedFilters.q)
        ? value.appliedFilters.q
        : undefined,
    ].filter((candidate): candidate is string => candidate !== undefined);
    if (searchedSsccs.length > 0) {
      value.items.forEach((item, index) => {
        for (const [match, state] of [
          ["sscc_current", "current"],
          ["sscc_historical", "historical"],
        ] as const) {
          if (
            item.matchedBy.includes(match) &&
            !item.ssccLinks.some(
              (link) => searchedSsccs.includes(link.ssccAtLink) && link.state === state,
            )
          )
            context.addIssue({
              code: "custom",
              path: ["items", index, "matchedBy"],
              message: "SSCC match lacks matching link evidence",
            });
        }
      });
    }
  });
export type UsTraceSearchPage = z.infer<typeof usTraceSearchPageSchema>;

const lotIdentity = z
  .object({
    id: platformUuidSchema,
    tlc: preservedTlcSchema,
    productId: platformUuidSchema,
    source: traceabilityLotSourceSchema,
    status: traceabilityLotStatusSchema,
  })
  .strict();
const balance = shippingBalanceResponseSchema.shape.balance;
// Receiving snapshots preserve UUID spelling; response validation must not normalize saved bytes.
const frozenProductDescription = productDescriptionSnapshotSchema.safeExtend({
  sourceProductId: z.uuid(),
});
// Transformation's saved string and current master names allow interior newlines.
const productDisplay = z.string().min(1).max(2000);
const originProduct = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("receiving"),
        productId: platformUuidSchema,
        description: frozenProductDescription,
      })
      .strict(),
    z
      .object({
        kind: z.literal("transformation"),
        productId: platformUuidSchema,
        description: productDisplay,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.kind === "receiving" &&
      value.productId !== value.description.sourceProductId.toLowerCase()
    )
      context.addIssue({
        code: "custom",
        path: ["description", "sourceProductId"],
        message: "Frozen source product mismatch",
      });
  });
const originProvenance = {
  eventId: platformUuidSchema,
  rootId: platformUuidSchema,
  revision: z.number().int().min(1),
  eventDate: traceabilityCivilDateSchema,
  lineNo: z.number().int().min(1).max(100),
};
const originReference = z.discriminatedUnion("kind", [
  z
    .object({
      ...originProvenance,
      kind: z.literal("receiving"),
      productId: platformUuidSchema,
      description: frozenProductDescription,
    })
    .strict(),
  z
    .object({
      ...originProvenance,
      kind: z.literal("transformation"),
      productId: platformUuidSchema,
      description: productDisplay,
    })
    .strict(),
]);
export const usLotCardSchema = z
  .object({
    lot: lotIdentity,
    currentMasterProduct: z
      .object({ id: platformUuidSchema, name: productDisplay })
      .strict()
      .nullable(),
    currentOriginProducts: z.array(originReference).max(50),
    currentOriginProductCount: z.number().int().nonnegative(),
    moreCurrentOriginProducts: z.boolean(),
    originState: z.enum(["current", "gap"]),
    caseSummary: z
      .object({
        activeCount: z.number().int().nonnegative(),
        historicalCount: z.number().int().nonnegative(),
      })
      .strict(),
    balance,
    ...dateSpan,
    links: z
      .object({
        cases: z.literal("cases"),
        trace: z.literal("trace"),
        history: z.literal("trace/history"),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    validDateSpan(value, context);
    if (
      (value.originState === "current") !== value.currentOriginProductCount > 0 ||
      value.currentOriginProducts.length !== Math.min(50, value.currentOriginProductCount) ||
      value.moreCurrentOriginProducts !== value.currentOriginProductCount > 50
    )
      context.addIssue({
        code: "custom",
        path: ["currentOriginProducts"],
        message: "Current origin snapshot mismatch",
      });
    if (
      value.currentMasterProduct !== null &&
      value.currentMasterProduct.id !== value.lot.productId
    )
      context.addIssue({
        code: "custom",
        path: ["currentMasterProduct"],
        message: "Current master product mismatch",
      });
    if (
      value.currentOriginProducts.some(
        (origin) =>
          origin.productId !== value.lot.productId ||
          (origin.kind === "receiving" &&
            origin.description.sourceProductId.toLowerCase() !== origin.productId),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["currentOriginProducts"],
        message: "Frozen origin product mismatch",
      });
  });
export type UsLotCard = z.infer<typeof usLotCardSchema>;

const evidenceLine = z
  .object({
    kind: z.enum(["receiving", "transformation_input", "transformation_output", "shipping"]),
    lineNo: z.number().int().min(1).max(100),
    quantity: positiveEvidenceQuantity,
    unitOfMeasure: uom,
    originProduct: originProduct.nullable(),
  })
  .strict()
  .superRefine((line, context) => {
    const expected =
      line.kind === "receiving"
        ? "receiving"
        : line.kind === "transformation_output"
          ? "transformation"
          : null;
    if ((line.originProduct?.kind ?? null) !== expected)
      context.addIssue({
        code: "custom",
        path: ["originProduct"],
        message: "Origin product must match the frozen line kind",
      });
  });
const evidenceDocument = z
  .object({ documentId: platformUuidSchema, type: frozenDocumentType, number: text(128) })
  .strict();
export const usLotCardEvidenceItemSchema = z
  .object({
    eventId: platformUuidSchema,
    rootId: platformUuidSchema,
    type: eventType,
    eventNumber: text(2000),
    revision: z.number().int().min(1),
    eventDate: traceabilityCivilDateSchema,
    timeZone: text(128),
    lines: z.array(evidenceLine).min(1).max(200),
    documents: z.array(evidenceDocument).max(100),
  })
  .strict();
export const usLotCardEvidencePageSchema = z
  .object({
    items: z.array(usLotCardEvidenceItemSchema).max(50),
    nextCursor: cursorText.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.items.map((item) => item.eventId)).size !== value.items.length)
      context.addIssue({ code: "custom", path: ["items"], message: "Duplicate current event" });
  });
export type UsLotCardEvidencePage = z.infer<typeof usLotCardEvidencePageSchema>;
