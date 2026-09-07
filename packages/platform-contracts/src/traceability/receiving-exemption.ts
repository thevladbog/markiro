import { isTlcSourceReferenceUrl } from "@markiro/domain";
import { z } from "zod";
import { preservedTlcSchema, tlcSchema } from "./lots.js";

export const receivingExemptReceiptSchema = z
  .object({
    evidenceUrl: z.string().refine(isTlcSourceReferenceUrl).nullable(),
    tlcHandling: z.enum(["preserve_existing", "assign_if_missing"]).nullable(),
    proposedTlc: tlcSchema.nullable(),
  })
  .strict();

export const preservedReceivingExemptReceiptSchema = receivingExemptReceiptSchema
  .extend({
    proposedTlc: preservedTlcSchema.nullable(),
  })
  .strict();
