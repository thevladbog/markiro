/**
 * Typed fetcher + TanStack Query hook for `GET /integrations` (Task 4) --
 * the channel list backing the admin's Integrations section. Thin wrapper
 * over `../../api/client.ts`'s `apiFetch`, mirroring `../kiosks/api.ts`'s
 * shape.
 */
import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

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
