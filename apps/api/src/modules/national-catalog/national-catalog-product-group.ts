import { z } from "zod";

export const catalogCategoryGroupSchema = z
  .object({
    id: z.number().int().positive(),
    active: z.boolean(),
    gismtCodes: z.array(z.number().int().positive()),
  })
  .strict();
export type CatalogCategoryGroup = z.infer<typeof catalogCategoryGroupSchema>;
export const catalogProductGroupEntrySchema = z
  .object({
    entryId: z.uuid(),
    target: z.literal("product_group"),
    source: z.literal("national_catalog"),
    currentValue: z.number().int().positive().nullable(),
    proposedValue: z.number().int().positive(),
  })
  .strict();
export type CatalogProductGroupEntry = z.infer<typeof catalogProductGroupEntrySchema>;

/** Category IDs and gismt_codes are provider identifiers, never names or inferred IDs. */
export function resolveCatalogProductGroup(
  sourceCategories: readonly unknown[],
  evidence: readonly CatalogCategoryGroup[],
): { code: number | null; reason: "product_group_unavailable" | "product_group_ambiguous" | null } {
  const parsed = z.array(z.object({ id: z.number().int().positive() })).safeParse(sourceCategories);
  if (!parsed.success || !parsed.data.length)
    return { code: null, reason: "product_group_unavailable" };
  const ids = [...new Set(parsed.data.map((category) => category.id))];
  const groups: Set<number>[] = [];
  for (const id of ids) {
    const matches = evidence.filter((category) => category.id === id);
    const category = matches[0];
    if (matches.length !== 1 || !category || (!category.active && category.gismtCodes.length))
      return { code: null, reason: "product_group_unavailable" };
    if (category.active && category.gismtCodes.length) groups.push(new Set(category.gismtCodes));
  }
  const first = groups[0];
  if (!first) return { code: null, reason: "product_group_unavailable" };
  const common = [...first].filter((code) => groups.every((group) => group.has(code)));
  return common.length === 1 && common[0] !== undefined
    ? { code: common[0], reason: null }
    : { code: null, reason: "product_group_ambiguous" };
}
