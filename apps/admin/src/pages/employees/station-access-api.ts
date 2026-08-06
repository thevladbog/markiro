/**
 * Typed fetchers + TanStack Query hooks for the operators/station-access
 * endpoints (Tasks 3-4 of Plan 05b-1: `GET /operators`, `PUT
 * /operators/:employeeId`, `PATCH /operators/:employeeId`, `DELETE
 * /operators/:employeeId`). Mirrors the shape of `./api.ts`'s employee hooks;
 * invalidates both the operators list and the employees list on every
 * mutation since `hasBadge`/roster membership can shift either view.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useState } from "react";

import { apiFetch } from "../../api/client.js";
import { EMPLOYEES_QUERY_KEY } from "./api.js";

export interface OperatorListItemDto {
  employeeId: string;
  fullName: string;
  role: string | null;
  login: string;
  active: boolean;
  hasBadge: boolean;
}

export interface StationAccessDto {
  employeeId: string;
  login: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GrantStationAccessInput {
  login: string;
  pin: string;
}

export interface UpdateStationAccessInput {
  active: boolean;
}

export const OPERATORS_QUERY_KEY = ["operators"] as const;

/** `GET /operators` — employees who have line-station access. */
export function useOperators(): UseQueryResult<OperatorListItemDto[]> {
  return useQuery({
    queryKey: OPERATORS_QUERY_KEY,
    queryFn: async () => {
      const response = await apiFetch<{ items: OperatorListItemDto[] }>("/operators");
      return response.items;
    },
  });
}

function invalidate(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: OPERATORS_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: EMPLOYEES_QUERY_KEY });
}

/**
 * `PUT /operators/:employeeId` -- grants access. PIN values are deliberately
 * kept out of TanStack's MutationCache because its mutation variables outlive
 * the section's transient inputs.
 */
export function useGrantStationAccess(): {
  grant: (variables: {
    employeeId: string;
    input: GrantStationAccessInput;
  }) => Promise<StationAccessDto>;
  isPending: boolean;
} {
  const queryClient = useQueryClient();
  const [isPending, setIsPending] = useState(false);
  return {
    isPending,
    grant: async ({ employeeId, input }) => {
      setIsPending(true);
      try {
        const data = await apiFetch<StationAccessDto>(`/operators/${employeeId}`, {
          method: "PUT",
          body: JSON.stringify(input),
        });
        invalidate(queryClient);
        return data;
      } finally {
        setIsPending(false);
      }
    },
  };
}

/**
 * `PATCH /operators/:employeeId` with `{ pin }` only. This matches the
 * reset endpoint contract without retaining the plaintext PIN in MutationCache.
 */
export function useResetStationAccessPin(): {
  resetPin: (variables: { employeeId: string; pin: string }) => Promise<StationAccessDto>;
  isPending: boolean;
} {
  const queryClient = useQueryClient();
  const [isPending, setIsPending] = useState(false);
  return {
    isPending,
    resetPin: async ({ employeeId, pin }) => {
      setIsPending(true);
      try {
        const data = await apiFetch<StationAccessDto>(`/operators/${employeeId}`, {
          method: "PATCH",
          body: JSON.stringify({ pin }),
        });
        invalidate(queryClient);
        return data;
      } finally {
        setIsPending(false);
      }
    },
  };
}

/** `PATCH /operators/:employeeId` -- enables or disables existing access. */
export function useUpdateStationAccess(): UseMutationResult<
  StationAccessDto,
  Error,
  { employeeId: string; input: UpdateStationAccessInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, input }) =>
      apiFetch<StationAccessDto>(`/operators/${employeeId}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: () => invalidate(queryClient),
  });
}

/** `DELETE /operators/:employeeId` — removes station access entirely. */
export function useRevokeStationAccess(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (employeeId) => apiFetch<void>(`/operators/${employeeId}`, { method: "DELETE" }),
    onSuccess: () => invalidate(queryClient),
  });
}
