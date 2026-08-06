import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useNavigate } from "react-router";

import {
  Alert,
  Button,
  ConfirmDialog,
  EmptyState,
  FilterBar,
  RowActions,
  Select,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { SelectOption, StatusChipStatus, TableColumn } from "@markiro/ui";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { formatCreatedAt } from "../../lib/datetime.js";
import { toast } from "../../lib/toast.js";
import type { KiosksPanelContext, KiosksPanelLocationState } from "./KioskPanelRoute.js";
import { KiosksLayout } from "./KiosksLayout.js";
import { useArchiveKiosk, useKiosks, type KioskDto } from "./api.js";
import {
  formatRelativeLastSeen,
  getKioskOperationalState,
  type KioskOperationalState,
  type KioskStateFilter,
} from "./kioskState.js";
import "./kiosks.css";

const STATE_TO_CHIP: Record<KioskOperationalState, StatusChipStatus> = {
  archived: "neutral",
  "awaiting-pairing": "warn",
  online: "ok",
  offline: "neutral",
};

const TABLE_SKELETON_COLUMNS = ["identity", "state", "activity", "limit", "prices", "actions"];
const TABLE_SKELETON_ROWS = ["first", "second", "third"];

function KiosksTableSkeleton({ label }: { label: string }) {
  return (
    <div
      className="mk-kiosks-table-skeleton"
      role="status"
      aria-label={label}
      aria-live="polite"
      aria-busy="true"
    >
      <span className="mk-visually-hidden">{label}</span>
      <div className="mk-kiosks-table-skeleton__scroll" aria-hidden="true">
        <table>
          <thead>
            <tr>
              {TABLE_SKELETON_COLUMNS.map((column) => (
                <th key={column}>
                  <span />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TABLE_SKELETON_ROWS.map((row) => (
              <tr key={row}>
                {TABLE_SKELETON_COLUMNS.map((column) => (
                  <td key={column}>
                    <span />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AuthorizedCreateKioskAction() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <Button
      type="button"
      onClick={() =>
        void navigate("new", {
          state: { kiosksBackground: true } satisfies KiosksPanelLocationState,
        })
      }
    >
      {t("pages.kiosks.addAction")}
    </Button>
  );
}

function AuthorizedKioskRowActions({ kiosk }: { kiosk: KioskDto }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const archiveMutation = useArchiveKiosk();
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const handleArchive = async () => {
    try {
      setArchiveError(null);
      await archiveMutation.mutateAsync(kiosk.id);
      toast("ok", t("pages.kiosks.toasts.archiveSuccess"));
      setArchiving(false);
    } catch (error) {
      setArchiveError(
        error instanceof ApiRequestError ? error.message : t("pages.kiosks.archivePersistentError"),
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
            void navigate(`${kiosk.id}/edit`, {
              state: { kiosksBackground: true } satisfies KiosksPanelLocationState,
            })
          }
        >
          {t("pages.kiosks.edit")}
        </Button>
        {kiosk.status === "active" ? (
          <Button
            type="button"
            size="compact"
            variant="destructive"
            onClick={() => {
              setArchiveError(null);
              setArchiving(true);
            }}
          >
            {t("pages.kiosks.archive")}
          </Button>
        ) : null}
      </RowActions>
      <ConfirmDialog
        open={archiving}
        title={t("pages.kiosks.archiveConfirmTitle")}
        description={t("pages.kiosks.archiveConfirmBody", { name: kiosk.name })}
        entity={kiosk.name}
        error={archiveError}
        cancelLabel={t("pages.kiosks.cancel")}
        confirmLabel={t("pages.kiosks.archiveConfirmAction")}
        tone="destructive"
        busy={archiveMutation.isPending}
        onCancel={() => {
          if (archiveMutation.isPending) return;
          setArchiving(false);
          setArchiveError(null);
        }}
        onConfirm={() => void handleArchive()}
      />
    </>
  );
}

/**
 * Admin kiosk settings screen -- Plan A Task 17
 * (list/create/edit/pair/archive). Mirrors
 * `../employees/index.tsx`'s active/archived +
 * confirm-modal pattern (Task 16) for the kiosk lifecycle, and
 */
export function KiosksPage() {
  const { t, i18n } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const canManageCredentials = useCan(CABINET_CAPABILITY.CREDENTIALS_MANAGE);
  const { data, isPending, isError, refetch } = useKiosks();
  const [stateFilter, setStateFilter] = useState<KioskStateFilter>("all");
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const items = useMemo(() => data ?? [], [data]);
  const kiosksResolved = data !== undefined;
  const visibleItems = useMemo(
    () =>
      items.filter(
        (kiosk) => stateFilter === "all" || getKioskOperationalState(kiosk, nowMs) === stateFilter,
      ),
    [items, nowMs, stateFilter],
  );
  const stateOptions: SelectOption<KioskStateFilter>[] = [
    { value: "all", label: t("pages.kiosks.filters.state.all") },
    { value: "awaiting-pairing", label: t("pages.kiosks.states.awaiting-pairing") },
    { value: "online", label: t("pages.kiosks.states.online") },
    { value: "offline", label: t("pages.kiosks.states.offline") },
    { value: "archived", label: t("pages.kiosks.states.archived") },
  ];

  const columns: TableColumn<KioskDto>[] = useMemo(
    () => [
      {
        key: "name",
        title: t("pages.kiosks.table.name"),
        render: (row) => (
          <div className="mk-kiosk-identity">
            <span className="mk-kiosk-identity__name">{row.name}</span>
            <span className="mk-kiosk-identity__location">{row.location ?? "—"}</span>
          </div>
        ),
      },
      {
        key: "state",
        title: t("pages.kiosks.table.state"),
        render: (row) => {
          const state = getKioskOperationalState(row, nowMs);
          return (
            <StatusChip status={STATE_TO_CHIP[state]} label={t(`pages.kiosks.states.${state}`)} />
          );
        },
      },
      {
        key: "lastSeenAt",
        title: t("pages.kiosks.table.lastActivity"),
        render: (row) =>
          row.lastSeenAt ? (
            <div className="mk-kiosk-activity">
              <time
                dateTime={row.lastSeenAt}
                title={formatCreatedAt(row.lastSeenAt, i18n.language)}
              >
                {formatRelativeLastSeen(row.lastSeenAt, nowMs, i18n.language)}
              </time>
              <span className="mk-kiosk-activity__label">{t("pages.kiosks.lastActivity")}</span>
            </div>
          ) : (
            <span className="mk-kiosk-activity__label">{t("pages.kiosks.neverActivity")}</span>
          ),
      },
      {
        key: "dayLimitPerEmployee",
        title: t("pages.kiosks.table.dayLimit"),
        align: "right",
        mono: true,
        render: (row) => <span className="mk-kiosk-day-limit">{row.dayLimitPerEmployee}</span>,
      },
      {
        key: "showPrices",
        title: t("pages.kiosks.table.showPrices"),
        render: (row) => (row.showPrices ? t("common.yes") : t("common.no")),
      },
      {
        key: "actions",
        title: t("pages.kiosks.table.actions"),
        align: "right",
        render: (row) => (
          <div className="mk-kiosk-row-actions">
            {canWrite ? <AuthorizedKioskRowActions kiosk={row} /> : null}
            {row.status === "active" && canManageCredentials ? (
              <KioskPairingAction kiosk={row} />
            ) : null}
          </div>
        ),
      },
    ],
    [t, i18n.language, canWrite, canManageCredentials, nowMs],
  );

  return (
    <KiosksLayout actions={canWrite ? <AuthorizedCreateKioskAction /> : null}>
      <FilterBar
        label={t("pages.kiosks.filters.label")}
        resultSummary={
          !isPending && !isError
            ? t("pages.kiosks.resultCount", { count: visibleItems.length })
            : ""
        }
        {...(stateFilter !== "all"
          ? { resetLabel: t("pages.kiosks.filters.reset"), onReset: () => setStateFilter("all") }
          : {})}
      >
        <Select
          className="mk-kiosks-filter--state"
          label={t("pages.kiosks.filters.stateLabel")}
          value={stateFilter}
          options={stateOptions}
          onValueChange={setStateFilter}
        />
      </FilterBar>

      {isPending ? (
        <KiosksTableSkeleton label={t("common.loading")} />
      ) : isError ? (
        <div className="mk-kiosks-section-state">
          <Alert tone="error">{t("common.loadError")}</Alert>
          <div>
            <Button type="button" variant="secondary" onClick={() => void refetch()}>
              {t("pages.kiosks.retry")}
            </Button>
          </div>
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title={t("pages.kiosks.emptyTitle")}
          hint={t("pages.kiosks.emptyHint")}
          action={canWrite ? <AuthorizedCreateKioskAction /> : null}
        />
      ) : visibleItems.length === 0 ? (
        <EmptyState
          title={t("pages.kiosks.filteredEmptyTitle")}
          hint={t("pages.kiosks.filteredEmptyHint")}
        />
      ) : (
        <Table columns={columns} rows={visibleItems} />
      )}
      <Outlet
        context={
          {
            kiosks: items,
            kiosksPending: isPending,
            kiosksError: isError,
            kiosksResolved,
            retryPanelData: async () => {
              await refetch();
            },
          } satisfies KiosksPanelContext
        }
      />
    </KiosksLayout>
  );
}

function KioskPairingAction({ kiosk }: { kiosk: KioskDto }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <Button
      type="button"
      size="compact"
      variant="secondary"
      onClick={() =>
        void navigate(`${kiosk.id}/pair`, {
          state: { kiosksBackground: true } satisfies KiosksPanelLocationState,
        })
      }
    >
      {t("pages.kiosks.pairing.action")}
    </Button>
  );
}
