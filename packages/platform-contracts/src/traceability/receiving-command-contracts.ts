import { z } from "zod";
import { receivingDraftRecordSchema, saveReceivingDraftSchema } from "./receiving-records.js";
import {
  finalizeReceivingSchema,
  receivingFinalizedRecordSchema,
} from "./receiving-finalization.js";
import {
  finalizeReceivingRevisionSchema,
  saveReceivingAmendmentSchema,
} from "./receiving-lifecycle.js";
import { receivingOperationReceiptV2Schema } from "./receiving-live-records.js";

// The strict legacy branches stay version-pinned. A partial revision command
// cannot fall back to an original command by dropping its lifecycle fields.
export const saveReceivingCommandSchema = z.union([
  saveReceivingDraftSchema,
  saveReceivingAmendmentSchema,
]);
export const finalizeReceivingCommandSchema = z.union([
  finalizeReceivingSchema,
  finalizeReceivingRevisionSchema,
]);

// These are historical acknowledgements, not current state. Consumers must
// additionally correlate the requested key/target/input, then perform a live GET.
export const receivingCreateResultSchema = z.union([
  receivingOperationReceiptV2Schema.safeExtend({ command: z.literal("receiving.create") }),
  receivingDraftRecordSchema,
]);
export const receivingSaveResultSchema = z.union([
  receivingOperationReceiptV2Schema.safeExtend({ command: z.literal("receiving.save") }),
  receivingDraftRecordSchema,
]);
export const receivingFinalizeResultSchema = z.union([
  receivingOperationReceiptV2Schema.safeExtend({ command: z.literal("receiving.finalize") }),
  receivingFinalizedRecordSchema,
]);

export type SaveReceivingCommandInput = z.infer<typeof saveReceivingCommandSchema>;
export type FinalizeReceivingCommandInput = z.infer<typeof finalizeReceivingCommandSchema>;
export type ReceivingCreateResult = z.infer<typeof receivingCreateResultSchema>;
export type ReceivingSaveResult = z.infer<typeof receivingSaveResultSchema>;
export type ReceivingFinalizeResult = z.infer<typeof receivingFinalizeResultSchema>;
