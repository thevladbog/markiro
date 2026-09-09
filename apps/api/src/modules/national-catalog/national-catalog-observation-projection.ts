import { schema } from "@markiro/db";
import {
  isValidGtin,
  normalizeToGtin14,
  parseCategorySchemaDefinition,
  productAttributeValueSchema,
} from "@markiro/domain";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createProductSchema } from "../products/dto";
import { mappingSchema } from "./national-catalog-import-preview-builder";
import { buildNationalCatalogImportEntries } from "./national-catalog-proposal.service";
import { canonicalJsonHash } from "./national-catalog-products.service";
import type { NationalCatalogProduct } from "./national-catalog.types";
import type { CatalogValueProjection } from "./national-catalog-summary";

export const projectionContextSchema = z
  .object({
    schemaVersionId: z.uuid(),
    categoryId: z.string(),
    groupCode: z.number().int(),
    definition: z.unknown(),
    stableMappings: z.array(mappingSchema),
  })
  .strict();
export const catalogProjectionSchema = z
  .object({
    version: z.literal(1),
    values: z.record(z.string(), z.unknown()),
    context: projectionContextSchema.nullable(),
  })
  .strict();
export type CatalogProjection = z.infer<typeof catalogProjectionSchema>;
export function readCatalogProjection(value: unknown): CatalogProjection | null {
  const parsed = catalogProjectionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function unorderedCatalogValue(value: unknown): unknown {
  if (Array.isArray(value))
    return value
      .map(unorderedCatalogValue)
      .sort((a, b) => canonicalJsonHash(a).localeCompare(canonicalJsonHash(b)));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, unorderedCatalogValue(item)]),
    );
  return value;
}
export function buildCatalogProjection(input: {
  providerName: string | null;
  mappedEntries: ReturnType<typeof buildNationalCatalogImportEntries>["entries"];
  imageChecksum: string | null;
  context: CatalogProjection["context"];
}): CatalogProjection {
  const values: Record<string, unknown> = {};
  const name = createProductSchema.shape.name.safeParse(input.providerName?.trim());
  if (name.success) values.name = name.data;
  for (const entry of input.mappedEntries) {
    const key =
      entry.target === "attribute"
        ? `attribute:${entry.targetSchemaVersionId}:${entry.targetAttributeId}`
        : `stable:${entry.targetField}`;
    values[key] = unorderedCatalogValue(entry.proposedValue);
  }
  if (input.imageChecksum !== null) values.photo = input.imageChecksum;
  return { version: 1, values, context: input.context };
}
export function observeCatalogProjection(
  source: NationalCatalogProduct,
  gtin14: string,
  baseline: CatalogProjection,
  imageChecksum: string | null,
): CatalogProjection {
  const context = baseline.context;
  const mappedEntries =
    context && source.categories.some((category) => String(category.id) === context.categoryId)
      ? buildNationalCatalogImportEntries({
          schemaVersionId: context.schemaVersionId,
          definitions: parseCategorySchemaDefinition(context.definition).attributes,
          currentValues: new Map(),
          sourceAttributes: source.attributes
            .filter(
              (a) =>
                a.gtin === null || (isValidGtin(a.gtin) && normalizeToGtin14(a.gtin) === gtin14),
            )
            .map((a) => ({ id: a.id, value: a.value, unit: null })),
          sourceName: source.name,
          stableMappings: context.stableMappings,
          currentStableFields: new Map(),
        }).entries
      : [];
  return buildCatalogProjection({
    providerName: source.name,
    mappedEntries,
    imageChecksum,
    context,
  });
}

