import { platformAuditContracts, type PlatformAuditEvent } from "@markiro/platform-contracts";
import { platformApiFetch } from "../../api/client.js";

export type AuditEvent = PlatformAuditEvent;

export const listAuditEvents = (params: { limit?: number; offset?: number } = {}) => {
  const query = new URLSearchParams();
  query.set("limit", String(params.limit ?? 50));
  query.set("offset", String(params.offset ?? 0));
  return platformApiFetch(`/audit?${query.toString()}`, platformAuditContracts.list.response);
};
