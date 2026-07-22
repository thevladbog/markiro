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
