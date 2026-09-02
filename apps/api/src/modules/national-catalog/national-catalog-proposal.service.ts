import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  parseCategorySchemaDefinition,
  productAttributeValueSchema,
  validateProductAttributeValue,
  type CategoryAttributeDefinition,
  type ProductAttributeValue,
} from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";

import { DB } from "../../auth/auth.module";
import { updateProductSchema } from "../products/dto";
import {
  nationalCatalogSnapshotSourceRef,
  parsePersistedProposalDiff,
  REGULATORY_PROPOSAL_TTL_MS,
} from "../product-regulatory/proposal-schema";

type ProposalEntry = ReturnType<typeof parsePersistedProposalDiff>["entries"][number];
type AttributeProposalEntry = Extract<ProposalEntry, { target: "attribute" }>;
type StableFieldProposalEntry = Extract<ProposalEntry, { target: "stable_field" }>;

export interface NationalCatalogStableFieldMapping {
  id: string;
  sourceAttributeId: string;
  targetField: "name" | "print_name" | "shelf_life_days";
  conversion: { kind: "identity" | "string_trim" | "positive_integer" };
  mappingVersion: number;
}

type StableFieldName = NationalCatalogStableFieldMapping["targetField"];
type StableFieldValue = string | number | null;

export interface NationalCatalogImportSourceAttribute {
  id: number;
  value: string;
  unit: string | null;
}

