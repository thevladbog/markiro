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
import type { CatalogValueProjection } from "./national-catalog-summary";
import { nationalCatalogProductAttributeUnit } from "./national-catalog.types";
import {
  catalogProductFieldForLabel,
  productFieldMappingSchema,
  readCatalogProductFields,
  type CatalogProductField,
} from "./national-catalog-product-fields";

const allSupportedProductFields = [
  "egais_code",
  "shelf_life_days",
] as const satisfies readonly CatalogProductField[];
const supportedProductFieldSchema = z.enum(allSupportedProductFields);
const productFieldReviewRequiredValue = {
  state: "review_required",
  reason: "source_field_changed",
} as const;

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
    productFieldMappings: z.array(productFieldMappingSchema).optional(),
    supportedProductFields: z
      .array(supportedProductFieldSchema)
      .max(allSupportedProductFields.length)
      .refine((fields) => new Set(fields).size === fields.length)
      .optional(),
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
  productFields?: ReturnType<typeof readCatalogProductFields>;
  productFieldMappings?: NonNullable<CatalogProjection["productFieldMappings"]>;
  supportedProductFields?: NonNullable<CatalogProjection["supportedProductFields"]>;
  reservedProductFieldSourceIds?: readonly number[];
}): CatalogProjection {
  const values: Record<string, unknown> = {};
  const name = createProductSchema.shape.name.safeParse(input.providerName?.trim());
  if (name.success) values.name = name.data;
  const productFieldMappings =
    input.productFieldMappings ??
    input.productFields?.map(({ targetField, sourceAttributeId, mappingVersion }) => ({
      targetField,
      sourceAttributeId,
      mappingVersion,
    }));
  const supportedProductFields =
    input.supportedProductFields ??
    (input.productFields === undefined ? undefined : [...allSupportedProductFields]);
  const reservedTargets = new Set<CatalogProductField>([
    ...(productFieldMappings?.map((mapping) => mapping.targetField) ?? []),
    ...(input.productFields?.map((field) => field.targetField) ?? []),
  ]);
  const reservedSourceIds = new Set([
    ...(productFieldMappings?.map((mapping) => String(mapping.sourceAttributeId)) ?? []),
    ...(input.productFields?.map((field) => String(field.sourceAttributeId)) ?? []),
    ...(input.reservedProductFieldSourceIds?.map(String) ?? []),
  ]);
  for (const entry of input.mappedEntries) {
    if (
      (entry.target === "stable_field" &&
        entry.targetField === "shelf_life_days" &&
        reservedTargets.has(entry.targetField)) ||
      (entry.target === "attribute" && reservedSourceIds.has(entry.targetAttributeId))
    )
      continue;
    const key =
      entry.target === "attribute"
        ? `attribute:${entry.targetSchemaVersionId}:${entry.targetAttributeId}`
        : `stable:${entry.targetField}`;
    values[key] = unorderedCatalogValue(entry.proposedValue);
  }
  if (input.imageChecksum !== null) values.photo = input.imageChecksum;
  for (const field of input.productFields ?? [])
    values[`stable:${field.targetField}`] = field.value;
  return {
    version: 1,
    values,
    context: input.context,
    ...(productFieldMappings?.length ? { productFieldMappings } : {}),
    ...(supportedProductFields ? { supportedProductFields } : {}),
  };
}

function supportedProductFieldsFor(projection: CatalogProjection): CatalogProductField[] {
  return (
    projection.supportedProductFields ?? [
      ...new Set(projection.productFieldMappings?.map((mapping) => mapping.targetField) ?? []),
    ]
  );
}

