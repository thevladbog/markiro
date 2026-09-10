import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Combobox, type ComboboxOption } from "@markiro/ui";

import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { listReportOptions } from "./api.js";

export function ReportProductSelect({
  tenantIds,
  value,
  onValueChange,
}: {
  tenantIds: string[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selected, setSelected] = useState<ComboboxOption | undefined>();
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const products = useInfiniteQuery({
    queryKey: ["platform", principal.userId, "report-products", tenantIds, debouncedSearch],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      listReportOptions({
        tenantIds,
        kind: "products",
        search: debouncedSearch,
        offset: pageParam,
      }),
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    enabled: tenantIds.length > 0 && principal.capabilities.includes("reports.read"),
  });
  const options: ComboboxOption[] = (products.data?.pages ?? []).flatMap((page) =>
    page.items.map((item) => ({ value: item.id, label: item.name })),
  );
  // A selection can be outside the current result page or search. Retain its label.
  if (selected?.value && !options.some((option) => option.value === selected.value))
    options.unshift(selected);
  options.unshift({ value: "", label: t("reports.any") });
  const loading = products.isLoading || search !== debouncedSearch;
  return (
    <Combobox
      label={t("reports.fields.product")}
      value={value}
      options={options}
      placeholder={t("reports.any")}
      searchPlaceholder={t("reports.productSearch.placeholder")}
      emptyText={t("reports.productSearch.empty")}
      loadingText={t("reports.productSearch.loading")}
      disabled={tenantIds.length === 0}
      loading={loading}
      {...(products.isError ? { error: t("reports.productSearch.error") } : {})}
      onSearchChange={setSearch}
      onValueChange={(next) => {
        setSelected(options.find((option) => option.value === next));
        onValueChange(next);
      }}
      footer={
        products.isError ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              void (products.isFetchNextPageError ? products.fetchNextPage() : products.refetch())
            }
          >
            {t("reports.retry")}
          </Button>
        ) : products.hasNextPage ? (
          <Button
            type="button"
            variant="secondary"
            disabled={loading || products.isFetchingNextPage}
            onClick={() => void products.fetchNextPage()}
          >
            {t(
              products.isFetchingNextPage
                ? "reports.productSearch.loading"
                : "reports.productSearch.more",
            )}
          </Button>
        ) : null
      }
    />
  );
}
