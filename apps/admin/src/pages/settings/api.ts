/**
 * Typed fetchers + TanStack Query hooks for the organisation-profile
 * endpoints: `GET/PUT /org/profile` (Plan 03 Task 4) and `GET/PUT
 * /org/profile/sscc` (06c Task 5, the tenant's own box SSCC counter). Thin
 * wrapper over `../../api/client.ts`'s `apiFetch` -- see that module for the
 * shared base URL, credentials, and error-message parsing.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { apiFetch } from "../../api/client.js";

/** Mirrors `apps/api/src/modules/org-profile/dto.ts`'s `OrgProfileDto`. */
export interface OrgProfileDto {
  gln: string | null;
  gs1Prefixes: string[];
  inn: string | null;
}

export type PutOrgProfileInput = Partial<OrgProfileDto>;

/** Mirrors `apps/api/src/modules/org-profile/dto.ts`'s `SsccCounterDto`. */
export interface SsccCounterDto {
  extensionDigit: number;
  nextSerial: number;
}

const ORG_PROFILE_QUERY_KEY = ["org-profile"] as const;
const ORG_PROFILE_SSCC_QUERY_KEY = ["org-profile", "sscc"] as const;

function fetchOrgProfile(): Promise<OrgProfileDto> {
  return apiFetch<OrgProfileDto>("/org/profile");
}

function putOrgProfile(input: PutOrgProfileInput): Promise<OrgProfileDto> {
  return apiFetch<OrgProfileDto>("/org/profile", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

function fetchOrgProfileSscc(): Promise<SsccCounterDto> {
  return apiFetch<SsccCounterDto>("/org/profile/sscc");
}

function putOrgProfileSscc(input: SsccCounterDto): Promise<SsccCounterDto> {
  return apiFetch<SsccCounterDto>("/org/profile/sscc", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/** `GET /org/profile` -- the active tenant's own profile. */
export function useOrgProfile(): UseQueryResult<OrgProfileDto> {
  return useQuery({ queryKey: ORG_PROFILE_QUERY_KEY, queryFn: fetchOrgProfile });
}

/** `PUT /org/profile`. Invalidates the profile query on success so it refetches. */
export function useUpdateOrgProfile(): UseMutationResult<OrgProfileDto, Error, PutOrgProfileInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: putOrgProfile,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ORG_PROFILE_QUERY_KEY });
    },
  });
}

/** `GET /org/profile/sscc` -- the tenant's own box SSCC counter. */
export function useOrgProfileSscc(): UseQueryResult<SsccCounterDto> {
  return useQuery({ queryKey: ORG_PROFILE_SSCC_QUERY_KEY, queryFn: fetchOrgProfileSscc });
}

/** `PUT /org/profile/sscc`. Invalidates the counter query on success so it refetches. */
export function useUpdateOrgProfileSscc(): UseMutationResult<
  SsccCounterDto,
  Error,
  SsccCounterDto
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: putOrgProfileSscc,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ORG_PROFILE_SSCC_QUERY_KEY });
    },
  });
}
