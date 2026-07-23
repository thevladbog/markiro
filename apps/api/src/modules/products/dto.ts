import { z } from "zod";

const PRODUCT_STATUSES = ["draft", "active"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/**
 * POST /products schema. Clients never send `status` -- it's server-computed
 * (see ProductsService.computeStatus). `gtin` accepts any GTIN-8/12/13/14;
 * normalization/validation happens in the service via `normalizeToGtin14`
 * (@markiro/domain) so the 400 body can carry the GTIN_INVALID code.
 */
export const createProductSchema = z.object({
  gtin: z.string().min(1),
  name: z.string().min(1).max(200),
  productGroup: z.string().min(1).max(200).nullable().optional(),
  boxCapacity: z.number().int().min(1).nullable().optional(),
  palletCapacity: z.number().int().min(1).nullable().optional(),
  defaultCounterpartyId: z.string().uuid().nullable().optional(),
  defaultLabelTemplateId: z.string().uuid().nullable().optional(),
});
export type CreateProductDto = z.infer<typeof createProductSchema>;

/** PATCH /products/:id schema -- partial update, preserves untouched fields. */
export const updateProductSchema = z.object({
  gtin: z.string().min(1).optional(),
  name: z.string().min(1).max(200).optional(),
  productGroup: z.string().min(1).max(200).nullable().optional(),
  boxCapacity: z.number().int().min(1).nullable().optional(),
  palletCapacity: z.number().int().min(1).nullable().optional(),
  defaultCounterpartyId: z.string().uuid().nullable().optional(),
  defaultLabelTemplateId: z.string().uuid().nullable().optional(),
});
export type UpdateProductDto = z.infer<typeof updateProductSchema>;

/** GET /products query schema. */
export const listProductsQuerySchema = z.object({
  search: z.string().min(1).optional(),
  status: z.enum(PRODUCT_STATUSES).optional(),
});
export type ListProductsQueryDto = z.infer<typeof listProductsQuerySchema>;

/** POST /products/gtin-check schema. */
export const gtinCheckSchema = z.object({
  gtin: z.string().min(1),
});
export type GtinCheckDto = z.infer<typeof gtinCheckSchema>;

/** Response DTO for a product. */
export interface ProductDto {
  id: string;
  gtin14: string;
  name: string;
  productGroup: string | null;
  boxCapacity: number | null;
  palletCapacity: number | null;
  status: ProductStatus;
  defaultCounterpartyId: string | null;
  defaultLabelTemplateId: string | null;
  createdAt: Date;
}

/** GET /products response. */
export interface ListProductsResponseDto {
  items: ProductDto[];
}

export type GtinOwner = "own" | "counterparty" | "unknown";

/** POST /products/gtin-check response. */
export interface GtinCheckResponseDto {
  gtin14: string;
  owner: GtinOwner;
  counterpartyId?: string;
  counterpartyName?: string;
}
