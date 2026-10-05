import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  Card,
  FilterBar,
  Input,
  PageHeader,
  Select,
  StatusChip,
  Table,
  type TableColumn,
  type TagPhase,
} from "@markiro/ui";

import type { OfficeProduct } from "../../host/protocol.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { activeFirstByName } from "../records.js";
import {
  findProducts,
  groupLabel,
  PAGE_SIZE,
  productState,
  type ProductFilter,
  type ProductState,
} from "./product-list.js";
import { useProductGroups } from "./product-queries.js";

/** A state in words and in its phase: archived is out of use, not an alarm. */
const STATE_PHASE = {
  draft: "draft",
  active: "active",
  archived: "retired",
} as const satisfies Record<ProductState, TagPhase>;

const FILTERS: readonly ProductFilter[] = ["all", "draft", "active", "archived"];

interface ProductsPagerProps {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}

/** The list's pages, in the office's words. */
function ProductsPager({ page, pageCount, onPage }: ProductsPagerProps) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t("office.products.pager.label")} className="office-pager">
      <Button
        variant="secondary"
        size="compact"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        {t("office.products.pager.previous")}
      </Button>
      <span>{t("office.products.pager.page", { page, pages: pageCount })}</span>
      <Button
        variant="secondary"
        size="compact"
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
      >
        {t("office.products.pager.next")}
      </Button>
    </nav>
  );
}

/**
 * The catalog's products (spec §4.3, §5.5), archived ones included. The host
 * sends the whole list, so the search, the state filter and the pages work
 * here. A product group's name comes from the host's lookup; when it does not
 * load, the list stays and shows the codes.
 */
export function ProductsPage() {
  const { t } = useTranslation();
  const products = useOfficeQuery(officeKeys.products, (api, token) => api.listProducts(token));
  const groups = useProductGroups();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ProductFilter>("all");
  const [page, setPage] = useState(1);

  const columns: TableColumn<OfficeProduct>[] = [
    {
      key: "gtin14",
      title: t("office.products.table.gtin"),
      mono: true,
      render: (product) => product.gtin14,
    },
    {
      key: "name",
      title: t("office.products.table.name"),
      wrap: true,
      render: (product) => (
        <span className="product-name">
          <span>{product.name}</span>
          {product.printName !== null && product.printName !== product.name && (
            <span className="product-name__print">
              {t("office.products.printNameShort", { name: product.printName })}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "group",
      title: t("office.products.table.group"),
      wrap: true,
      render: (product) => groupLabel(groups.data, product.chzProductGroupCode, t),
    },
    {
      key: "boxCapacity",
      title: t("office.products.table.boxCapacity"),
      mono: true,
      align: "right",
      render: (product) => product.boxCapacity ?? t("office.common.none"),
    },
    {
      key: "state",
      title: t("office.products.table.state"),
      render: (product) => {
        const state = productState(product);
        return (
          <StatusChip phase={STATE_PHASE[state]} label={t(`office.products.states.${state}`)} />
        );
      },
    },
  ];

  const content = () => {
    if (products.isPending) return <PageLoading />;
    if (products.isError) {
      return <LoadError error={products.error} onRetry={() => void products.refetch()} />;
    }
    const found = findProducts(activeFirstByName(products.data), search, filter);
    const pageCount = Math.max(1, Math.ceil(found.length / PAGE_SIZE));
    // A shorter list (a product archived and filtered out) never shows an empty page.
    const shown = Math.min(page, pageCount);
    return (
      <>
        <FilterBar
          label={t("office.products.filters")}
          resultSummary={t("office.products.found", {
            shown: found.length,
            total: products.data.length,
          })}
        >
          <Input
            label={t("office.products.search")}
            hint={t("office.products.searchHint")}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
          <Select
            native
            label={t("office.products.stateFilter")}
            options={FILTERS.map((value) => ({
              value,
              label: t(`office.products.states.${value}`),
            }))}
            value={filter}
            onValueChange={(value) => {
              setFilter(value);
              setPage(1);
            }}
          />
        </FilterBar>
        <Card>
          <Table
            columns={columns}
            rows={found.slice((shown - 1) * PAGE_SIZE, shown * PAGE_SIZE)}
            getRowKey={(product) => product.id}
            empty={t(
              products.data.length === 0 ? "office.products.empty" : "office.products.nothingFound",
            )}
            scrollLabel={t("office.products.title")}
          />
          {pageCount > 1 && <ProductsPager page={shown} pageCount={pageCount} onPage={setPage} />}
        </Card>
      </>
    );
  };

  return (
    <>
      <PageHeader title={t("office.products.title")} />
      {groups.isError && (
        <Alert
          tone="warn"
          action={
            <Button variant="secondary" size="compact" onClick={() => void groups.refetch()}>
              {t("office.common.retry")}
            </Button>
          }
        >
          {t("office.products.groupsFailed")}
        </Alert>
      )}
      {content()}
    </>
  );
}
