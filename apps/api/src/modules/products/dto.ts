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
  printName: z.string().trim().min(1).max(200).nullable().optional(),
  productGroup: z.string().min(1).max(200).nullable().optional(),
  boxCapacity: z.number().int().min(1).nullable().optional(),
  palletCapacity: z.number().int().min(1).nullable().optional(),
  defaultCounterpartyId: z.string().uuid().nullable().optional(),
  unitPrice: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/)
    .nullable()
    .optional(),
  egaisCode: z.string().trim().min(1).max(64).nullable().optional(),
  shelfLifeDays: z.number().int().min(1).max(3650).nullable().optional(),
  externalRef: z.string().trim().min(1).max(200).nullable().optional(),
  archived: z.boolean().optional(),
});
export type CreateProductDto = z.infer<typeof createProductSchema>;

/** PATCH /products/:id schema -- partial update, preserves untouched fields. */
export const updateProductSchema = z.object({
  gtin: z.string().min(1).optional(),
  name: z.string().min(1).max(200).optional(),
  printName: z.string().trim().min(1).max(200).nullable().optional(),
  productGroup: z.string().min(1).max(200).nullable().optional(),
  boxCapacity: z.number().int().min(1).nullable().optional(),
  palletCapacity: z.number().int().min(1).nullable().optional(),
  defaultCounterpartyId: z.string().uuid().nullable().optional(),
  unitPrice: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/)
    .nullable()
    .optional(),
  egaisCode: z.string().trim().min(1).max(64).nullable().optional(),
  shelfLifeDays: z.number().int().min(1).max(3650).nullable().optional(),
  externalRef: z.string().trim().min(1).max(200).nullable().optional(),
  archived: z.boolean().optional(),
});
export type UpdateProductDto = z.infer<typeof updateProductSchema>;

/**
 * GET /products query schema. `archived` defaults to `"false"` in the service:
 * without an explicit opt-in every selection surface (shift form, kiosk
 * allowlist, station GTIN resolution, 1С link modal) hides archived products.
 * `"all"` is the opt-in for the catalog page, the inventory form, and other
 * history-aware readers; `"true"` powers the catalog's "not in use" filter.
 */
export const listProductsQuerySchema = z.object({
  search: z.string().min(1).optional(),
  status: z.enum(PRODUCT_STATUSES).optional(),
  archived: z.enum(["true", "false", "all"]).optional(),
});
export type ListProductsQueryDto = z.infer<typeof listProductsQuerySchema>;

/** POST /products/gtin-check schema. */
export const gtinCheckSchema = z.object({
  gtin: z.string().min(1),
});
export type GtinCheckDto = z.infer<typeof gtinCheckSchema>;

/** Response DTO for a product. */
export interface ProductImageDescriptor {
  checksum: string;
  contentType: "image/webp";
  byteSize: number;
  width: number;
  height: number;
}

export interface ProductDto {
  id: string;
  gtin14: string;
  name: string;
  /** Short operator-facing name for the station shift card; null = use `name`. */
  printName: string | null;
  productGroup: string | null;
  boxCapacity: number | null;
  palletCapacity: number | null;
  status: ProductStatus;
  /** Operator-set "do not use" flag; archived products are hidden from selection surfaces except inventory. */
  archived: boolean;
  defaultCounterpartyId: string | null;
  unitPrice: string | null;
  egaisCode: string | null;
  shelfLifeDays: number | null;
  externalRef: string | null;
  createdAt: Date;
  /** Optional only for rolling compatibility; current server mappings always emit it. */
  image?: ProductImageDescriptor | null;
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
