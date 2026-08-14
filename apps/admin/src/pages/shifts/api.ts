/**
 * Typed fetchers + TanStack Query hooks for the shifts endpoints (Task 7:
 * `GET /shifts`, `POST /shifts`, `PATCH /shifts/:id`, `DELETE /shifts/:id`,
 * `POST /shifts/:id/close`), plus a small lines client. Thin wrapper over
 * `../../api/client.ts`'s `apiFetch` -- see that module for the shared base
 * URL, credentials, and error-message parsing. Mirrors the shape of
 * `../catalog/api.ts` (Task 12) / `../counterparties/api.ts` (Task 11).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { CABINET_ACCESS_QUERY_KEY } from "../../access/api.js";
import { apiFetch } from "../../api/client.js";

export type ShiftMode = "validation" | "aggregation";
export type ShiftStatus = "planned" | "active" | "closed";

/** Server-computed only (never client-submitted); "admin" for shifts created here. */
export type ShiftOrigin = "admin" | "station";

/** Mirrors `apps/api/src/modules/shifts/dto.ts`'s `ShiftDto` (joined with product/line/counterparty names). */
export interface ShiftDto {
  id: string;
  status: ShiftStatus;
  mode: ShiftMode;
  productId: string;
  productName: string | null;
  lineId: string | null;
  lineName: string | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  /** Whose numbers this shift's boxes carry; null means the tenant's own organisation. */
  ssccIssuerCounterpartyId: string | null;
  boxLabelTemplateId: string | null;
  plannedQty: number | null;
  plannedDate: string | null;
  boxCapacity: number | null;
  palletCapacity: number | null;
  palletsEnabled: boolean;
  createdFrom: ShiftOrigin;
  openedAt: string | null;
  closedAt: string | null;
  lateDataAt: string | null;
  closeReason: string | null;
  createdAt: string;
}

/**
 * `lineId`/`counterpartyId`/`boxCapacity`/`palletCapacity` are server-prefilled
 * from the product when omitted (`undefined`); an explicit `null` opts out of
 * the prefill for `counterpartyId`/capacities (see ShiftsService.createShift).
 */
export interface CreateShiftInput {
  productId: string;
  mode: ShiftMode;
  lineId?: string | null;
  counterpartyId?: string | null;
  ssccIssuerCounterpartyId?: string | null;
  boxLabelTemplateId?: string | null;
  plannedQty?: number | null;
  plannedDate?: string | null;
  boxCapacity?: number | null;
  palletCapacity?: number | null;
  palletsEnabled?: boolean;
}

export type UpdateShiftInput = Partial<CreateShiftInput>;

export interface ListShiftsParams {
  status?: ShiftStatus;
  from?: string;
  to?: string;
  lineId?: string;
}

interface ListShiftsResponse {
  items: ShiftDto[];
}

/** Shared TanStack Query cache key prefix for the shifts list (all filter variants). */
export const SHIFTS_QUERY_KEY = ["shifts"] as const;

function shiftsQueryKey(params: ListShiftsParams) {
  return [...SHIFTS_QUERY_KEY, params] as const;
}

function buildListPath(params: ListShiftsParams): string {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  if (params.lineId) query.set("lineId", params.lineId);
  const qs = query.toString();
  return qs ? `/shifts?${qs}` : "/shifts";
}

async function fetchShifts(params: ListShiftsParams): Promise<ShiftDto[]> {
  const response = await apiFetch<ListShiftsResponse>(buildListPath(params));
  return response.items;
}

function postShift(input: CreateShiftInput): Promise<ShiftDto> {
  return apiFetch<ShiftDto>("/shifts", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

function patchShift(id: string, input: UpdateShiftInput): Promise<ShiftDto> {
  return apiFetch<ShiftDto>(`/shifts/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

function removeShift(id: string): Promise<void> {
  return apiFetch<void>(`/shifts/${id}`, { method: "DELETE" });
}

function postCloseShift(id: string, reason: string): Promise<ShiftDto> {
  return apiFetch<ShiftDto>(`/shifts/${id}/close`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

/** `GET /shifts` -- the active tenant's shifts, optionally filtered by status/period/line. */
export function useShifts(params: ListShiftsParams = {}): UseQueryResult<ShiftDto[]> {
  return useQuery({
    queryKey: shiftsQueryKey(params),
    queryFn: () => fetchShifts(params),
  });
}

/** `POST /shifts`. Invalidates every shifts list query variant on success. */
export function useCreateShift(): UseMutationResult<ShiftDto, Error, CreateShiftInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postShift,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SHIFTS_QUERY_KEY });
    },
  });
}

/** `PATCH /shifts/:id` -- allowed only while the shift is planned (409 otherwise). */
export function useUpdateShift(): UseMutationResult<
  ShiftDto,
  Error,
  { id: string; input: UpdateShiftInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }) => patchShift(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SHIFTS_QUERY_KEY });
    },
  });
}

/** `DELETE /shifts/:id` -- allowed only while the shift is planned (409 otherwise). */
export function useDeleteShift(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: removeShift,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SHIFTS_QUERY_KEY });
    },
  });
}

/** `POST /shifts/:id/close` -- allowed only from an active shift (409 otherwise). */
export function useCloseShift(): UseMutationResult<
  ShiftDto,
  Error,
  { id: string; reason: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }) => postCloseShift(id, reason),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SHIFTS_QUERY_KEY });
    },
  });
}

// --- Lines mini-api ---------------------------------------------------------

/** Mirrors `apps/api/src/modules/lines/dto.ts`'s `LineDto`. */
export interface LineDto {
  id: string;
  name: string;
  createdAt: string;
}

export interface CreateLineInput {
  name: string;
}

export interface UpdateLineVariables {
  id: string;
  input: CreateLineInput;
}

interface ListLinesResponse {
  items: LineDto[];
}

/** Shared TanStack Query cache key for the lines list. */
export const LINES_QUERY_KEY = ["lines"] as const;

async function fetchLines(): Promise<LineDto[]> {
  const response = await apiFetch<ListLinesResponse>("/lines");
  return response.items;
}

function postLine(input: CreateLineInput): Promise<LineDto> {
  return apiFetch<LineDto>("/lines", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

function patchLine(id: string, input: CreateLineInput): Promise<LineDto> {
  return apiFetch<LineDto>(`/lines/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

function removeLine(id: string): Promise<void> {
  return apiFetch<void>(`/lines/${id}`, { method: "DELETE" });
}

/** `GET /lines` -- the active tenant's production lines. */
export function useLines(): UseQueryResult<LineDto[]> {
  return useQuery({ queryKey: LINES_QUERY_KEY, queryFn: fetchLines });
}

/** `POST /lines`. Invalidates the lines list on success. */
export function useCreateLine(): UseMutationResult<LineDto, Error, CreateLineInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postLine,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: LINES_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: CABINET_ACCESS_QUERY_KEY }),
      ]);
    },
  });
}

/** `PATCH /lines/:id`. Invalidates the lines list on success. */
export function useUpdateLine(): UseMutationResult<LineDto, Error, UpdateLineVariables> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }) => patchLine(id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LINES_QUERY_KEY }),
  });
}

/** `DELETE /lines/:id`. Invalidates the lines list on success. */
export function useDeleteLine(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: removeLine,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: LINES_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: CABINET_ACCESS_QUERY_KEY }),
      ]);
    },
  });
}
