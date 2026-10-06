import { useQuery } from "@tanstack/react-query";
import {
  supportChatContracts,
  supportTranscriptContracts,
  type SupportEpisodeView,
  type SupportMessage,
  type SupportTranscriptPage,
} from "@markiro/platform-contracts";
import { apiFetch } from "../../api/client.js";

const base = "/support-chat/episodes";
export type EpisodeList = ReturnType<typeof supportChatContracts.episodeList.response.parse>;

/** Fail closed until the active cabinet can reach the feature-gated episode list. */
export function useSupportChatAvailability(userId?: string, tenantId?: string | null) {
  return useQuery({
    queryKey: ["support-chat-availability", userId, tenantId],
    enabled: Boolean(userId && tenantId),
    queryFn: async () => {
      await listEpisodes();
      return true;
    },
    retry: false,
    staleTime: 30_000,
  });
}

export async function listEpisodes(cursor?: string): Promise<EpisodeList> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return supportChatContracts.episodeList.response.parse(
    await apiFetch<unknown>(`${base}${query}`),
  );
}
export async function createEpisode(key: string): Promise<SupportEpisodeView> {
  return supportChatContracts.episodeCreate.response.parse(
    await apiFetch<unknown>(base, {
      method: "POST",
      body: JSON.stringify({ idempotencyKey: key }),
    }),
  );
}
export async function getEpisode(id: string, cursor?: string): Promise<SupportEpisodeView> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return supportChatContracts.episode.response.parse(
    await apiFetch<unknown>(`${base}/${encodeURIComponent(id)}${query}`),
  );
}
export async function sendMessage(id: string, text: string, key: string): Promise<SupportMessage> {
  return supportChatContracts.message.response.parse(
    await apiFetch<unknown>(`${base}/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, idempotencyKey: key }),
    }),
  );
}
export async function decideProposal(
  id: string,
  proposalId: string,
  input: {
    decision: "accept" | "decline";
    revision: number;
    noticeVersion: string;
    noticeLocale: "ru" | "en";
    idempotencyKey: string;
  },
): Promise<SupportEpisodeView> {
  return supportChatContracts.decision.response.parse(
    await apiFetch<unknown>(
      `${base}/${encodeURIComponent(id)}/proposals/${encodeURIComponent(proposalId)}/decision`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  );
}
export async function getTranscript(id: string, cursor?: string): Promise<SupportTranscriptPage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return supportTranscriptContracts.tenant.response.parse(
    await apiFetch<unknown>(`/billing/requests/${encodeURIComponent(id)}/transcript${query}`),
  );
}
