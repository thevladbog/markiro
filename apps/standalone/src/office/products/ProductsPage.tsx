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
import { useCan } from "../access.js";
import { useProductGroups } from "../catalog-queries.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { OfficePager } from "../OfficePager.js";
import { LoadError, PageLoading } from "../page-state.js";
import { activeFirstByName, useStoreRecord } from "../records.js";
import { ProductDialog } from "./ProductDialog.js";
import {
  findProducts,
  groupLabel,
  PAGE_SIZE,
  productState,
  type ProductFilter,
  type ProductState,
} from "./product-list.js";

/** A state in words and in its phase: archived is out of use, not an alarm. */
const STATE_PHASE = {
  draft: "draft",
  active: "active",
  archived: "retired",
} as const satisfies Record<ProductState, TagPhase>;

const FILTERS: readonly ProductFilter[] = ["all", "draft", "active", "archived"];

type ProductsDialog = { kind: "create" } | { kind: "edit"; product: OfficeProduct };

/**
 * The catalog's products (spec §4.3, §5.5), archived ones included. The host
 * sends the whole list, so the search, the state filter and the pages work
 * here. A product group's name comes from the host's lookup; when it does not
 * load, the list stays and shows the codes. Both office roles add and change
 * products (`editCatalog`); there is no delete, a product is archived instead.
 */
export function ProductsPage() {
  const { t } = useTranslation();
  const canEdit = useCan("editCatalog");
  const products = useOfficeQuery(officeKeys.products, (api, token) => api.listProducts(token));
  const groups = useProductGroups();
  const store = useStoreRecord<OfficeProduct>(officeKeys.products);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ProductFilter>("all");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<ProductsDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const open = (next: ProductsDialog) => {
    setNotice(null);
    setDialog(next);
  };

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
          {/* In words, not a colour or an icon alone (plan ТОВ). */}
          {product.photoChecksum !== null && (
            <span className="product-name__print">{t("office.products.table.hasPhoto")}</span>
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
  if (canEdit) {
    columns.push({
      key: "actions",
      title: t("office.products.table.actions"),
      render: (product) => (
        <Button
          variant="secondary"
          size="compact"
          aria-label={t("office.products.editNamed", { name: product.name })}
          onClick={() => open({ kind: "edit", product })}
        >
          {t("office.products.edit")}
        </Button>
      ),
    });
  }

  const content = () => {
    if (products.isPending) return <PageLoading />;
    if (products.isError) {
      return (
        <LoadError
          error={products.error}
          onRetry={() => {
            void products.refetch();
            // One click recovers both reads when the group names failed too.
            if (groups.isError) void groups.refetch();
          }}
        />
      );
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
          {pageCount > 1 && (
            <OfficePager
              label={t("office.products.pager.label")}
              page={shown}
              pageCount={pageCount}
              onPage={setPage}
            />
          )}
        </Card>
      </>
    );
  };

  return (
    <>
      <PageHeader
        title={t("office.products.title")}
        actions={
          canEdit ? (
            <Button onClick={() => open({ kind: "create" })}>{t("office.products.add")}</Button>
          ) : null
        }
      />
      {notice && <Alert tone="ok">{notice}</Alert>}
      {/* About the list's group column: with no list on screen the products' error stands alone. */}
      {groups.isError && products.isSuccess && (
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
      {canEdit && dialog !== null && (
        <ProductDialog
          product={dialog.kind === "edit" ? dialog.product : null}
          onClose={() => setDialog(null)}
          onSaved={(product) => {
            store(product);
            setDialog(null);
            setNotice(
              dialog.kind === "create"
                ? t("office.products.created", { name: product.name })
                : t("office.common.saved"),
            );
          }}
          onReload={() => {
            setDialog(null);
            void products.refetch();
          }}
        />
      )}
    </>
  );
}
