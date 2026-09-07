import { z } from "zod";
import {
  RECEIVING_READINESS_RULE_VERSION,
  RECEIVING_READINESS_FIELDS,
  RECEIVING_READINESS_CODES,
  RECEIVING_READINESS_DETAILS,
} from "@markiro/domain";

const version = z.number().int().min(1).max(2147483647);
export const receivingReadinessQuerySchema = z
  .object({
    expectedDraftVersion: z.union([
      version,
      z
        .string()
        .regex(/^[1-9]\d{0,9}$/)
        .transform(Number)
        .pipe(version),
    ]),
  })
  .strict();
export const receivingReadinessIssueSchema = z
  .object({
    severity: z.enum(["error", "warning"]),
    group: z.enum(["header", "lines", "documents"]),
    line: z.number().int().min(1).max(100).nullable(),
    field: z.enum(RECEIVING_READINESS_FIELDS),
    code: z.enum(RECEIVING_READINESS_CODES),
    detail: z.enum(RECEIVING_READINESS_DETAILS).nullable(),
  })
  .strict()
  .refine(
    (value) => value.group === "lines" || value.line === null,
    "Only line findings have a line number",
  );
export const receivingReadinessSchema = z
  .object({
    eventId: z.uuid(),
    draftVersion: version,
    checkedAt: z.iso.datetime(),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    ruleVersion: z.literal(RECEIVING_READINESS_RULE_VERSION),
    profileCode: z.enum(["US_FSMA204_PROCESSOR", "US_GENERIC_LOT_TRACEABILITY"]),
    state: z.enum(["complete", "blocked"]),
    issues: z.array(receivingReadinessIssueSchema).max(5000),
    exemptReviewRequiredLines: z
      .array(z.number().int().min(1).max(100))
      .max(100)
      .refine((lines) =>
        lines.every((line, index) => index === 0 || line > (lines[index - 1] ?? 0)),
      ),
  })
  .strict()
  .refine(
    (value) =>
      (value.state === "blocked") === value.issues.some((issue) => issue.severity === "error"),
    "State must match blocking findings",
  );
export type ReceivingReadiness = z.infer<typeof receivingReadinessSchema>;
export type ReceivingReadinessQuery = z.infer<typeof receivingReadinessQuerySchema>;
