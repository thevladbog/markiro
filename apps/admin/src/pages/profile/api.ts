import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiErrorFromResponse, apiFetch } from "../../api/client.js";

export interface UserProfile {
  firstName: string | null;
  lastName: string | null;
  middleName: string | null;
  hasAvatar: boolean;
}

export interface UpdateProfileInput {
  firstName: string;
  lastName: string;
  middleName?: string | null;
}

export const PROFILE_QUERY_KEY = ["profile"] as const;
export const AVATAR_URL_QUERY_KEY = ["profile", "avatar-url"] as const;

export function useProfile() {
  return useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: () => apiFetch<UserProfile>("/profile"),
  });
}

export function useAvatarUrl(enabled: boolean) {
  return useQuery({
    queryKey: AVATAR_URL_QUERY_KEY,
    queryFn: () => apiFetch<{ url: string | null }>("/profile/avatar-url"),
    enabled,
    staleTime: 4 * 60 * 1000,
    refetchInterval: enabled ? 4 * 60 * 1000 : false,
    refetchOnWindowFocus: true,
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateProfileInput) =>
      apiFetch<UserProfile>("/profile", { method: "PATCH", body: JSON.stringify(input) }),
    onSuccess: (profile) => queryClient.setQueryData(PROFILE_QUERY_KEY, profile),
  });
}

export function useUploadAvatar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => uploadAvatar(file),
    onSuccess: (profile) => {
      queryClient.setQueryData(PROFILE_QUERY_KEY, profile);
      void queryClient.invalidateQueries({ queryKey: AVATAR_URL_QUERY_KEY });
    },
  });
}

export function useDeleteAvatar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>("/profile/avatar", { method: "DELETE" }),
    onSuccess: () => {
      queryClient.setQueryData<UserProfile>(PROFILE_QUERY_KEY, (current) =>
        current ? { ...current, hasAvatar: false } : current,
      );
      queryClient.removeQueries({ queryKey: AVATAR_URL_QUERY_KEY });
    },
  });
}

async function uploadAvatar(file: File): Promise<UserProfile> {
  const form = new FormData();
  form.append("avatar", file);
  const response = await fetch("/api/profile/avatar", {
    method: "POST",
    credentials: "include",
    body: form,
  });
  if (response.ok) return (await response.json()) as UserProfile;

  throw await apiErrorFromResponse(response);
}
