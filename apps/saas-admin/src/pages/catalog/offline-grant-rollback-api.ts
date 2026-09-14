import {
  platformGrantRollbackContracts,
  type PlatformGrantRollbackCancelRequest,
  type PlatformGrantRollbackCandidatesQuery,
  type PlatformGrantRollbackConfirmRequest,
  type PlatformGrantRollbackListQuery,
  type PlatformGrantRollbackPrepareRequest,
} from "@markiro/platform-contracts";
import { platformApiFetch } from "../../api/client.js";

function queryString(input: {
  limit: number;
  cursor?: string | undefined;
  tenantId?: string | undefined;
  deviceKind?: string | undefined;
  state?: string | undefined;
}) {
  const params = new URLSearchParams({ limit: String(input.limit) });
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.tenantId) params.set("tenantId", input.tenantId);
  if (input.deviceKind) params.set("deviceKind", input.deviceKind);
  if (input.state) params.set("state", input.state);
  return params.toString();
}

export function listOfflineGrantRollbackCandidates(
  query: PlatformGrantRollbackCandidatesQuery = {},
) {
  const parsed = platformGrantRollbackContracts.candidates.query.parse(query);
  return platformApiFetch(`/offline-grants/rollbacks/candidates?${queryString(parsed)}`, {
    responseSchema: platformGrantRollbackContracts.candidates.response,
  });
}
export function listOfflineGrantRollbacks(query: PlatformGrantRollbackListQuery = {}) {
  const parsed = platformGrantRollbackContracts.list.query.parse(query);
  return platformApiFetch(`/offline-grants/rollbacks?${queryString(parsed)}`, {
    responseSchema: platformGrantRollbackContracts.list.response,
  });
}
export function prepareOfflineGrantRollback(input: PlatformGrantRollbackPrepareRequest) {
  const body = platformGrantRollbackContracts.prepare.body.parse(input);
  return platformApiFetch("/offline-grants/rollbacks", {
    method: "POST",
    body: JSON.stringify(body),
    responseSchema: platformGrantRollbackContracts.prepare.response,
  });
}
export function confirmOfflineGrantRollback(
  id: string,
  input: PlatformGrantRollbackConfirmRequest,
) {
  const body = platformGrantRollbackContracts.confirm.body.parse(input);
  return platformApiFetch(`/offline-grants/rollbacks/${encodeURIComponent(id)}/confirm`, {
    method: "POST",
    body: JSON.stringify(body),
    responseSchema: platformGrantRollbackContracts.confirm.response,
  });
}
export function cancelOfflineGrantRollback(id: string, input: PlatformGrantRollbackCancelRequest) {
  const body = platformGrantRollbackContracts.cancel.body.parse(input);
  return platformApiFetch(`/offline-grants/rollbacks/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: JSON.stringify(body),
    responseSchema: platformGrantRollbackContracts.cancel.response,
  });
}
