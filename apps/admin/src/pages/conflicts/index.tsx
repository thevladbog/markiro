import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Badge, Button, EmptyState, PageHeader, Select, Spinner, Table } from "@markiro/ui";
import type { SelectOption, TableColumn } from "@markiro/ui";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { formatCreatedAt, formatScanTime } from "../../lib/datetime.js";
import { toast } from "../../lib/toast.js";
import { useShifts, type ShiftDto } from "../shifts/api.js";
import { useConflicts, useReviewConflict, type ConflictDto } from "./api.js";

type ReviewedFilter = "unreviewed" | "reviewed" | "all";

/**
 * Cabinet-only backstop for the conflict class a station never learns it
 * lost: the losing terminal's batch was already acknowledged, so the server
 * deliberately never tells that device -- `code_conflicts` (and this view)
 * is the only record a human ever sees of it. See 06b Task 7's brief and
 * `apps/api/src/modules/conflicts/conflicts.controller.ts`.
 *
 * The losing/winning scan times are rendered at second precision
 * (`formatScanTime`, not the shared `formatCreatedAt`) because a conflict is
 * by construction two scans of the same code seconds apart -- at minute
 * precision the two columns a manager is here to compare would read
 * identically. The shift filter/column both key off the *losing* shift
 * (`ConflictsService.listConflicts`'s indexed, deliberately losing-only
 * `shiftId` match) -- see that service for what this excludes.
 */
export function ConflictsPage() {
  const { t, i18n } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);

  const [shiftFilter, setShiftFilter] = useState<string>("all");
  // Defaults to "unreviewed": without this, the list keeps every conflict
  // ever detected, reviewed or not, forever -- so "mark reviewed" changed
  // only a badge and the list never got shorter. See the spec's testing
  // note: this view lists *unresolved* conflicts for a shift.
  const [reviewedFilter, setReviewedFilter] = useState<ReviewedFilter>("unreviewed");

  const { data, isPending, isError } = useConflicts({
    ...(shiftFilter !== "all" ? { shiftId: shiftFilter } : {}),
    ...(reviewedFilter !== "all" ? { reviewed: reviewedFilter === "reviewed" } : {}),
  });
  const { data: shiftsData } = useShifts();
  const items = data ?? [];
  const shifts = shiftsData ?? [];

  const shiftsById = useMemo(() => new Map(shifts.map((shift) => [shift.id, shift])), [shifts]);

  // `GET /shifts` orders oldest-first (`createdAt` ascending -- see
  // ShiftsService.listShifts), so the shift a manager is currently closing
  // would otherwise sit at the bottom of a long list. The filter dropdown
  // reverses that for its own display purposes only; `shiftsById` above
  // keeps the server's order since lookup doesn't care about it.
  const shiftFilterOptions: SelectOption[] = useMemo(
    () => [
      { value: "all", label: t("pages.conflicts.filters.shiftAll") },
      ...[...shifts].reverse().map((shift) => ({ value: shift.id, label: shiftLabel(shift) })),
    ],
    [t, shifts],
  );

  const reviewedFilterOptions: SelectOption[] = useMemo(
    () => [
      { value: "unreviewed", label: t("pages.conflicts.filters.reviewed.unreviewed") },
      { value: "reviewed", label: t("pages.conflicts.filters.reviewed.reviewed") },
      { value: "all", label: t("pages.conflicts.filters.reviewed.all") },
    ],
    [t],
  );

  const baseColumns: TableColumn<ConflictDto>[] = useMemo(
    () => [
      {
        key: "codeHash",
        title: t("pages.conflicts.table.code"),
        mono: true,
        render: (row) => <span title={row.codeHash}>{truncateHash(row.codeHash)}</span>,
      },
      {
        key: "shift",
        title: t("pages.conflicts.table.shift"),
        render: (row) => {
          const shift = shiftsById.get(row.losingShiftId);
          return (
            <span title={row.losingShiftId}>{shift ? shiftLabel(shift) : row.losingShiftId}</span>
          );
        },
      },
      {
        key: "losing",
        title: t("pages.conflicts.table.losing"),
        render: (row) => (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span>{row.losingTerminalId ?? "—"}</span>
            <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
              {formatScanTime(row.losingScannedAt, i18n.language)}
            </span>
          </div>
        ),
      },
      {
        key: "winning",
        title: t("pages.conflicts.table.winning"),
        render: (row) => (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span>{row.winningTerminalId ?? "—"}</span>
            <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
              {formatScanTime(row.winningScannedAt, i18n.language)}
            </span>
          </div>
        ),
      },
      {
        key: "detectedAt",
        title: t("pages.conflicts.table.detected"),
        render: (row) => formatCreatedAt(row.detectedAt, i18n.language),
      },
    ],
    [t, i18n.language, shiftsById],
  );

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader title={t("pages.conflicts.title")} />

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
        <div style={{ width: 260 }}>
          <Select
            label={t("pages.conflicts.filters.shiftLabel")}
            options={shiftFilterOptions}
            value={shiftFilter}
            hint={t("pages.conflicts.filters.shiftHint")}
            onChange={(value) => setShiftFilter(value)}
          />
        </div>
        <div style={{ width: 200 }}>
          <Select
            label={t("pages.conflicts.filters.reviewedLabel")}
            options={reviewedFilterOptions}
            value={reviewedFilter}
            onChange={(value) => setReviewedFilter(value as ReviewedFilter)}
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
        <EmptyState title={t("pages.conflicts.empty")} />
      ) : canWrite ? (
        <AuthorizedConflictsTable baseColumns={baseColumns} rows={items} />
      ) : (
        <ConflictsTable baseColumns={baseColumns} rows={items} />
      )}
    </div>
  );
}

