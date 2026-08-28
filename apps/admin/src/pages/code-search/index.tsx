import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

import { formatSsccHri } from "@markiro/domain";
import {
  Alert,
  Button,
  Combobox,
  DatePicker,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { ComboboxOption, SelectOption, StatusChipStatus, TableColumn } from "@markiro/ui";

import { formatCreatedAt, formatDate } from "../../lib/datetime.js";
import { useProducts } from "../catalog/api.js";
import {
  ApiRequestError,
  classifySearch,
  useCodes,
  type ClassifyBoxMatchDto,
  type CodeListItemDto,
} from "./api.js";
import { RegistryTabs } from "./RegistryTabs.js";

type StatusFilter = "all" | "free" | "aggregated" | "written_off";

// StatusChip only defines ok/error/warn/info/neutral tones (see
// packages/ui/src/components/StatusChip.tsx) -- "free" (still scannable)
// maps to the positive "ok" tone, "aggregated" (currently inside a box) to
// the informational "info" tone, and "written_off" (terminal, out of
// circulation) to "warn" rather than "neutral" so it stays visually
// distinct from the "all" filter's absence of a chip entirely.
const STATUS_TO_CHIP: Record<Exclude<StatusFilter, "all">, StatusChipStatus> = {
  free: "ok",
  aggregated: "info",
  written_off: "warn",
};

type SearchErrorCode = "unrecognized" | "not_found" | "generic";

/**
 * Admin code-search page (Task 11): an exact-lookup box up top (SSCC or KM,
 * classified server-side via `GET /code-search`) plus a filterable code
 * registry table below it (`GET /code-search/codes`). The lookup box
 * navigates straight to the resolved entity's card (Task 12); the registry
 * table's row click does the same for whichever code the manager clicked on
 * directly, without going through the lookup box at all.
 */
export function CodeSearchPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [query, setQuery] = useState("");
  const [searchError, setSearchError] = useState<SearchErrorCode | null>(null);
  const [searching, setSearching] = useState(false);
  // Non-null only after a partial-SSCC search matched several boxes -- the
  // manager picks the right one from this list instead of being navigated.
  const [boxMatches, setBoxMatches] = useState<ClassifyBoxMatchDto[] | null>(null);

  const [from, setFrom] = useState<string | undefined>(undefined);
  const [to, setTo] = useState<string | undefined>(undefined);
  const [productionFrom, setProductionFrom] = useState<string | undefined>(undefined);
  const [productionTo, setProductionTo] = useState<string | undefined>(undefined);
  const [productId, setProductId] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);

  // "all": code search is a reporting surface — codes produced under a
  // now-archived product must stay findable by that product.
  const { data: productsData } = useProducts({ archived: "all" });

  const { data, isPending, isError } = useCodes({
    page,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(productionFrom ? { productionFrom } : {}),
    ...(productionTo ? { productionTo } : {}),
    ...(productId !== "all" ? { productId } : {}),
    ...(statusFilter !== "all" ? { status: statusFilter } : {}),
  });

  const items = data?.items ?? [];

  const productOptions: ComboboxOption[] = useMemo(
    () => [
      { value: "all", label: t("pages.codeSearch.filters.product.all") },
      ...(productsData ?? []).map((product) => ({ value: product.id, label: product.name })),
    ],
    [productsData, t],
  );

  const statusOptions: SelectOption<StatusFilter>[] = [
    { value: "all", label: t("pages.codeSearch.filters.status.all") },
    { value: "free", label: t("pages.codeSearch.status.free") },
    { value: "aggregated", label: t("pages.codeSearch.status.aggregated") },
    { value: "written_off", label: t("pages.codeSearch.status.written_off") },
  ];

  const columns: TableColumn<CodeListItemDto>[] = [
    {
      key: "code",
      title: t("pages.codeSearch.table.code"),
      mono: true,
      render: (row) => `01${row.gtin14}21${row.serial}`,
    },
    {
      key: "productName",
      title: t("pages.codeSearch.table.product"),
      render: (row) => row.productName ?? "—",
    },
    {
      key: "status",
      title: t("pages.codeSearch.table.status"),
      render: (row) => (
        <StatusChip
          status={STATUS_TO_CHIP[row.status]}
          label={t(`pages.codeSearch.status.${row.status}`)}
        />
      ),
    },
    {
      key: "box",
      title: t("pages.codeSearch.table.box"),
      mono: true,
      render: (row) =>
        row.boxId ? (
          <Link to={`/codes/box/${row.boxId}`} onClick={(event) => event.stopPropagation()}>
            {row.boxSscc ? formatSsccHri(row.boxSscc) : t("pages.codeSearch.boxCard.noSscc")}
          </Link>
        ) : (
          "—"
        ),
    },
    {
      key: "scannedAt",
      title: t("pages.codeSearch.table.scannedAt"),
      render: (row) => formatCreatedAt(row.scannedAt, i18n.language),
    },
    {
      key: "productionDate",
      title: t("pages.codeSearch.table.productionDate"),
      render: (row) => (row.productionDate ? formatDate(row.productionDate, i18n.language) : "—"),
    },
  ];

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;

    setSearchError(null);
    setBoxMatches(null);
    setSearching(true);
    classifySearch(q)
      .then((result) => {
        if (result.type === "code") {
          void navigate(`/codes/km/${result.codeHash}`);
        } else if (result.type === "box") {
          void navigate(`/codes/box/${result.boxId}`);
        } else {
          setBoxMatches(result.items);
        }
      })
      .catch((error: unknown) => {
        // Only a confirmed 404 with one of the two known codes maps to its
        // specific copy -- anything else (5xx, a network failure, or a 404
        // with an unexpected/missing code) is a genuine failure, not "we
        // understood your input and it just isn't there", so it gets the
        // same generic failure alert the registry section below already
        // uses rather than being mislabeled as "not found".
        if (
          error instanceof ApiRequestError &&
          error.status === 404 &&
          error.code === "unrecognized"
        ) {
          setSearchError("unrecognized");
        } else if (
          error instanceof ApiRequestError &&
          error.status === 404 &&
          error.code === "not_found"
        ) {
          setSearchError("not_found");
        } else {
          setSearchError("generic");
        }
      })
      .finally(() => setSearching(false));
  };

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader title={t("pages.codeSearch.title")} />

      <RegistryTabs active="codes" />

      <form onSubmit={handleSearch} style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
        <div style={{ flex: 1, maxWidth: 480 }}>
          <Input
            mono
            size="md"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("pages.codeSearch.searchPlaceholder")}
            aria-label={t("pages.codeSearch.searchPlaceholder")}
          />
        </div>
        <Button type="submit" loading={searching}>
          {t("pages.codeSearch.searchButton")}
        </Button>
      </form>

      {searchError && (
        <Alert tone="error">
          {searchError === "generic"
            ? t("common.loadError")
            : t(`pages.codeSearch.errors.${searchError}`)}
        </Alert>
      )}

      {boxMatches && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
            {t("pages.codeSearch.multipleBoxes")}
          </span>
          <ul
            style={{
              margin: 0,
              padding: 0,
              listStyle: "none",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {boxMatches.map((match) => (
              <li
                key={match.boxId}
                style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}
              >
                <Link to={`/codes/box/${match.boxId}`} style={{ font: "var(--text-body)" }}>
                  {formatSsccHri(match.sscc)}
                </Link>
                {match.productName && (
                  <span style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
                    {match.productName}
                  </span>
                )}
                <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
                  {match.closedAt
                    ? formatCreatedAt(match.closedAt, i18n.language)
                    : t("pages.codeSearch.boxCard.status.open")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ width: 180 }}>
          <DatePicker
            label={t("pages.codeSearch.filters.fromLabel")}
            {...(from !== undefined ? { value: from } : {})}
            onValueChange={(value) => {
              setFrom(value);
              setPage(1);
            }}
          />
        </div>
        <div style={{ width: 180 }}>
          <DatePicker
            label={t("pages.codeSearch.filters.toLabel")}
            {...(to !== undefined ? { value: to } : {})}
            onValueChange={(value) => {
              setTo(value);
              setPage(1);
            }}
          />
        </div>
        <div style={{ width: 180 }}>
          <DatePicker
            label={t("pages.codeSearch.filters.productionFromLabel")}
            {...(productionFrom !== undefined ? { value: productionFrom } : {})}
            onValueChange={(value) => {
              setProductionFrom(value);
              setPage(1);
            }}
          />
        </div>
        <div style={{ width: 180 }}>
          <DatePicker
            label={t("pages.codeSearch.filters.productionToLabel")}
            {...(productionTo !== undefined ? { value: productionTo } : {})}
            onValueChange={(value) => {
              setProductionTo(value);
              setPage(1);
            }}
          />
        </div>
        <div style={{ width: 260 }}>
          <Combobox
            label={t("pages.codeSearch.filters.productLabel")}
            options={productOptions}
            value={productId}
            onValueChange={(value) => {
              setProductId(value);
              setPage(1);
            }}
            placeholder={t("pages.codeSearch.filters.product.all")}
            searchPlaceholder={t("pages.codeSearch.filters.productSearchPlaceholder")}
            emptyText={t("pages.codeSearch.filters.productEmpty")}
            loadingText={t("common.loading")}
          />
        </div>
        <div style={{ width: 200 }}>
          <Select
            label={t("pages.codeSearch.filters.statusLabel")}
            options={statusOptions}
            value={statusFilter}
            onValueChange={(value) => {
              setStatusFilter(value);
              setPage(1);
            }}
          />
        </div>
      </div>

      {isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : isError ? (
        <Alert tone="error">{t("common.loadError")}</Alert>
      ) : items.length === 0 ? (
        <EmptyState title={t("pages.codeSearch.empty")} />
      ) : (
        <Table
          columns={columns}
          rows={items}
          getRowKey={(row) => row.codeHash}
          page={data?.page}
          pageCount={data?.pageCount}
          onPage={setPage}
          onRowClick={(row) => void navigate(`/codes/km/${row.codeHash}`)}
        />
      )}
    </div>
  );
}
