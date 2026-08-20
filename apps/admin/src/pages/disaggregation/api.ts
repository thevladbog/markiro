/**
 * Typed fetchers + TanStack Query hooks for the disaggregation endpoints
 * (Tasks 3-6: `GET /disaggregation`, `POST /disaggregation`,
 * `GET /disaggregation/:id`, `PATCH /disaggregation/:id`,
 * `POST /disaggregation/:id/lines`, `POST /disaggregation/:id/import`,
 * `DELETE /disaggregation/:id/lines/:lineId`, `POST /disaggregation/:id/apply`,
 * `POST /disaggregation/:id/cancel`, plus the disaggregation-reasons list
 * (`GET /disaggregation-reasons`)). Thin wrapper over `../../api/client.ts`'s
 * `apiFetch` -- see that module for the shared base URL, credentials, and
 * error-message parsing. Mirrors the shape of `../catalog/api.ts` (Task 6).
 *
 * Names/signatures here are a contract Task 10 (document detail page)
 * reuses verbatim -- see the task-9 brief's Interfaces block.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { ApiRequestError, apiFetch } from "../../api/client.js";

/** Mirrors `apps/api/src/modules/disaggregation/dto.ts`'s `LineDto`, `Date` fields as `string`. */
export interface LineDto {
  id: string;
  ssccInput: string;
  sscc: string | null;
  boxId: string | null;
  status: string;
  productId: string | null;
  productName: string | null;
  codeCount: number;
  validatedAt: string;
}

/** Mirrors `apps/api/src/modules/disaggregation/dto.ts`'s `DocumentDto`, `Date` fields as `string`. */
export interface DocumentDto {
  id: string;
  docNo: string;
  status: "draft" | "applied" | "cancelled";
  reasonId: string | null;
  reasonName: string | null;
  comment: string | null;
  source: "manual" | "import";
  lineCount: number;
  codeCount: number;
  createdByUserId: string;
  createdByName: string | null;
  createdAt: string;
  appliedAt: string | null;
  appliedByUserId: string | null;
  cancelledAt: string | null;
}

export interface DocumentDetailDto extends DocumentDto {
  lines: LineDto[];
}

export interface UpdateDocumentInput {
  reasonId?: string | null;
  comment?: string | null;
}

export interface ListDocumentsFilters {
  status?: string;
  reasonId?: string;
  docNo?: string;
  from?: string;
  to?: string;
  page: number;
}

interface ListDocumentsResponse {
  items: DocumentDto[];
  page: number;
  pageCount: number;
  total: number;
}

interface AddLinesResponse {
  lines: LineDto[];
}

/** Mirrors `apps/api/src/modules/disaggregation-reasons/dto.ts`'s `ReasonDto`. */
export interface DisaggregationReasonDto {
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
  items: DisaggregationReasonDto[];
}

/** Shared TanStack Query cache key prefix for disaggregation documents (all filter variants). */
export const DISAGGREGATION_QUERY_KEY = ["disaggregation"] as const;

/** Cache key for the disaggregation reasons list. */
export const DISAGGREGATION_REASONS_QUERY_KEY = ["disaggregation-reasons"] as const;

function buildListPath(filters: ListDocumentsFilters): string {
  const query = new URLSearchParams();
  if (filters.status) query.set("status", filters.status);
  if (filters.reasonId) query.set("reasonId", filters.reasonId);
  if (filters.docNo) query.set("docNo", filters.docNo);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  query.set("page", String(filters.page));
  return `/disaggregation?${query.toString()}`;
}

async function fetchDocuments(filters: ListDocumentsFilters): Promise<ListDocumentsResponse> {
  return apiFetch<ListDocumentsResponse>(buildListPath(filters));
}

async function fetchDocument(id: string): Promise<DocumentDetailDto> {
  return apiFetch<DocumentDetailDto>(`/disaggregation/${id}`);
}

function postDocument(): Promise<DocumentDto> {
  return apiFetch<DocumentDto>("/disaggregation", { method: "POST", body: JSON.stringify({}) });
}

