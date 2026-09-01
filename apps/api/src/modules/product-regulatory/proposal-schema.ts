import { createHash } from "node:crypto";

import { productAttributeValueSchema } from "@markiro/domain";
import { z } from "zod";

export const REGULATORY_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
const NATIONAL_CATALOG_SNAPSHOT_SOURCE_REF_PREFIX = "national-catalog-snapshot:";

const nonEmptyStringSchema = z.string().trim().min(1);
const uuidSchema = z.string().uuid();
const egaisCodeSchema = z.string().regex(/^\d{19}$/);

const targetBindingSchema = z
  .object({
    schemaVersionId: uuidSchema,
    categoryId: nonEmptyStringSchema,
    categoryName: nonEmptyStringSchema,
    tnVedCode: nonEmptyStringSchema.nullable(),
    okpd2Code: nonEmptyStringSchema.nullable(),
  })
  .strict();

const attributeEntrySchema = z
  .object({
    entryId: uuidSchema,
    target: z.literal("attribute"),
    targetSchemaVersionId: uuidSchema,
    targetAttributeId: nonEmptyStringSchema,
    disposition: z.enum(["transferable", "convertible", "inapplicable", "conflict"]),
    currentValue: productAttributeValueSchema.nullable(),
    proposedValue: productAttributeValueSchema.nullable(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.currentValue === null && entry.proposedValue === null) {
      context.addIssue({
        code: "custom",
        message: "Attribute entry has no current or proposed value",
      });
    }
    if (
      (entry.disposition === "transferable" || entry.disposition === "convertible") &&
      entry.proposedValue === null
    ) {
      context.addIssue({ code: "custom", message: "Applicable attribute entry requires a value" });
    }
    if (
      entry.disposition === "transferable" &&
      (entry.currentValue === null ||
        JSON.stringify(entry.currentValue) !== JSON.stringify(entry.proposedValue))
    ) {
      context.addIssue({ code: "custom", message: "Transferable attribute value must be exact" });
    }
  });

const egaisCodeCollectionSchema = z
  .object({
    codes: z.array(egaisCodeSchema).max(20),
    primaryCode: egaisCodeSchema.nullable(),
  })
  .strict()
  .superRefine((collection, context) => {
    if (new Set(collection.codes).size !== collection.codes.length) {
      context.addIssue({ code: "custom", path: ["codes"], message: "Duplicate EGAIS code" });
    }
    if (
      (collection.codes.length === 0 && collection.primaryCode !== null) ||
      (collection.codes.length > 0 &&
        (collection.primaryCode === null || !collection.codes.includes(collection.primaryCode)))
    ) {
      context.addIssue({
        code: "custom",
        path: ["primaryCode"],
        message: "Primary EGAIS code must belong to the collection",
      });
    }
  });

const egaisCodesEntrySchema = z
  .object({
    entryId: uuidSchema,
    target: z.literal("egais_codes"),
    current: egaisCodeCollectionSchema,
    proposed: egaisCodeCollectionSchema,
  })
  .strict();

const stableFieldConversionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("identity") }).strict(),
  z.object({ kind: z.literal("string_trim") }).strict(),
  z.object({ kind: z.literal("positive_integer") }).strict(),
]);

const stableFieldValueSchema = z.union([
  nonEmptyStringSchema,
  z.number().int().positive(),
  z.null(),
]);

const stableFieldEntrySchema = z
  .object({
    entryId: uuidSchema,
    target: z.literal("stable_field"),
    targetField: z.enum(["name", "print_name", "shelf_life_days"]),
    mappingId: uuidSchema,
    mappingVersion: z.number().int().positive(),
    conversion: stableFieldConversionSchema,
    currentValue: stableFieldValueSchema,
    proposedValue: stableFieldValueSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.targetField === "name") {
      if (typeof entry.currentValue !== "string" || typeof entry.proposedValue !== "string") {
        context.addIssue({ code: "custom", message: "Name mapping requires string values" });
      }
      if (entry.conversion.kind === "positive_integer") {
        context.addIssue({ code: "custom", message: "Name mapping conversion is incompatible" });
      }
      return;
    }
    if (entry.targetField === "print_name") {
      if (
        (entry.currentValue !== null && typeof entry.currentValue !== "string") ||
        (entry.proposedValue !== null && typeof entry.proposedValue !== "string")
      ) {
        context.addIssue({ code: "custom", message: "Print name mapping requires string values" });
      }
      if (entry.conversion.kind === "positive_integer") {
        context.addIssue({
          code: "custom",
          message: "Print name mapping conversion is incompatible",
        });
      }
      return;
    }
    if (
      (entry.currentValue !== null || entry.proposedValue !== null) &&
      entry.currentValue !== null &&
      typeof entry.currentValue !== "number"
    ) {
      context.addIssue({ code: "custom", message: "Shelf life mapping requires integer values" });
    }
    if (entry.proposedValue !== null && typeof entry.proposedValue !== "number") {
      context.addIssue({ code: "custom", message: "Shelf life mapping requires integer values" });
    }
    if (entry.conversion.kind === "string_trim") {
      context.addIssue({
        code: "custom",
        message: "Shelf life mapping conversion is incompatible",
      });
    }
  });

