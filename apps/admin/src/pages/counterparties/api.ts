/**
 * Typed fetchers + TanStack Query hooks for the counterparties endpoints
 * (Task 5: `GET /counterparties`, `POST /counterparties`,
 * `PATCH /counterparties/:id`, `DELETE /counterparties/:id`). Thin wrapper
 * over `../../api/client.ts`'s `apiFetch` -- see that module for the shared
 * base URL, credentials, and error-message parsing.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { apiFetch } from "../../api/client.js";

/** Mirrors `apps/api/src/modules/counterparties/dto.ts`'s `CounterpartyDto`. */
export interface CounterpartyDto {
  id: string;
  name: string;
  gln: string;
  inn: string | null;
  gs1Prefixes: string[];
  notes: string | null;
  createdAt: string;
}

export interface CreateCounterpartyInput {
  name: string;
  gln: string;
  inn?: string | null;
  gs1Prefixes?: string[];
  notes?: string | null;
}

export type UpdateCounterpartyInput = Partial<CreateCounterpartyInput>;

/** Mirrors `apps/api/src/modules/counterparties/dto.ts`'s (re-exported) `SsccCounterDto`. */
export interface SsccCounterDto {
  extensionDigit: number;
  nextSerial: number;
}

interface ListCounterpartiesResponse {
  items: CounterpartyDto[];
}

/** Shared TanStack Query cache key for the counterparties list. */
export const COUNTERPARTIES_QUERY_KEY = ["counterparties"] as const;

function ssccQueryKey(id: string) {
  return ["counterparties", id, "sscc"] as const;
}

async function fetchCounterparties(): Promise<CounterpartyDto[]> {
  const response = await apiFetch<ListCounterpartiesResponse>("/counterparties");
  return response.items;
}

function postCounterparty(input: CreateCounterpartyInput): Promise<CounterpartyDto> {
  return apiFetch<CounterpartyDto>("/counterparties", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

function patchCounterparty(id: string, input: UpdateCounterpartyInput): Promise<CounterpartyDto> {
  return apiFetch<CounterpartyDto>(`/counterparties/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

function removeCounterparty(id: string): Promise<void> {
  return apiFetch<void>(`/counterparties/${id}`, { method: "DELETE" });
}

/** `GET /counterparties` -- the active tenant's counterparties list. */
export function useCounterparties(): UseQueryResult<CounterpartyDto[]> {
  return useQuery({ queryKey: COUNTERPARTIES_QUERY_KEY, queryFn: fetchCounterparties });
}

/** `POST /counterparties`. Invalidates the list query on success so it refetches. */
export function useCreateCounterparty(): UseMutationResult<
  CounterpartyDto,
  Error,
  CreateCounterpartyInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postCounterparty,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: COUNTERPARTIES_QUERY_KEY });
    },
  });
}

/** `PATCH /counterparties/:id`. Invalidates the list query on success so it refetches. */
export function useUpdateCounterparty(): UseMutationResult<
  CounterpartyDto,
  Error,
  { id: string; input: UpdateCounterpartyInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }) => patchCounterparty(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: COUNTERPARTIES_QUERY_KEY });
    },
  });
}

/** `DELETE /counterparties/:id`. Invalidates the list query on success so it refetches. */
export function useDeleteCounterparty(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: removeCounterparty,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: COUNTERPARTIES_QUERY_KEY });
    },
  });
}

function fetchCounterpartySscc(id: string): Promise<SsccCounterDto> {
  return apiFetch<SsccCounterDto>(`/counterparties/${id}/sscc`);
}

function putCounterpartySscc(id: string, input: SsccCounterDto): Promise<SsccCounterDto> {
  return apiFetch<SsccCounterDto>(`/counterparties/${id}/sscc`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/**
 * `GET /counterparties/:id/sscc` -- this counterparty's own box SSCC counter
 * (06c Task 5). Only meaningful for an existing counterparty, so `id` is
 * optional and the query stays disabled (never fires) until one is given --
 * covers the create-modal case, which has no id yet.
 */
export function useCounterpartySscc(id: string | undefined): UseQueryResult<SsccCounterDto> {
  return useQuery({
    queryKey: ssccQueryKey(id ?? ""),
    queryFn: () => fetchCounterpartySscc(id!),
    enabled: Boolean(id),
  });
}

/** `PUT /counterparties/:id/sscc`. Invalidates that counterparty's counter query on success. */
export function useUpdateCounterpartySscc(): UseMutationResult<
  SsccCounterDto,
  Error,
  { id: string; input: SsccCounterDto }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }) => putCounterpartySscc(id, input),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ssccQueryKey(variables.id) });
    },
  });
}
