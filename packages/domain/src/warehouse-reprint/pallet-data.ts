import { z } from "zod";
import { isValidSscc } from "../gs1/sscc.js";
import { LABEL_FIELDS } from "../labels/model.js";
import { labelTemplateUsesField } from "../labels/eligibility.js";
import { formatLabelDate } from "../labels/date.js";
import { shelfLifeExpiryDate } from "../labels/shelf-life.js";
import { productLabelValueDigest } from "../product-labels/km.js";
import { palletLabelSourceSchema } from "./pallet-contracts.js";
import { palletTemplateChoiceSchema, type PalletTemplateChoice } from "./pallet-reprint-v2.js";
import { validatePalletBranding } from "./pallet-branding.js";

export const UNIFIED_REPRINT_PROTOCOL = "warehouse-unified-reprint-v3";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const fieldsSchema = z.record(z.enum(LABEL_FIELDS), z.string().max(4096));
const contentSchema = z.strictObject({
  version: z.literal(3),
  sscc: z.string().refine(isValidSscc, "Invalid SSCC"),
  shiftId: z.uuid(),
  closedAt: z.iso.datetime(),
  boxCount: z.number().int().positive(),
  itemCount: z.number().int().positive(),
  boxSsccs: z.array(z.string().refine(isValidSscc)).min(1).max(10000),
  compositionDigest: digest,
  legacySourceRevision: digest.nullable(),
  fields: fieldsSchema,
  productionDate: z.iso.date().nullable(),
  expiryDate: z.iso.date().nullable(),
  brandingJson: z.string().max(131072).nullable(),
});
export const palletDataSchema = contentSchema
  .extend({ revision: digest })
  .superRefine((value, ctx) => {
    const { revision, ...body } = value;
    if (productLabelValueDigest(body) !== revision)
      ctx.addIssue({ code: "custom", message: "Pallet data digest mismatch" });
    if (
      value.boxSsccs.length !== value.boxCount ||
      new Set(value.boxSsccs).size !== value.boxCount ||
      value.fields.sscc !== value.sscc ||
      value.fields.qty !== String(value.itemCount) ||
      value.fields["qty.boxes"] !== String(value.boxCount) ||
      value.fields["km.code"] !== ""
    )
      ctx.addIssue({ code: "custom", message: "Pallet data identity mismatch" });
    if (!value.fields["product.printName"].trim() || !/^\d{14}$/.test(value.fields["product.gtin"]))
      ctx.addIssue({ code: "custom", message: "Pallet product data unavailable" });
    if (
      value.fields.date !== (value.productionDate ? formatLabelDate(value.productionDate) : "") ||
      value.fields.expiry !== (value.expiryDate ? formatLabelDate(value.expiryDate) : "")
    )
      ctx.addIssue({ code: "custom", message: "Pallet historical date mismatch" });
    if (value.brandingJson !== null) {
      try {
        validatePalletBranding(value.brandingJson);
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid pallet branding" });
      }
    }
    if (new TextEncoder().encode(JSON.stringify(value)).length > 700000)
      ctx.addIssue({ code: "custom", message: "Pallet data exceeds bounds" });
  });
