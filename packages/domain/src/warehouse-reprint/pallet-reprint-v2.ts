import { z } from "zod";
import { labelTemplateSpecSchema, type LabelTemplateSpec } from "../labels/model.js";
import { palletSheetTemplateSnapshotSchema } from "../labels/pallet-sheet-snapshot.js";
import { productLabelValueDigest } from "../product-labels/km.js";
import { validatePalletBranding } from "./pallet-branding.js";
import {
  palletLabelSourceSchema,
  palletLookupRequestSchema,
  palletReprintEventSchema,
  makePalletLabelSource,
  type PalletLabelSourceV1,
} from "./pallet-contracts.js";
import { warehouseReasonSchema } from "./contracts.js";

export const PALLET_REPRINT_V2_PROTOCOL = "warehouse-pallet-reprint-v2";
export const PALLET_PRODUCTION_RESOLUTION_PROTOCOL = "warehouse-pallet-production-resolution-v1";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sscc = palletLabelSourceSchema.shape.sscc;
const id = z.uuid().toLowerCase();
const choiceFields = {
  id: id.nullable(),
  name: z.string().min(1).max(255),
  snapshotDigest: digest,
};
export const palletTemplateChoiceSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...choiceFields,
      kind: z.literal("a4"),
      snapshot: palletSheetTemplateSnapshotSchema,
    }),
    z.strictObject({
      ...choiceFields,
      kind: z.literal("thermal"),
      snapshot: labelTemplateSpecSchema,
    }),
  ])
  .superRefine((choice, ctx) => {
    if (productLabelValueDigest(choice.snapshot) !== choice.snapshotDigest)
      ctx.addIssue({ code: "custom", message: "Template snapshot digest mismatch" });
    if (choice.kind === "a4" && choice.id !== null && choice.id !== choice.snapshot.id)
      ctx.addIssue({ code: "custom", message: "Template identity mismatch" });
  });
export type PalletTemplateChoice = z.infer<typeof palletTemplateChoiceSchema>;
export const palletTemplateCatalogV2Schema = z.strictObject({
  protocol: z.literal(PALLET_REPRINT_V2_PROTOCOL),
  templates: z.array(palletTemplateChoiceSchema).max(1000),
});
export type PalletTemplateCatalogV2 = z.infer<typeof palletTemplateCatalogV2Schema>;

function containsUnitCode(template: LabelTemplateSpec): boolean {
  return template.elements.some(
    (element) =>
      ("data" in element && element.data === "km.code") ||
      ("text" in element && element.text.includes("{km.code}")),
  );
}
export const palletRenderingV2Schema = z
  .strictObject({
    version: z.literal(2),
    sscc,
    sourceRevision: digest,
    templateId: id.nullable(),
    templateName: z.string().min(1).max(255),
    rendering: palletLabelSourceSchema.shape.rendering,
    renderingRevision: digest,
  })
  .superRefine((value, ctx) => {
    const { renderingRevision, ...body } = value;
    if (productLabelValueDigest(body) !== renderingRevision)
      ctx.addIssue({ code: "custom", message: "Rendering digest mismatch" });
    if (value.rendering.brandingJson !== null) {
      try {
        validatePalletBranding(value.rendering.brandingJson);
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid saved branding" });
      }
    }
    if (value.rendering.kind === "thermal") {
      if (
        value.rendering.fields.sscc !== value.sscc ||
        value.rendering.fields["km.code"] !== "" ||
        containsUnitCode(value.rendering.template)
      )
        ctx.addIssue({ code: "custom", message: "Pallet rendering identity mismatch" });
    } else if (
      value.rendering.facts.sscc !== value.sscc ||
      (value.templateId !== null && value.templateId !== value.rendering.template.id)
    ) {
      ctx.addIssue({ code: "custom", message: "Pallet rendering identity mismatch" });
    }
    if (new TextEncoder().encode(JSON.stringify(value)).length > 800000)
      ctx.addIssue({ code: "custom", message: "Rendering exceeds bounds" });
  });
export type PalletRenderingV2 = z.infer<typeof palletRenderingV2Schema>;

