import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Combobox } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import { getTenant, listTenants } from "../tenants/api.js";

export function OfferTenantFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const tenants = useQuery({
    queryKey: ["platform", "offer-tenants", page],
    queryFn: () => listTenants({ page, limit: 100 }),
  });
  const selected = useQuery({
    queryKey: ["platform", "tenants", value],
    queryFn: () => getTenant(value),
    enabled: !!value && tenants.isSuccess && !tenants.data.items.some((item) => item.id === value),
  });
  const options = (tenants.data?.items ?? []).map((item) => ({
    value: item.id,
    label: item.name,
    description: item.slug,
  }));
  if (selected.data && !options.some((item) => item.value === value))
    options.unshift({
      value,
      label: selected.data.tenant.name,
      description: selected.data.tenant.slug,
    });
  return (
    <Combobox
      label={t("offerWorkspace.tenantFilter")}
      value={value}
      onValueChange={onChange}
      options={[{ value: "", label: t("offerWorkspace.allTenants") }, ...options]}
      placeholder={t("offerWorkspace.allTenants")}
      searchPlaceholder={t("offerWorkspace.searchTenant")}
      emptyText={t("offerWorkspace.noTenants")}
      loadingText={t("shell.routeLoading")}
      loading={tenants.isPending}
      {...(tenants.error || selected.error ? { error: t("offerWorkspace.errors.tenants") } : {})}
      footer={
        <div className="offer-pagination">
          {tenants.error || selected.error ? (
            <Button
              variant="secondary"
              onClick={() => {
                void tenants.refetch();
                if (value) void selected.refetch();
              }}
            >
              {t("offerWorkspace.retry")}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            disabled={page === 1 || tenants.isFetching}
            onClick={() => setPage(page - 1)}
          >
            {t("offerWorkspace.previous")}
          </Button>
          <span>{t("offerWorkspace.page", { page })}</span>
          <Button
            variant="secondary"
            disabled={tenants.isFetching || page * 100 >= (tenants.data?.total ?? 0)}
            onClick={() => setPage(page + 1)}
          >
            {t("offerWorkspace.next")}
          </Button>
        </div>
      }
    />
  );
}
