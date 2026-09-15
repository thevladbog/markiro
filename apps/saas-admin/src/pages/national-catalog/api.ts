import { platformNationalCatalogContracts } from "@markiro/platform-contracts";
import type { z } from "zod";

import { platformApiFetch } from "../../api/client.js";

export type NationalCatalogSchemas = z.output<
  typeof platformNationalCatalogContracts.listSchemas.response
>;

export function listNationalCatalogSchemas() {
  return platformApiFetch("/operations/national-catalog/schemas", {
    responseSchema: platformNationalCatalogContracts.listSchemas.response,
  });
}

export function refreshNationalCatalogSchemas(sourceTenantId: string) {
  const body = platformNationalCatalogContracts.refresh.body.parse({ sourceTenantId });
  return platformApiFetch("/operations/national-catalog/schema-refresh", {
    method: "POST",
    body: JSON.stringify(body),
    responseSchema: platformNationalCatalogContracts.refresh.response,
  });
}

export function reviewNationalCatalogGroupMapping(
  chzProductGroupCode: number,
  schemaVersionId: string,
) {
  const body = platformNationalCatalogContracts.reviewGroupMapping.body.parse({
    state: "exact",
    schemaVersionIds: [schemaVersionId],
  });
  return platformApiFetch(
    `/operations/national-catalog/group-mappings/${chzProductGroupCode}/review`,
    {
      method: "POST",
      body: JSON.stringify(body),
      responseSchema: platformNationalCatalogContracts.reviewGroupMapping.response,
    },
  );
}

export function activateNationalCatalogSchema(schemaVersionId: string) {
  return platformApiFetch(
    `/operations/national-catalog/schema-versions/${encodeURIComponent(schemaVersionId)}/activate`,
    {
      method: "POST",
      body: "{}",
      responseSchema: platformNationalCatalogContracts.activate.response,
    },
  );
}
