import { photoReviewSchema } from "./national-catalog-image-state";
import { createHash } from "node:crypto";
import { z } from "zod";
import { productAttributeValueSchema } from "@markiro/domain";
import { schema } from "@markiro/db";
import {
  importApplySchema,
  importDecisionSchema,
  importPreviewSchema,
  type ImportApply,
} from "@markiro/platform-contracts";
import {
  attributeEntrySchema,
  stableFieldEntrySchema,
} from "../product-regulatory/proposal-schema";
import { optionSchema, type StoredImportDiff } from "./national-catalog-import-preview-builder";
import { createProductSchema } from "../products/dto";
import type { buildNationalCatalogImportEntries } from "./national-catalog-proposal.service";
import { canonicalJsonHash } from "./national-catalog-products.service";

const entrySchema = z.discriminatedUnion("target", [
  z
    .object({
      entryId: z.uuid(),
      target: z.literal("name"),
      source: z.enum(["manual", "national_catalog"]),
      currentValue: z.string().nullable(),
      proposedValue: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      entryId: z.uuid(),
      target: z.literal("category"),
      source: z.literal("national_catalog"),
      option: optionSchema,
    })
    .strict(),
  z
    .object({
      entryId: z.uuid(),
      target: z.literal("mapped"),
      source: z.literal("national_catalog"),
      entry: z.union([attributeEntrySchema, stableFieldEntrySchema]),
      requiresEntryIds: z.array(z.uuid()),
    })
    .strict(),
]);
// Persisted v1 views predate public dependency metadata. Read their strict shape,
// then derive dependencies from the private entries; never rewrite stored evidence.
const storedFieldSchema = z
  .object({
    ...importPreviewSchema.shape.fields.element.shape,
    requiresEntryIds: z.array(z.uuid()).optional(),
  })
  .strict();
const storedViewSchema = z
  .object({
    ...importPreviewSchema.shape,
    fields: z.array(storedFieldSchema),
    identity: importPreviewSchema.shape.identity.optional(),
  })
  .strict();
const enrichedStoredViewSchema = z
  .object({ ...importPreviewSchema.shape, identity: importPreviewSchema.shape.identity.optional() })
  .strict();
const diffSchema = z
  .object({ version: z.literal(1), entries: z.array(entrySchema), view: storedViewSchema })
  .strict();
export function parseImportDiff(value: unknown): StoredImportDiff {
  const diff = diffSchema.parse(value);
  const entries = new Map(diff.entries.map((entry) => [entry.entryId, entry]));
  const view = enrichedStoredViewSchema.parse({
    ...diff.view,
    fields: diff.view.fields.map((field) => {
      const entry = entries.get(field.id);
      return {
        ...field,
        requiresEntryIds: entry?.target === "mapped" ? entry.requiresEntryIds : [],
      };
    }),
  });
  return { ...diff, view };
}
export const storedDecisionSchema = importDecisionSchema.safeExtend({
  version: z.literal(1),
  acceptedBy: z.string().min(1),
  reviewedPhotoCandidateId: z.uuid().optional(),
  sourceHash: z.string().length(64),
  acceptedEntries: z.array(entrySchema),
});
export const sourceEnvelopeSchema = z
  .object({
    sourceMethod: z.literal("feed_product"),
    environment: z.enum(["production", "sandbox"]),
    cardId: z.string().min(1),
    boundGtin14: z.string().length(14),
    access: z.enum(["own", "provided"]).nullable(),
    raw: z.record(z.string(), z.unknown()),
    normalized: z
      .object({
        id: z.number().int(),
        name: z.string().nullable(),
        status: z.string().nullable(),
        detailedStatuses: z.array(z.string()),
        identifiers: z.array(z.object({ value: z.string() }).passthrough()),
        categories: z.array(z.unknown()),
        attributes: z.array(
          z
            .object({ id: z.number().int(), value: z.string(), gtin: z.string().nullable() })
            .passthrough(),
        ),
        images: z.array(z.unknown()),
      })
      .passthrough(),
  })
  .strict();
