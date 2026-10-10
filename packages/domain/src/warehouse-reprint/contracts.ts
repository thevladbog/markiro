import { z } from "zod";
import { DomainError } from "../errors.js";
import { isValidSscc } from "../gs1/sscc.js";
import { kmHash } from "../gs1/km.js";
import { assertDuplicateTemplate } from "../labels/duplicate.js";
import { LABEL_FIELDS, labelTemplateSpecSchema } from "../labels/model.js";
import {
  parseDuplicateKm,
  productLabelBytesDigest,
  productLabelValueDigest,
} from "../product-labels/km.js";

export const WAREHOUSE_REPRINT_PROTOCOL = "warehouse-label-reprint-v1";
export const MAX_WAREHOUSE_REPRINT_EVENTS = 100;
const id = z.uuid().toLowerCase();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const warehouseReasonSchema = z.enum(["not_printed", "damaged", "lost"]);
const repair = z.literal("legacy_tspl_fnc1_literal").nullable();
const fields = z.record(z.enum(LABEL_FIELDS), z.string().max(4096));

export const warehouseLookupRequestSchema = z.strictObject({
  protocol: z.literal(WAREHOUSE_REPRINT_PROTOCOL),
  raw: z.string().min(1).max(2048),
  operatorId: id,
});
export type WarehouseLookupRequest = z.infer<typeof warehouseLookupRequestSchema>;

const templateShape = z.strictObject({
  id,
  revision: digest,
  digest,
  name: z.string().min(1).max(256),
  purpose: z.enum(["product_duplicate", "box"]),
  enabled: z.boolean(),
  chzProductGroupCodes: z.array(z.number().int().nonnegative()).max(100).nullable(),
  spec: labelTemplateSpecSchema,
});
export const warehouseTemplateSchema = templateShape.superRefine((value, ctx) => {
  const { digest: saved, ...snapshot } = value;
  if (productLabelValueDigest(snapshot) !== saved)
    ctx.addIssue({ code: "custom", message: "Template digest mismatch" });
  try {
    if (value.purpose === "product_duplicate") assertDuplicateTemplate(value.spec);
    else {
      const codes = value.spec.elements.filter((e) => e.kind === "barcode" && e.data === "sscc");
      if (
        codes.length !== 1 ||
        codes[0]?.kind !== "barcode" ||
        codes[0].format !== "code128" ||
        value.spec.elements.some(
          (e) =>
            (e.kind === "barcode" && e.data === "km.code") ||
            (e.kind === "field" && e.field === "km.code"),
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "Box template requires one SSCC Code128 and no product KM",
        });
    }
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    ctx.addIssue({ code: "custom", message: "Incompatible product template" });
  }
});
export type WarehouseTemplate = z.infer<typeof warehouseTemplateSchema>;
export const warehouseTemplateCatalogSchema = z.strictObject({
  protocol: z.literal(WAREHOUSE_REPRINT_PROTOCOL),
  revision: digest,
  templates: z.array(warehouseTemplateSchema).max(1000),
});
export type WarehouseTemplateCatalog = z.infer<typeof warehouseTemplateCatalogSchema>;

const sourceShape = z.strictObject({
  kind: z.enum(["unit", "box"]),
  sourceId: z.string().min(1).max(128),
  identity: z.string().min(1).max(64),
  revision: digest,
  productName: z.string().min(1).max(4096),
  chzProductGroupCode: z.number().int().nonnegative().nullable(),
  fields,
  unavailableFields: z.array(z.enum(LABEL_FIELDS)).max(LABEL_FIELDS.length),
  payloadDigest: digest,
  sourceShiftId: id.nullable(),
});
export const warehouseSourceSchema = sourceShape.superRefine((value, ctx) => {
  const { revision, ...snapshot } = value;
  if (productLabelValueDigest(snapshot) !== revision)
    ctx.addIssue({ code: "custom", message: "Source revision mismatch" });
  try {
    const payload =
      value.kind === "box" ? value.fields.sscc : parseDuplicateKm(value.fields["km.code"]).raw;
    const identity = value.kind === "box" ? payload : kmHash(parseDuplicateKm(payload));
    if (
      (value.kind === "box" && !isValidSscc(payload)) ||
      identity !== value.identity ||
      productLabelBytesDigest(new TextEncoder().encode(payload)) !== value.payloadDigest
    )
      ctx.addIssue({ code: "custom", message: "Source identity or payload mismatch" });
    if (
      (value.kind === "box" && value.fields["km.code"] !== "") ||
      (value.kind === "unit" && value.fields.sscc !== "")
    )
      ctx.addIssue({ code: "custom", message: "Source barcode purpose mismatch" });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    ctx.addIssue({ code: "custom", message: "Source requires full valid barcode" });
  }
});
export type WarehouseReprintSource = z.infer<typeof warehouseSourceSchema>;
export const warehouseLookupResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("found"), source: warehouseSourceSchema, repair }),
  z.strictObject({ status: z.literal("not_found") }),
  z.strictObject({
    status: z.literal("unavailable"),
    code: z.enum([
      "incomplete_km",
      "source_fields_missing",
      "source_not_printable",
      "unsupported_pallet",
      "ownership_conflict",
    ]),
  }),
]);
export type WarehouseLookupResult = z.infer<typeof warehouseLookupResultSchema>;