function sourceAttributeIsInScope(attribute: { gtin: string | null }, gtin14: string): boolean {
  return (
    attribute.gtin === null ||
    (isValidGtin(attribute.gtin) && normalizeToGtin14(attribute.gtin) === gtin14)
  );
}
export function observeCatalogProjection(
  source: {
    name: string | null;
    categories: Array<{ id: number }>;
    attributes: Array<{
      id: number;
      name?: string | undefined;
      value: string;
      gtin: string | null;
    }>;
  },
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
            .map((a) => ({
              id: a.id,
              value: a.value,
              unit: nationalCatalogProductAttributeUnit(a),
            })),
          sourceName: source.name,
          stableMappings: context.stableMappings,
          currentStableFields: new Map(),
        }).entries
      : [];
  const supportedProductFields = supportedProductFieldsFor(baseline);
  const productFieldSupportDeclared =
    baseline.supportedProductFields !== undefined || baseline.productFieldMappings !== undefined;
  const sourceProductFields = productFieldSupportDeclared
    ? readCatalogProductFields(source.attributes, gtin14)
    : [];
  const trustedProductFields = sourceProductFields.filter((field) => {
    if (!supportedProductFields.includes(field.targetField)) return false;
    const mapping = baseline.productFieldMappings?.find(
      (candidate) => candidate.targetField === field.targetField,
    );
    return (
      mapping === undefined ||
      (mapping.sourceAttributeId === field.sourceAttributeId &&
        mapping.mappingVersion === field.mappingVersion)
    );
  });
  const scopedAttributes = source.attributes.filter((attribute) =>
    sourceAttributeIsInScope(attribute, gtin14),
  );
  const reservedProductFieldSourceIds = productFieldSupportDeclared
    ? scopedAttributes.flatMap((attribute) => {
        const isRecognizedLabel =
          attribute.name !== undefined && catalogProductFieldForLabel(attribute.name) !== undefined;
        const isPinnedId = baseline.productFieldMappings?.some(
          (mapping) => mapping.sourceAttributeId === attribute.id,
        );
        return isRecognizedLabel || isPinnedId ? [attribute.id] : [];
      })
    : [];
  const projection = buildCatalogProjection({
    providerName: source.name,
    mappedEntries,
    imageChecksum,
    context,
    ...(productFieldSupportDeclared ? { productFields: trustedProductFields } : {}),
    ...(baseline.productFieldMappings
      ? { productFieldMappings: baseline.productFieldMappings }
      : {}),
    ...(baseline.supportedProductFields
      ? { supportedProductFields: baseline.supportedProductFields }
      : {}),
    reservedProductFieldSourceIds,
  });
  for (const mapping of baseline.productFieldMappings ?? []) {
    if (trustedProductFields.some((field) => field.targetField === mapping.targetField)) continue;
    const fieldStillPresent = scopedAttributes.some(
      (attribute) =>
        attribute.id === mapping.sourceAttributeId ||
        (attribute.name !== undefined &&
          catalogProductFieldForLabel(attribute.name) === mapping.targetField),
    );
    if (fieldStillPresent)
      projection.values[`stable:${mapping.targetField}`] = productFieldReviewRequiredValue;
  }
  return projection;
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
  const supportedProductFields = supportedProductFieldsFor(projection);
  for (const targetField of supportedProductFields) {
    const target = `stable:${targetField}`;
    if (!Object.hasOwn(values, target)) values[target] = null;
  }
  const reservedSourceIds = new Set(
    projection.productFieldMappings?.map((mapping) => String(mapping.sourceAttributeId)) ?? [],
  );
  const context = projection.context;
  if (context) {
    for (const definition of parseCategorySchemaDefinition(context.definition).attributes) {
      if (reservedSourceIds.has(definition.id)) continue;
      const target = `attribute:${context.schemaVersionId}:${definition.id}`;
      if (!Object.hasOwn(values, target)) values[target] = null;
    }
    for (const mapping of context.stableMappings) {
      if (
        projection.productFieldMappings?.some(
          (productMapping) => productMapping.targetField === mapping.targetField,
        )
      )
        continue;
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
    egaisCode?: string | null;
    chzProductGroupCode: number | null;
  },
  imageChecksum: string | null,
  localState: unknown,
): CatalogValueProjection {
  const values: Record<string, unknown> = { name: product.name, photo: imageChecksum };
  for (const targetField of baseline ? supportedProductFieldsFor(baseline) : []) {
    if (targetField === "shelf_life_days") values["stable:shelf_life_days"] = product.shelfLifeDays;
    if (targetField === "egais_code") values["stable:egais_code"] = product.egaisCode ?? null;
  }
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