interface ConflictsTableProps {
  baseColumns: TableColumn<ConflictDto>[];
  rows: ConflictDto[];
  onReview?: (id: string) => Promise<void>;
  pendingReviewId?: string;
}

function ConflictsTable({ baseColumns, rows, onReview, pendingReviewId }: ConflictsTableProps) {
  const { t } = useTranslation();

  const columns: TableColumn<ConflictDto>[] = [
    ...baseColumns,
    {
      key: "actions",
      title: t("pages.conflicts.table.actions"),
      align: "right",
      render: (row) =>
        row.reviewedAt ? (
          <Badge tone="neutral">{t("pages.conflicts.reviewed")}</Badge>
        ) : onReview ? (
          <Button
            type="button"
            size="compact"
            variant="secondary"
            loading={pendingReviewId === row.id}
            onClick={() => void onReview(row.id)}
          >
            {t("pages.conflicts.review")}
          </Button>
        ) : null,
    },
  ];

  return <Table columns={columns} rows={rows} />;
}

function AuthorizedConflictsTable({
  baseColumns,
  rows,
}: Pick<ConflictsTableProps, "baseColumns" | "rows">) {
  const { t } = useTranslation();
  const reviewMutation = useReviewConflict();

  const handleReview = async (id: string) => {
    try {
      await reviewMutation.mutateAsync(id);
      toast("ok", t("pages.conflicts.toasts.reviewSuccess"));
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError ? error.message : t("pages.conflicts.toasts.reviewError"),
      );
    }
  };

  return (
    <ConflictsTable
      baseColumns={baseColumns}
      rows={rows}
      onReview={handleReview}
      {...(reviewMutation.isPending ? { pendingReviewId: reviewMutation.variables } : {})}
    />
  );
}

/** Short, human-identifiable label for a shift filter option / shift column cell. */
function shiftLabel(shift: ShiftDto): string {
  if (shift.plannedDate && shift.productName) return `${shift.plannedDate} — ${shift.productName}`;
  return shift.productName ?? shift.plannedDate ?? shift.id;
}

/**
 * `codeHash` is a 64-char hex string that would otherwise dominate the
 * table's width -- shown truncated with the full value in the cell's
 * `title` (see the `codeHash` column's render above).
 */
function truncateHash(hash: string): string {
  if (hash.length <= 18) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}
