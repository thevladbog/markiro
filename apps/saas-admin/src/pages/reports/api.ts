import {
  platformReportContracts,
  type PlatformReport,
  type PlatformReportInput,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

export function listReports(offset = 0) {
  return platformApiFetch(`/reports?limit=50&offset=${offset}`, {
    responseSchema: platformReportContracts.list.response,
  });
}

export function listReportOptions(query: {
  tenantIds: string[];
  kind: "lines" | "products" | "operators";
  search?: string;
  offset?: number;
}) {
  const params = new URLSearchParams({
    kind: query.kind,
    limit: "50",
    offset: String(query.offset ?? 0),
  });
  for (const tenantId of query.tenantIds) params.append("tenantIds", tenantId);
  if (query.search) params.set("search", query.search);
  return platformApiFetch(`/reports/options?${params.toString()}`, {
    responseSchema: platformReportContracts.options.response,
  });
}

export function createReport(input: PlatformReportInput, idempotencyKey: string) {
  return platformApiFetch("/reports", {
    responseSchema: platformReportContracts.create.response,
    method: "POST",
    body: JSON.stringify({ ...input, idempotencyKey }),
  });
}

export function downloadReport(reportId: PlatformReport["id"]) {
  return platformApiFetch(`/reports/${reportId}/download`, {
    responseSchema: platformReportContracts.download.response,
    method: "POST",
  });
}