const proposalEntrySchema = z.union([
  attributeEntrySchema,
  egaisCodesEntrySchema,
  stableFieldEntrySchema,
]);

const versionedProposalDiffSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        version: z.literal(1),
        kind: z.literal("category_binding"),
        target: targetBindingSchema,
        entries: z.array(proposalEntrySchema).max(200),
      })
      .strict(),
    z
      .object({
        version: z.literal(1),
        kind: z.literal("category_change"),
        target: targetBindingSchema,
        entries: z.array(proposalEntrySchema).max(200),
      })
      .strict(),
    z
      .object({
        version: z.literal(1),
        kind: z.literal("national_catalog_import"),
        entries: z.array(proposalEntrySchema).max(200),
      })
      .strict(),
  ])
  .superRefine((diff, context) => {
    const ids = diff.entries.map((entry) => entry.entryId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Duplicate proposal entry ID",
      });
    }
  });

const legacyCategoryChangeDiffSchema = z
  .object({
    target: targetBindingSchema,
    values: z.array(
      z
        .object({
          entryId: uuidSchema,
          attributeId: nonEmptyStringSchema,
          disposition: z.enum(["transferable", "convertible", "inapplicable", "conflict"]),
          currentValue: productAttributeValueSchema,
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((diff, context) => {
    const ids = diff.values.map((entry) => entry.entryId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["values"],
        message: "Duplicate proposal entry ID",
      });
    }
  });

const proposalContextSchema = z
  .object({
    kind: z.enum(["category_binding", "category_change", "national_catalog_import"]),
    source: z.enum(["manual", "1c", "national_catalog", "migration"]),
    snapshotId: uuidSchema.nullable(),
    sourceRef: nonEmptyStringSchema.nullable(),
  })
  .strict();

export type PersistedProposalDiff = z.infer<typeof versionedProposalDiffSchema>;
export type PersistedProposalContext = z.infer<typeof proposalContextSchema>;

export function nationalCatalogSnapshotSourceRef(snapshotId: string): string {
  return `${NATIONAL_CATALOG_SNAPSHOT_SOURCE_REF_PREFIX}${uuidSchema.parse(snapshotId)}`;
}

export function parsePersistedProposalDiff(
  value: unknown,
  inputContext: PersistedProposalContext,
): PersistedProposalDiff {
  const proposalContext = proposalContextSchema.parse(inputContext);
  const candidate =
    isRecord(value) && ("version" in value || "kind" in value)
      ? versionedProposalDiffSchema.parse(value)
      : normalizeLegacyCategoryChange(value, proposalContext);

  if (candidate.kind !== proposalContext.kind) {
    throw new TypeError("Proposal kind does not match its persisted row");
  }
  if (candidate.kind === "national_catalog_import") {
    if (proposalContext.source !== "national_catalog") {
      throw new TypeError("National Catalog import requires the national_catalog source");
    }
    if (proposalContext.snapshotId === null) {
      throw new TypeError("National Catalog import requires a snapshot");
    }
    if (
      proposalContext.sourceRef !== nationalCatalogSnapshotSourceRef(proposalContext.snapshotId)
    ) {
      throw new TypeError("National Catalog source reference must identify the exact snapshot");
    }
  } else {
    if (proposalContext.source === "national_catalog") {
      throw new TypeError("National Catalog source requires the import proposal kind");
    }
    if (proposalContext.snapshotId !== null) {
      throw new TypeError("Category binding proposals cannot carry a National Catalog snapshot");
    }
  }
  return candidate;
}

export function canonicalProposalSelection(acceptedEntryIds: string[]): {
  acceptedEntryIds: string[];
  hash: string;
} {
  const parsed = z.array(uuidSchema).max(200).parse(acceptedEntryIds);
  if (new Set(parsed).size !== parsed.length) {
    throw new TypeError("Duplicate accepted proposal entry ID");
  }
  const canonical = [...parsed].sort();
  return {
    acceptedEntryIds: canonical,
    hash: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
  };
}

function normalizeLegacyCategoryChange(
  value: unknown,
  proposalContext: PersistedProposalContext,
): PersistedProposalDiff {
  if (proposalContext.kind !== "category_change") {
    throw new TypeError("Legacy proposal diff is valid only for category_change rows");
  }
  const legacy = legacyCategoryChangeDiffSchema.parse(value);
  return versionedProposalDiffSchema.parse({
    version: 1,
    kind: "category_change",
    target: legacy.target,
    entries: legacy.values.map((entry) => ({
      entryId: entry.entryId,
      target: "attribute" as const,
      targetSchemaVersionId: legacy.target.schemaVersionId,
      targetAttributeId: entry.attributeId,
      disposition: entry.disposition,
      currentValue: entry.currentValue,
      proposedValue:
        entry.disposition === "transferable" || entry.disposition === "convertible"
          ? entry.currentValue
          : null,
    })),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
