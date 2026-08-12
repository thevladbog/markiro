import { Combobox } from "@markiro/ui";
import { useTranslation } from "react-i18next";

import type { TenantListItem } from "../tenants/api.js";

export interface TenantPickerProps {
  tenants: readonly TenantListItem[];
  value: string;
  loading: boolean;
  disabled?: boolean;
  error?: string;
  onChange: (tenantId: string) => void;
}

export function TenantPicker({
  tenants,
  value,
  loading,
  disabled,
  error,
  onChange,
}: TenantPickerProps) {
  const { t } = useTranslation();

  return (
    <Combobox
      label={t("documents.tenant")}
      value={value}
      loading={loading}
      {...(disabled === undefined ? {} : { disabled })}
      {...(error === undefined ? {} : { error })}
      options={tenants.map((tenant) => ({
        value: tenant.id,
        label: tenant.name,
        description: tenant.slug,
        keywords: [tenant.name, tenant.slug],
      }))}
      placeholder={t("documents.tenantPlaceholder")}
      searchPlaceholder={t("documents.tenantSearch")}
      emptyText={t("documents.tenantEmpty")}
      onValueChange={onChange}
    />
  );
}
