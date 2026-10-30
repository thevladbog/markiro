import { z } from "zod";

// Office disaggregation documents (plan ДЗГ): mirrors
// `markiro_proto::disaggregation`. Answers are lenient (`z.object`), bodies
// strict (`.strict()`), as the Rust types; `proto/fixtures/disaggregation-*.json`
// and `changes-code-releases.json` hold the shapes both sides read.

/** Lines of one `POST …/lines` (`MAX_LINES_PER_REQUEST`). */
export const DISAGGREGATION_MAX_LINES_PER_REQUEST = 500;
/** Lines of one document (`MAX_LINES_PER_DOCUMENT`, the cloud's import limit). */
export const DISAGGREGATION_MAX_LINES_PER_DOCUMENT = 10_000;
/** `details.constraint` of a document's `conflict` (`constraints::ALL`). */
export const DISAGGREGATION_CONSTRAINTS = [
  "document_not_draft",
  "reason_required",
  "no_lines",
  "invalid_lines",
  "restore_hold",
  "document_not_applied",
] as const;

export const disaggregationStatusSchema = z.enum(["draft", "applied", "cancelled"]);
export const disaggregationSourceSchema = z.enum(["manual", "import"]);
export const disaggregationLineStatusSchema = z.enum([
  "ok",
  "not_found",
  "not_closed",
  "shift_open",
  "already_disassembled",
  "duplicate",
]);
const ssccSchema = z.string().regex(/^\d{18}$/u);

export const disaggregationReasonSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  sortOrder: z.number().int(),
  archived: z.boolean(),
  rev: z.number().int(),
});
export const disaggregationReasonCreateSchema = z
  .object({ name: z.string(), sortOrder: z.number().int() })
  .strict();
export const disaggregationReasonUpdateSchema = z
  .object({
    name: z.string(),
    sortOrder: z.number().int(),
    archived: z.boolean(),
    expectedRev: z.number().int(),
  })
  .strict();

export const disaggregationDocumentSchema = z.object({
  id: z.uuid(),
  docNo: z.string().regex(/^DSG-\d{2}-\d{4,}$/u),
  status: disaggregationStatusSchema,
  reasonId: z.uuid().nullable(),
  reasonName: z.string().nullable(),
  comment: z.string().nullable(),
  source: disaggregationSourceSchema,
  lineCount: z.number().int().nonnegative(),
  codeCount: z.number().int().nonnegative(),
  createdBy: z.string(),
  createdByName: z.string(),
  createdAt: z.string(),
  appliedAt: z.string().nullable(),
  appliedBy: z.string().nullable(),
  appliedByName: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelledBy: z.string().nullable(),
  rev: z.number().int(),
});
export const disaggregationLineSchema = z.object({
  id: z.uuid(),
  cloudHistory: z.literal(true).optional(),
  ssccInput: z.string(),
  sscc: ssccSchema.nullable(),
  boxId: z.uuid().nullable(),
  palletId: z.uuid().nullable(),
  warehousePalletId: z.uuid().optional(),
  shiftId: z.uuid().nullable(),
  shiftNumber: z.string().nullable(),
  status: disaggregationLineStatusSchema,
  productId: z.uuid().nullable(),
  productName: z.string().nullable(),
  codeCount: z.number().int().nonnegative(),
  validatedAt: z.string(),
});
export const disaggregationDetailSchema = z.object({
  document: disaggregationDocumentSchema,
  lines: z.array(disaggregationLineSchema),
});
export const disaggregationCreateSchema = z
  .object({ reasonId: z.uuid().nullable(), comment: z.string().nullable() })
  .strict();
export const disaggregationUpdateSchema = z
  .object({
    reasonId: z.uuid().nullable(),
    comment: z.string().nullable(),
    expectedRev: z.number().int(),
  })
  .strict();
export const disaggregationLineInputSchema = z
  .object({ input: z.string(), sscc: ssccSchema.nullable() })
  .strict();
export const disaggregationLinesAddSchema = z
  .object({
    lines: z.array(disaggregationLineInputSchema).min(1).max(DISAGGREGATION_MAX_LINES_PER_REQUEST),
    import: z.boolean(),
  })
  .strict();
export const disaggregationTransitionSchema = z.object({ expectedRev: z.number().int() }).strict();

