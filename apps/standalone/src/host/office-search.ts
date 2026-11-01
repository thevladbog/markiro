import { z } from "zod";

const id = z.string().uuid();
const codeHash = z.string().regex(/^[0-9a-f]{64}$/);
const source = z.enum(["local", "cloud"]);
export const officeSearchRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("code"), codeHash }).strict(),
  z.object({ kind: z.literal("sscc"), sscc: z.string().regex(/^\d{18}$/) }).strict(),
  z.object({ kind: z.literal("gtin"), gtin14: z.string().regex(/^\d{14}$/) }).strict(),
  z.object({ kind: z.literal("shift"), id }).strict(),
  z
    .object({
      kind: z.literal("text"),
      text: z.string().refine((v) => {
        const length = Array.from(v).length;
        return length >= 2 && length <= 120 && v.trim() === v && !/\p{Cc}/u.test(v);
      }),
    })
    .strict(),
]);
export type OfficeSearchRequest = z.infer<typeof officeSearchRequestSchema>;
export type OfficeSearchQuery = OfficeSearchRequest;

export const officeSearchTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shift"), id: z.string(), source }),
  z.object({ kind: z.literal("box"), id: z.string(), source }),
  z.object({ kind: z.literal("pallet"), id: z.string(), source }),
  z.object({ kind: z.literal("warehouse_pallet"), id: z.string() }),
  z.object({ kind: z.literal("product"), id: z.string() }),
  z.object({ kind: z.literal("disaggregation"), id: z.string() }),
  z.object({ kind: z.literal("code"), codeHash, source }),
  z.object({
    kind: z.literal("document"),
    id: z.string(),
    targetType: z.enum(["shift", "box", "pallet", "warehouse_pallet", "disaggregation_document"]),
    targetId: z.string(),
    source,
  }),
]);
export type OfficeSearchTarget = z.infer<typeof officeSearchTargetSchema>;
export const officeSearchResponseSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        detail: z.string().nullable(),
        target: officeSearchTargetSchema,
      }),
    )
    .max(50),
  truncated: z.boolean(),
});
export type OfficeSearchResponse = z.infer<typeof officeSearchResponseSchema>;