function patchDocument(id: string, input: UpdateDocumentInput): Promise<DocumentDto> {
  return apiFetch<DocumentDto>(`/disaggregation/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

function postLines(id: string, ssccs: string[]): Promise<AddLinesResponse> {
  return apiFetch<AddLinesResponse>(`/disaggregation/${id}/lines`, {
    method: "POST",
    body: JSON.stringify({ ssccs }),
  });
}

function postImportLines(id: string, file: File): Promise<AddLinesResponse> {
  const form = new FormData();
  form.append("file", file);
  return apiFetch<AddLinesResponse>(`/disaggregation/${id}/import`, {
    method: "POST",
    body: form,
  });
}

function removeLineRequest(id: string, lineId: string): Promise<void> {
  return apiFetch<void>(`/disaggregation/${id}/lines/${lineId}`, { method: "DELETE" });
}

function postApply(id: string): Promise<DocumentDetailDto> {
  return apiFetch<DocumentDetailDto>(`/disaggregation/${id}/apply`, { method: "POST" });
}

function postCancel(id: string): Promise<DocumentDto> {
  return apiFetch<DocumentDto>(`/disaggregation/${id}/cancel`, { method: "POST" });
}

async function fetchReasons(): Promise<DisaggregationReasonDto[]> {
  const response = await apiFetch<ListReasonsResponse>("/disaggregation-reasons");
  return response.items;
}

function postReason(input: CreateReasonInput): Promise<DisaggregationReasonDto> {
  return apiFetch<DisaggregationReasonDto>("/disaggregation-reasons", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

function patchReason(id: string, input: UpdateReasonInput): Promise<DisaggregationReasonDto> {
  return apiFetch<DisaggregationReasonDto>(`/disaggregation-reasons/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

function archiveReasonRequest(id: string): Promise<void> {
  return apiFetch<void>(`/disaggregation-reasons/${id}`, { method: "DELETE" });
}

/** `GET /disaggregation` -- the active tenant's disaggregation documents, filtered/paged. */
export function useDocuments(
  filters: ListDocumentsFilters,
): UseQueryResult<ListDocumentsResponse> {
  return useQuery({
    queryKey: [...DISAGGREGATION_QUERY_KEY, filters],
    queryFn: () => fetchDocuments(filters),
  });
}

/** `GET /disaggregation/:id`. Disabled (no request sent) while no id is given. */
export function useDocument(id: string | undefined): UseQueryResult<DocumentDetailDto> {
  return useQuery({
    queryKey: [...DISAGGREGATION_QUERY_KEY, id],
    queryFn: () => fetchDocument(id!),
    enabled: Boolean(id),
  });
}

/** `POST /disaggregation` -- creates an empty draft. Invalidates the documents list on success. */
export function useCreateDocument(): UseMutationResult<DocumentDto, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postDocument,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DISAGGREGATION_QUERY_KEY });
    },
  });
}

/** `PATCH /disaggregation/:id`. Invalidates every disaggregation query variant on success. */
export function useUpdateDocument(
  id: string,
): UseMutationResult<DocumentDto, Error, UpdateDocumentInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateDocumentInput) => patchDocument(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DISAGGREGATION_QUERY_KEY });
    },
  });
}

/** `POST /disaggregation/:id/lines`. Invalidates every disaggregation query variant on success. */
export function useAddLines(id: string): UseMutationResult<AddLinesResponse, Error, string[]> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ssccs: string[]) => postLines(id, ssccs),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DISAGGREGATION_QUERY_KEY });
    },
  });
}

/** `POST /disaggregation/:id/import` (multipart). Invalidates every disaggregation query variant on success. */
export function useImportLines(id: string): UseMutationResult<AddLinesResponse, Error, File> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => postImportLines(id, file),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DISAGGREGATION_QUERY_KEY });
    },
  });
}

/** `DELETE /disaggregation/:id/lines/:lineId`. Invalidates every disaggregation query variant on success. */
export function useRemoveLine(id: string): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (lineId: string) => removeLineRequest(id, lineId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DISAGGREGATION_QUERY_KEY });
    },
  });
}

/**
 * `POST /disaggregation/:id/apply`. Invalidates every disaggregation query
 * variant on success -- and also on a 409 `invalid_lines` rejection, since
 * that response means one or more lines' statuses changed underneath the
 * draft (e.g. a box got written off via a kiosk between page load and the
 * apply click). Re-fetching there is what lets the detail page (Task 10)
 * show the caller the fresh per-line statuses instead of the stale "ok"
 * chips that made the apply button look enabled in the first place.
 */
export function useApplyDocument(id: string): UseMutationResult<DocumentDetailDto, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => postApply(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DISAGGREGATION_QUERY_KEY });
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.status === 409 && error.code === "invalid_lines") {
        void queryClient.invalidateQueries({ queryKey: DISAGGREGATION_QUERY_KEY });
      }
    },
  });
}

/** `POST /disaggregation/:id/cancel`. Invalidates every disaggregation query variant on success. */
export function useCancelDocument(id: string): UseMutationResult<DocumentDto, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => postCancel(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DISAGGREGATION_QUERY_KEY });
    },
  });
}

/** `GET /disaggregation-reasons` -- the active tenant's disaggregation reasons. */
export function useDisaggregationReasons(): UseQueryResult<DisaggregationReasonDto[]> {
  return useQuery({ queryKey: DISAGGREGATION_REASONS_QUERY_KEY, queryFn: fetchReasons });
}

/** `POST /disaggregation-reasons`. Invalidates the reasons list query on success. */
export function useCreateReason(): UseMutationResult<
  DisaggregationReasonDto,
  Error,
  CreateReasonInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postReason,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DISAGGREGATION_REASONS_QUERY_KEY });
    },
  });
}

/** `PATCH /disaggregation-reasons/:id`. Invalidates the reasons list query on success. */
export function useUpdateReason(): UseMutationResult<
  DisaggregationReasonDto,
  Error,
  { id: string; input: UpdateReasonInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }) => patchReason(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DISAGGREGATION_REASONS_QUERY_KEY });
    },
  });
}

/** `DELETE /disaggregation-reasons/:id` -- archives the reason. Invalidates the reasons list query on success. */
export function useArchiveReason(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: archiveReasonRequest,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DISAGGREGATION_REASONS_QUERY_KEY });
    },
  });
}