/** The chosen template belongs to a new rendering, never to the production source. */
export function makePalletRenderingV2(
  sourceInput: PalletLabelSourceV1,
  choiceInput: PalletTemplateChoice,
): PalletRenderingV2 {
  const source = palletLabelSourceSchema.parse(sourceInput),
    choice = palletTemplateChoiceSchema.parse(choiceInput);
  let rendering: PalletLabelSourceV1["rendering"];
  if (source.rendering.kind === "a4" && choice.kind === "a4")
    rendering = { ...source.rendering, template: choice.snapshot };
  else if (source.rendering.kind === "thermal" && choice.kind === "thermal")
    rendering = { ...source.rendering, template: choice.snapshot };
  else throw new Error("WAREHOUSE_PALLET_TEMPLATE_KIND");
  const body = {
    version: 2 as const,
    sscc: source.sscc,
    sourceRevision: source.revision,
    templateId: choice.id,
    templateName: choice.name,
    rendering,
  };
  const result = palletRenderingV2Schema.parse({
    ...body,
    renderingRevision: productLabelValueDigest(body),
  });
  assertPalletRenderingMatchesSource(source, result);
  return result;
}
export function assertPalletRenderingMatchesSource(
  sourceInput: PalletLabelSourceV1,
  renderingInput: PalletRenderingV2,
): void {
  const source = palletLabelSourceSchema.parse(sourceInput),
    value = palletRenderingV2Schema.parse(renderingInput);
  if (
    source.sscc !== value.sscc ||
    source.revision !== value.sourceRevision ||
    source.rendering.kind !== value.rendering.kind
  )
    throw new Error("WAREHOUSE_PALLET_SOURCE_CHANGED");
  const { template: originalTemplate, ...historical } = source.rendering;
  const { template: selectedTemplate, ...selectedFacts } = value.rendering;
  if (productLabelValueDigest(historical) !== productLabelValueDigest(selectedFacts))
    throw new Error("WAREHOUSE_PALLET_SOURCE_CHANGED");
  if (
    value.templateId === null &&
    productLabelValueDigest(originalTemplate) !== productLabelValueDigest(selectedTemplate)
  )
    throw new Error("WAREHOUSE_PALLET_TEMPLATE_CHANGED");
  makePalletLabelSource({
    version: 1,
    sscc: source.sscc,
    shiftId: source.shiftId,
    closedAt: source.closedAt,
    boxCount: source.boxCount,
    itemCount: source.itemCount,
    compositionDigest: source.compositionDigest,
    boxSsccs: source.boxSsccs,
    originalAttempt: source.originalAttempt,
    rendering: value.rendering,
  });
}

const diagnosticBase = {
  sscc,
  sourceRevision: digest.nullable(),
  originDeviceId: id.nullable(),
  shiftId: id.nullable(),
};
export const palletDeliveryDiagnosticSchema = z.strictObject({
  ...diagnosticBase,
  kind: z.enum([
    "sync_pending",
    "delivery_unknown",
    "prepared",
    "sending",
    "failed_before_send",
    "snapshot_missing",
    "composition_changed",
  ]),
  attemptId: z.string().min(1).max(255).nullable(),
  productionSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
});
export type PalletDeliveryDiagnostic = z.infer<typeof palletDeliveryDiagnosticSchema>;
export const palletLookupV2RequestSchema = palletLookupRequestSchema.extend({
  protocol: z.literal(PALLET_REPRINT_V2_PROTOCOL),
});
export const palletLookupV2ResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("found"), source: palletLabelSourceSchema }),
  z.strictObject({ status: z.literal("not_found") }),
  z.strictObject({
    status: z.literal("unavailable"),
    code: z.enum([
      "not_closed",
      "not_production",
      "composition_changed",
      "snapshot_missing",
      "delivery_unresolved",
      "ambiguous",
    ]),
    diagnostic: palletDeliveryDiagnosticSchema.nullable(),
  }),
]);
const statuses = z.enum(["accepted", "retryable", "conflict"]);
export const palletRenderingsV2BatchSchema = z.strictObject({
  protocol: z.literal(PALLET_REPRINT_V2_PROTOCOL),
  entries: z
    .array(z.strictObject({ jobId: id, operatorId: id, rendering: palletRenderingV2Schema }))
    .max(1),
});
export const palletRenderingsV2ReceiptSchema = z.strictObject({
  protocol: z.literal(PALLET_REPRINT_V2_PROTOCOL),
  results: z
    .array(z.strictObject({ jobId: id, renderingRevision: digest, status: statuses }))
    .max(1),
});
export const palletReprintEventV2Schema = palletReprintEventSchema.extend({
  renderingRevision: digest,
});
export const palletEventsV2BatchSchema = z.strictObject({
  protocol: z.literal(PALLET_REPRINT_V2_PROTOCOL),
  entries: z.array(palletReprintEventV2Schema).max(100),
});
export const palletEventsV2ReceiptSchema = z.strictObject({
  protocol: z.literal(PALLET_REPRINT_V2_PROTOCOL),
  results: z.array(z.strictObject({ eventId: id, status: statuses })).max(100),
});
export const palletProductionResolutionSchema = z
  .strictObject({
    eventId: id,
    sscc,
    sourceRevision: digest,
    attemptId: z.string().min(1).max(255),
    productionSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    operatorId: id,
    reason: warehouseReasonSchema,
    occurredAt: z.iso.datetime(),
    outcome: z.enum(["confirmed", "skipped"]),
    scannedSscc: sscc.nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      value.outcome === "confirmed" ? value.scannedSscc !== value.sscc : value.scannedSscc !== null
    )
      ctx.addIssue({ code: "custom", message: "Resolution scan mismatch" });
  });
export type PalletProductionResolution = z.infer<typeof palletProductionResolutionSchema>;
export const palletProductionResolutionsSchema = z.strictObject({
  protocol: z.literal(PALLET_PRODUCTION_RESOLUTION_PROTOCOL),
  entries: z.array(palletProductionResolutionSchema).max(100),
});
export const palletProductionResolutionsReceiptSchema = z.strictObject({
  protocol: z.literal(PALLET_PRODUCTION_RESOLUTION_PROTOCOL),
  results: z.array(z.strictObject({ eventId: id, status: statuses })).max(100),
});