/** `data` of a `code_releases` feed item; the item's `id` is the box's. */
export const codeReleaseRecordSchema = z.object({
  shiftId: z.uuid(),
  documentId: z.uuid(),
  releasedAt: z.string(),
  codeCount: z.number().int().nonnegative(),
});

export type DisaggregationStatus = z.infer<typeof disaggregationStatusSchema>;
export type DisaggregationSource = z.infer<typeof disaggregationSourceSchema>;
export type DisaggregationLineStatus = z.infer<typeof disaggregationLineStatusSchema>;
export type DisaggregationReason = z.infer<typeof disaggregationReasonSchema>;
export type DisaggregationReasonCreate = z.infer<typeof disaggregationReasonCreateSchema>;
export type DisaggregationReasonUpdate = z.infer<typeof disaggregationReasonUpdateSchema>;
export type DisaggregationDocument = z.infer<typeof disaggregationDocumentSchema>;
export type DisaggregationLine = z.infer<typeof disaggregationLineSchema>;
export type DisaggregationDetail = z.infer<typeof disaggregationDetailSchema>;
export type DisaggregationCreate = z.infer<typeof disaggregationCreateSchema>;
export type DisaggregationUpdate = z.infer<typeof disaggregationUpdateSchema>;
export type DisaggregationLineInput = z.infer<typeof disaggregationLineInputSchema>;
export type DisaggregationLinesAdd = z.infer<typeof disaggregationLinesAddSchema>;
export type DisaggregationTransition = z.infer<typeof disaggregationTransitionSchema>;
export type CodeReleaseRecord = z.infer<typeof codeReleaseRecordSchema>;

/** The list's filters (Р16): instants of the host's format, not dates. */
export interface DisaggregationFilter {
  status?: DisaggregationStatus;
  reasonId?: string;
  from?: string;
  to?: string;
  q?: string;
}

/** The query string of `GET /v1/office/disaggregation`, keys in a fixed order. */
export function disaggregationQuery(filter: DisaggregationFilter = {}): string {
  const params = new URLSearchParams();
  for (const key of ["status", "reasonId", "from", "to", "q"] as const) {
    const value = filter[key];
    if (value !== undefined && value !== "") params.set(key, value);
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

const bareSsccSchema = z.string().regex(/^\d{18}$/u);

export const disaggregationReportVariantSchema = z.enum(["boxes", "full"]);
export type DisaggregationReportVariant = z.infer<typeof disaggregationReportVariantSchema>;

/** Mirrors `markiro_proto::disaggregation::DisaggregationReportRows` (plan ДЗГ-О). */
export const disaggregationReportRowsSchema = z.object({
  id: z.uuid(),
  docNo: z.string().min(1),
  status: disaggregationStatusSchema,
  createdAt: z.iso.datetime(),
  appliedAt: z.iso.datetime().nullable(),
  createdByName: z.string().nullable(),
  appliedByName: z.string().nullable(),
  reasonName: z.string().nullable(),
  comment: z.string().nullable(),
  organization: z.object({ name: z.string(), inn: z.string().nullable() }),
  variant: disaggregationReportVariantSchema,
  lines: z.array(
    z.object({
      id: z.uuid(),
      sscc: bareSsccSchema,
      boxId: z.string().nullable(),
      palletId: z.string().nullable(),
      productName: z.string().nullable(),
      codeCount: z.number().int().min(0),
      items: z.array(z.object({ gtin14: z.string(), serial: z.string(), canonical: z.string() })),
      boxes: z.array(z.object({ sscc: bareSsccSchema.nullable(), units: z.number().int().min(0) })),
    }),
  ),
});
export type DisaggregationReportRows = z.infer<typeof disaggregationReportRowsSchema>;

export const DISAGGREGATION_XML_FORMAT_ID = "disaggregation_xml_gismt";
export const DISAGGREGATION_XML_FORMAT_VERSION = 1;

/** Mirrors `DisaggregationExportRecord`: what the office tells the host about the saved ЧЗ file. */
export const disaggregationExportRecordSchema = z
  .object({
    formatId: z.literal(DISAGGREGATION_XML_FORMAT_ID),
    formatVersion: z.literal(DISAGGREGATION_XML_FORMAT_VERSION),
    packingCount: z.number().int().min(1),
  })
  .strict();
export type DisaggregationExportRecord = z.infer<typeof disaggregationExportRecordSchema>;
