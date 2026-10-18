import { useQueries, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { getTenant } from "../tenants/api.js";

const NAME_STALE_MS = 5 * 60_000;

const nameQuery = (tenantId: string) => ({
  queryKey: ["platform", "tenant-name", tenantId] as const,
  queryFn: async () => (await getTenant(tenantId)).tenant.name,
  staleTime: NAME_STALE_MS,
  retry: false,
});

/**
 * The agreements API returns only `tenantId`. Names are resolved one tenant at
 * a time through the tenant detail endpoint: exact for any number of tenants
 * (the tenant list is paginated) and cached per tenant, so a registry that
 * repeats a tenant asks once.
 */
export function useTenantNames(tenantIds: readonly (string | null)[]): Map<string, string> {
  const unique = [...new Set(tenantIds.filter((id): id is string => id !== null))];
  const results = useQueries({ queries: unique.map(nameQuery) });
  const names = new Map<string, string>();
  unique.forEach((id, index) => {
    const name = results[index]?.data;
    if (name) names.set(id, name);
  });
  return names;
}

export function useTenantName(tenantId: string | null) {
  return useQuery({ ...nameQuery(tenantId ?? ""), enabled: tenantId !== null });
}

/** Tenant name as a link to the tenant card; the id stands in while it loads or fails. */
export function TenantLink({ tenantId, name }: { tenantId: string; name: string | undefined }) {
  const { t } = useTranslation();
  return (
    <Link to={`/tenants/${tenantId}`} className="agreement-tenant-link">
      {name ?? <span title={t("agreements.detail.tenantLoading")}>{tenantId.slice(0, 8)}…</span>}
    </Link>
  );
}