export type PalletDataV3 = z.infer<typeof palletDataSchema>;
export function parsePalletData(input: unknown): PalletDataV3 {
  return palletDataSchema.parse(input);
}
export function makePalletData(input: Omit<PalletDataV3, "revision">): PalletDataV3 {
  const body = contentSchema.parse(input);
  return parsePalletData({ ...body, revision: productLabelValueDigest(body) });
}
function savedCivilDate(text: string): string | null {
  if (text === "") return null;
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  if (!match) throw new Error("WAREHOUSE_SOURCE_DATE");
  return z.iso.date().parse(`${match[3]}-${match[2]}-${match[1]}`);
}
/** Adapter reads only frozen source facts. It never queries the catalog or clock. */
export function palletDataFromLegacySource(input: unknown): PalletDataV3 {
  const source = palletLabelSourceSchema.parse(input),
    saved = source.rendering;
  let fields: z.infer<typeof fieldsSchema>;
  let productionDate: string | null, expiryDate: string | null;
  if (saved.kind === "thermal") {
    fields = { ...saved.fields };
    productionDate = savedCivilDate(fields.date);
    expiryDate = savedCivilDate(fields.expiry);
  } else {
    const facts = saved.facts;
    productionDate = facts.productionDate;
    expiryDate = productionDate
      ? shelfLifeExpiryDate(productionDate, facts.shelfLifeDays) || null
      : null;
    fields = fieldsSchema.parse(Object.fromEntries(LABEL_FIELDS.map((name) => [name, ""])));
    Object.assign(fields, {
      sscc: source.sscc,
      "product.name": facts.productPrintName,
      "product.printName": facts.productPrintName,
      "product.gtin": facts.gtin14,
      "product.egais": facts.egaisCode ?? "",
      "shift.no": facts.shiftNumber ?? "",
      qty: String(source.itemCount),
      "qty.boxes": String(source.boxCount),
      date: productionDate ? formatLabelDate(productionDate) : "",
      expiry: expiryDate ? formatLabelDate(expiryDate) : "",
    });
  }
  return makePalletData({
    version: 3,
    sscc: source.sscc,
    shiftId: source.shiftId,
    closedAt: source.closedAt,
    boxCount: source.boxCount,
    itemCount: source.itemCount,
    boxSsccs: source.boxSsccs,
    compositionDigest: source.compositionDigest,
    legacySourceRevision: source.revision,
    fields,
    productionDate,
    expiryDate,
    brandingJson: saved.brandingJson,
  });
}
const renderingContentSchema = z.strictObject({
  version: z.literal(3),
  sscc: contentSchema.shape.sscc,
  sourceRevision: digest,
  choice: palletTemplateChoiceSchema,
  fields: fieldsSchema,
  productionDate: z.iso.date().nullable(),
  expiryDate: z.iso.date().nullable(),
  brandingJson: contentSchema.shape.brandingJson,
});
export const palletRenderingV3Schema = renderingContentSchema
  .extend({ renderingRevision: digest })
  .superRefine((value, ctx) => {
    const { renderingRevision, ...body } = value;
    if (productLabelValueDigest(body) !== renderingRevision)
      ctx.addIssue({ code: "custom", message: "Rendering digest mismatch" });
    if (value.choice.id === null)
      ctx.addIssue({ code: "custom", message: "A catalog template must be chosen" });
    if (value.fields.sscc !== value.sscc || value.fields["km.code"] !== "")
      ctx.addIssue({ code: "custom", message: "Pallet rendering identity mismatch" });
    if (
      value.choice.kind === "thermal" &&
      (labelTemplateUsesField(value.choice.snapshot, "km.code") ||
        !value.choice.snapshot.elements.some(
          (e) => e.kind === "barcode" && e.format === "code128" && e.data === "sscc",
        ))
    )
      ctx.addIssue({ code: "custom", message: "Pallet SSCC barcode required" });
    if (new TextEncoder().encode(JSON.stringify(value)).length > 800000)
      ctx.addIssue({ code: "custom", message: "Rendering exceeds bounds" });
  });
export type PalletRenderingV3 = z.infer<typeof palletRenderingV3Schema>;
export function renderingFromPalletData(
  input: PalletDataV3,
  selected: PalletTemplateChoice,
): PalletRenderingV3 {
  const data = parsePalletData(input),
    choice = palletTemplateChoiceSchema.parse(selected);
  if (choice.kind === "thermal") {
    if (!data.fields.date && labelTemplateUsesField(choice.snapshot, "date"))
      throw new Error("WAREHOUSE_SOURCE_DATE");
    if (!data.fields.expiry && labelTemplateUsesField(choice.snapshot, "expiry"))
      throw new Error("WAREHOUSE_SOURCE_EXPIRY");
    for (const field of ["operator", "counterparty.name"] as const)
      if (!data.fields[field] && labelTemplateUsesField(choice.snapshot, field))
        throw new Error("WAREHOUSE_SOURCE_FIELDS");
  }
  const body = {
    version: 3 as const,
    sscc: data.sscc,
    sourceRevision: data.revision,
    choice,
    fields: data.fields,
    productionDate: data.productionDate,
    expiryDate: data.expiryDate,
    brandingJson: data.brandingJson,
  };
  return palletRenderingV3Schema.parse({
    ...body,
    renderingRevision: productLabelValueDigest(body),
  });
}
export function assertPalletRenderingV3MatchesData(
  input: PalletDataV3,
  value: PalletRenderingV3,
): void {
  const data = parsePalletData(input),
    rendered = palletRenderingV3Schema.parse(value);
  const expected = renderingFromPalletData(data, rendered.choice);
  if (expected.renderingRevision !== rendered.renderingRevision)
    throw new Error("WAREHOUSE_PALLET_SOURCE_CHANGED");
}

/** Supplies A4 with the same civil dates and quantities as the thermal fields. */
export function palletSheetFactsFromData(input: PalletDataV3) {
  const data = parsePalletData(input);
  return {
    sscc: data.sscc,
    productPrintName: data.fields["product.printName"],
    gtin14: data.fields["product.gtin"],
    egaisCode: data.fields["product.egais"] || null,
    productionDate: data.productionDate,
    expiryDate: data.expiryDate,
    shelfLifeDays: null,
    boxCount: data.boxCount,
    itemCount: data.itemCount,
    shiftNumber: data.fields["shift.no"] || null,
  };
}
