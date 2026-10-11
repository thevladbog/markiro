import {
  platformSupportChatContracts,
  supportTranscriptContracts,
  type SupportEpisodeView,
  type SupportProposal,
  type SupportTranscriptPage,
} from "@markiro/platform-contracts";
import { platformApiFetch } from "../../api/client.js";

const base = "/support-chat/episodes";
export async function listSupportEpisodes(cursor?: string, tenantId?: string) {
  const query = new URLSearchParams();
  if (cursor) query.set("cursor", cursor);
  if (tenantId) query.set("tenantId", tenantId);
  return platformApiFetch(`${base}${query.size ? `?${query}` : ""}`, {
    responseSchema: platformSupportChatContracts.episodeList.response,
  });
}
export async function getSupportEpisode(id: string, cursor?: string): Promise<SupportEpisodeView> {
  return platformApiFetch(
    `${base}/${encodeURIComponent(id)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    { responseSchema: platformSupportChatContracts.episode.response },
  );
}
export async function proposeSupportRequest(
  id: string,
  input: { title: string; summary: string; idempotencyKey: string },
): Promise<SupportProposal> {
  return platformApiFetch(`${base}/${encodeURIComponent(id)}/proposals`, {
    method: "POST",
    body: JSON.stringify(input),
    responseSchema: platformSupportChatContracts.proposal.response,
  });
}
export async function retrySupportSync(id: string): Promise<SupportEpisodeView> {
  return platformApiFetch(`${base}/${encodeURIComponent(id)}/retry-sync`, {
    method: "POST",
    body: "{}",
    responseSchema: platformSupportChatContracts.retrySync.response,
  });
}
export async function getPlatformTranscript(
  id: string,
  cursor?: string,
): Promise<SupportTranscriptPage> {
  return platformApiFetch(
    `/billing/requests/${encodeURIComponent(id)}/transcript${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    { responseSchema: supportTranscriptContracts.platform.response },
  );
}
