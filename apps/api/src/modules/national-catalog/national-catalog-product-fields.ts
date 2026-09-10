import { isValidGtin, normalizeToGtin14 } from "@markiro/domain";
import { z } from "zod";
import { createProductSchema } from "../products/dto";

// These two explicit correspondences are independent of a regulatory category.
// Never infer a numeric provider ID, match a substring, or convert a different unit.
const sourceLabels = {
  egais_code: "Код продукции в ЕГАИС",
  shelf_life_days: "Срок годности, дней",
} as const;
export type CatalogProductField = keyof typeof sourceLabels;
export const productFieldMappingSchema = z
  .object({
    targetField: z.enum(["egais_code", "shelf_life_days"]),
    sourceAttributeId: z.number().int().positive(),
    mappingVersion: z.literal(1),
  })
  .strict();
const entryBase = {
  entryId: z.uuid(),
  target: z.literal("product_field"),
  source: z.literal("national_catalog"),
  sourceAttributeId: z.number().int().positive(),
  mappingVersion: z.literal(1),
};
export const productFieldEntrySchema = z.discriminatedUnion("targetField", [
  z
    .object({
      ...entryBase,
      targetField: z.literal("egais_code"),
      currentValue: z.string().nullable(),
      proposedValue: z.string().regex(/^\d{19}$/),
    })
    .strict(),
  z
    .object({
      ...entryBase,
      targetField: z.literal("shelf_life_days"),
      currentValue: z.number().int().nullable(),
      proposedValue: z.number().int().min(1).max(3650),
    })
    .strict(),
]);
export type CatalogProductFieldEntry = z.infer<typeof productFieldEntrySchema>;
type SourceAttribute = {
  id: number;
  name?: string | undefined;
  value: string;
  gtin: string | null;
};
export function catalogProductFieldForLabel(label: string): CatalogProductField | undefined {
  return (Object.keys(sourceLabels) as CatalogProductField[]).find(
    (key) => sourceLabels[key] === label.trim(),
  );
}
export function readCatalogProductFields(attributes: readonly SourceAttribute[], gtin14: string) {
  const result: Array<z.infer<typeof productFieldMappingSchema> & { value: string | number }> = [];
  const scoped = attributes.filter(
    (a) => a.gtin === null || (isValidGtin(a.gtin) && normalizeToGtin14(a.gtin) === gtin14),
  );
  for (const targetField of Object.keys(sourceLabels) as CatalogProductField[]) {
    const candidates = scoped.filter((a) => a.name?.trim() === sourceLabels[targetField]);
    const ids = new Set(candidates.map((a) => a.id));
    const values = new Set(candidates.map((a) => a.value.trim()));
    const sourceAttributeId = candidates[0]?.id;
    const raw = candidates[0]?.value.trim();
    if (
      ids.size !== 1 ||
      values.size !== 1 ||
      sourceAttributeId === undefined ||
      !Number.isSafeInteger(sourceAttributeId) ||
      sourceAttributeId <= 0 ||
      scoped.some(
        (a) => a.id === sourceAttributeId && a.name?.trim() !== sourceLabels[targetField],
      ) ||
      !raw
    )
      continue;
    if (targetField === "egais_code") {
      if (/^\d{19}$/.test(raw))
        result.push({ targetField, sourceAttributeId, mappingVersion: 1, value: raw });
    } else if (/^\d+$/.test(raw)) {
      const parsed = createProductSchema.shape.shelfLifeDays.safeParse(Number(raw));
      if (parsed.success && typeof parsed.data === "number")
        result.push({ targetField, sourceAttributeId, mappingVersion: 1, value: parsed.data });
    }
  }
  return result;
}
