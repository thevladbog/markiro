import { RECEIVING_CSV_VERSION } from "@markiro/domain";
import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { receivingDraftSchema } from "./receiving.js";

const maxFileBytes = 256 * 1024;
const maxEncodedLength = Math.ceil(maxFileBytes / 3) * 4;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Check length, alphabet and unused bits before any decoder can accept aliases. */
function canonicalBoundedBase64(value: string): boolean {
  if (value.length > maxEncodedLength || value.length % 4 !== 0) return false;
  if (!value.length) return true; // The CSV decoder reports an empty file as no_rows.
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if ((value.length / 4) * 3 - padding > maxFileBytes) return false;
  const dataEnd = value.length - padding;
  for (let index = 0; index < dataEnd; index++) {
    const char = value[index];
    if (char === undefined || !alphabet.includes(char)) return false;
  }
  const last = value[dataEnd - 1];
  if (last === undefined) return false;
  const bits = alphabet.indexOf(last);
  return padding === 2 ? (bits & 15) === 0 : padding === 1 ? (bits & 3) === 0 : true;
}

/** Body shape only. It neither creates a preview nor authorizes a tenant write. */
export const receivingCsvPreviewInputSchema = z
  .object({
    templateVersion: z.literal(RECEIVING_CSV_VERSION),
    fileBase64: z
      .string()
      .max(maxEncodedLength)
      .refine(canonicalBoundedBase64, "Expected canonical base64 within the 256 KiB file limit"),
    header: receivingDraftSchema.omit({ items: true }),
    fileName: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value), "Invalid file name")
      .optional(),
  })
  .strict();

/** The tenant and run UUID come from authenticated/path context, never this body. */
export const receivingCsvApplyInputSchema = z
  .object({
    operationKey: platformUuidSchema,
    expectedPreviewDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type ReceivingCsvPreviewInput = z.infer<typeof receivingCsvPreviewInputSchema>;
export type ReceivingCsvApplyInput = z.infer<typeof receivingCsvApplyInputSchema>;
