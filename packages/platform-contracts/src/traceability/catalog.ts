import { isValidGtin } from "@markiro/domain";
import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { listUsPartiesQuerySchema } from "./master-data.js";

const productNameSchema = z.string().trim().min(1).max(200);
const suppliedGtinSchema = z.string().refine(isValidGtin).nullable();

export const createUsProductSchema = z
  .object({
    name: productNameSchema,
    gtin: suppliedGtinSchema.default(null),
  })
  .strict();

export const updateUsProductSchema = z
  .object({
    name: productNameSchema.optional(),
    gtin: suppliedGtinSchema.optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Expected at least one field",
  });

const canonicalGtin14Schema = z
  .string()
  .regex(/^\d{14}$/)
  .refine(isValidGtin);

export const usProductSchema = z
  .object({
    id: platformUuidSchema,
    name: productNameSchema,
    gtin14: canonicalGtin14Schema.nullable(),
    archived: z.boolean(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const listUsProductsQuerySchema = listUsPartiesQuerySchema
  .pick({ search: true, archived: true, limit: true, offset: true })
  .strict();

export const usProductListSchema = z
  .object({
    items: z.array(usProductSchema).max(100),
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0).max(100000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.items.length > value.limit) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Item count exceeds response limit",
      });
    }
  });

export type CreateUsProductInput = z.infer<typeof createUsProductSchema>;
export type UpdateUsProductInput = z.infer<typeof updateUsProductSchema>;
export type UsProduct = z.infer<typeof usProductSchema>;
export type ListUsProductsQuery = z.infer<typeof listUsProductsQuerySchema>;
export type UsProductList = z.infer<typeof usProductListSchema>;
