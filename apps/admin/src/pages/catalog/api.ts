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

import { apiFetch } from "../../api/client.js";

export type ProductStatus = "draft" | "active";

/** Mirrors `apps/api/src/modules/products/dto.ts`'s `ProductDto`. */
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
  createdAt: string;
}

/**
 * `status` is deliberately absent -- it's server-computed from
 * productGroup/boxCapacity/palletCapacity (see ProductsService.computeStatus)
 * and must never be sent by the client.
 */
export interface CreateProductInput {
  gtin: string;
  name: string;
  productGroup?: string | null;
  boxCapacity?: number | null;
  palletCapacity?: number | null;
  defaultCounterpartyId?: string | null;
  defaultLabelTemplateId?: string | null;
}

export type UpdateProductInput = Partial<CreateProductInput>;

export interface ListProductsParams {
  search?: string;
  status?: ProductStatus;
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

/** Shared TanStack Query cache key prefix for the products list (all filter variants). */
export const PRODUCTS_QUERY_KEY = ["products"] as const;

function productsQueryKey(params: ListProductsParams) {
  return [...PRODUCTS_QUERY_KEY, params] as const;
}

function buildListPath(params: ListProductsParams): string {
  const query = new URLSearchParams();
  if (params.search) query.set("search", params.search);
  if (params.status) query.set("status", params.status);
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

/** `GET /products` -- the active tenant's catalog, optionally filtered by search/status. */
export function useProducts(params: ListProductsParams = {}): UseQueryResult<ProductDto[]> {
  return useQuery({
    queryKey: productsQueryKey(params),
    queryFn: () => fetchProducts(params),
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
