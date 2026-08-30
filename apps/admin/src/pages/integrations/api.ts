/**
 * Typed fetcher + TanStack Query hook for `GET /integrations` (Task 4) --
 * the channel list backing the admin's Integrations section. Thin wrapper
 * over `../../api/client.ts`'s `apiFetch`, mirroring `../kiosks/api.ts`'s
 * shape.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { apiFetch, ApiRequestError } from "../../api/client.js";

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

/**
 * `DELETE /integrations/:type` -- полное отключение интеграции: сервер
 * удаляет настройки, учётные данные обмена, сеансы, журнал и очередь
 * несопоставленных одной транзакцией (`IntegrationsService.deleteChannel`).
 * Никакого секрета в ответе нет, так что, в отличие от `useIssueCredentials`
 * выше, обычный `useMutation` безопасен. Инвалидируется корневой ключ
 * `["integrations"]`: удаление меняет сразу список каналов, деталь, журнал
 * и очередь -- перечислять их по одному значит забыть следующий.
 */
export function useDeleteChannel(type: string): UseMutationResult<void, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>(`/integrations/${type}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INTEGRATIONS_QUERY_KEY });
    },
  });
}

/**
 * Mirrors `apps/api/src/modules/integrations/dto.ts`'s `CandidateDto` -- one
 * position from the exchange the queue (Task 14) has not yet matched to the
 * catalog. `suggestedProductId` is `null` whenever the server found no
 * match *or* found more than one -- an ambiguous suggestion is worse than no
 * suggestion (it gets accepted without a second look), so the server
 * suppresses it entirely rather than sending a guess (see Task 10's
 * `suggestProductId`).
 */
export interface CandidateDto {
  id: string;
  externalRef: string;
  name: string;
  article: string | null;
  unit: string | null;
  gtin: string | null;
  price: string | null;
  priceType: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  hidden: boolean;
  suggestedProductId: string | null;
}

interface CandidatesPageResponse {
  candidates: CandidateDto[];
}

/**
 * Cache key for one channel's candidates queue, split by `hidden` -- the
 * working queue and the hidden view are two disjoint queries (never a
 * single list filtered client-side), matching the server's own "two
 * non-overlapping views, not a union" contract for this endpoint.
 */
export function candidatesQueryKey(
  type: string,
  hidden: boolean,
): readonly [string, string, string, boolean] {
  return ["integrations", type, "candidates", hidden] as const;
}

async function fetchCandidates(type: string, hidden: boolean): Promise<CandidateDto[]> {
  const response = await apiFetch<CandidatesPageResponse>(
    `/integrations/${type}/candidates?hidden=${hidden ? "true" : "false"}`,
  );
  return response.candidates;
}

/** `GET /integrations/:type/candidates?hidden=true|false` -- feeds `CandidatesQueue`. */
export function useCandidates(type: string, hidden: boolean): UseQueryResult<CandidateDto[]> {
  return useQuery({
    queryKey: candidatesQueryKey(type, hidden),
    queryFn: () => fetchCandidates(type, hidden),
  });
}

export interface LinkCandidateInput {
  candidateId: string;
  productId: string;
}

function postLinkCandidate(type: string, { candidateId, productId }: LinkCandidateInput) {
  return apiFetch<void>(`/integrations/${type}/candidates/${candidateId}/link`, {
    method: "POST",
    body: JSON.stringify({ productId }),
  });
}

/**
 * `POST /integrations/:type/candidates/:id/link`. A 409 here means the
 * chosen product already carries a different external link -- the caller
 * (`CandidatesQueue`) surfaces the server's own message rather than a
 * generic failure, per Task 14's "a 409 is an answer, not a crash".
 * Invalidates both the working and hidden views: a link removes the row
 * from whichever one it was in.
 */
export function useLinkCandidate(type: string): UseMutationResult<void, Error, LinkCandidateInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LinkCandidateInput) => postLinkCandidate(type, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["integrations", type, "candidates"] });
    },
  });
}

/**
 * Same request as `useLinkCandidate`'s `mutationFn`, but with no query-cache
 * side effect of its own -- for the bulk "confirm all suggestions" path
 * (`CandidatesQueue`'s `handleConfirmAllSuggestions`), which can be linking
 * hundreds of candidates (the first exchange queues the tenant's whole
 * catalogue, per that component's own doc comment) and must not invalidate
 * -- and thus refetch -- the candidates list once per completed link. The
 * caller invalidates exactly once after the whole batch settles instead.
 */
export function linkCandidateRequest(type: string, input: LinkCandidateInput): Promise<void> {
  return postLinkCandidate(type, input);
}

/** `POST /integrations/:type/candidates/:id/hide` -- moves a row out of the working queue into the hidden view. */
export function useHideCandidate(type: string): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (candidateId: string) =>
      apiFetch<void>(`/integrations/${type}/candidates/${candidateId}/hide`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["integrations", type, "candidates"] });
    },
  });
}

/** `POST /integrations/:type/candidates/:id/unhide` -- restores a hidden row back into the working queue. */
export function useUnhideCandidate(type: string): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (candidateId: string) =>
      apiFetch<void>(`/integrations/${type}/candidates/${candidateId}/unhide`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["integrations", type, "candidates"] });
    },
  });
}

/**
 * Mirrors `apps/api/src/modules/api-keys/api-keys.service.ts`'s
 * `ApiKeySummaryDto` -- one public API key, without its secret. `kind` stays
 * a literal `"public"` (not widened to `string` the way `ChannelSummaryDto.type`
 * is) because the server's own type only ever hands back this one value here
 * -- station keys are filtered out by the whitelist before they ever reach
 * this endpoint (task-15-brief.md), so there is no second kind this union
 * would need to grow to cover.
 */
export interface ApiKeySummaryDto {
  id: string;
  name: string | null;
  kind: "public";
  createdAt: string;
  lastRequest: string | null;
}

/**
 * Mirrors `ApiKeyIssuedDto`. Returned exactly once, by `useIssueApiKey`
 * below -- the caller must hold `key` only in local component state (never
 * the query cache) and never expect a second read; `useApiKeys`'s list never
 * carries it.
 */
export interface ApiKeyIssuedDto {
  id: string;
  key: string;
}

interface ApiKeysListResponse {
  keys: ApiKeySummaryDto[];
}

/** Cache key for the `public_api` channel's key list (`GET /integrations/public_api/keys`). */
export const API_KEYS_QUERY_KEY = ["integrations", "public_api", "keys"] as const;

async function fetchApiKeys(): Promise<ApiKeySummaryDto[]> {
  const response = await apiFetch<ApiKeysListResponse>("/integrations/public_api/keys");
  return response.keys;
}

/** `GET /integrations/public_api/keys` -- feeds `ApiKeysPanel`. */
export function useApiKeys(): UseQueryResult<ApiKeySummaryDto[]> {
  return useQuery({ queryKey: API_KEYS_QUERY_KEY, queryFn: fetchApiKeys });
}

/**
 * `POST /integrations/public_api/keys` -- mints a fresh public API key and
 * hands back its plaintext secret exactly once (see `ApiKeyIssuedDto`
 * above). Deliberately NOT a `useMutation`, for the same reason
 * `useIssueCredentials` above isn't (see that doc comment for the full
 * explanation): a `Mutation` extends `Removable` and only *schedules* its
 * own removal once its last observer unsubscribes, so with the default
 * `gcTime` (five minutes) a `useMutation`-based version would leave this
 * plaintext secret sitting in the `MutationCache` for up to five minutes
 * after `ApiKeysPanel` unmounts -- and the mutation's own `reset()` doesn't
 * clear it either. A plain async wrapper creates no such cache entry: the
 * secret exists only in whatever the caller (`ApiKeysPanel`'s own state)
 * does with the returned value. Invalidates the list on success so the new
 * key (sans secret) shows up in the table without a manual refetch.
 */
export function useIssueApiKey(): { issue: (name: string) => Promise<ApiKeyIssuedDto> } {
  const queryClient = useQueryClient();
  return {
    issue: async (name: string) => {
      const data = await apiFetch<ApiKeyIssuedDto>("/integrations/public_api/keys", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      void queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY });
      return data;
    },
  };
}

/**
 * `DELETE /integrations/public_api/keys/:id` -- revokes (deletes) a public
 * API key. Carries no secret, so unlike `useIssueApiKey` above there is no
 * mutation-cache leak concern here -- a plain `useMutation` is fine. Revoking
 * an already-revoked id is the server's own 404 (`api-keys.service.ts`'s
 * `revoke`: "there is no separate 'already revoked' response").
 *
 * That 404 means the caller's goal is already met -- the key is gone either
 * way -- so it must not be treated like any other failed mutation: the list
 * has to lose that row regardless of which of the two calls (this one, or
 * whoever revoked it first) actually deleted it. Invalidating only in
 * `onSuccess` (the previous shape) left a 404'd row sitting in the table
 * forever, offering "Отозвать" against it indefinitely with the same 404
 * every time. `ApiKeysPanel` still tells the two cases apart for its own
 * toast/modal handling -- this hook only owns making sure the list itself
 * always ends up correct.
 */
export function useRevokeApiKey(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/integrations/public_api/keys/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY });
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.status === 404) {
        void queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY });
      }
    },
  });
}

/**
 * Mirrors `apps/api/src/modules/signer-agents/dto.ts`'s `SignerAgentSummaryDto`
 * -- one paired "Markiro Подписант" agent (a desktop machine holding a КЭП
 * certificate for the `chestny_znak` channel). Task 8 (this file's own
 * `SignerAgentsPanel`).
 */
export type SignerAgentStatus = "active" | "revoked";

export interface SignerAgent {
  id: string;
  name: string;
  appVersion: string | null;
  status: SignerAgentStatus;
  certThumbprint: string | null;
  certSubject: string | null;
  certInn: string | null;
  certNotAfter: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

/** Mirrors `SignerTokenStatusDto` -- the tenant's current True API token, obtained by whichever agent last authenticated. */
export interface SignerTokenStatus {
  status: "none" | "active" | "expiring" | "expired";
  obtainedAt: string | null;
  expiresAt: string | null;
  certThumbprint: string | null;
}

/** Mirrors `SignerAgentsOverviewDto` -- the full `GET /signer-agents` response. */
export interface SignerAgentsOverview {
  agents: SignerAgent[];
  token: SignerTokenStatus;
}

/** Cache key for the signer agents overview. The endpoint is mounted flat (`@Controller("signer-agents")`, no `/integrations` prefix), but the cache key stays nested under the channel so channel-level invalidation covers it. */
export const signerAgentsQueryKey = ["integrations", "chestny_znak", "agents"] as const;

/** `GET /signer-agents` -- feeds `SignerAgentsPanel`. */
export function useSignerAgents(): UseQueryResult<SignerAgentsOverview> {
  return useQuery({
    queryKey: signerAgentsQueryKey,
    queryFn: () => apiFetch<SignerAgentsOverview>("/signer-agents"),
  });
}

/** Mirrors `IssueSignerPairingCodeResultDto`. Returned exactly once, by `issueSignerPairingCode` below. */
export interface SignerPairingCodeResult {
  code: string;
  expiresAt: string;
}

/**
 * `POST /signer-agents/pairing-code` -- mints a fresh one-time pairing code
 * for the "Markiro Подписант" desktop agent to consume. Deliberately NOT a
 * `useMutation`, for the same reason `useIssueCredentials` above isn't (see
 * that doc comment for the full explanation): the plaintext code would
 * otherwise sit in the `MutationCache` for up to five minutes after the
 * panel unmounts. A plain async wrapper creates no such cache entry -- the
 * code exists only in whatever the caller (`SignerAgentsPanel`'s own state)
 * does with the returned value.
 */
export function issueSignerPairingCode(): Promise<SignerPairingCodeResult> {
  return apiFetch<SignerPairingCodeResult>("/signer-agents/pairing-code", {
    method: "POST",
  });
}

/** `POST /signer-agents/:id/revoke` -- revokes a paired agent (204, no body). Invalidates the overview so the revoked status and the newly-hidden revoke button both show up without a manual refetch. */
export function useRevokeSignerAgent(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) =>
      apiFetch<void>(`/signer-agents/${agentId}/revoke`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: signerAgentsQueryKey });
    },
  });
}

/**
 * Mirrors `apps/api/src/modules/chz-code-statuses/dto.ts`'s
 * `ChzCodeStatusSummaryDto` -- the freshness line under `SignerAgentsPanel`'s
 * agent table (Task 6): how many marking codes `chz_code_statuses` knows
 * about tenant-wide, how many ЧЗ answered for in the last day, and how many
 * carry no ЧЗ product group (stuck until their product gets one).
 */
export interface ChzCodeStatusSummary {
  total: number;
  refreshedLastDay: number;
  withoutProductGroup: number;
  lastCheckedAt: string | null;
}

/** Cache key for the `chestny_znak` channel's code-status summary. */
export const CHZ_CODE_STATUS_SUMMARY_QUERY_KEY = [
  "integrations",
  "chestny_znak",
  "code-statuses",
] as const;

/**
 * `GET /integrations/chestny_znak/code-statuses` -- feeds `SignerAgentsPanel`'s
 * freshness line. Hardcoded to `chestny_znak` the same way `useApiKeys` above
 * is hardcoded to `public_api`: `SignerAgentsPanel` is only ever mounted for
 * that one channel (`ChannelPage.tsx`), so there is no second `type` this
 * hook would ever need to take as a parameter.
 */
export function useChzCodeStatusSummary(): UseQueryResult<ChzCodeStatusSummary> {
  return useQuery({
    queryKey: CHZ_CODE_STATUS_SUMMARY_QUERY_KEY,
    queryFn: () => apiFetch<ChzCodeStatusSummary>("/integrations/chestny_znak/code-statuses"),
  });
}
