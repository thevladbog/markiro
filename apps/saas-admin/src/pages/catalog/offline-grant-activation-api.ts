import {
  platformGrantActivationContracts,
  type PlatformGrantActivationCancelRequest,
  type PlatformGrantActivationConfirmRequest,
  type PlatformGrantActivationListQuery,
  type PlatformGrantActivationPrepareRequest,
} from "@markiro/platform-contracts";

import { ApiRequestError, platformApiFetch } from "../../api/client.js";

export function activationErrorKind(error: unknown): "authorization" | "stale" | "uncertain" {
  if (!(error instanceof ApiRequestError)) return "uncertain";
  if (error.kind === "authorization" && (error.status === 401 || error.status === 403)) {
    return "authorization";
  }
  if (error.kind === "domain" && error.status === 409) return "stale";
  return "uncertain";
}

export function listOfflineGrantActivations(query: PlatformGrantActivationListQuery = {}) {
  const parsed = platformGrantActivationContracts.list.query.parse(query);
  const params = new URLSearchParams({ limit: String(parsed.limit) });
  if (parsed.state) params.set("state", parsed.state);
  if (parsed.cursor) params.set("cursor", parsed.cursor);
  return platformApiFetch(`/offline-grants/activations?${params.toString()}`, {
    responseSchema: platformGrantActivationContracts.list.response,
  });
}

export function getOfflineGrantActivation(id: string) {
  return platformApiFetch(`/offline-grants/activations/${encodeURIComponent(id)}`, {
    responseSchema: platformGrantActivationContracts.detail.response,
  });
}

export function prepareOfflineGrantActivation(input: PlatformGrantActivationPrepareRequest) {
  const body = platformGrantActivationContracts.prepare.body.parse(input);
  return platformApiFetch("/offline-grants/activations", {
    method: "POST",
    body: JSON.stringify(body),
    responseSchema: platformGrantActivationContracts.prepare.response,
  });
}

export function confirmOfflineGrantActivation(
  id: string,
  input: PlatformGrantActivationConfirmRequest,
) {
  const body = platformGrantActivationContracts.confirm.body.parse(input);
  return platformApiFetch(`/offline-grants/activations/${encodeURIComponent(id)}/confirm`, {
    method: "POST",
    body: JSON.stringify(body),
    responseSchema: platformGrantActivationContracts.confirm.response,
  });
}

export function cancelOfflineGrantActivation(
  id: string,
  input: PlatformGrantActivationCancelRequest,
) {
  const body = platformGrantActivationContracts.cancel.body.parse(input);
  return platformApiFetch(`/offline-grants/activations/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: JSON.stringify(body),
    responseSchema: platformGrantActivationContracts.cancel.response,
  });
}
