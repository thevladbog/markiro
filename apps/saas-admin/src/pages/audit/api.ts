import { platformApiFetch } from "../../api/client.js";

export type AuditEvent = {
  id: string;
  tenantId: string | null;
  actorPlatformUserId: string | null;
  action: string;
  outcome: "success" | "failed" | "denied";
  createdAt: string;
  before: unknown;
  after: unknown;
};

export const listAuditEvents = (params: { limit?: number; offset?: number } = {}) => {
  const query = new URLSearchParams();
  query.set("limit", String(params.limit ?? 50));
  query.set("offset", String(params.offset ?? 0));
  return platformApiFetch<{ items: AuditEvent[]; nextOffset: number | null }>(
    `/audit?${query.toString()}`,
  );
};
