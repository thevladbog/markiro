import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  Input,
  PageHeader,
  StatusChip,
  type TableColumn,
  type TagPhase,
} from "@markiro/ui";

import type { OfficeProduct } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { useProductGroups } from "../catalog-queries.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { OfficeIcon } from "../OfficeIcon.js";
import { listViewState } from "../list/list-state.js";
import { ListCard, ListFilters } from "../list/ListCard.js";
import { ListEmpty, ListError, ListNothing, ListSkeleton } from "../list/ListStates.js";
import { RowActionBar } from "../list/RowActionBar.js";
import { StateFilter } from "../list/StateFilter.js";
import { PagedTable } from "../paging/PagedTable.js";
import { activeFirstByName, useStoreRecord } from "../records.js";
import { ArchiveProductDialog } from "./ArchiveProductDialog.js";
import { ProductDrawer } from "./ProductDrawer.js";
import { ProductThumb } from "./ProductThumb.js";
import {
  findProducts,
  groupLabel,
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

type ProductsDialog =
  | { kind: "create" }
  | { kind: "edit"; product: OfficeProduct }
  | { kind: "archive"; product: OfficeProduct }
  | { kind: "restore"; product: OfficeProduct };

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
  const [dialog, setDialog] = useState<ProductsDialog | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  const open = (next: ProductsDialog) => {
    setNotice(null);
    setDialog(next);
  };

  const columns: TableColumn<OfficeProduct>[] = [
    {
      // The photo, the name and the print name are one cell: the product as the eye reads it.
      key: "name",
      title: t("office.products.table.product"),
      wrap: true,
      minWidth: 260,
      render: (product) => (
        <span className="product-cell">
          <ProductThumb product={product} />
          <span className="product-name">
            <span className="product-name__full">{product.name}</span>
            {product.printName !== null && product.printName !== product.name && (
              <span className="product-name__print">
                {t("office.products.printNameShort", { name: product.printName })}
              </span>
            )}
          </span>
        </span>
      ),
    },
    {
      key: "gtin14",
      title: t("office.products.table.gtin"),
      mono: true,
      render: (product) => product.gtin14,
    },
    {
      key: "group",
      title: t("office.products.table.group"),
      wrap: true,
      minWidth: 150,
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
      stickyEnd: true,
      title: t("office.products.table.actions"),
      render: (product) => (
        <RowActionBar
          actions={[
            {
              key: "edit",
              label: t("office.products.editNamed", { name: product.name }),
              icon: "pencil",
              onSelect: () => open({ kind: "edit", product }),
            },
          ]}
          menu={{
            label: t("office.common.rowActions", { name: product.name }),
            items: [
              {
                key: "edit",
                label: t("office.products.edit"),
                ariaLabel: t("office.products.editNamed", { name: product.name }),
                icon: "pencil",
                onSelect: () => open({ kind: "edit", product }),
              },
              product.archived
                ? {
                    key: "restore",
                    label: t("office.products.restore"),
                    ariaLabel: t("office.products.restoreNamed", { name: product.name }),
                    icon: "reset",
                    onSelect: () => open({ kind: "restore", product }),
                  }
                : {
                    key: "archive",
                    label: t("office.products.archive"),
                    ariaLabel: t("office.products.archiveNamed", { name: product.name }),
                    icon: "archive",
                    destructive: true,
                    onSelect: () => open({ kind: "archive", product }),
                  },
            ],
          }}
        />
      ),
    });
  }

  const resetFilters = () => {
    setSearch("");
    setFilter("all");
  };
  const filtersOn = search.trim() !== "" || filter !== "all";
  const found = products.isSuccess
    ? findProducts(activeFirstByName(products.data), search, filter)
    : [];
  const view = listViewState({
    pending: products.isPending,
    failed: products.isError,
    total: products.data?.length ?? 0,
    found: found.length,
  });
  const state =
    view === "loading" ? (
      <ListSkeleton />
    ) : view === "error" ? (
      <ListError
        error={products.error}
        onRetry={() => {
          void products.refetch();
          // One click recovers both reads when the group names failed too.
          if (groups.isError) void groups.refetch();
        }}
      />
    ) : view === "empty" ? (
      <ListEmpty
        icon="package"
        title={t("office.products.empty")}
        hint={t("office.products.emptyHint")}
        {...(canEdit
          ? {
              action: (
                <Button
                  icon={<OfficeIcon name="plus" size={20} />}
                  onClick={() => open({ kind: "create" })}
                >
                  {t("office.products.add")}
                </Button>
              ),
            }
          : {})}
      />
    ) : view === "nothing" ? (
      <ListNothing onReset={resetFilters} />
    ) : null;

  const content = (
    <ListCard>
      {products.isSuccess && (
        <ListFilters
          label={t("office.products.filters")}
          resultSummary={t("office.products.found", {
            shown: found.length,
            total: products.data.length,
          })}
          onReset={filtersOn ? resetFilters : undefined}
        >
          <Input
            label={t("office.products.search")}
            placeholder={t("office.products.searchHint")}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
          <StateFilter
            label={t("office.products.stateFilter")}
            options={FILTERS.map((value) => ({
              value,
              label: t(`office.products.states.${value}`),
            }))}
            value={filter}
            onChange={setFilter}
          />
        </ListFilters>
      )}
      <PagedTable
        tableId="products"
        pagerLabel={t("office.products.pager.label")}
        resetKey={`${search}|${filter}`}
        columns={columns}
        rows={found}
        getRowKey={(product) => product.id}
        empty={state}
        scrollLabel={t("office.products.title")}
      />
    </ListCard>
  );

  return (
    <>
      <PageHeader
        title={t("office.products.title")}
        description={t("office.products.subtitle")}
        actions={
          canEdit ? (
            <Button onClick={() => open({ kind: "create" })}>{t("office.products.add")}</Button>
          ) : null
        }
      />
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
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
      {content}
      {canEdit && (dialog?.kind === "archive" || dialog?.kind === "restore") && (
        <ArchiveProductDialog
          product={dialog.product}
          mode={dialog.kind}
          onClose={() => setDialog(null)}
          onDone={(product) => {
            store(product);
            setDialog(null);
            setNotice({
              tone: "ok",
              text: t(
                dialog.kind === "archive" ? "office.products.archived" : "office.products.restored",
                { name: product.name },
              ),
            });
          }}
          onReload={() => {
            setDialog(null);
            void products.refetch();
          }}
        />
      )}
      {canEdit && (dialog?.kind === "create" || dialog?.kind === "edit") && (
        <ProductDrawer
          product={dialog.kind === "edit" ? dialog.product : null}
          onClose={() => setDialog(null)}
          onSaved={(product, photoFailed) => {
            store(product);
            setDialog(null);
            setNotice(
              photoFailed
                ? { tone: "warn", text: t("office.products.photoFailed", { name: product.name }) }
                : {
                    tone: "ok",
                    text:
                      dialog.kind === "create"
                        ? t("office.products.created", { name: product.name })
                        : t("office.common.saved"),
                  },
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
