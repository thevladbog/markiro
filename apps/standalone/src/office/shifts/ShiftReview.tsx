import type { UseQueryResult } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Card, StatusChip, Table, type TableColumn } from "@markiro/ui";

import { FACT_KINDS, FACT_RECEIPT_CODES, type OfficeShift } from "../../host/protocol.js";
import type {
  ConflictQuery,
  OfficeConflict,
  OfficeShiftException,
  OfficeShiftRejection,
} from "../../host/review.js";
import { conflictKindKey } from "../conflicts/conflict-list.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { OfficePager } from "../OfficePager.js";
import { LoadError, PageLoading } from "../page-state.js";
import { BOX_PAGE_SIZE, ssccText } from "./shift-card.js";

/**
 * A shift's review on its card (plan КНФ, pilot spec §7): the exceptions its
 * stations sent, the records of it the host refused and the code conflicts
 * its scans lost. Each section reads on its own, so one that does not load
 * leaves the others; each lists at most the host's newest 500 and pages
 * them by 50.
 */
export interface ReviewSectionProps {
  shift: OfficeShift;
  /** An instant in the organization's zone, or «—». */
  at: (instant: string | null) => string;
}

const RECEIPT_CODES: ReadonlySet<string> = new Set(FACT_RECEIPT_CODES);
const RECORD_KINDS: ReadonlySet<string> = new Set(FACT_KINDS);

/** Counts with the thousands apart by a no-break space: «1 200». */
const COUNT = new Intl.NumberFormat("ru");

/** A refusal's code in the station's words (`floor.queue.code.*`); a code a newer host adds, as itself. */
function refusalText(code: string, t: TFunction): string {
  return RECEIPT_CODES.has(code)
    ? t(`floor.queue.code.${code}`)
    : t("floor.queue.code.other", { code });
}

/** A refused record's kind in the station's words; a kind a newer host adds, as unknown. */
function recordKindText(kind: string | null, t: TFunction): string {
  return kind !== null && RECORD_KINDS.has(kind)
    ? t(`floor.queue.kind.${kind}`)
    : t("office.shiftCard.review.rejections.unknownKind");
}

/** An exception's reason in the station's words; `other` with the words the operator typed. */
function reasonText(item: OfficeShiftException, t: TFunction): string {
  // An office disassembly carries its document's reason as plain words.
  if (item.source === "office") return item.reasonText ?? t("office.common.none");
  if (item.reasonCode === null) return t("office.common.none");
  const list = item.kind === "reprint" ? "reprint" : "disassemble";
  const reason = t(`floor.exceptions.reasons.${list}.${item.reasonCode}`, {
    defaultValue: item.reasonCode,
  });
  return item.reasonText === null
    ? reason
    : t("office.shiftCard.review.exceptions.reasonWords", { reason, words: item.reasonText });
}

/** The field a refused record's `invalid_record` names, when it names one. */
function refusedField(details: OfficeShiftRejection["details"]): string | null {
  const field = details?.["field"];
  return typeof field === "string" ? field : null;
}

interface ReviewSectionShellProps<T> {
  title: string;
  query: UseQueryResult<{ items: T[]; total: number }, Error>;
  columns: TableColumn<T>[];
  rowKey: (row: T) => string;
  empty: string;
  tableLabel: string;
  /** What stands under the title: a hint, a summary, a link. */
  intro?: ReactNode;
}

/**
 * One section of the review: its title, what stands under it, then the
 * table — waiting, a failure with «Повторить», or the rows by 50 with
 * «Показаны последние N из M» when the host answered fewer than it counted.
 */
