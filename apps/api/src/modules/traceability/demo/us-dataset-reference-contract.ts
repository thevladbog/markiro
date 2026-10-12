import { canonicalExportDigest } from "./us-demo-canonical.js";
import {
  platformUuidSchema,
  productTraceabilityProfileSchema,
  usLocationSchema,
  usPartySchema,
  usProductSchema,
  type ProductTraceabilityProfile,
  type UsLocation,
  type UsParty,
  type UsProduct,
} from "@markiro/platform-contracts";
import { z } from "zod";
import { assertBoundedSyntheticJson } from "./us-demo-journal-contract.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";
import { makeUsSixMonthCatalogue } from "./us-six-month-references.js";

const catalogue = makeUsSixMonthCatalogue();

export type UsDatasetReferenceResult = Readonly<{
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  bindings: Readonly<{
    parties: readonly Readonly<{ key: string; id: string }>[];
    locations: readonly Readonly<{ key: string; id: string }>[];
    products: readonly Readonly<{ key: string; id: string }>[];
  }>;
  evidence: Readonly<{
    parties: readonly UsParty[];
    locations: readonly UsLocation[];
    products: readonly UsProduct[];
    profiles: readonly ProductTraceabilityProfile[];
  }>;
}>;

export function datasetReferenceError(
  code:
    | "us_dataset_reference_mismatch"
    | "us_dataset_references_incomplete"
    | "us_dataset_reference_conflict",
  cause?: unknown,
): Error & { unitKey: "references"; stage: "references" } {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), {
    unitKey: "references" as const,
    stage: "references" as const,
  });
}

const binding = z.object({ key: z.string(), id: platformUuidSchema }).strict();
const resultSchema = z
  .object({
    version: z.literal("us-processor-six-month-v1"),
    definitionDigest: z.literal(usSixMonthDefinition.digest),
    bindings: z
      .object({
        parties: z.array(binding).length(23),
        locations: z.array(binding).length(23),
        products: z.array(binding).length(16),
      })
      .strict(),
    evidence: z
      .object({
        parties: z.array(usPartySchema).length(23),
        locations: z.array(usLocationSchema).length(23),
        products: z.array(usProductSchema).length(16),
        profiles: z.array(productTraceabilityProfileSchema).length(16),
      })
      .strict(),
  })
  .strict();

/** Reject unsafe or oversized raw JSON before any schema can read or normalize it. */
export function parseUsDatasetReferenceResult(raw: unknown): UsDatasetReferenceResult {
  try {
    assertBoundedSyntheticJson(raw);
    const parsed = resultSchema.safeParse(raw);
    if (!parsed.success) throw datasetReferenceError("us_dataset_reference_mismatch");
    const result = parsed.data;
    const groups = ["parties", "locations", "products"] as const;
    const ids = groups.flatMap((group) => result.bindings[group].map(({ id }) => id));
    if (
      new Set(ids).size !== 62 ||
      groups.some((group) =>
        result.bindings[group].some(
          ({ key, id }, index) =>
            key !== catalogue[group][index]?.key || id !== result.evidence[group][index]?.id,
        ),
      ) ||
      result.evidence.profiles.some(
        (profile, index) => profile.productId !== result.bindings.products[index]?.id,
      ) ||
      canonicalExportDigest(raw) !== canonicalExportDigest(result)
    )
      throw datasetReferenceError("us_dataset_reference_mismatch");
    return result;
  } catch (cause) {
    throw datasetReferenceError("us_dataset_reference_mismatch", cause);
  }
}
