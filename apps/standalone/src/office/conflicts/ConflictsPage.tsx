import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";

import {
  Alert,
  Button,
  Card,
  FilterBar,
  PageHeader,
  Select,
  StatusChip,
  Table,
  type TableColumn,
} from "@markiro/ui";

import type { OfficeConflict, OfficeConflictScan } from "../../host/review.js";
import { useCan } from "../access.js";
import { instantFormat, type FormatInstant } from "../codes/CodeCard.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";
import { formTimeZone } from "../forms/render-form.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { OfficePager } from "../OfficePager.js";
import { LoadError, PageLoading, WriteFailureAlert } from "../page-state.js";
import { searchableSelect } from "../select-search.js";
import { ssccText } from "../shifts/shift-card.js";
import {
  conflictQuery,
  loserBoxLink,
  readPage,
  readReviewed,
  REVIEWED_FILTERS,
  type ReviewedFilter,
} from "./conflict-list.js";

/** Counts with the thousands apart by a no-break space: «10 000». */
const COUNT = new Intl.NumberFormat("ru");

/**
 * «Конфликты» (plan КНФ, the cloud's `/conflicts`): two accepted scans of one
 * code, the earlier won it. Newest detection first, a page of 50, narrowed by
 * the losing shift and by review — unreviewed by default, as the cloud — all
 * in the address, so «Назад» and a link from a shift's card find it again.
 * Each row names the code by GTIN and serial (never the full code), what
 * happened, both scans — shift, station, operator, the instant to the second
 * in the organization's zone, the box — and links the loser's box.
 * «Отметить разобранным» (both roles) marks it once; the notice takes the
 * focus, and every list of conflicts reads again.
 */