function ReviewSection<T>({
  title,
  query,
  columns,
  rowKey,
  empty,
  tableLabel,
  intro,
}: ReviewSectionShellProps<T>) {
  const { t } = useTranslation();
  const titleId = useId();
  const [page, setPage] = useState(1);
  const content = () => {
    if (query.isPending) return <PageLoading />;
    if (query.isError) {
      return <LoadError error={query.error} onRetry={() => void query.refetch()} />;
    }
    const { items, total } = query.data;
    const pageCount = Math.max(1, Math.ceil(items.length / BOX_PAGE_SIZE));
    const shown = Math.min(page, pageCount);
    return (
      <>
        {total > items.length && (
          <p className="office-note">
            {t("office.shiftCard.review.limited", {
              shown: COUNT.format(items.length),
              total: COUNT.format(total),
            })}
          </p>
        )}
        <Table
          columns={columns}
          rows={items.slice((shown - 1) * BOX_PAGE_SIZE, shown * BOX_PAGE_SIZE)}
          getRowKey={rowKey}
          empty={empty}
          scrollLabel={tableLabel}
        />
        {pageCount > 1 && (
          <OfficePager
            label={t("office.shiftCard.review.pager", { title })}
            page={shown}
            pageCount={pageCount}
            onPage={setPage}
          />
        )}
      </>
    );
  };
  return (
    <section className="shift-card__section" aria-labelledby={titleId}>
      <h2 id={titleId}>{title}</h2>
      <Card>
        {intro}
        {content()}
      </Card>
    </section>
  );
}

