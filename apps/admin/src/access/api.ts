import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { CabinetCapability, CabinetRole } from "@markiro/domain";

import { apiFetch } from "../api/client.js";

export interface AccessDocument {
  roles: CabinetRole[];
  capabilities: CabinetCapability[];
}

/** Gets effective cabinet access for one authenticated user and active organization. */
export function useAccessDocument(
  userId: string,
  activeOrganizationId: string,
): UseQueryResult<AccessDocument> {
  return useQuery({
    queryKey: ["cabinet-access", userId, activeOrganizationId],
    queryFn: () => apiFetch<AccessDocument>("/access/me"),
    retry: false,
    staleTime: 0,
  });
}