export function ConflictsPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const shiftId = params.get("shift") ?? "";
  const reviewed = readReviewed(params.get("state"));
  const page = readPage(params.get("page"));
  const query = conflictQuery(shiftId, reviewed, page);
  const canReview = useCan("reviewConflicts");
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const noticeId = useId();
  const conflicts = useOfficeQuery(officeKeys.conflictList(query), (api, token) =>
    api.listConflicts(token, query),
  );
  const shifts = useOfficeQuery(officeKeys.shiftList(null), (api, token) => api.listShifts(token));
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const review = useOfficeMutation((api, token, id: string) => api.reviewConflict(token, id));
  const at = instantFormat(formTimeZone(org.data));

  useEffect(() => {
    if (notice !== null) document.getElementById(noticeId)?.focus();
  }, [notice, noticeId]);

  const setFilter = (next: { shift?: string; state?: ReviewedFilter; page?: number }) => {
    // A notice or a refusal is about the list it was given on.
    setNotice(null);
    setFailure(null);
    const merged = new URLSearchParams(params);
    if (next.shift !== undefined) merged.set("shift", next.shift);
    if (next.state !== undefined) merged.set("state", next.state);
    merged.set("page", String(next.page ?? 1));
    for (const [key, value] of [...merged.entries()]) {
      if (
        value === "" ||
        (key === "state" && value === "unreviewed") ||
        (key === "page" && value === "1")
      ) {
        merged.delete(key);
      }
    }
    setParams(merged);
  };

  const onReview = (conflict: OfficeConflict) => {
    setFailure(null);
    setNotice(null);
    review.mutate(conflict.id, {
      onSuccess: () => {
        setNotice(t("office.conflicts.reviewedNotice", { serial: conflict.serial }));
        void queryClient.invalidateQueries({ queryKey: officeKeys.conflicts });
      },
      onError: (error) => setFailure(alertFailure(error)),
    });
  };

  // A shift a link named that the list does not hold — or a list that did not load yet or at
  // all: the select must still show what the page is narrowed to, never «Все смены».
  const linkedShiftUnknown =
    shiftId !== "" && !(shifts.data?.some((s) => s.id === shiftId) ?? false);
  const shiftOptions = [
    { value: "", label: t("office.conflicts.filters.shiftAll") },
    ...(shifts.data ?? []).map((shift) => ({ value: shift.id, label: shift.number })),
    ...(linkedShiftUnknown
      ? [{ value: shiftId, label: t("office.conflicts.filters.shiftLinked") }]
      : []),
  ];

  const columns: TableColumn<OfficeConflict>[] = [
    {
      key: "code",
      title: t("office.conflicts.table.code"),
      mono: true,
      wrap: true,
      render: (row) => t("office.conflicts.code", { gtin: row.gtin14, serial: row.serial }),
    },
    {
      key: "kind",
      title: t("office.conflicts.table.kind"),
      wrap: true,
      render: (row) => t(`office.conflicts.kinds.${row.kind}`),
    },
    {
      key: "loser",
      title: t("office.conflicts.table.loser"),
      wrap: true,
      render: (row) => (
        <span className="shift-cell">
          <ScanCell scan={row.loser} at={at} />
          <Link
            to={loserBoxLink(row.loser)}
            aria-label={
              row.loser.boxId === null
                ? t("office.conflicts.loserBoxNamed", {
                    serial: row.serial,
                    number: row.loser.shiftNumber,
                  })
                : t("office.conflicts.loserBoxCardNamed", { serial: row.serial })
            }
          >
            {t("office.conflicts.loserBox")}
          </Link>
        </span>
      ),
    },
    {
      key: "winner",
      title: t("office.conflicts.table.winner"),
      wrap: true,
      render: (row) => <ScanCell scan={row.winner} at={at} />,
    },
    {
      key: "detected",
      title: t("office.conflicts.table.detected"),
      wrap: true,
      render: (row) => at(row.detectedAt),
    },
    {
      key: "state",
      title: t("office.conflicts.table.state"),
      wrap: true,
      render: (row) =>
        row.reviewedAt !== null ? (
          <span className="shift-cell">
            <StatusChip phase="done" label={t("office.conflicts.reviewed")} />
            <span className="shift-cell__quiet">
              {t("office.conflicts.reviewedBy", {
                name: row.reviewedByName ?? t("office.common.none"),
                at: at(row.reviewedAt),
              })}
            </span>
          </span>
        ) : (
          <span className="shift-cell">
            <StatusChip phase="attention" label={t("office.conflicts.unreviewed")} />
            {canReview && (
              <Button
                variant="secondary"
                size="compact"
                // Also while the list reads again after a review: its row is still on screen.
                disabled={review.isPending || (review.isSuccess && conflicts.isFetching)}
                aria-label={t("office.conflicts.reviewNamed", { serial: row.serial })}
                onClick={() => onReview(row)}
              >
                {t("office.conflicts.review")}
              </Button>
            )}
          </span>
        ),
    },
  ];

  const filtered = shiftId !== "" || reviewed !== "unreviewed";
  const content = () => {
    // The instants are the organization's: the rows wait for its zone.
    if (conflicts.isPending || org.isPending) return <PageLoading />;
    if (conflicts.isError) {
      return <LoadError error={conflicts.error} onRetry={() => void conflicts.refetch()} />;
    }
    const data = conflicts.data;
    return (
      <Card>
        <Table
          columns={columns}
          rows={data.items}
          getRowKey={(row) => row.id}
          empty={t(filtered ? "office.conflicts.emptyFiltered" : "office.conflicts.empty")}
          scrollLabel={t("office.conflicts.table.label")}
        />
        {data.pageCount > 1 && (
          <OfficePager
            label={t("office.conflicts.pager")}
            page={data.page}
            pageCount={data.pageCount}
            onPage={(next) => setFilter({ page: next })}
          />
        )}
      </Card>
    );
  };

  return (
    <div className="office-stack">
      <PageHeader title={t("office.conflicts.title")} />
      <p className="office-note">{t("office.conflicts.intro")}</p>
      {notice !== null && (
        <Alert tone="ok" id={noticeId} tabIndex={-1}>
          {notice}
        </Alert>
      )}
      <WriteFailureAlert failure={failure} />
      <FilterBar
        label={t("office.conflicts.filters.label")}
        resultSummary={
          conflicts.isSuccess
            ? t("office.conflicts.found", { total: COUNT.format(conflicts.data.total) })
            : ""
        }
        {...(filtered
          ? {
              resetLabel: t("office.conflicts.filters.reset"),
              onReset: () => {
                setNotice(null);
                setFailure(null);
                setParams(new URLSearchParams());
              },
            }
          : {})}
      >
        <Select
          {...searchableSelect(t)}
          label={t("office.conflicts.filters.shift")}
          hint={t("office.conflicts.filters.shiftHint")}
          options={shiftOptions}
          value={shiftId}
          onValueChange={(value) => setFilter({ shift: value })}
        />
        <Select
          label={t("office.conflicts.filters.reviewed")}
          options={REVIEWED_FILTERS.map((value) => ({
            value,
            label: t(`office.conflicts.filters.reviewedOptions.${value}`),
          }))}
          value={reviewed}
          onValueChange={(value) => setFilter({ state: readReviewed(value) })}
        />
      </FilterBar>
      {content()}
    </div>
  );
}

/** One side of a conflict: its shift (a link to its card), station, operator, instant and box. */
function ScanCell({ scan, at }: { scan: OfficeConflictScan; at: FormatInstant }) {
  const { t } = useTranslation();
  const box =
    scan.boxId === null
      ? t("office.conflicts.scan.noBox")
      : scan.boxSscc === null
        ? t("office.conflicts.scan.openBox")
        : t("office.conflicts.scan.box", { sscc: ssccText(scan.boxSscc) });
  return (
    <span className="shift-cell">
      <Link to={`/shifts/${scan.shiftId}`}>
        {t("office.conflicts.scan.shift", { number: scan.shiftNumber })}
      </Link>
      <span>{scan.deviceName}</span>
      <span className="shift-cell__quiet">
        {scan.operatorName === null
          ? t("office.conflicts.scan.noOperator")
          : t("office.conflicts.scan.operator", { name: scan.operatorName })}
      </span>
      <span className="shift-cell__quiet">{at(scan.scannedAt)}</span>
      <span className="shift-cell__quiet">{box}</span>
    </span>
  );
}
