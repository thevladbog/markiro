import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { CabinetCapability, CabinetRole } from "@markiro/domain";

import { apiFetch } from "../api/client.js";

export interface AccessDocument {
  roles: CabinetRole[];
  capabilities: CabinetCapability[];
  subscription?: {
    access: "managed" | "read_only" | "unmanaged";
    status: "unmanaged" | "pending_activation" | "trial" | "active" | "expired" | "read_only";
    startsAt: string | null;
    endsAt: string | null;
    plan: { id: string; version: number; nameRu: string; nameEn: string } | null;
    addons: Array<{
      catalogVersionId: string;
      quantity: number;
      quotas: Record<string, number>;
      features: string[];
    }>;
  };
  scheduled?: AccessDocument["subscription"] | null;
  usage?: { lines: number; stations: number; kiosks: number; cabinetUsers: number };
  quotas?: Record<string, number | null>;
  features?: Record<string, boolean>;
}

/** Shared cache-key prefix for the active cabinet access and subscription usage. */
export const CABINET_ACCESS_QUERY_KEY = ["cabinet-access"] as const;

/** Gets effective cabinet access for one authenticated user and active organization. */
export function useAccessDocument(
  userId: string,
  activeOrganizationId: string,
): UseQueryResult<AccessDocument> {
  return useQuery({
    queryKey: [...CABINET_ACCESS_QUERY_KEY, userId, activeOrganizationId],
    queryFn: () => apiFetch<AccessDocument>("/access/me"),
    retry: false,
    staleTime: 0,
  });
}
