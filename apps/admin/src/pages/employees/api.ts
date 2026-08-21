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
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { apiFetch } from "../../api/client.js";

export type EmployeeStatus = "active" | "archived";
export type EmployeePickupLimitMode = "limited" | "unlimited";

export interface EmployeePickupPolicyInput {
  limitMode: EmployeePickupLimitMode;
  dayLimit: number;
  canWriteoff: boolean;
}

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
  pickupPolicy: EmployeePickupPolicyInput;
  badges: BadgeDto[];
  createdAt: string;
}

export interface CreateEmployeeInput {
  fullName: string;
  role?: string | null;
  /** Cabinet member to link the new employee to (create-from-registered-user flow). */
  memberId?: string | null;
}

/** Mirrors `apps/api/src/modules/employees/dto.ts`'s `LinkableMemberDto`. */
export interface LinkableMemberDto {
  memberId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  middleName: string | null;
  position: string | null;
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

export interface BulkEmployeePickupLimitsInput {
  employeeIds: string[];
  limitMode: EmployeePickupLimitMode;
  dayLimit: number;
}

export interface BulkEmployeePickupWriteoffInput {
  employeeIds: string[];
  canWriteoff: boolean;
}

interface BulkEmployeePickupPolicyResponse {
  items: Array<EmployeePickupPolicyInput & { employeeId: string }>;
}

interface ListEmployeesResponse {
  items: EmployeeDto[];
}

interface ListLinkableMembersResponse {
  items: LinkableMemberDto[];
}

/** Shared TanStack Query cache key prefix for the employees list (all filter variants). */
export const EMPLOYEES_QUERY_KEY = ["employees"] as const;

/** Cache key for the linkable cabinet members picker (create-employee form). */
export const LINKABLE_MEMBERS_QUERY_KEY = ["employees", "linkable-members"] as const;

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

function patchPickupPolicy(id: string, input: EmployeePickupPolicyInput): Promise<EmployeeDto> {
  return apiFetch<EmployeeDto>(`/employees/${id}/pickup-policy`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

function patchBulkPickupLimits(
  input: BulkEmployeePickupLimitsInput,
): Promise<BulkEmployeePickupPolicyResponse> {
  return apiFetch<BulkEmployeePickupPolicyResponse>("/employees/pickup-policy/limits", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

function patchBulkPickupWriteoff(
  input: BulkEmployeePickupWriteoffInput,
): Promise<BulkEmployeePickupPolicyResponse> {
  return apiFetch<BulkEmployeePickupPolicyResponse>(
    "/employees/pickup-policy/writeoff-permission",
    { method: "PATCH", body: JSON.stringify(input) },
  );
}

/** `GET /employees` -- the active tenant's employees, optionally filtered by status. */
export function useEmployees(params: ListEmployeesParams = {}): UseQueryResult<EmployeeDto[]> {
  return useQuery({
    queryKey: employeesQueryKey(params),
    queryFn: () => fetchEmployees(params),
  });
}

/** `GET /employees/linkable-members` -- cabinet members without a linked employee. */
export function useLinkableMembers(): UseQueryResult<LinkableMemberDto[]> {
  return useQuery({
    queryKey: LINKABLE_MEMBERS_QUERY_KEY,
    queryFn: async () => {
      const response = await apiFetch<ListLinkableMembersResponse>("/employees/linkable-members");
      return response.items;
    },
  });
}

/**
 * `POST /employees`. Invalidates every employees list query variant on success;
 * the shared `["employees"]` prefix also covers the linkable-members picker
 * (a linked member must leave it).
 */
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

function useInvalidateEmployeesMutation<TInput>(
  mutationFn: (input: TInput) => Promise<unknown>,
): UseMutationResult<unknown, Error, TInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: EMPLOYEES_QUERY_KEY }),
  });
}

export function useUpdateEmployeePickupPolicy(): UseMutationResult<
  EmployeeDto,
  Error,
  { id: string; input: EmployeePickupPolicyInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }) => patchPickupPolicy(id, input),
    onSuccess: (savedEmployee) => {
      queryClient.setQueriesData<EmployeeDto[]>({ queryKey: EMPLOYEES_QUERY_KEY }, (employees) =>
        employees?.map((employee) => (employee.id === savedEmployee.id ? savedEmployee : employee)),
      );
      void queryClient.invalidateQueries({ queryKey: EMPLOYEES_QUERY_KEY });
    },
  });
}

export function useBulkEmployeePickupLimits(): UseMutationResult<
  unknown,
  Error,
  BulkEmployeePickupLimitsInput
> {
  return useInvalidateEmployeesMutation(patchBulkPickupLimits);
}

export function useBulkEmployeePickupWriteoff(): UseMutationResult<
  unknown,
  Error,
  BulkEmployeePickupWriteoffInput
> {
  return useInvalidateEmployeesMutation(patchBulkPickupWriteoff);
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

/**
 * `POST /employees/:id/badges`. Badge codes are transient credentials, so
 * this deliberately avoids `useMutation`: MutationCache retains mutation
 * variables after the section clears its inputs. Pending state remains local
 * while the established list invalidation still occurs after success.
 */
export function useIssueBadge(): {
  issue: (variables: { id: string; input: IssueBadgeInput }) => Promise<EmployeeDto>;
  isPending: boolean;
} {
  const queryClient = useQueryClient();
  const [isPending, setIsPending] = useState(false);
  return {
    isPending,
    issue: async ({ id, input }) => {
      setIsPending(true);
      try {
        const data = await postIssueBadge(id, input);
        void queryClient.invalidateQueries({ queryKey: EMPLOYEES_QUERY_KEY });
        return data;
      } finally {
        setIsPending(false);
      }
    },
  };
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
