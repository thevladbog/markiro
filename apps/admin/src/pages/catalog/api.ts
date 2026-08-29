/**
 * Typed fetchers + TanStack Query hooks for the products endpoints (Task 6:
 * `GET /products`, `POST /products`, `PATCH /products/:id`,
 * `DELETE /products/:id`, `POST /products/gtin-check`). Thin wrapper over
 * `../../api/client.ts`'s `apiFetch` -- see that module for the shared base
 * URL, credentials, and error-message parsing. Mirrors the shape of
 * `../counterparties/api.ts` (Task 11).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { API_BASE, apiFetch } from "../../api/client.js";

export type ProductStatus = "draft" | "active";

export interface ProductImageDescriptor {
  checksum: string;
  contentType: "image/webp";
  byteSize: number;
  width: number;
  height: number;
}

/** Mirrors `apps/api/src/modules/products/product-groups.service.ts`. */
export interface ChzProductGroupDto {
  code: number;
  alias: string;
  name: string;
}

/** Mirrors `apps/api/src/modules/products/dto.ts`'s `ProductDto`. */
export interface ProductDto {
  id: string;
  gtin14: string;
  name: string;
  /** Resolved name of `chzProductGroupCode`; null when no group is selected. */
  productGroup: string | null;
  chzProductGroupCode: number | null;
  boxCapacity: number | null;
  palletCapacity: number | null;
  unitPrice: string | null;
  printName: string | null;
  egaisCode: string | null;
  shelfLifeDays: number | null;
  /**
   * The `<Ид>` of the 1С item this product is linked to (Task 10's
   * `integration_candidates.external_ref`), or `null` if never linked.
   * Surfaced on the product's own card (Task 14) alongside the unlink
   * action -- see `useUnlinkProduct` below.
   */
  externalRef: string | null;
  status: ProductStatus;
  /**
   * Operator-set "do not use" flag, orthogonal to the computed `status`:
   * archived products stay for history but are hidden from every selection
   * surface except inventory (see `ListProductsParams.archived`).
   */
  archived: boolean;
  defaultCounterpartyId: string | null;
  createdAt: string;
  image?: ProductImageDescriptor | null;
}

/**
 * `status` is deliberately absent -- it's server-computed from
 * chzProductGroupCode/boxCapacity/palletCapacity (see ProductsService.computeStatus)
 * and must never be sent by the client.
 */
export interface CreateProductInput {
  gtin: string;
  name: string;
  /** FK into `chz_product_groups`; null clears the product's group. */
  chzProductGroupCode?: number | null;
  boxCapacity?: number | null;
  palletCapacity?: number | null;
  unitPrice?: string | null;
  printName?: string | null;
  egaisCode?: string | null;
  shelfLifeDays?: number | null;
  defaultCounterpartyId?: string | null;
  archived?: boolean;
}

export type UpdateProductInput = Partial<CreateProductInput>;

export interface ListProductsParams {
  search?: string;
  status?: ProductStatus;
  /**
   * Server default is `"false"` (archived hidden) so selection surfaces are
   * safe without opting in. `"all"` is for history-aware readers (catalog,
   * inventory form, code search); `"true"` is the catalog's archive filter.
   */
  archived?: "true" | "false" | "all";
}

export type GtinOwner = "own" | "counterparty" | "unknown";

/** Mirrors `apps/api/src/modules/products/dto.ts`'s `GtinCheckResponseDto`. */
export interface GtinCheckResult {
  gtin14: string;
  owner: GtinOwner;
  counterpartyId?: string;
  counterpartyName?: string;
}

interface ListProductsResponse {
  items: ProductDto[];
}

export const CHZ_PRODUCT_GROUPS_QUERY_KEY = ["chz-product-groups"] as const;

async function fetchChzProductGroups(): Promise<ChzProductGroupDto[]> {
  const value = await apiFetch<{ items: ChzProductGroupDto[] }>("/chz-product-groups");
  return value.items;
}

/** Shared TanStack Query cache key prefix for the products list (all filter variants). */
export const PRODUCTS_QUERY_KEY = ["products"] as const;

function productsQueryKey(params: ListProductsParams) {
  return [...PRODUCTS_QUERY_KEY, params] as const;
}