/** The shift's exceptions as the stations sent them, newest first (plan КНФ). */
export function ShiftExceptions({ shift, at }: ReviewSectionProps) {
  const { t } = useTranslation();
  const list = useOfficeQuery(officeKeys.shiftExceptions(shift.id), (api, token) =>
    api.listShiftExceptions(token, shift.id),
  );
  const columns: TableColumn<OfficeShiftException>[] = [
    {
      key: "when",
      title: t("office.shiftCard.review.exceptions.when"),
      wrap: true,
      minWidth: 150,
      render: (item) => at(item.occurredAt),
    },
    {
      key: "what",
      title: t("office.shiftCard.review.exceptions.what"),
      wrap: true,
      render: (item) => (
        <span className="shift-cell">
          <span>{t(`office.shiftCard.review.exceptions.kinds.${item.kind}`)}</span>
          {item.documentId !== null && item.documentNo !== null && (
            <span className="shift-cell__quiet">
              <Link to={`/disaggregation/${item.documentId}`}>
                {t("office.shiftCard.review.exceptions.document", { docNo: item.documentNo })}
              </Link>
            </span>
          )}
          {item.serial !== null && (
            <span className="shift-cell__quiet">
              {t("office.shiftCard.review.exceptions.code", { serial: item.serial })}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "subject",
      title: t("office.shiftCard.review.exceptions.subject"),
      mono: true,
      render: (item) => {
        if (item.sscc !== null) {
          return t(`office.shiftCard.review.exceptions.${item.subject}`, {
            sscc: ssccText(item.sscc),
          });
        }
        return item.subject === "box"
          ? t("office.shiftCard.review.exceptions.openBox")
          : t("office.shiftCard.noSscc");
      },
    },
    {
      key: "reason",
      title: t("office.shiftCard.review.exceptions.reason"),
      wrap: true,
      render: (item) => reasonText(item, t),
    },
    {
      key: "device",
      title: t("office.shiftCard.review.exceptions.device"),
      render: (item) =>
        item.source === "office"
          ? t("office.shiftCard.review.exceptions.office")
          : (item.deviceName ?? t("office.common.none")),
    },
    {
      key: "operator",
      title: t("office.shiftCard.review.exceptions.operator"),
      render: (item) => item.operatorName ?? item.officeUserName ?? t("office.common.none"),
    },
  ];
  return (
    <ReviewSection
      title={t("office.shiftCard.review.exceptions.title")}
      query={list}
      columns={columns}
      rowKey={(item) => item.id}
      empty={t("office.shiftCard.review.exceptions.empty")}
      tableLabel={t("office.shiftCard.review.exceptions.table")}
    />
  );
}

/**
 * The shift's records the host refused, newest first (plan КНФ). A refusal
 * the host could not tie to the shift is not here, and a record the station
 * sent again under a new id leaves its refusal here: the hint says both.
 */
export function ShiftRejections({ shift, at }: ReviewSectionProps) {
  const { t } = useTranslation();
  const list = useOfficeQuery(officeKeys.shiftRejections(shift.id), (api, token) =>
    api.listShiftRejections(token, shift.id),
  );
  const columns: TableColumn<OfficeShiftRejection>[] = [
    {
      key: "when",
      title: t("office.shiftCard.review.rejections.when"),
      wrap: true,
      minWidth: 150,
      render: (item) => at(item.receivedAt),
    },
    {
      key: "what",
      title: t("office.shiftCard.review.rejections.what"),
      wrap: true,
      render: (item) => recordKindText(item.kind, t),
    },
    {
      key: "reason",
      title: t("office.shiftCard.review.rejections.reason"),
      wrap: true,
      render: (item) => {
        const field = refusedField(item.details);
        return (
          <span className="shift-cell">
            <span>{refusalText(item.code, t)}</span>
            {field !== null && (
              <span className="shift-cell__quiet">
                {t("office.shiftCard.review.rejections.field", { field })}
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: "device",
      title: t("office.shiftCard.review.exceptions.device"),
      render: (item) => item.deviceName,
    },
  ];
  return (
    <ReviewSection
      title={t("office.shiftCard.review.rejections.title")}
      query={list}
      columns={columns}
      rowKey={(item) => `${item.deviceId}:${item.recordId}`}
      empty={t("office.shiftCard.review.rejections.empty")}
      tableLabel={t("office.shiftCard.review.rejections.table")}
      intro={<p className="office-note">{t("office.shiftCard.review.rejections.hint")}</p>}
    />
  );
}

/**
 * The code conflicts the shift's scans lost (plan КНФ, the filter of
 * «Конфликты» by the losing shift): how many are unreviewed, the first page
 * and a link to all of them. The review itself is on «Конфликты».
 */
export function ShiftConflicts({ shift }: ReviewSectionProps) {
  const { t } = useTranslation();
  const firstPage: ConflictQuery = { shiftId: shift.id, page: 1 };
  const list = useOfficeQuery(officeKeys.conflictList(firstPage), (api, token) =>
    api.listConflicts(token, firstPage),
  );
  // More than one page: the unreviewed are counted by the host, not on the page.
  const unreviewedQuery: ConflictQuery = { shiftId: shift.id, reviewed: false, page: 1 };
  const beyondFirstPage = list.data !== undefined && list.data.pageCount > 1;
  const unreviewedPage = useOfficeQuery(
    officeKeys.conflictList(unreviewedQuery),
    (api, token) => api.listConflicts(token, unreviewedQuery),
    { enabled: beyondFirstPage },
  );
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
      render: (row) => t(conflictKindKey(row)),
    },
    {
      key: "winner",
      title: t("office.conflicts.table.winner"),
      wrap: true,
      render: (row) => (
        <span className="shift-cell">
          <Link to={`/shifts/${row.winner.shiftId}`}>
            {t("office.conflicts.scan.shift", { number: row.winner.shiftNumber })}
          </Link>
          <span>{row.winner.deviceName}</span>
        </span>
      ),
    },
    {
      key: "state",
      title: t("office.conflicts.table.state"),
      render: (row) =>
        row.reviewedAt !== null ? (
          <StatusChip phase="done" label={t("office.conflicts.reviewed")} />
        ) : (
          <StatusChip phase="attention" label={t("office.conflicts.unreviewed")} />
        ),
    },
  ];
  const unreviewed = (): number | null => {
    if (list.data === undefined) return null;
    if (!beyondFirstPage) return list.data.items.filter((row) => row.reviewedAt === null).length;
    return unreviewedPage.data?.total ?? null;
  };
  const counted = unreviewed();
  const intro = (
    <div className="shift-cell">
      {list.data !== undefined && list.data.total > 0 && counted !== null && (
        <span>
          {t("office.shiftCard.review.conflicts.summary", {
            unreviewed: COUNT.format(counted),
            total: COUNT.format(list.data.total),
          })}
        </span>
      )}
      <Link to={`/conflicts?shift=${shift.id}&state=all`}>
        {t("office.shiftCard.review.conflicts.all")}
      </Link>
    </div>
  );
  return (
    <ReviewSection
      title={t("office.shiftCard.review.conflicts.title")}
      query={list}
      columns={columns}
      rowKey={(row) => row.id}
      empty={t("office.shiftCard.review.conflicts.empty")}
      tableLabel={t("office.conflicts.table.label")}
      intro={intro}
    />
  );
}
