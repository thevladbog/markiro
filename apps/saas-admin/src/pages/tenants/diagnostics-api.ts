import {
  platformStandaloneDiagnosticsContracts as contracts,
  platformUuidSchema,
  standaloneOpaqueIdSchema,
  type StandaloneDiagnosticDetail,
  type StandaloneDiagnosticsHistory,
  type StandaloneDiagnosticsIngestRequest,
  type StandaloneDiagnosticsIngestResponse,
  type StandaloneDiagnosticsOverview,
  type StandaloneDiagnosticsStatistics,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

const base = (tenantId: string) =>
  `/tenants/${encodeURIComponent(standaloneOpaqueIdSchema.parse(tenantId))}/standalone-diagnostics`;

export const diagnosticsKey = (tenantId: string, ...part: string[]) =>
  ["platform", "tenants", tenantId, "standalone-diagnostics", ...part] as const;

export function ingestDiagnostics(
  tenantId: string,
  input: StandaloneDiagnosticsIngestRequest,
): Promise<StandaloneDiagnosticsIngestResponse> {
  return platformApiFetch(base(tenantId), {
    method: contracts.ingest.method,
    responseSchema: contracts.ingest.response,
    body: JSON.stringify(contracts.ingest.body.parse(input)),
  });
}

export function getDiagnosticsOverview(tenantId: string): Promise<StandaloneDiagnosticsOverview> {
  return platformApiFetch(`${base(tenantId)}/overview`, {
    responseSchema: contracts.overview.response,
  });
}

export function getDiagnosticsHistory(
  tenantId: string,
  cursor?: string,
): Promise<StandaloneDiagnosticsHistory> {
  const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  return platformApiFetch(`${base(tenantId)}${query}`, {
    responseSchema: contracts.history.response,
  });
}

export function getDiagnosticsStatistics(
  tenantId: string,
  hostKey?: string,
): Promise<StandaloneDiagnosticsStatistics> {
  const query = hostKey === undefined ? "" : `?hostKey=${encodeURIComponent(hostKey)}`;
  return platformApiFetch(`${base(tenantId)}/statistics${query}`, {
    responseSchema: contracts.statistics.response,
  });
}

export function getDiagnostic(tenantId: string, id: string): Promise<StandaloneDiagnosticDetail> {
  return platformApiFetch(`${base(tenantId)}/${platformUuidSchema.parse(id)}`, {
    responseSchema: contracts.detail.response,
  });
}
