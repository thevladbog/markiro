import {
  platformGrantReadinessListQuerySchema,
  platformGrantReadinessListResponseSchema,
  platformGrantReadinessPreviewRequestSchema,
  platformGrantReadinessPreviewResponseSchema,
  type PlatformGrantReadinessListQuery,
  type PlatformGrantReadinessPreviewRequest,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

export function listOfflineGrantReadiness(
  filters: Omit<PlatformGrantReadinessListQuery, "cursor"> = {},
  cursor?: string,
) {
  const query = platformGrantReadinessListQuerySchema.parse({ ...filters, cursor });
  const params = new URLSearchParams();
  if (query.tenantId) params.set("tenantId", query.tenantId);
  if (query.deviceKind) params.set("deviceKind", query.deviceKind);
  if (query.readiness) params.set("readiness", query.readiness);
  if (query.policyId) params.set("policyId", query.policyId);
  if (query.cursor) params.set("cursor", query.cursor);
  params.set("limit", String(query.limit));
  return platformApiFetch(`/offline-grants/readiness?${params.toString()}`, {
    responseSchema: platformGrantReadinessListResponseSchema,
  });
}

export function previewOfflineGrantReadiness(input: PlatformGrantReadinessPreviewRequest) {
  const body = platformGrantReadinessPreviewRequestSchema.parse(input);
  return platformApiFetch("/offline-grants/readiness/preview", {
    method: "POST",
    body: JSON.stringify(body),
    responseSchema: platformGrantReadinessPreviewResponseSchema,
  });
}
