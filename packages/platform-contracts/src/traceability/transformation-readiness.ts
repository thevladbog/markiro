import { TRANSFORMATION_READINESS_RULE_VERSION } from "@markiro/domain";
import { z } from "zod";

const version = z.number().int().min(1).max(2147483647);
export const transformationIssueSchema = z
  .object({
    severity: z.literal("error"),
    group: z.enum(["event", "inputs", "outputs", "documents"]),
    line: z.number().int().min(1).max(100).nullable(),
    field: z.string().min(1).max(100),
    code: z.string().min(1).max(100),
    detail: z.string().max(200).nullable(),
  })
  .strict()
  .refine((issue) => issue.group === "inputs" || issue.group === "outputs" || issue.line === null);
export const transformationReadinessSchema = z
  .object({
    eventId: z.uuid(),
    state: z.enum(["complete", "incomplete"]),
    ruleVersion: z.literal(TRANSFORMATION_READINESS_RULE_VERSION),
    expectedDraftVersion: version,
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    issues: z.array(transformationIssueSchema).max(5000),
  })
  .strict()
  .refine(
    (value) => (value.state === "complete") === (value.issues.length === 0),
    "State must match readiness issues",
  );
export type TransformationReadiness = z.infer<typeof transformationReadinessSchema>;
