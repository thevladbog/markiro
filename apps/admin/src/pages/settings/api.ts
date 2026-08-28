/**
 * Typed fetchers + TanStack Query hooks for the organisation-profile
 * endpoints: `GET/PUT /org/profile` (Plan 03 Task 4) and `GET/PUT
 * /org/profile/sscc` (06c Task 5, the tenant's own box SSCC counter). Thin
 * wrapper over `../../api/client.ts`'s `apiFetch` -- see that module for the
 * shared base URL, credentials, and error-message parsing.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { apiErrorFromResponse, apiFetch } from "../../api/client.js";
import type { SsccCounterStateDto } from "../../lib/sscc-counter.js";

export type { SsccCounterStateDto } from "../../lib/sscc-counter.js";

/** Mirrors `apps/api/src/modules/org-profile/dto.ts`'s `OrgProfileDto`. */
export interface OrgProfileDto {
  defaultBoxLabelTemplateId: string | null;
  gln: string | null;
  gs1Prefixes: string[];
  inn: string | null;
  timeZone: string;
  pickupLimitsEnabled: boolean;
  logoUrl: string | null;
  logoRevision: string | null;
}

export type PutOrgProfileInput = Partial<
  Pick<
    OrgProfileDto,
    "defaultBoxLabelTemplateId" | "gln" | "gs1Prefixes" | "inn" | "pickupLimitsEnabled" | "timeZone"
  >
>;

export interface OrganizationLogoDto {
  logoRevision: string;
  logoUrl: string;
}

/** Mirrors `apps/api/src/modules/org-profile/dto.ts`'s `SsccCounterDto` -- the PUT body. */
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

function fetchOrgProfileSscc(): Promise<SsccCounterStateDto> {
  return apiFetch<SsccCounterStateDto>("/org/profile/sscc");
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

/**
 * `PUT /org/profile`. Invalidates the profile query on success so it
 * refetches, and the counter query alongside it: setting a GLN for the first
 * time is what lets `GET /org/profile/sscc` derive a prefix at all, and
 * changing an existing GLN changes that prefix -- without this, the counter
 * card below only picks up either change on a window refocus or a remount.
 */
export function useUpdateOrgProfile(): UseMutationResult<OrgProfileDto, Error, PutOrgProfileInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: putOrgProfile,
    onSuccess: (profile) => {
      // Adopt the mutation response before starting any refetch. Consumers
      // using the profile as an editable baseline must not briefly fall back
      // to stale cache data while another settings card updates the same key.
      queryClient.setQueryData<OrgProfileDto>(ORG_PROFILE_QUERY_KEY, profile);
      void queryClient.invalidateQueries({ queryKey: ORG_PROFILE_QUERY_KEY });
      // Belt-and-suspenders alongside TanStack Query's default prefix-based
      // invalidation (invalidating ["org-profile"] already matches
      // ["org-profile", "sscc"] since the latter extends the former) --
      // explicit here so the counter still refetches even if that matching
      // behavior or either key ever changes.
      void queryClient.invalidateQueries({ queryKey: ORG_PROFILE_SSCC_QUERY_KEY });
    },
  });
}

async function uploadOrganizationLogo(file: File): Promise<OrganizationLogoDto> {
  const form = new FormData();
  form.append("logo", file);
  const response = await fetch("/api/org/profile/logo", {
    method: "POST",
    credentials: "include",
    body: form,
  });
  if (response.ok) return (await response.json()) as OrganizationLogoDto;
  throw await apiErrorFromResponse(response);
}

export function useUploadOrganizationLogo(): UseMutationResult<OrganizationLogoDto, Error, File> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: uploadOrganizationLogo,
    onSuccess: (logo) => {
      queryClient.setQueryData<OrgProfileDto>(ORG_PROFILE_QUERY_KEY, (current) =>
        current ? { ...current, ...logo } : current,
      );
    },
  });
}

export function useDeleteOrganizationLogo(): UseMutationResult<void, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>("/org/profile/logo", { method: "DELETE" }),
    onSuccess: () => {
      queryClient.setQueryData<OrgProfileDto>(ORG_PROFILE_QUERY_KEY, (current) =>
        current ? { ...current, logoUrl: null, logoRevision: null } : current,
      );
    },
  });
}

/**
 * `GET /org/profile/sscc` -- the tenant's own box SSCC counter. `gln` is
 * nullable on `orgProfiles`, so every tenant starts with no GLN and thus no
 * derivable prefix; in that state the server refuses this endpoint with a
 * 400 ("organisation profile has no GLN"). `enabled` lets the caller gate
 * this query on a prefix actually being derivable, so a first-run tenant
 * gets the `prefixUnavailable` hint (see OrgProfilePage.tsx) instead of that
 * 400 being surfaced as a generic load error.
 */
export function useOrgProfileSscc(options?: {
  enabled?: boolean;
}): UseQueryResult<SsccCounterStateDto> {
  return useQuery({
    queryKey: ORG_PROFILE_SSCC_QUERY_KEY,
    queryFn: fetchOrgProfileSscc,
    enabled: options?.enabled ?? true,
  });
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
