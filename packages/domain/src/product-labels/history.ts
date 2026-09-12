import { z } from "zod";
import { productLabelEventSchema } from "./contracts.js";

export const productLabelSummarySchema = z.strictObject({
  sentAttempts: z.number().int().nonnegative(),
  verifiedAttempts: z.number().int().nonnegative(),
  unresolvedJobs: z.number().int().nonnegative(),
  reprintAttempts: z.number().int().nonnegative(),
});
export const productLabelHistoryRowSchema = z.strictObject({
  jobId: z.uuid(),
  deviceId: z.uuid(),
  codeSuffix: z.string().max(6),
  acceptedAt: z.iso.datetime(),
  status: z.enum(["prepared", "sending", "awaiting_verification", "completed", "attention"]),
  verificationOutcome: z.enum(["not_required", "pending", "verified", "skipped"]),
  attemptNo: z.number().int().positive(),
  ownershipConflict: z.boolean(),
});
export const productLabelHistorySchema = z.strictObject({
  summary: productLabelSummarySchema,
  items: z.array(productLabelHistoryRowSchema).max(100),
  nextCursor: z.string().nullable(),
});
export const productLabelEventHistorySchema = z.strictObject({
  items: z.array(productLabelEventSchema).max(100),
  nextSequence: z.number().int().positive().nullable(),
});
export type ProductLabelSummary = z.infer<typeof productLabelSummarySchema>;
export type ProductLabelHistoryRow = z.infer<typeof productLabelHistoryRowSchema>;
export type ProductLabelHistory = z.infer<typeof productLabelHistorySchema>;
export type ProductLabelEventHistory = z.infer<typeof productLabelEventHistorySchema>;