const eventBase = z.strictObject({
  eventId: id,
  jobId: id,
  sessionId: id,
  attemptId: id,
  operatorId: id,
  sequence: positive,
  occurredAt: z.iso.datetime(),
});
const warehousePreparedBase = eventBase.extend({
  kind: z.literal("prepared"),
  attemptNo: z.literal(1),
  reason: warehouseReasonSchema,
  sourceKind: z.enum(["unit", "box"]),
  sourceId: z.string().min(1).max(128),
  identity: z.string().min(1).max(64),
  sourceRevision: digest,
  sourceShiftId: id.nullable(),
  templateId: id,
  templateRevision: digest,
  templateDigest: digest,
  payloadDigest: digest,
  bytesDigest: digest,
  scanDigest: digest,
  repair,
  dpi: z.union([z.literal(203), z.literal(300)]),
});
const warehouseRawPrepared = warehousePreparedBase.extend({
  language: z.enum(["zpl", "tspl"]),
  printFormat: z.never().optional(),
});
const warehouseRasterPrepared = warehousePreparedBase.extend({
  printFormat: z.literal("mono-raster-v1"),
  language: z.never().optional(),
});
const warehouseOtherEventSchema = z.discriminatedUnion("kind", [
  eventBase.extend({ kind: z.literal("sending") }),
  eventBase.extend({ kind: z.literal("sent") }),
  eventBase.extend({ kind: z.literal("verified") }),
  eventBase.extend({
    kind: z.literal("delivery_unknown"),
    errorCode: z.enum(["transport_failed", "interrupted"]),
  }),
  eventBase.extend({
    kind: z.literal("failed_before_send"),
    errorCode: z.enum([
      "printer_unconfigured",
      "printer_changed",
      "owner_changed",
      "driver_rejected",
    ]),
  }),
  eventBase.extend({
    kind: z.literal("reprint_prepared"),
    attemptNo: positive,
    reason: warehouseReasonSchema,
    rerender: z
      .strictObject({
        bytesDigest: digest,
        dpi: z.union([z.literal(203), z.literal(300)]),
      })
      .optional(),
  }),
]);
export const warehouseEventSchema = z.union([
  warehouseRawPrepared,
  warehouseRasterPrepared,
  warehouseOtherEventSchema,
]);
export type WarehouseReprintEvent = z.infer<typeof warehouseEventSchema>;
export const warehouseEventBatchSchema = z.strictObject({
  protocol: z.literal(WAREHOUSE_REPRINT_PROTOCOL),
  events: z.array(warehouseEventSchema).min(1).max(MAX_WAREHOUSE_REPRINT_EVENTS),
});
export const warehouseReceiptSchema = z.strictObject({
  protocol: z.literal(WAREHOUSE_REPRINT_PROTOCOL),
  acceptedEventIds: z.array(id).max(MAX_WAREHOUSE_REPRINT_EVENTS),
  quarantined: z
    .array(
      z.strictObject({
        eventId: id,
        code: z.enum([
          "parent_missing",
          "source_not_printable",
          "ownership_conflict",
          "invalid_transition",
          "sequence_gap",
          "invalid_operator",
          "template_mismatch",
        ]),
      }),
    )
    .max(MAX_WAREHOUSE_REPRINT_EVENTS),
});
export type WarehouseReprintReceipt = z.infer<typeof warehouseReceiptSchema>;
export type WarehouseReprintRejection = WarehouseReprintReceipt["quarantined"][number]["code"];
