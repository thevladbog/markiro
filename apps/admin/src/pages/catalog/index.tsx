import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Outlet, useNavigate } from "react-router";

import {
  AdminPage,
  Alert,
  Button,
  ConfirmDialog,
  EmptyState,
  FilterBar,
  Input,
  PageHeader,
  RowActions,
  Select,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { SelectOption, TableColumn } from "@markiro/ui";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useCounterparties } from "../counterparties/api.js";
import { useCandidates } from "../integrations/api.js";
import {
  productImageUrl,
  useDeleteProduct,
  useProducts,
  type ProductDto,
  type ProductStatus,
} from "./api.js";
import type { CatalogPanelContext, CatalogPanelLocationState } from "./ProductPanelRoute.js";
import "./catalog.css";

/**
 * The channel this plaque points into. Hardcoded rather than looped over
 * every channel: `commerceml` is the only channel that produces
 * `integration_candidates` rows today (see
 * `apps/api/src/modules/integrations/integrations.service.ts`'s
 * `unlinkProduct` doc comment, which hardcodes the same assumption on the
 * server side) -- there is exactly one queue to point at, not several to
 * pick from.
 */
const CANDIDATES_CHANNEL_TYPE = "commerceml";

type StatusFilter = "all" | ProductStatus | "archived";

function ProductThumbnail({ product }: { product: ProductDto }) {
  const [failed, setFailed] = useState(false);
  if (!product.image || failed) {
    return <span aria-label={failed ? "" : undefined}>—</span>;
  }
  return (
    <img
      src={productImageUrl(product) ?? undefined}
      alt={product.name}
      width={48}
      height={48}
      onError={() => setFailed(true)}
      style={{ objectFit: "cover", borderRadius: 6 }}
    />
  );
}

/** Debounce delay (ms) between the last keystroke in the search box and the refetch. */
const SEARCH_DEBOUNCE_MS = 300;

const DEFAULT_PAGE_SIZE = 10;
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

function CatalogPager({
  page,
  pageCount,
  onPage,
  label,
  previousLabel,
  nextLabel,
}: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
  label: string;
  previousLabel: string;
  nextLabel: string;
}) {
  return (
    <nav
      aria-label={label}
      style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8 }}
    >
      <Button
        aria-label={previousLabel}
        size="compact"
        variant="secondary"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        ‹
      </Button>
      <span style={{ font: "var(--text-meta)", color: "var(--fg-2)" }}>
        {page} / {pageCount}
      </span>
      <Button
        aria-label={nextLabel}
        size="compact"
        variant="secondary"
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
      >
        ›
      </Button>
    </nav>
  );
}

function AuthorizedCreateProductAction() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <Button
      type="button"
      onClick={() =>
        void navigate("new", {
          state: { catalogBackground: true } satisfies CatalogPanelLocationState,
        })
      }
    >
      {t("pages.catalog.addAction")}
    </Button>
  );
}

/**
 * Keeps the integrations-only candidates query out of the catalog route for
 * operators who can read products but not integrations. This must remain a
 * child rather than an `enabled` option on the parent hook: cached candidate
 * data must not be read into the catalog render tree before the capability
 * check succeeds.
 */
function AuthorizedCandidatesPlaque() {
  const { t } = useTranslation();
  const { data: candidatesData } = useCandidates(CANDIDATES_CHANNEL_TYPE, false);
  const candidatesCount = candidatesData?.length ?? 0;

  if (candidatesCount === 0) return null;

  return (
    <Alert
      tone="info"
      action={
        <Link
          to={`/integrations/${CANDIDATES_CHANNEL_TYPE}`}
          style={{ font: "600 13px/18px var(--font-ui)", color: "var(--info-fg)" }}
        >
          {t("pages.catalog.candidatesPlaque.action")}
        </Link>
      }
    >
      {t("pages.catalog.candidatesPlaque.text", { count: candidatesCount })}
    </Alert>
  );
}

function AuthorizedProductRowActions({ product }: { product: ProductDto }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const deleteMutation = useDeleteProduct();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async () => {
    try {
      setDeleteError(null);
      await deleteMutation.mutateAsync(product.id);
      toast("ok", t("pages.catalog.toasts.deleteSuccess"));
      setDeleting(false);
    } catch (error) {
      setDeleteError(
        error instanceof ApiRequestError ? error.message : t("pages.catalog.toasts.deleteError"),
      );
    }
  };

  return (
    <>
      <RowActions>
        <Button
          type="button"
          size="compact"
          variant="secondary"
          onClick={() =>
            void navigate(`${product.id}/edit`, {
              state: { catalogBackground: true } satisfies CatalogPanelLocationState,
            })
          }
        >
          {t("pages.catalog.edit")}
        </Button>
        <Button
          type="button"
          size="compact"
          variant="destructive"
          onClick={() => {
            setDeleteError(null);
            setDeleting(true);
          }}
        >
          {t("pages.catalog.delete")}
        </Button>
      </RowActions>
      <ConfirmDialog
        open={deleting}
        title={t("pages.catalog.deleteConfirmTitle")}
        description={
          <>
            <span>{t("pages.catalog.deleteConfirmBody", { name: product.name })}</span>
            {deleteError ? <Alert tone="error">{deleteError}</Alert> : null}
          </>
        }
        entity={product.gtin14}
        cancelLabel={t("pages.catalog.cancel")}
        confirmLabel={t("pages.catalog.deleteConfirmAction")}
        tone="destructive"
        busy={deleteMutation.isPending}
        onCancel={() => setDeleting(false)}
        onConfirm={() => void handleDelete()}
      />
    </>
  );
}