export const previousValuesSchema = z
  .object({
    product: z.record(z.string(), z.unknown()).nullable(),
    profile: z.record(z.string(), z.unknown()).nullable(),
    // Task7 persists local DB rows here; provider attributes belong only to sourceEnvelopeSchema.
    attributes: z.array(
      z
        .object({
          id: z.uuid(),
          tenantId: z.string().min(1),
          productId: z.uuid(),
          schemaVersionId: z.uuid(),
          attributeId: z.string().min(1),
          value: productAttributeValueSchema,
          state: z.enum(schema.productAttributeState.enumValues),
          source: z.enum(schema.productAttributeSource.enumValues),
          sourceRef: z.string().nullable(),
          observedAt: z.iso.datetime().nullable(),
          appliedBy: z.string().nullable(),
          appliedAt: z.iso.datetime(),
          supersededAt: z.iso.datetime().nullable(),
        })
        .strict(),
    ),
    link: z.object({ id: z.uuid(), revision: z.number() }).passthrough().nullable(),
    schema: z
      .object({
        version: z.object({ id: z.uuid() }).passthrough(),
        mapping: z.object({ id: z.uuid() }).passthrough(),
      })
      .nullable(),
    stableMappings: z.array(z.unknown()),
    initialProduct: z.object({
      chzProductGroupCode: z.number().nullable(),
      boxCapacity: z.null(),
      palletCapacity: z.null(),
      status: z.literal("draft"),
    }),
    expectedAbsentGtin: z.string().nullable(),
  })
  .strict();
/** Reconstructed fixed keys make request object key ordering irrelevant. */
export function canonicalImportDecisions(value: ImportApply) {
  const parsed = importApplySchema.parse(value);
  const decisions = parsed.decisions
    .map((d) => ({
      previewId: d.previewId,
      acceptedEntryIds: [...d.acceptedEntryIds].sort(),
      linkAction: d.linkAction,
      photo:
        d.photo.kind === "keep"
          ? {
              kind: "keep" as const,
              ...(d.photo.reviewedCandidateId
                ? { reviewedCandidateId: d.photo.reviewedCandidateId }
                : {}),
            }
          : { kind: "candidate" as const, candidateId: d.photo.candidateId },
    }))
    .sort((a, b) => a.previewId.localeCompare(b.previewId));
  return { decisions, hash: createHash("sha256").update(JSON.stringify(decisions)).digest("hex") };
}
export function storedCanonicalDecisions(requestId: string, values: unknown[]) {
  const decisions = values.map((value) => {
    const d = storedDecisionSchema.parse(value);
    return {
      previewId: d.previewId,
      acceptedEntryIds: d.acceptedEntryIds,
      linkAction: d.linkAction,
      photo: d.photo,
    };
  });
  return canonicalImportDecisions({ requestId, decisions });
}
/** Task10 must use the same baseline shape when comparing a fresh normalized card. */
export function meaningfulCatalogHash(input: {
  providerName: string | null;
  mappedEntries: ReturnType<typeof buildNationalCatalogImportEntries>["entries"];
  imageChecksum: string | null;
}): string {
  const parsedName = createProductSchema.shape.name.safeParse(input.providerName?.trim());
  const values = input.mappedEntries
    .map((entry) => ({
      target:
        entry.target === "attribute"
          ? `attribute:${entry.targetSchemaVersionId}:${entry.targetAttributeId}`
          : `stable:${entry.targetField}`,
      value: unorderedValue(entry.proposedValue),
    }))
    .sort((a, b) => a.target.localeCompare(b.target));
  return canonicalJsonHash({
    version: 1,
    providerName: parsedName.success ? parsedName.data : null,
    values,
    imageChecksum: input.imageChecksum,
  });
}
function unorderedValue(value: unknown): unknown {
  if (Array.isArray(value))
    return value
      .map(unorderedValue)
      .sort((a, b) => canonicalJsonHash(a).localeCompare(canonicalJsonHash(b)));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, unorderedValue(item)]),
    );
  return value;
}

export const appliedEvidenceSchema = z
  .object({
    version: z.literal(1),
    appliedBy: z.string().min(1),
    photoReview: photoReviewSchema.optional(),
    linkId: z.uuid(),
    cardId: z.string().min(1),
    environment: z.enum(["production", "sandbox"]),
    boundGtin14: z.string().length(14),
    snapshotId: z.uuid(),
    sourceRef: z.string().min(1),
    sourceHash: z.string().length(64),
    acceptedEntryIds: z.array(z.uuid()),
    acceptedEntries: z.array(entrySchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sourceRef !== `national-catalog-snapshot:${value.snapshotId}`)
      context.addIssue({ code: "custom", message: "invalid_snapshot_provenance" });
  });
