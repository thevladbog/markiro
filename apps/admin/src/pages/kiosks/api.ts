/**
 * Typed fetchers + TanStack Query hooks for the kiosks endpoints (Task 4:
 * `GET /kiosks`, `POST /kiosks`, `PATCH /kiosks/:id`, `DELETE /kiosks/:id`
 * (archive), `PUT /kiosks/:id/products`, `POST /kiosks/:id/enroll`), plus the
 * pickup-reasons endpoints (Task 4: `GET /pickup-reasons`,
 * `POST /pickup-reasons`, `PATCH /pickup-reasons/:id`,
 * `DELETE /pickup-reasons/:id`). Thin wrapper over `../../api/client.ts`'s
 * `apiFetch` -- see that module for the shared base URL, credentials, and
 * error-message parsing. Mirrors the shape of `../counterparties/api.ts`
 * (Task 11).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { apiFetch } from "../../api/client.js";

export type KioskStatus = "active" | "archived";

/** Mirrors `apps/api/src/modules/kiosks/dto.ts`'s `KioskDto`. */
export interface KioskDto {
  id: string;
  name: string;
  location: string | null;
  dayLimitPerEmployee: number;
  showPrices: boolean;
  status: KioskStatus;
  lastSeenAt: string | null;
  enrolled: boolean;
  productIds: string[];
  createdAt: string;
}

export interface CreateKioskInput {
  name: string;
  location?: string | null;
  dayLimitPerEmployee?: number;
  showPrices?: boolean;
}

export interface UpdateKioskInput {
  name?: string;
  location?: string | null;
  dayLimitPerEmployee?: number;
  showPrices?: boolean;
  status?: KioskStatus;
}

/** Mirrors `apps/api/src/modules/kiosks/dto.ts`'s `EnrollKioskResponseDto`. */
export interface EnrollKioskResult {
  token: string;
}

interface ListKiosksResponse {
  items: KioskDto[];
}

/** Shared TanStack Query cache key for the kiosks list. */
export const KIOSKS_QUERY_KEY = ["kiosks"] as const;

async function fetchKiosks(): Promise<KioskDto[]> {
  const response = await apiFetch<ListKiosksResponse>("/kiosks");
  return response.items;
}

function postKiosk(input: CreateKioskInput): Promise<KioskDto> {
  return apiFetch<KioskDto>("/kiosks", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

function patchKiosk(id: string, input: UpdateKioskInput): Promise<KioskDto> {
  return apiFetch<KioskDto>(`/kiosks/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

function archiveKioskRequest(id: string): Promise<void> {
  return apiFetch<void>(`/kiosks/${id}`, { method: "DELETE" });
}

function putKioskProducts(id: string, productIds: string[]): Promise<KioskDto> {
  return apiFetch<KioskDto>(`/kiosks/${id}/products`, {
    method: "PUT",
    body: JSON.stringify({ productIds }),
  });
}

function postEnrollKiosk(id: string): Promise<EnrollKioskResult> {
  return apiFetch<EnrollKioskResult>(`/kiosks/${id}/enroll`, { method: "POST" });
}

/** `GET /kiosks` -- the active tenant's pickup kiosks. */
export function useKiosks(): UseQueryResult<KioskDto[]> {
  return useQuery({ queryKey: KIOSKS_QUERY_KEY, queryFn: fetchKiosks });
}

/** `POST /kiosks`. Invalidates the kiosks list query on success. */
export function useCreateKiosk(): UseMutationResult<KioskDto, Error, CreateKioskInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postKiosk,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KIOSKS_QUERY_KEY });
    },
  });
}

/** `PATCH /kiosks/:id`. Invalidates the kiosks list query on success. */
export function useUpdateKiosk(): UseMutationResult<
  KioskDto,
  Error,
  { id: string; input: UpdateKioskInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }) => patchKiosk(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KIOSKS_QUERY_KEY });
    },
  });
}

/** `DELETE /kiosks/:id` -- archives the kiosk. Invalidates the kiosks list query on success. */
export function useArchiveKiosk(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: archiveKioskRequest,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KIOSKS_QUERY_KEY });
    },
  });
}

/** `PUT /kiosks/:id/products`. Invalidates the kiosks list query on success. */
export function useSetKioskProducts(): UseMutationResult<
  KioskDto,
  Error,
  { id: string; productIds: string[] }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, productIds }) => putKioskProducts(id, productIds),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KIOSKS_QUERY_KEY });
    },
  });
}

/** `POST /kiosks/:id/enroll` -- issues a fresh enrollment token. Invalidates the kiosks list query on success. */
export function useEnrollKiosk(): UseMutationResult<EnrollKioskResult, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postEnrollKiosk,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KIOSKS_QUERY_KEY });
    },
  });
}

// --- Pickup reasons mini-api ------------------------------------------------
// Write-off reasons feed the kiosks settings screen (Task 18); listed here
// rather than a separate page directory since there's no standalone
// "reasons" page -- they're managed alongside kiosks.

/** Mirrors `apps/api/src/modules/pickup-reasons/dto.ts`'s `ReasonDto`. */
export interface ReasonDto {
  id: string;
  name: string;
  sortOrder: number;
}

export interface CreateReasonInput {
  name: string;
  sortOrder?: number;
}

export type UpdateReasonInput = Partial<CreateReasonInput>;

interface ListReasonsResponse {
  items: ReasonDto[];
}

/** Shared TanStack Query cache key for the pickup-reasons list. */
export const PICKUP_REASONS_QUERY_KEY = ["pickup-reasons"] as const;

async function fetchReasons(): Promise<ReasonDto[]> {
  const response = await apiFetch<ListReasonsResponse>("/pickup-reasons");
  return response.items;
}

function postReason(input: CreateReasonInput): Promise<ReasonDto> {
  return apiFetch<ReasonDto>("/pickup-reasons", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

function patchReason(id: string, input: UpdateReasonInput): Promise<ReasonDto> {
  return apiFetch<ReasonDto>(`/pickup-reasons/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

function archiveReasonRequest(id: string): Promise<void> {
  return apiFetch<void>(`/pickup-reasons/${id}`, { method: "DELETE" });
}

/** `GET /pickup-reasons` -- the active tenant's write-off reasons. */
export function usePickupReasons(): UseQueryResult<ReasonDto[]> {
  return useQuery({ queryKey: PICKUP_REASONS_QUERY_KEY, queryFn: fetchReasons });
}

/** `POST /pickup-reasons`. Invalidates the reasons list query on success. */
export function useCreateReason(): UseMutationResult<ReasonDto, Error, CreateReasonInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postReason,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PICKUP_REASONS_QUERY_KEY });
    },
  });
}

/** `PATCH /pickup-reasons/:id`. Invalidates the reasons list query on success. */
export function useUpdateReason(): UseMutationResult<
  ReasonDto,
  Error,
  { id: string; input: UpdateReasonInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }) => patchReason(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PICKUP_REASONS_QUERY_KEY });
    },
  });
}

/** `DELETE /pickup-reasons/:id` -- archives the reason. Invalidates the reasons list query on success. */
export function useArchiveReason(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: archiveReasonRequest,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PICKUP_REASONS_QUERY_KEY });
    },
  });
}
