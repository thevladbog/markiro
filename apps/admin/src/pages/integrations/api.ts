/**
 * Typed fetcher + TanStack Query hook for `GET /integrations` (Task 4) --
 * the channel list backing the admin's Integrations section. Thin wrapper
 * over `../../api/client.ts`'s `apiFetch`, mirroring `../kiosks/api.ts`'s
 * shape.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { apiFetch } from "../../api/client.js";

/**
 * Mirrors `apps/api/src/modules/integrations/dto.ts`'s `ChannelState`. Five
 * states, not four: "silent" (an inbound channel has gone quiet) is a
 * distinct diagnosis from "error" (it answered and the answer was bad) --
 * see docs/design-briefs/08-integrations.md's "On the silent state".
 */
export type ChannelState = "not_configured" | "working" | "error" | "silent" | "unavailable";

/**
 * Mirrors `apps/api/src/modules/integrations/dto.ts`'s `ChannelSummaryDto`.
 * `type` is left as `string` rather than mirroring the server's
 * `IntegrationChannelType` union deliberately: the registry (and thus the
 * set of channel types) lives entirely in server code (brief 08, "the
 * channel registry lives in code, the configuration in data") -- the admin
 * only ever needs `labelKey` to render a channel, never its `type` union, so
 * it stays decoupled from server-side additions to that registry.
 */
export interface ChannelSummaryDto {
  type: string;
  labelKey: string;
  state: ChannelState;
  lastEventAt: string | null;
}

interface ListChannelsResponse {
  channels: ChannelSummaryDto[];
}

/** Shared TanStack Query cache key for the channels list. */
export const INTEGRATIONS_QUERY_KEY = ["integrations"] as const;

async function fetchChannels(): Promise<ChannelSummaryDto[]> {
  const response = await apiFetch<ListChannelsResponse>("/integrations");
  return response.channels;
}

/**
 * `GET /integrations` -- every channel the tenant can see, including
 * channels with no adapter yet (`state: "unavailable"`), which are real
 * entries, not placeholders.
 */
export function useChannels(): UseQueryResult<ChannelSummaryDto[]> {
  return useQuery({ queryKey: INTEGRATIONS_QUERY_KEY, queryFn: fetchChannels });
}

/**
 * Mirrors `apps/api/src/modules/integrations/dto.ts`'s `ChannelDetailDto`.
 * Adds the channel's own settings, its silence threshold, and the persisted
 * exchange login on top of `ChannelSummaryDto` -- everything Task 13's
 * channel page needs beyond the list's summary. The secret itself is never
 * part of this shape (see `CredentialsIssuedDto` below) -- `credentialLogin`
 * is the one piece of a channel's credentials that stays visible after
 * issuance.
 */
export interface ChannelDetailDto extends ChannelSummaryDto {
  settings: Record<string, unknown>;
  silentAfterHours: number;
  credentialLogin: string | null;
}

/**
 * Mirrors `apps/api/src/modules/integrations/dto.ts`'s `JournalEventDto`.
 * `direction`/`outcome` stay `string` rather than a union for the same
 * reason `ChannelSummaryDto.type` does: the enumeration lives in server code
 * (`journal.service.ts`'s `AppendEventInput`), the admin only ever renders
 * it through an i18n key, never branches on a specific value beyond that.
 */
export interface JournalEventDto {
  at: string;
  direction: string;
  outcome: string;
  message: string;
  details: Record<string, unknown> | null;
}

/** Mirrors `JournalSessionDto`. `outcome`/`finishedAt` are `null` for a session still running. */
export interface JournalSessionDto {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  summary: Record<string, unknown> | null;
  events: JournalEventDto[];
}

interface JournalPageResponse {
  sessions: JournalSessionDto[];
}

/**
 * Mirrors `CredentialsIssuedDto`. Returned exactly once, by
 * `useIssueCredentials` below -- the caller must hold it only in local
 * component state (never the query cache) and never expect a second read;
 * the server itself never answers with the plaintext secret again.
 */
export interface CredentialsIssuedDto {
  login: string;
  secret: string;
}

/** Cache key for one channel's detail (`GET /integrations/:type`). */
export function channelDetailQueryKey(type: string): readonly [string, string] {
  return ["integrations", type] as const;
}

/** Cache key for one channel's journal (`GET /integrations/:type/journal`). */
export function channelJournalQueryKey(type: string): readonly [string, string, string] {
  return ["integrations", type, "journal"] as const;
}

async function fetchChannelDetail(type: string): Promise<ChannelDetailDto> {
  return apiFetch<ChannelDetailDto>(`/integrations/${type}`);
}

/** `GET /integrations/:type` -- the channel page's header + settings data. */
export function useChannelDetail(type: string): UseQueryResult<ChannelDetailDto> {
  return useQuery({
    queryKey: channelDetailQueryKey(type),
    queryFn: () => fetchChannelDetail(type),
  });
}

async function fetchChannelJournal(type: string): Promise<JournalSessionDto[]> {
  const response = await apiFetch<JournalPageResponse>(`/integrations/${type}/journal`);
  return response.sessions;
}

/** `GET /integrations/:type/journal` -- feeds `JournalList`. */
export function useChannelJournal(type: string): UseQueryResult<JournalSessionDto[]> {
  return useQuery({
    queryKey: channelJournalQueryKey(type),
    queryFn: () => fetchChannelJournal(type),
  });
}

/**
 * `PATCH /integrations/:type` -- persists the channel's own settings (e.g.
 * CommerceML's `priceType`/`splitWriteoffDocument`; brief 08's "Settings --
 * the channel's own form"). The server echoes back the full
 * `ChannelDetailDto`, which replaces the cached detail directly rather than
 * triggering a second round trip.
 */
export function useUpdateChannelSettings(
  type: string,
): UseMutationResult<ChannelDetailDto, unknown, Record<string, unknown>> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      apiFetch<ChannelDetailDto>(`/integrations/${type}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(channelDetailQueryKey(type), data);
    },
  });
}

/**
 * `POST /integrations/:type/credentials` -- mints a fresh exchange login and
 * hands back its secret in plaintext exactly once (see `CredentialsIssuedDto`
 * above). `credentialLogin` on the cached detail is updated here so a later
 * remount (without reissuing) still shows the persisted login; the secret
 * itself never touches the query cache -- the page keeps it only in its own
 * transient state, per the "shown once" rule.
 *
 * Deliberately NOT a `useMutation`: a `Mutation` extends `Removable` and only
 * *schedules* its own removal once its last observer unsubscribes -- it does
 * not clear `state.data` right away. With the default `gcTime` (five
 * minutes) and `main.tsx`'s single app-lifetime `QueryClient`, a
 * `useMutation`-based version of this call would leave the plaintext secret
 * sitting in the `MutationCache` for up to five minutes after the page (and
 * its local `issued` state) is gone -- and calling the mutation's own
 * `reset()` doesn't help, because it only detaches *that* observer, it
 * doesn't clear the underlying `Mutation`'s retained data either. A plain
 * async wrapper creates no such cache entry: the secret exists only in
 * whatever the caller does with the returned value.
 */
export function useIssueCredentials(type: string): { issue: () => Promise<CredentialsIssuedDto> } {
  const queryClient = useQueryClient();
  return {
    issue: async () => {
      const data = await apiFetch<CredentialsIssuedDto>(`/integrations/${type}/credentials`, {
        method: "POST",
      });
      queryClient.setQueryData(channelDetailQueryKey(type), (old: ChannelDetailDto | undefined) =>
        old ? { ...old, credentialLogin: data.login } : old,
      );
      return data;
    },
  };
}
