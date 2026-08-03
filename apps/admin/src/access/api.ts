import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { CabinetCapability, CabinetRole } from "@markiro/domain";

import { apiFetch } from "../api/client.js";

export interface AccessDocument {
  roles: CabinetRole[];
  capabilities: CabinetCapability[];
}

/** Gets the effective cabinet access for one active organization. */
export function useAccessDocument(activeOrganizationId: string): UseQueryResult<AccessDocument> {
  return useQuery({
    queryKey: ["cabinet-access", activeOrganizationId],
    queryFn: () => apiFetch<AccessDocument>("/access/me"),
    retry: false,
    staleTime: 0,
  });
}
