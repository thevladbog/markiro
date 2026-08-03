import { useQuery } from "@tanstack/react-query";

import { ApiRequestError, apiErrorFromResponse, apiFetch } from "../../api/client.js";

export interface PublicInvitation {
  id: string;
  email: string;
  organizationName: string;
  role: string;
  state: "pending";
  expiresAt: string;
  hasAccount: boolean;
}

export interface RegisterInvitationInput {
  firstName: string;
  lastName: string;
  middleName?: string | null;
  password: string;
}

export function useInvitation(id: string | undefined) {
  return useQuery({
    queryKey: ["invitation", id],
    queryFn: () => apiFetch<PublicInvitation>(`/invitations/${id}`),
    enabled: Boolean(id),
    retry: (failureCount, error) =>
      failureCount < 2 &&
      (!(error instanceof ApiRequestError) || (error.status >= 500 && error.status < 600)),
  });
}

export async function registerInvitation(
  id: string,
  input: RegisterInvitationInput,
): Promise<void> {
  await postInvitation(id, "register", input);
}

export async function acceptInvitation(id: string): Promise<void> {
  await withDeliveryRetry(() => postInvitation(id, "accept"));
}

export async function rejectInvitation(id: string): Promise<void> {
  await withDeliveryRetry(() => postInvitation(id, "reject"));
}

async function postInvitation(id: string, action: string, body?: unknown): Promise<void> {
  const response = await fetch(`/api/invitations/${id}/${action}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.ok) return;

  throw await apiErrorFromResponse(response);
}

async function withDeliveryRetry(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof ApiRequestError) || error.code !== "delivery_in_flight") throw error;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await action();
  }
}
