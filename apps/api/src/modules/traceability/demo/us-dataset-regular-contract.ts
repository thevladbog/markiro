import { z } from "zod";
import { assertBoundedSyntheticJson } from "./us-demo-journal-contract.js";

export type UsDatasetRegularRange = Readonly<{ startIndex: number; count: number }>;
export type UsDatasetRegularResult = Readonly<{
  datasetId: string;
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  range: UsDatasetRegularRange;
  state: "selected_regular_shipping_verified";
  datasetComplete: false;
  chains: readonly Readonly<{
    index: number;
    unitKey: string;
    shipmentCount: number;
    shippingResultDigest: string;
  }>[];
}>;

const rangeSchema = z
  .object({
    startIndex: z
      .number()
      .int()
      .min(0)
      .max(259)
      .refine((value) => !Object.is(value, -0)),
    count: z.number().int().min(1).max(260),
  })
  .strict()
  .refine(({ startIndex, count }) => startIndex + count <= 260);

/** Descriptor-safe JSON guard precedes all schema reads of caller evidence. */
export function parseUsDatasetRegularRange(raw: unknown): UsDatasetRegularRange {
  try {
    assertBoundedSyntheticJson(raw);
    const parsed = rangeSchema.safeParse(raw);
    if (!parsed.success) throw new Error("us_dataset_regular_range_invalid");
    return Object.freeze({ ...parsed.data });
  } catch {
    throw new Error("us_dataset_regular_range_invalid");
  }
}

export function makeUsDatasetRegularIndices(range: UsDatasetRegularRange): readonly number[] {
  const selected = parseUsDatasetRegularRange(range);
  return Object.freeze(
    Array.from({ length: selected.count }, (_, index) => selected.startIndex + index),
  );
}