export function buildNationalCatalogImportEntries(input: {
  schemaVersionId: string;
  definitions: readonly CategoryAttributeDefinition[];
  currentValues: ReadonlyMap<string, ProductAttributeValue>;
  sourceAttributes: readonly NationalCatalogImportSourceAttribute[];
  sourceName?: string | null;
  stableMappings?: readonly NationalCatalogStableFieldMapping[];
  currentStableFields?: ReadonlyMap<StableFieldName, StableFieldValue>;
  entryId?: (attributeId: string) => string;
}): {
  entries: Array<AttributeProposalEntry | StableFieldProposalEntry>;
  ignored: Array<{ attributeId: string; reason: "ambiguous" | "invalid_value" | "unmapped" }>;
} {
  const byDefinition = new Map(input.definitions.map((definition) => [definition.id, definition]));
  const grouped = new Map<string, NationalCatalogImportSourceAttribute[]>();
  const ignored: Array<{
    attributeId: string;
    reason: "ambiguous" | "invalid_value" | "unmapped";
  }> = [];
  for (const source of input.sourceAttributes) {
    const id = String(source.id);
    const values = grouped.get(id) ?? [];
    values.push(source);
    grouped.set(id, values);
  }

  const entries: Array<AttributeProposalEntry | StableFieldProposalEntry> = [];
  for (const [attributeId, sources] of [...grouped.entries()].sort(
    ([left], [right]) => Number(left) - Number(right),
  )) {
    const definition = byDefinition.get(attributeId);
    if (!definition) {
      ignored.push({ attributeId, reason: "unmapped" });
      continue;
    }
    const distinct = [...new Set(sources.map((source) => source.value.trim()).filter(Boolean))];
    if (definition.multiplicity === "one" && distinct.length !== 1) {
      ignored.push({ attributeId, reason: "ambiguous" });
      continue;
    }
    const proposedValue = sourceValue(definition, distinct, sources);
    if (!proposedValue || !validateProductAttributeValue(definition, proposedValue)) {
      ignored.push({ attributeId, reason: "invalid_value" });
      continue;
    }
    const currentValue = input.currentValues.get(attributeId) ?? null;
    entries.push({
      entryId: (input.entryId ?? (() => randomUUID()))(attributeId),
      target: "attribute",
      targetSchemaVersionId: input.schemaVersionId,
      targetAttributeId: attributeId,
      disposition:
        currentValue !== null && isDeepStrictEqual(currentValue, proposedValue)
          ? "transferable"
          : "convertible",
      currentValue,
      proposedValue,
    });
  }

  const mappingsByTarget = new Map<StableFieldName, NationalCatalogStableFieldMapping[]>();
  for (const mapping of input.stableMappings ?? []) {
    const values = mappingsByTarget.get(mapping.targetField) ?? [];
    values.push(mapping);
    mappingsByTarget.set(mapping.targetField, values);
  }
  for (const [targetField, mappings] of [...mappingsByTarget.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (mappings.length !== 1) {
      ignored.push({ attributeId: `stable:${targetField}`, reason: "ambiguous" });
      continue;
    }
    const mapping = mappings[0]!;
    const source = stableMappingSource(mapping.sourceAttributeId, input.sourceName, grouped);
    const proposedValue = convertStableFieldValue(targetField, mapping.conversion.kind, source);
    if (proposedValue === undefined) {
      ignored.push({ attributeId: `stable:${targetField}`, reason: "invalid_value" });
      continue;
    }
    entries.push({
      entryId: (input.entryId ?? (() => randomUUID()))(`stable:${targetField}`),
      target: "stable_field",
      targetField,
      mappingId: mapping.id,
      mappingVersion: mapping.mappingVersion,
      conversion: mapping.conversion,
      currentValue: input.currentStableFields?.get(targetField) ?? null,
      proposedValue,
    });
  }
  return { entries, ignored };
}

function stableMappingSource(
  sourceAttributeId: string,
  sourceName: string | null | undefined,
  grouped: ReadonlyMap<string, NationalCatalogImportSourceAttribute[]>,
): string | null {
  if (sourceAttributeId === "good_name") return sourceName ?? null;
  const values = [
    ...new Set(
      (grouped.get(sourceAttributeId) ?? [])
        .map((attribute) => attribute.value.trim())
        .filter(Boolean),
    ),
  ];
  return values.length === 1 ? values[0]! : null;
}

function convertStableFieldValue(
  targetField: StableFieldName,
  conversion: NationalCatalogStableFieldMapping["conversion"]["kind"],
  source: string | null,
): StableFieldValue | undefined {
  if (source === null) return undefined;
  if (conversion === "positive_integer") {
    if (targetField !== "shelf_life_days" || !/^\d+$/.test(source)) return undefined;
    const value = Number(source);
    const parsed = updateProductSchema.shape.shelfLifeDays.safeParse(value);
    return parsed.success && parsed.data !== null ? parsed.data : undefined;
  }
  if (targetField === "shelf_life_days") return undefined;
  const value = conversion === "string_trim" ? source.trim() : source;
  const parsed =
    targetField === "name"
      ? updateProductSchema.shape.name.safeParse(value)
      : updateProductSchema.shape.printName.safeParse(value);
  return parsed.success && parsed.data !== null ? parsed.data : undefined;
}

function sourceValue(
  definition: CategoryAttributeDefinition,
  values: string[],
  sources: NationalCatalogImportSourceAttribute[],
): ProductAttributeValue | null {
  const first = values[0];
  let candidate: unknown;
  switch (definition.valueType) {
    case "string":
    case "enum":
      candidate = first === undefined ? null : { type: definition.valueType, value: first };
      break;
    case "string_list":
    case "enum_list":
      candidate = values.length === 0 ? null : { type: definition.valueType, value: values };
      break;
    case "decimal": {
      const units = [...new Set(sources.map((source) => source.unit))];
      candidate =
        first !== undefined && /^-?\d+(\.\d+)?$/.test(first) && units.length === 1
          ? { type: "decimal", value: first, unit: units[0] ?? null }
          : null;
      break;
    }
    case "date":
      candidate =
        first !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(first)
          ? { type: "date", value: first }
          : null;
      break;
    case "boolean":
      candidate =
        first === "true" || first === "false" ? { type: "boolean", value: first === "true" } : null;
      break;
  }
  const parsed = productAttributeValueSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

const snapshotPayloadSchema = z
  .object({
    raw: z.record(z.string(), z.unknown()),
    normalized: z
      .object({
        name: z.string().nullable(),
        categories: z.array(z.object({ id: z.number().int().positive() }).strict()),
        attributes: z.array(
          z
            .object({
              id: z.number().int().positive(),
              value: z.string(),
              unit: z.string().nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

const stableMappingRowSchema = z
  .object({
    id: z.string().uuid(),
    sourceAttributeId: z.string().trim().min(1),
    targetField: z.enum(["name", "print_name", "shelf_life_days"]),
    conversion: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("identity") }).strict(),
      z.object({ kind: z.literal("string_trim") }).strict(),
      z.object({ kind: z.literal("positive_integer") }).strict(),
    ]),
    mappingVersion: z.number().int().positive(),
  })
  .strict();

@Injectable()
export class NationalCatalogProposalService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async preview(tenantId: string, actorUserId: string, productId: string, snapshotId: string) {
    return this.db.transaction(async (tx) => {
      const [product] = await tx
        .select({
          id: schema.products.id,
          archived: schema.products.archived,
          chzProductGroupCode: schema.products.chzProductGroupCode,
          name: schema.products.name,
          printName: schema.products.printName,
          shelfLifeDays: schema.products.shelfLifeDays,
        })
        .from(schema.products)
        .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)))
        .limit(1);
      if (!product) throw new NotFoundException();
      if (product.archived) throw new ConflictException({ code: "PRODUCT_ARCHIVED" });

      const [profile] = await tx
        .select()
        .from(schema.productRegulatoryProfiles)
        .where(
          and(
            eq(schema.productRegulatoryProfiles.tenantId, tenantId),
            eq(schema.productRegulatoryProfiles.productId, productId),
          ),
        )
        .for("update")
        .limit(1);
      if (!profile) {
        throw new ConflictException({ code: "PRODUCT_REGULATORY_BINDING_REQUIRED" });
      }
      const [target] = await tx
        .select()
        .from(schema.nationalCatalogSchemaVersions)
        .where(
          and(
            eq(schema.nationalCatalogSchemaVersions.id, profile.schemaVersionId),
            eq(schema.nationalCatalogSchemaVersions.status, "active"),
          ),
        )
        .limit(1);
      if (!target) throw new ConflictException({ code: "REGULATORY_PROPOSAL_SCHEMA_INACTIVE" });
      const definition = parseCategorySchemaDefinition(target.definition);
      const mappingRows = await tx
        .select({
          id: schema.nationalCatalogAttributeMappings.id,
          sourceAttributeId: schema.nationalCatalogAttributeMappings.sourceAttributeId,
          targetField: schema.nationalCatalogAttributeMappings.targetField,
          conversion: schema.nationalCatalogAttributeMappings.conversion,
          mappingVersion: schema.nationalCatalogAttributeMappings.mappingVersion,
        })
        .from(schema.nationalCatalogAttributeMappings)
        .where(eq(schema.nationalCatalogAttributeMappings.schemaVersionId, target.id));
      const stableMappings: NationalCatalogStableFieldMapping[] = [];
      for (const row of mappingRows) {
        const parsed = stableMappingRowSchema.safeParse(row);
        if (parsed.success) stableMappings.push(parsed.data);
      }
      const [mapping] = await tx
        .select({ id: schema.nationalCatalogCategoryGroupMappings.id })
        .from(schema.nationalCatalogCategoryGroupMappings)
        .where(
          and(
            eq(
              schema.nationalCatalogCategoryGroupMappings.chzProductGroupCode,
              product.chzProductGroupCode ?? -1,
            ),
            eq(schema.nationalCatalogCategoryGroupMappings.schemaVersionId, target.id),
            eq(schema.nationalCatalogCategoryGroupMappings.state, "exact"),
            isNotNull(schema.nationalCatalogCategoryGroupMappings.reviewedAt),
          ),
        )
        .limit(1);
      if (!mapping) {
        throw new ConflictException({ code: "NATIONAL_CATALOG_EXACT_MAPPING_REQUIRED" });
      }
      const [snapshot] = await tx
        .select()
        .from(schema.nationalCatalogCardSnapshots)
        .where(
          and(
            eq(schema.nationalCatalogCardSnapshots.tenantId, tenantId),
            eq(schema.nationalCatalogCardSnapshots.productId, productId),
            eq(schema.nationalCatalogCardSnapshots.id, snapshotId),
          ),
        )
        .limit(1);
      if (
        !snapshot ||
        snapshot.sourceMethod === "legacy_unknown" ||
        snapshot.payloadFormatVersion !== 2
      ) {
        throw new NotFoundException();
      }
      const payload = snapshotPayloadSchema.safeParse(snapshot.payload);
      if (!payload.success) {
        throw new ConflictException({ code: "NATIONAL_CATALOG_SNAPSHOT_INVALID" });
      }
      if (
        !payload.data.normalized.categories.some(
          (category) => String(category.id) === target.categoryId,
        )
      ) {
        throw new ConflictException({ code: "NATIONAL_CATALOG_CATEGORY_MISMATCH" });
      }
      const currentRows = await tx
        .select({
          attributeId: schema.productRegulatoryAttributeValues.attributeId,
          value: schema.productRegulatoryAttributeValues.value,
        })
        .from(schema.productRegulatoryAttributeValues)
        .where(
          and(
            eq(schema.productRegulatoryAttributeValues.tenantId, tenantId),
            eq(schema.productRegulatoryAttributeValues.productId, productId),
            isNull(schema.productRegulatoryAttributeValues.supersededAt),
          ),
        );
      const currentValues = new Map<string, ProductAttributeValue>();
      for (const row of currentRows) {
        const value = productAttributeValueSchema.safeParse(row.value);
        if (value.success) currentValues.set(row.attributeId, value.data);
      }
      const built = buildNationalCatalogImportEntries({
        schemaVersionId: target.id,
        definitions: definition.attributes,
        currentValues,
        sourceAttributes: payload.data.normalized.attributes,
        sourceName: payload.data.normalized.name,
        stableMappings,
        currentStableFields: new Map<StableFieldName, StableFieldValue>([
          ["name", product.name],
          ["print_name", product.printName],
          ["shelf_life_days", product.shelfLifeDays],
        ]),
      });
      if (built.entries.length === 0) {
        throw new ConflictException({ code: "NATIONAL_CATALOG_NO_IMPORTABLE_VALUES" });
      }
      const sourceRef = nationalCatalogSnapshotSourceRef(snapshot.id);
      const diff = parsePersistedProposalDiff(
        { version: 1, kind: "national_catalog_import", entries: built.entries },
        {
          kind: "national_catalog_import",
          source: "national_catalog",
          snapshotId: snapshot.id,
          sourceRef,
        },
      );
      const now = this.now();
      const [proposal] = await tx
        .insert(schema.productRegulatoryProposals)
        .values({
          tenantId,
          productId,
          snapshotId: snapshot.id,
          kind: "national_catalog_import",
          source: "national_catalog",
          sourceRef,
          baseRevision: profile.revision,
          diff,
          createdBy: actorUserId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + REGULATORY_PROPOSAL_TTL_MS),
        })
        .returning({ id: schema.productRegulatoryProposals.id });
      if (!proposal) throw new ConflictException("Failed to persist National Catalog preview");
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "product.national_catalog_import.previewed",
        outcome: "success",
        targetType: "product",
        targetId: productId,
        before: { revision: profile.revision },
        after: {
          proposalId: proposal.id,
          snapshotId: snapshot.id,
          sourceRef,
          selectableEntryCount: built.entries.length,
          ignored: built.ignored,
        },
      });
      return {
        proposalId: proposal.id,
        snapshotId: snapshot.id,
        baseRevision: profile.revision,
        diff,
        ignored: built.ignored,
      };
    });
  }
}
