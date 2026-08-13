import { z } from "zod";
import { hasValidCheckDigit } from "@markiro/domain";

/** GS1 GLN: exactly 13 digits with valid check digit. */
const glnSchema = z
  .string()
  .regex(/^\d{13}$/, "gln must be exactly 13 digits")
  .refine((v) => hasValidCheckDigit(v), { message: "GLN check digit is invalid" });

/** GS1 company prefix: 4-12 digits. */
const gs1PrefixSchema = z.string().regex(/^\d{4,12}$/, "gs1Prefixes entries must be 4-12 digits");

export const putOrgProfileSchema = z.object({
  gln: glnSchema.nullable().optional(),
  gs1Prefixes: z.array(gs1PrefixSchema).optional(),
  inn: z.string().nullable().optional(),
});
export type PutOrgProfileDto = z.infer<typeof putOrgProfileSchema>;

export interface OrgProfileDto {
  gln: string | null;
  gs1Prefixes: string[];
  inn: string | null;
}

/**
 * A 9-digit issuer prefix leaves a 7-digit serial, so the GS1-valid space is
 * 0..9_999_999 per extension digit. Fresh box allocation starts at 1, while
 * serial zero remains valid historical SSCC input. Seeding beyond the space
 * cannot produce a valid SSCC, so it is refused at the boundary rather than
 * at the first close.
 *
 * Shared by both the org-profile and counterparties controllers (Task 5) --
 * one tenant's own counter and each counterparty's counter carry the exact
 * same shape, so the schema is defined once here and imported by the other.
 */
export const ssccCounterSchema = z
  .object({
    extensionDigit: z.number().int().min(0).max(9),
    nextSerial: z.number().int().min(0).max(9_999_999),
  })
  .superRefine(({ extensionDigit, nextSerial }, ctx) => {
    if (extensionDigit === 0 && nextSerial < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["nextSerial"],
        message: "box nextSerial must be at least 1",
      });
    }
  });
export type SsccCounterDto = z.infer<typeof ssccCounterSchema>;
