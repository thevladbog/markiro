import { z } from "zod";
import type { LabelField } from "../labels/model.js";
import { LABEL_FIELDS } from "../labels/model.js";
import { productLabelValueDigest } from "../product-labels/km.js";
export const LABEL_FACTS_PROTOCOL = "warehouse-label-facts-v1";
const body = z.strictObject({
  version: z.literal(1),
  shiftId: z.uuid(),
  codeHash: z.string().regex(/^[0-9a-f]{64}$/),
  acceptedAt: z.iso.datetime(),
  fields: z.record(z.enum(LABEL_FIELDS), z.string().max(4096)),
  dateProvenance: z.enum(["accepted_context", "saved_print_job"]),
});
export const unitLabelFactsSchema = body
  .extend({ digest: z.string().regex(/^[0-9a-f]{64}$/) })
  .superRefine((value, ctx) => {
    const { digest, ...facts } = value;
    if (
      productLabelValueDigest(facts) !== digest ||
      value.fields["km.code"] !== "" ||
      value.fields.sscc !== "" ||
      value.fields.qty !== "1"
    )
      ctx.addIssue({ code: "custom", message: "Invalid unit label facts" });
  });
export type UnitLabelFactsV1 = z.infer<typeof unitLabelFactsSchema>;
export function makeUnitLabelFacts(input: z.infer<typeof body>): UnitLabelFactsV1 {
  const facts = body.parse(input);
  return unitLabelFactsSchema.parse({ ...facts, digest: productLabelValueDigest(facts) });
}
export const labelFactsBatchSchema = z.strictObject({
  protocol: z.literal(LABEL_FACTS_PROTOCOL),
  operatorId: z.uuid().nullable(),
  entries: z.array(unitLabelFactsSchema).min(1).max(100),
});
export const labelFactsReceiptSchema = z.strictObject({
  protocol: z.literal(LABEL_FACTS_PROTOCOL),
  results: z
    .array(
      z.strictObject({
        digest: z.string().regex(/^[0-9a-f]{64}$/),
        status: z.enum(["accepted", "retryable", "conflict"]),
      }),
    )
    .max(100),
});

/** An uncaptured operator is unknown, unlike an explicitly frozen empty field on a printed job. */
export function unitLabelFactsUnavailableFields(facts: UnitLabelFactsV1): LabelField[] {
  return facts.dateProvenance === "accepted_context" && facts.fields.operator === ""
    ? ["operator"]
    : [];
}
