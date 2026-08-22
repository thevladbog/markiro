import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  DataTabs,
  Pager,
  SectionHeader,
  Spinner,
  StatusChip,
  Table,
  type TableColumn,
} from "@markiro/ui";

import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { useNavigationGuard } from "../../layout/NavigationGuard.js";
import { getDefaultDemoPlan, listCatalogVersions, type CatalogVersionDto } from "./api.js";
import { CatalogVersionPanel } from "./CatalogVersionPanel.js";
import { CatalogCreatePanel } from "./CatalogCreatePanel.js";
import { CatalogDrawer } from "./CatalogDrawer.js";

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
  const [drawerDirty, setDrawerDirty] = useState(false);
  const pageGuard = useNavigationGuard(drawerDirty, false);
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
        <SectionHeader
          eyebrow="COMMERCE / CATALOG"
          title={t("catalog.title")}
          description={t("catalog.description")}
        />
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
        <SectionHeader
          eyebrow="COMMERCE / CATALOG"
          title={t("catalog.title")}
          description={t("catalog.description")}
        />
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
      <SectionHeader
        eyebrow="COMMERCE / CATALOG"
        title={t("catalog.title")}
        description={t("catalog.description")}
        actionsLabel={t("catalog.actionsLabel")}
        actions={
          principal.capabilities.includes("catalog.write") ? (
            <Button
              onClick={() =>
                pageGuard.requestProtectedAction(() => {
                  setSelectedId(null);
                  setDrawerDirty(false);
                  setCreating(true);
                })
              }
            >
              {t("catalog.create")}
            </Button>
          ) : null
        }
      />
      <section className="commerce-ledger catalog-frame" aria-labelledby="catalog-ledger-title">
        <header className="commerce-ledger__header">
          <div>
            <span className="commerce-ledger__eyebrow">VERSION CONTROL</span>
            <h2 id="catalog-ledger-title">{t("catalog.registryTitle")}</h2>
          </div>
          <span className="commerce-ledger__count">{visibleItems.length}</span>
        </header>
        <DataTabs
          className="catalog-data-tabs"
          label={t("catalog.groupLabel")}
          activeId={activeKind}
          items={tabs.map((tab) => ({
            id: tab.kind,
            label: tab.label,
            count: items.filter((item) => item.kind === tab.kind).length,
          }))}
          onChange={(id) =>
            pageGuard.requestProtectedAction(() => {
              setActiveKind(id as CatalogKind);
              setPage(1);
              setCreating(false);
              setDrawerDirty(false);
              setSelectedId(null);
            })
          }
        />
        <Table
          columns={columns}
          rows={pagedItems}
          empty={t("catalog.empty")}
          onRowClick={(item) => {
            pageGuard.requestProtectedAction(() => {
              setCreating(false);
              setDrawerDirty(false);
              setSelectedId(item.id);
            });
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
      </section>
      {selected ? (
        <CatalogDrawer
          title={t("catalog.panelLabel", { version: selected.version, name: selected.nameRu })}
          dirty={drawerDirty}
          busy={false}
          closeLabel={t("catalog.closePanel")}
          onClose={() => {
            setSelectedId(null);
            setDrawerDirty(false);
          }}
        >
          <CatalogVersionPanel
            key={selected.id}
            item={selected}
            canWrite={principal.capabilities.includes("catalog.write")}
            isSupport={isSupport}
            defaultDemoId={defaultDemo.data?.catalogVersionId ?? null}
            onClose={() => setSelectedId(null)}
            onVersionCreated={(created) => setSelectedId(created.id)}
            onDirtyChange={setDrawerDirty}
          />
        </CatalogDrawer>
      ) : null}
      {creating ? (
        <CatalogDrawer
          title={t("catalog.createTitle")}
          dirty={drawerDirty}
          busy={false}
          closeLabel={t("catalog.closePanel")}
          onClose={() => {
            setCreating(false);
            setDrawerDirty(false);
          }}
        >
          <CatalogCreatePanel
            kind={activeKind}
            onClose={() => setCreating(false)}
            onCreated={(created) => setSelectedId(created.id)}
            onDirtyChange={setDrawerDirty}
          />
        </CatalogDrawer>
      ) : null}
    </section>
  );
}
