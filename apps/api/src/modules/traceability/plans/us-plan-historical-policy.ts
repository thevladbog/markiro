import { z } from "zod";

// Historical descriptors are append-only. A policy change needs a new explicit
// decoder here; never replace v1 with values derived from today's domain policy.
const workflowV1Schema = z
  .object({
    version: z.literal(1),
    reviewMode: z.literal("manual"),
    coverageStatuses: z.tuple([
      z.literal("covered"),
      z.literal("contains_ftl_same_form"),
      z.literal("not_covered"),
      z.literal("unknown"),
      z.literal("exemption_review_required"),
    ]),
    positiveCoverageStatuses: z.tuple([z.literal("covered"), z.literal("contains_ftl_same_form")]),
    positiveCoverageEvidenceFields: z.tuple([
      z.literal("coverageRationale"),
      z.literal("ftlCategory"),
      z.literal("ftlSourceUrl"),
      z.literal("ftlSourceVersion"),
    ]),
    coverageChangeAuthority: z.literal("traceability.qa.manage"),
    reviewerAttribution: z.literal("server_actor_on_coverage_change"),
    reviewTimeAttribution: z.literal("server_time_on_coverage_change"),
    reviewCadenceSource: z.literal("operator_narrative"),
    automaticLegalDetermination: z.literal(false),
  })
  .strict();

export function parseUsPlanHistoricalWorkflow(value: unknown) {
  return workflowV1Schema.parse(value);
}
