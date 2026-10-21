import {
  platformLeadContracts,
  type PlatformLeadContacted,
  type PlatformLeadCreateTenant,
  type PlatformLeadDetail,
  type PlatformLeadEvent,
  type PlatformLeadLinkTenant,
  type PlatformLeadListItem,
  type PlatformLeadListQueryInput,
  type PlatformLeadListResponse,
  type PlatformLeadSummary,
  type PlatformLeadUpdateInput,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

export type {
  PlatformLeadDetail as LeadDetail,
  PlatformLeadEvent as LeadEvent,
  PlatformLeadListItem as LeadListItem,
  PlatformLeadListQueryInput as LeadListQueryInput,
};

/** Every leads query lives under one root, so a mutation invalidates list, summary and card. */
export const leadKeys = {
  all: ["platform", "leads"] as const,
  list: (query: PlatformLeadListQueryInput) => ["platform", "leads", "list", query] as const,
  summary: () => ["platform", "leads", "summary"] as const,
  detail: (id: string) => ["platform", "leads", "detail", id] as const,
};

const LIST_PARAMS = ["search", "status", "kind", "from", "to"] as const;

export function leadListPath(query: PlatformLeadListQueryInput): string {
  const parsed = platformLeadContracts.list.query.parse(query);
  const search = new URLSearchParams({ page: String(parsed.page), limit: String(parsed.limit) });
  for (const key of LIST_PARAMS) {
    const value = parsed[key];
    if (value) search.set(key, value);
  }
  return `/leads?${search.toString()}`;
}

function leadPath(id: string, action = ""): string {
  const { id: leadId } = platformLeadContracts.detail.params.parse({ id });
  return `/leads/${leadId}${action}`;
}

export function listLeads(query: PlatformLeadListQueryInput): Promise<PlatformLeadListResponse> {
  return platformApiFetch(leadListPath(query), {
    responseSchema: platformLeadContracts.list.response,
  });
}

export function getLeadSummary(): Promise<PlatformLeadSummary> {
  return platformApiFetch("/leads/summary", {
    responseSchema: platformLeadContracts.summary.response,
  });
}

export async function getLead(id: string): Promise<PlatformLeadDetail> {
  return platformApiFetch(leadPath(id), { responseSchema: platformLeadContracts.detail.response });
}

export async function updateLead(
  id: string,
  input: PlatformLeadUpdateInput,
): Promise<PlatformLeadDetail> {
  const path = leadPath(id);
  const body = platformLeadContracts.update.body.parse(input);
  return platformApiFetch(path, {
    method: "PATCH",
    body: JSON.stringify(body),
    responseSchema: platformLeadContracts.update.response,
  });
}

export async function markLeadContacted(
  id: string,
  input: PlatformLeadContacted = {},
): Promise<PlatformLeadDetail> {
  const path = leadPath(id, "/contacted");
  const body = platformLeadContracts.contacted.body.parse(input);
  return platformApiFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
    responseSchema: platformLeadContracts.contacted.response,
  });
}

export async function linkLeadTenant(
  id: string,
  input: PlatformLeadLinkTenant,
): Promise<PlatformLeadDetail> {
  const path = leadPath(id, "/link-tenant");
  const body = platformLeadContracts.linkTenant.body.parse(input);
  return platformApiFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
    responseSchema: platformLeadContracts.linkTenant.response,
  });
}

export async function createLeadTenant(
  id: string,
  input: PlatformLeadCreateTenant,
): Promise<PlatformLeadDetail> {
  const path = leadPath(id, "/create-tenant");
  const body = platformLeadContracts.createTenant.body.parse(input);
  return platformApiFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
    responseSchema: platformLeadContracts.createTenant.response,
  });
}

export async function anonymizeLead(id: string): Promise<PlatformLeadDetail> {
  return platformApiFetch(leadPath(id, "/anonymize"), {
    method: "POST",
    responseSchema: platformLeadContracts.anonymize.response,
  });
}
