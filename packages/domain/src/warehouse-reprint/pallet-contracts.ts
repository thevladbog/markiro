import { validatePalletBranding } from "./pallet-branding.js";
import { z } from "zod";
import { isValidSscc } from "../gs1/sscc.js";
import { labelTemplateSpecSchema, LABEL_FIELDS } from "../labels/model.js";
import { palletSheetTemplateSnapshotSchema } from "../labels/pallet-sheet-snapshot.js";
import { productLabelValueDigest } from "../product-labels/km.js";
import { warehouseReasonSchema } from "./contracts.js";
export const PALLET_REPRINT_PROTOCOL = "warehouse-pallet-reprint-v1";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sscc = z.string().refine(isValidSscc, "Invalid SSCC");
export const palletFactsSchema = z.strictObject({
  sscc,
  productPrintName: z.string().min(1).max(4096),
  gtin14: z.string().regex(/^\d{14}$/),
  egaisCode: z
    .string()
    .regex(/^\d{19}$/)
    .nullable(),
  productionDate: z.iso.date().nullable(),
  shelfLifeDays: z.number().int().positive().nullable(),
  boxCount: z.number().int().positive(),
  itemCount: z.number().int().positive(),
  shiftNumber: z.string().max(255).nullable(),
});
const rendering = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("thermal"),
    rendererVersion: z.literal("thermal-v1"),
    template: labelTemplateSpecSchema,
    fields: z.record(z.enum(LABEL_FIELDS), z.string().max(4096)),
    brandingJson: z.string().max(131072).nullable(),
  }),
  z.strictObject({
    kind: z.literal("a4"),
    rendererVersion: z.literal("pallet-sheet-v1"),
    template: palletSheetTemplateSnapshotSchema,
    facts: palletFactsSchema,
    brandingJson: z.string().min(1).max(131072),
  }),
]);
const shape = z.strictObject({
  version: z.literal(1),
  sscc,
  shiftId: z.uuid(),
  closedAt: z.iso.datetime(),
  boxCount: z.number().int().positive(),
  itemCount: z.number().int().positive(),
  compositionDigest: digest,
  boxSsccs: z.array(sscc).min(1).max(10000),
  rendering,
  originalAttempt: z
    .strictObject({
      scope: z.string().max(1024),
      attemptId: z.string().max(255),
      bytesDigest: digest,
      geometryFingerprint: z.string().max(4096).nullable(),
    })
    .nullable()
    .default(null),
  revision: digest,
});
export const palletLabelSourceSchema = shape.superRefine((v, c) => {
  if (v.rendering.brandingJson !== null) {
    try {
      validatePalletBranding(v.rendering.brandingJson);
    } catch {
      c.addIssue({ code: "custom", message: "Invalid pallet branding resource" });
    }
  }
  if (new TextEncoder().encode(JSON.stringify(v)).length > 700000)
    c.addIssue({ code: "custom", message: "Pallet source exceeds bounds" });
  const { revision, ...body } = v;
  if (productLabelValueDigest(body) !== revision)
    c.addIssue({ code: "custom", message: "Pallet source changed" });
  if (v.boxCount !== v.boxSsccs.length || new Set(v.boxSsccs).size !== v.boxCount)
    c.addIssue({ code: "custom", message: "Pallet composition mismatch" });
  if (v.rendering.kind === "thermal") {
    if (
      v.rendering.fields["km.code"] !== "" ||
      v.rendering.template.elements.some(
        (e) =>
          ("data" in e && e.data === "km.code") || ("text" in e && e.text.includes("{km.code}")),
      )
    )
      c.addIssue({ code: "custom", message: "Pallet sources cannot contain unit KM payloads" });
    if (
      v.rendering.fields.sscc !== v.sscc ||
      v.rendering.fields.qty !== String(v.itemCount) ||
      v.rendering.fields["qty.boxes"] !== String(v.boxCount)
    )
      c.addIssue({ code: "custom", message: "Pallet label identity mismatch" });
    if (
      !v.rendering.template.elements.some(
        (e) => e.kind === "barcode" && e.data === "sscc" && e.format === "code128",
      )
    )
      c.addIssue({ code: "custom", message: "Pallet SSCC barcode required" });
  } else if (
    v.rendering.facts.sscc !== v.sscc ||
    v.rendering.facts.boxCount !== v.boxCount ||
    v.rendering.facts.itemCount !== v.itemCount
  )
    c.addIssue({ code: "custom", message: "Pallet sheet identity mismatch" });
});
export type PalletLabelSourceV1 = z.infer<typeof palletLabelSourceSchema>;
export function makePalletLabelSource(
  value: Omit<PalletLabelSourceV1, "revision" | "originalAttempt"> & {
    originalAttempt?: PalletLabelSourceV1["originalAttempt"];
  },
): PalletLabelSourceV1 {
  const body = { ...value, originalAttempt: value.originalAttempt ?? null };
  return palletLabelSourceSchema.parse({ ...body, revision: productLabelValueDigest(body) });
}
export const palletLookupRequestSchema = z.strictObject({
  protocol: z.literal(PALLET_REPRINT_PROTOCOL),
  raw: z.string().min(1).max(2048),
  operatorId: z.uuid(),
});
export const palletLookupResultSchema = z.discriminatedUnion("status", [
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
  }),
]);
export const palletSourcesBatchSchema = z.strictObject({
  protocol: z.literal(PALLET_REPRINT_PROTOCOL),
  entries: z.array(palletLabelSourceSchema).max(1),
});
export const palletSourcesReceiptSchema = z.strictObject({
  protocol: z.literal(PALLET_REPRINT_PROTOCOL),
  results: z
    .array(
      z.strictObject({ revision: digest, status: z.enum(["accepted", "retryable", "conflict"]) }),
    )
    .max(10),
});
export const palletReprintEventSchema = z.strictObject({
  eventId: z.uuid(),
  jobId: z.uuid(),
  attemptId: z.uuid(),
  sscc,
  sourceRevision: digest,
  operatorId: z.uuid(),
  reason: warehouseReasonSchema,
  occurredAt: z.iso.datetime(),
  state: z.enum([
    "prepared",
    "sent",
    "failed_before_send",
    "delivery_unknown",
    "verified",
    "skipped",
  ]),
  printFormat: z.enum(["zpl", "tspl", "mono-raster-v1"]),
  bytesDigest: digest,
});
export const palletEventsBatchSchema = z.strictObject({
  protocol: z.literal(PALLET_REPRINT_PROTOCOL),
  entries: z.array(palletReprintEventSchema).max(100),
});
export const palletEventsReceiptSchema = z.strictObject({
  protocol: z.literal(PALLET_REPRINT_PROTOCOL),
  results: z
    .array(
      z.strictObject({ eventId: z.uuid(), status: z.enum(["accepted", "retryable", "conflict"]) }),
    )
    .max(100),
});

/** Binds active unit occurrences as well as box identities; no KM payload is included. */
export function palletCompositionDigest(
  items: ReadonlyArray<{ boxSscc: string; codeHash: string; acceptedAt: string }>,
) {
  const normalized = items.map((item) => ({
    boxSscc: sscc.parse(item.boxSscc),
    codeHash: digest.parse(item.codeHash),
    acceptedAt: z.iso.datetime().parse(new Date(item.acceptedAt).toISOString()),
  }));
  normalized.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
  return productLabelValueDigest(normalized);
}
