import { z } from "zod";
import {
  UNIFIED_REPRINT_PROTOCOL,
  palletDataSchema,
  palletRenderingV3Schema,
} from "./pallet-data.js";
import { warehouseSourceSchema } from "./contracts.js";
import { palletSourcesReceiptSchema, palletProductionDeliverySchema } from "./pallet-contracts.js";
import {
  palletDeliveryDiagnosticSchema,
  palletReprintEventV2Schema,
  palletRenderingsV2ReceiptSchema,
  palletEventsV2ReceiptSchema,
} from "./pallet-reprint-v2.js";
export const unifiedLookupRequestSchema = z.strictObject({
  protocol: z.literal(UNIFIED_REPRINT_PROTOCOL),
  raw: z.string().min(1).max(2048),
  operatorId: z.uuid(),
});
export const unifiedLookupResultSchema = z.union([
  z
    .strictObject({
      status: z.literal("found"),
      kind: z.enum(["unit", "box"]),
      source: warehouseSourceSchema,
      repair: z.enum(["legacy_tspl_fnc1_literal"]).nullable(),
    })
    .superRefine((v, c) => {
      if (v.kind !== v.source.kind) c.addIssue({ code: "custom", message: "Lookup kind mismatch" });
    }),
  z.strictObject({ status: z.literal("found"), kind: z.literal("pallet"), data: palletDataSchema }),
  z.strictObject({ status: z.literal("not_found") }),
  z.strictObject({
    status: z.literal("unavailable"),
    diagnostic: palletDeliveryDiagnosticSchema.nullable().optional(),
    code: z.enum([
      "not_closed",
      "not_production",
      "composition_changed",
      "snapshot_missing",
      "delivery_unresolved",
      "ambiguous",
      "incomplete_km",
      "source_fields_missing",
      "source_not_printable",
      "unsupported_pallet",
      "ownership_conflict",
    ]),
  }),
]);
export const palletDataBatchSchema = z
  .strictObject({
    protocol: z.literal(UNIFIED_REPRINT_PROTOCOL),
    entries: z.array(palletDataSchema).max(1),
    productionDelivery: palletProductionDeliverySchema.optional(),
  })
  .superRefine((v, c) => {
    if (
      v.productionDelivery &&
      (v.entries.length !== 1 || v.entries[0]?.revision !== v.productionDelivery.sourceRevision)
    )
      c.addIssue({ code: "custom", message: "Delivery source mismatch" });
  });
export const palletDataReceiptSchema = palletSourcesReceiptSchema.extend({
  protocol: z.literal(UNIFIED_REPRINT_PROTOCOL),
});
export const palletRenderingsV3BatchSchema = z.strictObject({
  protocol: z.literal(UNIFIED_REPRINT_PROTOCOL),
  entries: z
    .array(
      z.strictObject({ jobId: z.uuid(), operatorId: z.uuid(), rendering: palletRenderingV3Schema }),
    )
    .max(1),
});
export const palletRenderingsV3ReceiptSchema = palletRenderingsV2ReceiptSchema.extend({
  protocol: z.literal(UNIFIED_REPRINT_PROTOCOL),
});
export const palletEventsV3BatchSchema = z.strictObject({
  protocol: z.literal(UNIFIED_REPRINT_PROTOCOL),
  entries: z.array(palletReprintEventV2Schema).max(100),
});
export const palletEventsV3ReceiptSchema = palletEventsV2ReceiptSchema.extend({
  protocol: z.literal(UNIFIED_REPRINT_PROTOCOL),
});
export type UnifiedLookupResult = z.infer<typeof unifiedLookupResultSchema>;
