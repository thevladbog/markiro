/**
 * Admin code card (Task 12) -- read-only detail view for a single marking
 * code, reached from the registry table (`./index.tsx`), the box card's
 * item table, and the code-search lookup box. Shows the code's identity,
 * current status/box, and its full movement history (`useCodeCard`, Task
 * 11's `./api.ts`). Mirrors `../pickup/OrderDetail.tsx`'s
 * PageHeader + DetailField grid pattern; the history timeline is a fresh
 * pattern -- a vertical list of left-bordered divs, no new UI component.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { formatSsccHri } from "@markiro/domain";
import { Alert, Card, PageHeader, Spinner, StatusChip } from "@markiro/ui";
import type { StatusChipStatus } from "@markiro/ui";

import { formatCreatedAt } from "../../lib/datetime.js";
import { useCodeCard, type CodeHistoryEvent, type CodeStatus } from "./api.js";

// Mirrors `./index.tsx`'s `STATUS_TO_CHIP` -- see its doc comment for why
// "written_off" maps to "warn" rather than a nonexistent "success"/"danger" tone.
const STATUS_TO_CHIP: Record<CodeStatus, StatusChipStatus> = {
  free: "ok",
  aggregated: "info",
  written_off: "warn",
};

function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>{label}</span>
      <span style={{ font: "var(--text-body)", color: "var(--fg-1)" }}>{value}</span>
    </div>
  );
}

/** Contextual right-hand link for a single history row, per the Task 12 brief. */
function historyEventLink(event: CodeHistoryEvent): ReactNode {
  switch (event.type) {
    case "scanned":
      return null;
    case "box_added":
    case "box_displaced":
    case "box_removed":
      return event.boxSscc ? (
        <Link to={`/codes/box/${event.boxId}`}>{formatSsccHri(event.boxSscc)}</Link>
      ) : (
        <Link to={`/codes/box/${event.boxId}`}>{event.boxId}</Link>
      );
    case "box_disassembled":
      return event.disaggregationDocumentId && event.disaggregationDocNo ? (
        <Link to={`/disaggregation/${event.disaggregationDocumentId}`}>
          {event.disaggregationDocNo}
        </Link>
      ) : event.boxSscc ? (
        <Link to={`/codes/box/${event.boxId}`}>{formatSsccHri(event.boxSscc)}</Link>
      ) : null;
    case "pickup_locked":
    case "pickup_resolved":
      return <Link to={`/pickup/${event.orderId}`}>{event.orderNo}</Link>;
  }
}

function HistoryTimeline({ history, language }: { history: CodeHistoryEvent[]; language: string }) {
  const { t } = useTranslation();

  if (history.length === 0) {
    return <span style={{ font: "var(--text-body)", color: "var(--fg-3)" }}>—</span>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {history.map((event, index) => (
        <div
          key={`${event.type}:${event.at}:${index}`}
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 16,
            padding: "10px 0 10px 16px",
            borderLeft: "2px solid var(--line)",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
              {formatCreatedAt(event.at, language)}
            </span>
            <span style={{ font: "var(--text-body)", color: "var(--fg-1)" }}>
              {t(`pages.codeSearch.history.${event.type}`)}
            </span>
          </div>
          <span style={{ font: "var(--text-body)" }}>{historyEventLink(event)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * `GET /codes/km/:codeHash` -- a single code's identity, current status/box,
 * and its full movement history.
 */
export function CodeCardPage() {
  const { t, i18n } = useTranslation();
  const { codeHash } = useParams();

  const { data: card, isPending, isError } = useCodeCard(codeHash);

  if (isPending) {
    return (
      <div style={{ padding: "28px 32px", display: "flex", justifyContent: "center" }}>
        <Spinner label={t("common.loading")} />
      </div>
    );
  }

  if (isError || !card) {
    return (
      <div style={{ padding: "28px 32px" }}>
        <Alert tone="error">{t("common.loadError")}</Alert>
      </div>
    );
  }

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader title={t("pages.codeSearch.codeCard.title")} />
      <span
        className="font-mono"
        style={{ font: "var(--text-code)", color: "var(--fg-2)", marginTop: -12 }}
      >
        {`01${card.gtin14}21${card.serial}`}
      </span>

      <Card>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 16,
          }}
        >
          <DetailField
            label={t("pages.codeSearch.codeCard.productLabel")}
            value={card.productName ?? "—"}
          />
          <DetailField label={t("pages.codeSearch.codeCard.gtinLabel")} value={card.gtin14} />
          <DetailField label={t("pages.codeSearch.codeCard.serialLabel")} value={card.serial} />
          <DetailField
            label={t("pages.codeSearch.codeCard.statusLabel")}
            value={
              <StatusChip
                status={STATUS_TO_CHIP[card.status]}
                label={t(`pages.codeSearch.status.${card.status}`)}
              />
            }
          />
          <DetailField
            label={t("pages.codeSearch.codeCard.currentBoxLabel")}
            value={
              card.currentBox ? (
                <Link to={`/codes/box/${card.currentBox.id}`}>
                  {card.currentBox.sscc
                    ? formatSsccHri(card.currentBox.sscc)
                    : t("pages.codeSearch.boxCard.noSscc")}
                </Link>
              ) : (
                "—"
              )
            }
          />
        </div>
      </Card>

      <Card title={t("pages.codeSearch.codeCard.historyTitle")}>
        <HistoryTimeline history={card.history} language={i18n.language} />
      </Card>
    </div>
  );
}
