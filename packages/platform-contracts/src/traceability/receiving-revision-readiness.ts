import { z } from "zod";
import { receivingReadinessSchema } from "./receiving-readiness.js";

/** New revision check; the persisted/legacy v3 schema remains version-pinned. */
export const receivingRevisionReadinessSchema = z
  .object({
    ...receivingReadinessSchema.shape,
    ruleVersion: z.literal("receiving-readiness-v4"),
    rootId: z.uuid(),
    expectedLifecycleVersion: z.number().int().min(1).max(2147483647),
    previousRevisionId: z.uuid().nullable(),
  })
  .strict()
  .refine(
    (value) =>
      (value.state === "blocked") === value.issues.some((issue) => issue.severity === "error"),
    "State must match blocking findings",
  )
  .refine((value) => {
    const original = value.eventId.toLowerCase() === value.rootId.toLowerCase();
    return original
      ? value.previousRevisionId === null
      : value.previousRevisionId !== null &&
          value.previousRevisionId.toLowerCase() !== value.eventId.toLowerCase();
  }, "Root, event and predecessor must describe the same revision kind");

export type ReceivingRevisionReadiness = z.infer<typeof receivingRevisionReadinessSchema>;
