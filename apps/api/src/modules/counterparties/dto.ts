import { z } from "zod";
import { hasValidCheckDigit } from "@markiro/domain";

/** GS1 GLN: exactly 13 digits with valid check digit. */
const glnSchema = z
  .string()
  .regex(/^\d{13}$/, "gln must be exactly 13 digits")
  .refine((v) => hasValidCheckDigit(v), { message: "GLN check digit is invalid" });

/** GS1 company prefix: 4-12 digits. */
const gs1PrefixSchema = z.string().regex(/^\d{4,12}$/, "gs1Prefixes entries must be 4-12 digits");

/** POST /counterparties schema. */
export const createCounterpartySchema = z.object({
  name: z.string().min(1).max(200),
  gln: glnSchema,
  inn: z.string().nullable().optional(),
  gs1Prefixes: z.array(gs1PrefixSchema).optional(),
  notes: z.string().nullable().optional(),
});
export type CreateCounterpartyDto = z.infer<typeof createCounterpartySchema>;

/** PATCH /counterparties/:id schema. */
export const updateCounterpartySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  gln: glnSchema.optional(),
  inn: z.string().nullable().optional(),
  gs1Prefixes: z.array(gs1PrefixSchema).optional(),
  notes: z.string().nullable().optional(),
});
export type UpdateCounterpartyDto = z.infer<typeof updateCounterpartySchema>;

/** Response DTO for a counterparty. */
export interface CounterpartyDto {
  id: string;
  name: string;
  gln: string;
  inn: string | null;
  gs1Prefixes: string[];
  notes: string | null;
  createdAt: Date;
}

/** GET /counterparties response. */
export interface ListCounterpartiesResponseDto {
  items: CounterpartyDto[];
}