/** One SQL statement with tenant/product-scoped aggregation, shared by detail and catalogue. */
export const catalogLocalStateSelection = sql<unknown>`(
  select jsonb_build_object(
    'schemaVersionId', p.schema_version_id, 'categoryId', p.category_id,
    'status', v.status, 'definition', v.definition,
    'compatible', exists(select 1 from national_catalog_category_group_mappings g
       where g.schema_version_id = p.schema_version_id and g.category_id = p.category_id
       and g.chz_product_group_code = ${schema.products.chzProductGroupCode} and g.state = 'exact' and g.reviewed_at is not null),
    'stableMappings', coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'sourceAttributeId',m.source_attribute_id,'targetField',m.target_field,'conversion',m.conversion,'mappingVersion',m.mapping_version)) from national_catalog_attribute_mappings m where m.schema_version_id = p.schema_version_id and m.target_field <> 'name'), '[]'::jsonb),
    'attributes', coalesce((select jsonb_object_agg(a.attribute_id,a.value) from product_regulatory_attribute_values a where a.tenant_id = ${schema.products.tenantId} and a.product_id = ${schema.products.id} and a.schema_version_id = p.schema_version_id and a.superseded_at is null), '{}'::jsonb)
  ) from product_regulatory_profiles p join national_catalog_schema_versions v on v.id = p.schema_version_id
  where p.tenant_id = ${schema.products.tenantId} and p.product_id = ${schema.products.id}
)`;
const localStateSchema = z.object({
  schemaVersionId: z.string(),
  categoryId: z.string(),
  status: z.string(),
  definition: z.unknown(),
  compatible: z.boolean(),
  stableMappings: z.array(mappingSchema),
  attributes: z.record(z.string(), productAttributeValueSchema),
});
/** A real confirmation reviews the complete card under this pinned supported-target universe.
 * Missing transferable field values are known absence; missing photos remain unknown.
 * This is comparison-only: never alter persisted source/review values or hashes. */
export function reviewedCatalogValues(
  projection: CatalogProjection | null,
): CatalogValueProjection | null {
  if (!projection) return null;
  const values: Record<string, unknown> = { name: null, ...projection.values };
  const context = projection.context;
  if (context) {
    for (const definition of parseCategorySchemaDefinition(context.definition).attributes) {
      const target = `attribute:${context.schemaVersionId}:${definition.id}`;
      if (!Object.hasOwn(values, target)) values[target] = null;
    }
    for (const mapping of context.stableMappings) {
      if (
        context.stableMappings.filter((other) => other.targetField === mapping.targetField)
          .length !== 1
      )
        continue;
      const target = `stable:${mapping.targetField}`;
      if (!Object.hasOwn(values, target)) values[target] = null;
    }
  }
  return { version: 1, values };
}

export function currentCatalogProjection(
  baseline: CatalogProjection | null,
  product: {
    name: string;
    printName: string | null;
    shelfLifeDays: number | null;
    chzProductGroupCode: number | null;
  },
  imageChecksum: string | null,
  localState: unknown,
): CatalogValueProjection {
  const values: Record<string, unknown> = { name: product.name, photo: imageChecksum };
  const context = baseline?.context;
  const parsed = localStateSchema.safeParse(localState);
  if (context && parsed.success) {
    const local = parsed.data;
    const compatible =
      local.schemaVersionId === context.schemaVersionId &&
      local.categoryId === context.categoryId &&
      product.chzProductGroupCode === context.groupCode &&
      local.status === "active" &&
      local.compatible &&
      canonicalJsonHash(local.definition) === canonicalJsonHash(context.definition) &&
      canonicalJsonHash(unorderedCatalogValue(local.stableMappings)) ===
        canonicalJsonHash(unorderedCatalogValue(context.stableMappings));
    if (compatible) {
      values["stable:print_name"] = product.printName;
      values["stable:shelf_life_days"] = product.shelfLifeDays;
      for (const target of Object.keys(reviewedCatalogValues(baseline)?.values ?? {})) {
        const prefix = `attribute:${context.schemaVersionId}:`;
        if (target.startsWith(prefix))
          values[target] = unorderedCatalogValue(
            local.attributes[target.slice(prefix.length)] ?? null,
          );
      }
    }
  }
  return { version: 1, values };
}

/** Exactly the Task8 version1 meaningful hash shape; context and local values are excluded. */
export function catalogProjectionHash(projection: CatalogProjection): string {
  const values = Object.entries(projection.values)
    .filter(([target]) => target !== "name" && target !== "photo")
    .map(([target, value]) => ({ target, value: unorderedCatalogValue(value) }))
    .sort((a, b) => a.target.localeCompare(b.target));
  return canonicalJsonHash({
    version: 1,
    providerName: projection.values.name ?? null,
    values,
    imageChecksum: projection.values.photo ?? null,
  });
}
