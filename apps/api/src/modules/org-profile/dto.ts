import { z } from "zod";

/** GS1 GLN: exactly 13 digits (mirrors the check-digit family in @markiro/domain, but this layer only validates shape). */
const glnSchema = z.string().regex(/^\d{13}$/, "gln must be exactly 13 digits");

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
