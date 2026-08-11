import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  Card,
  Pager,
  PageHeader,
  Spinner,
  StatusChip,
  Table,
  type TableColumn,
} from "@markiro/ui";

import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { getDefaultDemoPlan, listCatalogVersions, type CatalogVersionDto } from "./api.js";
import { CatalogVersionPanel } from "./CatalogVersionPanel.js";
import { CatalogCreatePanel } from "./CatalogCreatePanel.js";

type CatalogKind = CatalogVersionDto["kind"];

const CATALOG_PAGE_SIZE = 50;

const STATUS_TONE = {
  draft: "warn",
  published: "ok",
  retired: "neutral",
} as const;

export function CatalogPage() {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  const [activeKind, setActiveKind] = useState<CatalogKind>("plan");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const catalog = useQuery({
    queryKey: ["platform", "catalog"],
    queryFn: listCatalogVersions,
  });
  const defaultDemo = useQuery({
    queryKey: ["platform", "settings", "demo-plan"],
    queryFn: getDefaultDemoPlan,
  });
  const items = catalog.data?.items ?? [];
  const visibleItems = useMemo(
    () => items.filter((item) => item.kind === activeKind),
    [activeKind, items],
  );
  const pageCount = Math.max(1, Math.ceil(visibleItems.length / CATALOG_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedItems = visibleItems.slice(
    (currentPage - 1) * CATALOG_PAGE_SIZE,
    currentPage * CATALOG_PAGE_SIZE,
  );
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const isSupport = principal.role === "support";

  const columns: TableColumn<CatalogVersionDto>[] = [
    {
      key: "nameRu",
      title: t("catalog.columns.name"),
      render: (item) => (
        <button
          type="button"
          className="table-link"
          aria-label={t("catalog.openVersion", { name: item.nameRu, version: item.version })}
          onClick={() => setSelectedId(item.id)}
        >
          <span>{item.nameRu}</span>
          <small>{item.catalogItemCode}</small>
        </button>
      ),
    },
    { key: "version", title: t("catalog.columns.version"), mono: true },
    {
      key: "status",
      title: t("catalog.columns.status"),
      render: (item) => (
        <StatusChip status={STATUS_TONE[item.status]} label={t(`catalog.status.${item.status}`)} />
      ),
    },
    ...(isSupport
      ? []
      : [
          {
            key: "unitPrice",
            title: t("catalog.columns.price"),
            align: "right" as const,
            mono: true,
            render: (item: CatalogVersionDto) =>
              item.unitPrice ? t("catalog.money", { value: item.unitPrice }) : "—",
          },
        ]),
  ];

  if (catalog.isPending || defaultDemo.isPending) {
    return (
      <section className="catalog-page">
        <PageHeader title={t("catalog.title")} />
        <div className="catalog-state" role="status">
          <Spinner label={t("catalog.loading")} />
          <span>{t("catalog.loading")}</span>
        </div>
      </section>
    );
  }

  if (catalog.error || defaultDemo.error) {
    return (
      <section className="catalog-page">
        <PageHeader title={t("catalog.title")} />
        <Alert tone="error">{t("catalog.loadError")}</Alert>
      </section>
    );
  }

  const tabs: Array<{ kind: CatalogKind; label: string }> = [
    { kind: "plan", label: t("catalog.tabs.plan") },
    { kind: "addon", label: t("catalog.tabs.addon") },
    { kind: "service", label: t("catalog.tabs.service") },
  ];

  return (
    <section className="catalog-page">
      <PageHeader title={t("catalog.title")} />
      <div className="catalog-coordinate" aria-hidden="true">
        CATALOG / VERSION CONTROL / {activeKind.toUpperCase()}
      </div>
      {principal.capabilities.includes("catalog.write") ? (
        <div className="catalog-toolbar">
          <Button
            onClick={() => {
              setSelectedId(null);
              setCreating(true);
            }}
          >
            {t("catalog.create")}
          </Button>
        </div>
      ) : null}
      <Card className="catalog-frame" padding={0}>
        <div className="catalog-tabs" role="tablist" aria-label={t("catalog.groupLabel")}>
          {tabs.map((tab) => (
            <button
              key={tab.kind}
              type="button"
              role="tab"
              aria-label={tab.label}
              aria-selected={activeKind === tab.kind}
              onClick={() => {
                setActiveKind(tab.kind);
                setPage(1);
                setCreating(false);
                setSelectedId(null);
              }}
            >
              <span>{String(tabs.indexOf(tab) + 1).padStart(2, "0")}</span>
              {tab.label}
              <b>{items.filter((item) => item.kind === tab.kind).length}</b>
            </button>
          ))}
        </div>
        <Table
          columns={columns}
          rows={pagedItems}
          empty={t("catalog.empty")}
          onRowClick={(item) => {
            setCreating(false);
            setSelectedId(item.id);
          }}
        />
        {visibleItems.length > CATALOG_PAGE_SIZE ? (
          <Pager
            className="catalog-pagination"
            page={currentPage}
            pageCount={pageCount}
            onPageChange={setPage}
            ariaLabel={t("catalog.pagination.label")}
            previousLabel={t("catalog.pagination.previous")}
            nextLabel={t("catalog.pagination.next")}
            pageLabel={(activePage, count) =>
              t("catalog.pagination.page", { page: activePage, pageCount: count })
            }
          />
        ) : null}
      </Card>
      {selected ? (
        <CatalogVersionPanel
          key={selected.id}
          item={selected}
          canWrite={principal.capabilities.includes("catalog.write")}
          isSupport={isSupport}
          defaultDemoId={defaultDemo.data?.catalogVersionId ?? null}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
      {creating ? (
        <CatalogCreatePanel
          kind={activeKind}
          onClose={() => setCreating(false)}
          onCreated={(created) => setSelectedId(created.id)}
        />
      ) : null}
    </section>
  );
}