/** Admin product catalog CRUD screen -- Plan 03 Task 12 (list/create/edit/delete + GTIN owner hint). */
export function CatalogPage() {
  const { t } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const canReadIntegrations = useCan(CABINET_CAPABILITY.INTEGRATIONS_READ);

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(DEFAULT_PAGE_SIZE);

  // Debounce the free-text search so typing doesn't refetch on every keystroke.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const {
    data,
    isPending,
    isError,
    refetch: refetchProducts,
  } = useProducts({
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    // "all" opts into archived rows (the server hides them by default);
    // "archived" asks for archived rows only; draft/active keep the default.
    ...(statusFilter === "all"
      ? { archived: "all" as const }
      : statusFilter === "archived"
        ? { archived: "true" as const }
        : { status: statusFilter }),
  });
  const {
    data: counterpartiesData,
    isPending: counterpartiesPending,
    isError: counterpartiesError,
    refetch: refetchCounterparties,
  } = useCounterparties();
  const items = data ?? [];
  const counterparties = useMemo(() => counterpartiesData ?? [], [counterpartiesData]);

  // Snap back to the first page whenever the visible set changes shape.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, statusFilter, pageSize]);

  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  // Clamp instead of an effect: deletions on the last page must not flash an empty table.
  const currentPage = Math.min(page, pageCount);
  const pageItems = items.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const statusFilterOptions: SelectOption<StatusFilter>[] = [
    { value: "all", label: t("pages.catalog.statusFilter.all") },
    { value: "draft", label: t("pages.catalog.statusFilter.draft") },
    { value: "active", label: t("pages.catalog.statusFilter.active") },
    { value: "archived", label: t("pages.catalog.statusFilter.archived") },
  ];

  const pageSizeOptions: SelectOption<`${PageSize}`>[] = PAGE_SIZE_OPTIONS.map((size) => ({
    value: `${size}`,
    label: `${size}`,
  }));

  const columns: TableColumn<ProductDto>[] = useMemo(
    () => [
      { key: "gtin14", title: t("pages.catalog.table.gtin"), mono: true },
      {
        key: "image",
        title: t("pages.catalog.table.image"),
        render: (row) => <ProductThumbnail product={row} />,
      },
      { key: "name", title: t("pages.catalog.table.name"), wrap: true },
      {
        key: "productGroup",
        title: t("pages.catalog.table.productGroup"),
        render: (row) => row.productGroup ?? "—",
      },
      {
        key: "boxCapacity",
        title: t("pages.catalog.table.boxCapacity"),
        align: "right",
        mono: true,
        render: (row) => row.boxCapacity ?? "—",
      },
      {
        key: "status",
        title: t("pages.catalog.table.status"),
        render: (row) =>
          row.archived ? (
            <StatusChip status="neutral" label={t("pages.catalog.status.archived")} />
          ) : (
            <StatusChip
              status={row.status === "active" ? "ok" : "warn"}
              label={t(`pages.catalog.status.${row.status}`)}
            />
          ),
      },
      {
        key: "actions",
        title: t("pages.catalog.table.actions"),
        align: "right",
        render: (row) => (canWrite ? <AuthorizedProductRowActions product={row} /> : null),
      },
    ],
    [t, canWrite],
  );

  const retryPanelData = async () => {
    await Promise.all([refetchProducts(), refetchCounterparties()]);
  };

  return (
    <AdminPage className="mk-catalog-page" data-testid="catalog-page">
      <PageHeader
        title={t("pages.catalog.title")}
        actions={canWrite ? <AuthorizedCreateProductAction /> : null}
      />

      {canReadIntegrations ? <AuthorizedCandidatesPlaque /> : null}

      <FilterBar
        label={t("pages.catalog.filtersLabel")}
        resultSummary={
          !isPending && !isError ? t("pages.catalog.resultCount", { count: items.length }) : ""
        }
      >
        <div className="mk-catalog-filters__search">
          <Input
            label={t("pages.catalog.searchLabel")}
            placeholder={t("pages.catalog.searchPlaceholder")}
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
        <div className="mk-catalog-filters__status">
          <Select
            label={t("pages.catalog.statusFilterLabel")}
            options={statusFilterOptions}
            value={statusFilter}
            onValueChange={setStatusFilter}
          />
        </div>
        <div className="mk-catalog-filters__page-size">
          <Select
            label={t("pages.catalog.pageSizeLabel")}
            options={pageSizeOptions}
            value={`${pageSize}`}
            onValueChange={(value) => setPageSize(Number(value) as PageSize)}
          />
        </div>
      </FilterBar>

      {isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : isError ? (
        <Alert tone="error">{t("common.loadError")}</Alert>
      ) : items.length === 0 ? (
        <EmptyState
          title={t("pages.catalog.emptyTitle")}
          hint={t("pages.catalog.emptyHint")}
          action={canWrite ? <AuthorizedCreateProductAction /> : null}
        />
      ) : (
        <>
          <Table columns={columns} rows={pageItems} />
          {pageCount > 1 ? (
            <CatalogPager
              page={currentPage}
              pageCount={pageCount}
              onPage={setPage}
              label={t("pages.catalog.pager.label")}
              previousLabel={t("pages.catalog.pager.previous")}
              nextLabel={t("pages.catalog.pager.next")}
            />
          ) : null}
        </>
      )}
      <Outlet
        context={
          {
            products: items,
            productsPending: isPending,
            productsError: isError,
            counterparties,
            counterpartiesPending,
            counterpartiesError,
            retryPanelData,
          } satisfies CatalogPanelContext
        }
      />
    </AdminPage>
  );
}
