import { Combobox, type ComboboxOption } from "@markiro/ui";
import { useTranslation } from "react-i18next";

import type { TenantListItem } from "../tenants/api.js";

export function TenantPicker({
  tenants,
  value,
  loading,
  error,
  onValueChange,
}: {
  tenants: readonly TenantListItem[];
  value: string;
  loading: boolean;
  error?: string;
  onValueChange: (tenantId: string) => void;
}) {
  const { t } = useTranslation();
  const options: ComboboxOption[] = tenants.map((tenant) => ({
    value: tenant.id,
    label: `${tenant.name} · ${tenant.slug}`,
    keywords: [tenant.name, tenant.slug],
  }));

  return (
    <Combobox
      label={t("documents.tenant")}
      options={options}
      {...(value ? { value } : {})}
      onValueChange={onValueChange}
      placeholder={t("documents.tenantPlaceholder")}
      searchPlaceholder={t("documents.tenantSearch")}
      emptyText={t("documents.tenantEmpty")}
      loadingText={t("documents.tenantLoading")}
      loading={loading}
      {...(error ? { error } : {})}
    />
  );
}
