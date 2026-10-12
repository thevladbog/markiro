import { z } from "zod";
import type { UsDatasetRegularResult } from "./us-dataset-regular-contract.js";
import type { UsDatasetSpecialChainsResult } from "./us-dataset-special-chains-seed.js";
import { assertBoundedSyntheticJson } from "./us-demo-journal-contract.js";
import { makeUsSixMonthRegularChain } from "./us-six-month-chains.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";

export type UsDatasetNativeAssemblyInput = Readonly<{
  datasetId: string;
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  state: "native_assembly_input_validated";
  datasetComplete: false;
  regular: UsDatasetRegularResult;
  special: UsDatasetSpecialChainsResult;
}>;

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const identity = {
  datasetId: uuid,
  version: z.literal("us-processor-six-month-v1"),
  definitionDigest: digest,
  datasetComplete: z.literal(false),
};
const regularSchema = z
  .object({
    ...identity,
    state: z.literal("selected_regular_shipping_verified"),
    range: z
      .object({
        startIndex: z.literal(0).refine((value) => !Object.is(value, -0)),
        count: z.literal(260),
      })
      .strict(),
    chains: z
      .array(
        z
          .object({
            index: z
              .number()
              .int()
              .min(0)
              .max(259)
              .refine((value) => !Object.is(value, -0)),
            unitKey: z.string(),
            shipmentCount: z.number().int().min(1).max(2),
            shippingResultDigest: digest,
          })
          .strict(),
      )
      .length(260),
  })
  .strict();
const specialSchema = z
  .object({
    ...identity,
    state: z.literal("special_chains_shipping_verified"),
    correction: z
      .object({
        unitKey: z.literal("correction_0001"),
        lifecycleResultDigest: digest,
        transformationResultDigest: digest,
        casesResultDigest: digest,
        shippingResultDigest: digest,
        shipmentCount: z.literal(1),
      })
      .strict(),
    orphan: z.object({ unitKey: z.literal("orphan_0001"), lifecycleResultDigest: digest }).strict(),
  })
  .strict();

/** The shared guard must validate descriptors and bounds before this traversal. */
function assertStandardArrays(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value) && Object.getPrototypeOf(value) !== Array.prototype)
    throw new Error("us_dataset_native_assembly_input_invalid");
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) throw new Error("us_dataset_native_assembly_input_invalid");
    assertStandardArrays(descriptor.value);
  }
}

/** Only schema-owned JSON enters this helper; caller evidence remains mutable. */
function freezeOwned<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}

/** Validates summary relationships only; it does not establish native database proof. */
export function makeUsDatasetNativeAssemblyInput(
  regular: unknown,
  special: unknown,
): UsDatasetNativeAssemblyInput {
  try {
    const envelope = { regular, special };
    assertBoundedSyntheticJson(envelope);
    assertStandardArrays(envelope);
    const parsedRegular = regularSchema.parse(regular);
    const parsedSpecial = specialSchema.parse(special);
    if (
      parsedRegular.datasetId !== parsedSpecial.datasetId ||
      parsedRegular.definitionDigest !== usSixMonthDefinition.digest ||
      parsedSpecial.definitionDigest !== usSixMonthDefinition.digest
    )
      throw new Error("us_dataset_native_assembly_input_invalid");
    const shippingDigests = new Set<string>();
    for (const [index, row] of parsedRegular.chains.entries()) {
      const recipe = makeUsSixMonthRegularChain(index);
      if (
        row.index !== index ||
        row.unitKey !== recipe.unitKey ||
        row.shipmentCount !== recipe.shipping.length ||
        shippingDigests.has(row.shippingResultDigest)
      )
        throw new Error("us_dataset_native_assembly_input_invalid");
      shippingDigests.add(row.shippingResultDigest);
    }
    if (shippingDigests.has(parsedSpecial.correction.shippingResultDigest))
      throw new Error("us_dataset_native_assembly_input_invalid");
    return freezeOwned({
      datasetId: parsedRegular.datasetId,
      version: parsedRegular.version,
      definitionDigest: parsedRegular.definitionDigest,
      state: "native_assembly_input_validated" as const,
      datasetComplete: false as const,
      regular: parsedRegular,
      special: parsedSpecial,
    });
  } catch {
    throw new Error("us_dataset_native_assembly_input_invalid");
  }
}
