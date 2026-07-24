/**
 * Typed fetchers + TanStack Query hooks for the employees endpoints (Task 4:
 * `GET /employees`, `POST /employees`, `PATCH /employees/:id`,
 * `DELETE /employees/:id` (archive), `POST /employees/:id/badges`,
 * `DELETE /employees/:id/badges/:badgeId`). Thin wrapper over
 * `../../api/client.ts`'s `apiFetch` -- see that module for the shared base
 * URL, credentials, and error-message parsing. Mirrors the shape of
 * `../shifts/api.ts` (Task 12) for the filtered-list query key + optional
 * `buildListPath` pattern.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { apiFetch } from "../../api/client.js";

export type EmployeeStatus = "active" | "archived";

/** Mirrors `apps/api/src/modules/employees/dto.ts`'s `BadgeDto`. */
export interface BadgeDto {
  id: string;
  badgeCode: string;
  label: string | null;
  issuedAt: string;
  revokedAt: string | null;
}

/** Mirrors `apps/api/src/modules/employees/dto.ts`'s `EmployeeDto`. */
export interface EmployeeDto {
  id: string;
  fullName: string;
  role: string | null;
  status: EmployeeStatus;
  badges: BadgeDto[];
  createdAt: string;
}

export interface CreateEmployeeInput {
  fullName: string;
  role?: string | null;
}

export interface UpdateEmployeeInput {
  fullName?: string;
  role?: string | null;
  status?: EmployeeStatus;
}

export interface ListEmployeesParams {
  status?: EmployeeStatus;
}

export interface IssueBadgeInput {
  badgeCode: string;
  label?: string | null;
}

interface ListEmployeesResponse {
  items: EmployeeDto[];
}

/** Shared TanStack Query cache key prefix for the employees list (all filter variants). */
export const EMPLOYEES_QUERY_KEY = ["employees"] as const;

function employeesQueryKey(params: ListEmployeesParams) {
  return [...EMPLOYEES_QUERY_KEY, params] as const;
}

function buildListPath(params: ListEmployeesParams): string {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  const qs = query.toString();
  return qs ? `/employees?${qs}` : "/employees";
}

async function fetchEmployees(params: ListEmployeesParams): Promise<EmployeeDto[]> {
  const response = await apiFetch<ListEmployeesResponse>(buildListPath(params));
  return response.items;
}

function postEmployee(input: CreateEmployeeInput): Promise<EmployeeDto> {
  return apiFetch<EmployeeDto>("/employees", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

function patchEmployee(id: string, input: UpdateEmployeeInput): Promise<EmployeeDto> {
  return apiFetch<EmployeeDto>(`/employees/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

function archiveEmployeeRequest(id: string): Promise<void> {
  return apiFetch<void>(`/employees/${id}`, { method: "DELETE" });
}

function postIssueBadge(id: string, input: IssueBadgeInput): Promise<EmployeeDto> {
  return apiFetch<EmployeeDto>(`/employees/${id}/badges`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

function removeBadge(id: string, badgeId: string): Promise<void> {
  return apiFetch<void>(`/employees/${id}/badges/${badgeId}`, { method: "DELETE" });
}

/** `GET /employees` -- the active tenant's employees, optionally filtered by status. */
export function useEmployees(params: ListEmployeesParams = {}): UseQueryResult<EmployeeDto[]> {
  return useQuery({
    queryKey: employeesQueryKey(params),
    queryFn: () => fetchEmployees(params),
  });
}

/** `POST /employees`. Invalidates every employees list query variant on success. */
export function useCreateEmployee(): UseMutationResult<EmployeeDto, Error, CreateEmployeeInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postEmployee,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: EMPLOYEES_QUERY_KEY });
    },
  });
}

/** `PATCH /employees/:id`. Invalidates every employees list query variant on success. */
export function useUpdateEmployee(): UseMutationResult<
  EmployeeDto,
  Error,
  { id: string; input: UpdateEmployeeInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }) => patchEmployee(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: EMPLOYEES_QUERY_KEY });
    },
  });
}

/** `DELETE /employees/:id` -- archives (soft-deletes) the employee. Invalidates the list on success. */
export function useArchiveEmployee(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: archiveEmployeeRequest,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: EMPLOYEES_QUERY_KEY });
    },
  });
}

/** `POST /employees/:id/badges`. Invalidates every employees list query variant on success. */
export function useIssueBadge(): UseMutationResult<
  EmployeeDto,
  Error,
  { id: string; input: IssueBadgeInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }) => postIssueBadge(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: EMPLOYEES_QUERY_KEY });
    },
  });
}

/** `DELETE /employees/:id/badges/:badgeId`. Invalidates every employees list query variant on success. */
export function useRevokeBadge(): UseMutationResult<void, Error, { id: string; badgeId: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, badgeId }) => removeBadge(id, badgeId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: EMPLOYEES_QUERY_KEY });
    },
  });
}
