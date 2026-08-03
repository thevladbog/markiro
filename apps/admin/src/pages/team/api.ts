import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationOptions, UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { apiFetch } from "../../api/client.js";
import { ApiRequestError } from "../../api/client.js";

export type TeamRole = "admin" | "manager";

export interface TeamEmployee {
  id: string;
  fullName: string;
  status: "active" | "archived";
  operatorAccess: boolean;
}

export interface TeamMember {
  id: string;
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  middleName: string | null;
  avatarAssetId: string | null;
  role: string;
  position: string | null;
  employee: TeamEmployee | null;
  createdAt: string;
}

export interface TeamInvitation {
  id: string;
  email: string;
  role: string | null;
  position: string | null;
  accessStatus: string;
  expiresAt: string;
  employee: TeamEmployee | null;
  delivery: { id: string; status: string; errorCategory: string | null } | null;
}

export interface TeamResponse {
  members: TeamMember[];
  invitations: TeamInvitation[];
}

export interface CreateInvitationInput {
  email: string;
  role: TeamRole;
  position?: string | null;
  employeeId?: string | null;
}

export interface UpdateMemberInput {
  role?: TeamRole;
  position?: string | null;
}

export const TEAM_QUERY_KEY = ["team"] as const;

export function useTeam(): UseQueryResult<TeamResponse> {
  return useQuery({
    queryKey: TEAM_QUERY_KEY,
    queryFn: () => apiFetch<TeamResponse>("/team"),
    refetchInterval: (query) => {
      const team = query.state.data;
      return team?.invitations.some((invitation) =>
        ["queued", "sending", "retrying"].includes(invitation.delivery?.status ?? ""),
      )
        ? 5_000
        : false;
    },
  });
}

function useTeamMutation<TData, TVariables>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  options: Pick<UseMutationOptions<TData, Error, TVariables>, "retry" | "retryDelay"> = {},
): UseMutationResult<TData, Error, TVariables> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    ...options,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: TEAM_QUERY_KEY }),
  });
}

export function useCreateInvitation() {
  return useTeamMutation((input: CreateInvitationInput) =>
    apiFetch<TeamInvitation>("/team/invitations", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
}

export function useResendInvitation() {
  return useTeamMutation(
    (id: string) => apiFetch<TeamInvitation>(`/team/invitations/${id}/resend`, { method: "POST" }),
    deliveryRetryOptions,
  );
}

export function useCancelInvitation() {
  return useTeamMutation(
    (id: string) => apiFetch<void>(`/team/invitations/${id}`, { method: "DELETE" }),
    deliveryRetryOptions,
  );
}

const deliveryRetryOptions = {
  retry: (failureCount: number, error: Error) =>
    failureCount < 1 && error instanceof ApiRequestError && error.code === "delivery_in_flight",
  retryDelay: 1_500,
};

export function useUpdateMember() {
  return useTeamMutation(({ id, input }: { id: string; input: UpdateMemberInput }) =>
    apiFetch<TeamMember>(`/team/members/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export function useLinkEmployee() {
  return useTeamMutation(({ id, employeeId }: { id: string; employeeId: string }) =>
    apiFetch<TeamMember>(`/team/members/${id}/employee`, {
      method: "PUT",
      body: JSON.stringify({ employeeId }),
    }),
  );
}

export function useUnlinkEmployee() {
  return useTeamMutation((id: string) =>
    apiFetch<TeamMember>(`/team/members/${id}/employee`, { method: "DELETE" }),
  );
}

export function useRemoveMember() {
  return useTeamMutation((id: string) =>
    apiFetch<void>(`/team/members/${id}`, { method: "DELETE" }),
  );
}