function buildListPath(params: ListProductsParams): string {
  const query = new URLSearchParams();
  if (params.search) query.set("search", params.search);
  if (params.status) query.set("status", params.status);
  if (params.archived) query.set("archived", params.archived);
  const qs = query.toString();
  return qs ? `/products?${qs}` : "/products";
}

async function fetchProducts(params: ListProductsParams): Promise<ProductDto[]> {
  const response = await apiFetch<ListProductsResponse>(buildListPath(params));
  return response.items;
}

function postProduct(input: CreateProductInput): Promise<ProductDto> {
  return apiFetch<ProductDto>("/products", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

function patchProduct(id: string, input: UpdateProductInput): Promise<ProductDto> {
  return apiFetch<ProductDto>(`/products/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

function removeProduct(id: string): Promise<void> {
  return apiFetch<void>(`/products/${id}`, { method: "DELETE" });
}

function postGtinCheck(gtin: string): Promise<GtinCheckResult> {
  return apiFetch<GtinCheckResult>("/products/gtin-check", {
    method: "POST",
    body: JSON.stringify({ gtin }),
  });
}

function uploadProductImage(id: string, file: File): Promise<ProductDto> {
  const body = new FormData();
  body.append("image", file, file.name || "product-image");
  return apiFetch<ProductDto>(`/products/${id}/image`, { method: "POST", body });
}

function deleteProductImage(id: string): Promise<void> {
  return apiFetch<void>(`/products/${id}/image`, { method: "DELETE" });
}

export function productImageUrl(product: Pick<ProductDto, "id" | "image">): string | null {
  if (!product.image) return null;
  const productId = encodeURIComponent(product.id);
  const checksum = encodeURIComponent(product.image.checksum);
  return `${API_BASE}/products/${productId}/image/${checksum}`;
}

/** `GET /products` -- the active tenant's catalog, optionally filtered by search/status. */
export function useProducts(params: ListProductsParams = {}): UseQueryResult<ProductDto[]> {
  return useQuery({
    queryKey: productsQueryKey(params),
    queryFn: () => fetchProducts(params),
  });
}

/** `GET /chz-product-groups` -- global reference data, safe to cache for the session. */
export function useChzProductGroups(): UseQueryResult<ChzProductGroupDto[]> {
  return useQuery({
    queryKey: CHZ_PRODUCT_GROUPS_QUERY_KEY,
    queryFn: fetchChzProductGroups,
    staleTime: Infinity,
  });
}

/** `POST /products`. Invalidates every products list query variant on success. */
export function useCreateProduct(): UseMutationResult<ProductDto, Error, CreateProductInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postProduct,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY });
    },
  });
}

/** `PATCH /products/:id`. Invalidates every products list query variant on success. */
export function useUpdateProduct(): UseMutationResult<
  ProductDto,
  Error,
  { id: string; input: UpdateProductInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }) => patchProduct(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY });
    },
  });
}

/** `DELETE /products/:id`. Invalidates every products list query variant on success. */
export function useDeleteProduct(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: removeProduct,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY });
    },
  });
}

/**
 * `POST /products/gtin-check` -- owner-hint lookup for the catalog form.
 * Callers must pre-validate with `isValidGtin` (@markiro/domain) before
 * calling `.mutate` so this never fires for a checksum-invalid GTIN.
 */
export function useGtinCheck(): UseMutationResult<GtinCheckResult, Error, string> {
  return useMutation({ mutationFn: postGtinCheck });
}

export function useUploadProductImage(): UseMutationResult<
  ProductDto,
  Error,
  { id: string; file: File }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, file }) => uploadProductImage(id, file),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY });
    },
  });
}

export function useDeleteProductImage(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteProductImage,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY });
    },
  });
}

function deleteExternalLink(id: string): Promise<void> {
  return apiFetch<void>(`/products/${id}/external-link`, { method: "DELETE" });
}

/**
 * `DELETE /products/:id/external-link` -- breaks a product's link to its
 * external (1С) counterpart without touching any of its own fields (brief
 * 08: "unlinking leaves the product's current values alone"). On a
 * not-currently-linked product the server answers 409 -- the caller
 * (`ProductForm`) surfaces that message rather than a generic failure, same
 * as `useLinkCandidate` on the other side of this same link. Invalidates the
 * products list so the card reflects `externalRef: null` the next time it's
 * opened.
 */
export function useUnlinkProduct(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteExternalLink,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY });
    },
  });
}
