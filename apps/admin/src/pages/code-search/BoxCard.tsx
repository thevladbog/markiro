/**
 * Admin box card (Task 12) -- read-only detail view for a single box,
 * reached from the code registry table, the code card's "current box"
 * link, and the disaggregation document detail's SSCC links
 * (`../disaggregation/DocumentDetail.tsx`). Shows the box's identity,
 * status/timestamps, the code composition table (incl. displaced/removed
 * rows), and its exceptions/pickup-order history (`useBoxCard`, Task 11's
 * `./api.ts`). Mirrors `../pickup/OrderDetail.tsx`'s
 * PageHeader + DetailField grid + Table pattern.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { formatSsccHri } from "@markiro/domain";
import { Alert, Badge, Card, PageHeader, Spinner, StatusChip, Table } from "@markiro/ui";
import type { StatusChipStatus, TableColumn } from "@markiro/ui";

import { formatCreatedAt } from "../../lib/datetime.js";
import { useBoxCard, type BoxCardDto, type BoxCardItemDto } from "./api.js";

// Box status has its own three-way meaning distinct from a code's ("open"
// still in progress, "closed" a completed/normal end state, "disassembled"
// a terminal removal from circulation) so it gets its own mapping rather
// than reusing the code registry's `STATUS_TO_CHIP` --
// open -> "info" (in progress), closed -> "ok" (successfully completed),
// disassembled -> "neutral" (out of circulation, not an error in itself).
const STATUS_TO_CHIP: Record<BoxCardDto["status"], StatusChipStatus> = {
  open: "info",
  closed: "ok",
  disassembled: "neutral",
};

function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>{label}</span>
      <span style={{ font: "var(--text-body)", color: "var(--fg-1)" }}>{value}</span>
    </div>
  );
}

function itemState(item: BoxCardItemDto): "active" | "displaced" | "removed" {
  if (item.removedAt) return "removed";
  if (item.displacedAt) return "displaced";
  return "active";
}

export function BoxCardPage() {
  const { t, i18n } = useTranslation();
  const { boxId } = useParams();

  const { data: box, isPending, isError } = useBoxCard(boxId);

  if (isPending) {
    return (
      <div style={{ padding: "28px 32px", display: "flex", justifyContent: "center" }}>
        <Spinner label={t("common.loading")} />
      </div>
    );
  }

  if (isError || !box) {
    return (
      <div style={{ padding: "28px 32px" }}>
        <Alert tone="error">{t("common.loadError")}</Alert>
      </div>
    );
  }

  const title = box.sscc ? formatSsccHri(box.sscc) : t("pages.codeSearch.boxCard.noSscc");

  const itemColumns: TableColumn<BoxCardItemDto>[] = [
    {
      key: "code",
      title: t("pages.codeSearch.boxCard.table.code"),
      mono: true,
      render: (row) => {
        const state = itemState(row);
        return (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              opacity: state === "active" ? 1 : 0.5,
            }}
          >
            <Link to={`/codes/km/${row.codeHash}`}>
              {row.gtin14 && row.serial ? `01${row.gtin14}21${row.serial}` : row.codeHash}
            </Link>
          </div>
        );
      },
    },
    {
      key: "addedAt",
      title: t("pages.codeSearch.boxCard.table.addedAt"),
      render: (row) => (
        <span style={{ opacity: itemState(row) === "active" ? 1 : 0.5 }}>
          {formatCreatedAt(row.addedAt, i18n.language)}
        </span>
      ),
    },
    {
      key: "state",
      title: t("pages.codeSearch.boxCard.table.state"),
      render: (row) => {
        const state = itemState(row);
        if (state === "displaced") {
          return <Badge tone="warn">{t("pages.codeSearch.boxCard.displaced")}</Badge>;
        }
        if (state === "removed") {
          return <Badge tone="error">{t("pages.codeSearch.boxCard.removed")}</Badge>;
        }
        return null;
      },
    },
  ];

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={title}
        actions={
          <StatusChip
            status={STATUS_TO_CHIP[box.status]}
            label={t(`pages.codeSearch.boxCard.status.${box.status}`)}
          />
        }
      />

      <Card>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 16,
          }}
        >
          <DetailField
            label={t("pages.codeSearch.boxCard.productLabel")}
            value={box.productName ?? "—"}
          />
          <DetailField label={t("pages.codeSearch.boxCard.shiftLabel")} value={box.shiftId} />
          <DetailField
            label={t("pages.codeSearch.boxCard.openedAtLabel")}
            value={formatCreatedAt(box.openedAt, i18n.language)}
          />
          <DetailField
            label={t("pages.codeSearch.boxCard.closedAtLabel")}
            value={box.closedAt ? formatCreatedAt(box.closedAt, i18n.language) : "—"}
          />
          <DetailField
            label={t("pages.codeSearch.boxCard.disassembledAtLabel")}
            value={box.disassembledAt ? formatCreatedAt(box.disassembledAt, i18n.language) : "—"}
          />
        </div>
      </Card>

      <Card title={t("pages.codeSearch.boxCard.itemsTitle")}>
        <Table
          columns={itemColumns}
          rows={box.items}
          getRowKey={(row) => row.codeHash}
          empty={t("pages.codeSearch.boxCard.itemsEmpty")}
        />
      </Card>

      <Card title={t("pages.codeSearch.boxCard.exceptionsTitle")}>
        {box.exceptions.length === 0 ? (
          <span style={{ font: "var(--text-body)", color: "var(--fg-3)" }}>
            {t("pages.codeSearch.boxCard.exceptionsEmpty")}
          </span>
        ) : (
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
            {box.exceptions.map((exception, index) => (
              <li
                key={`${exception.kind}:${exception.occurredAt}:${index}`}
                style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}
              >
                <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
                  {formatCreatedAt(exception.occurredAt, i18n.language)}
                </span>
                <span style={{ font: "var(--text-body)", color: "var(--fg-1)" }}>
                  {t(`pages.codeSearch.boxCard.exceptionKind.${exception.kind}`)}
                </span>
                {exception.reason ? (
                  <span style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
                    {exception.reason}
                  </span>
                ) : null}
                {exception.disaggregationDocumentId && exception.disaggregationDocNo ? (
                  <Link to={`/disaggregation/${exception.disaggregationDocumentId}`}>
                    {exception.disaggregationDocNo}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t("pages.codeSearch.boxCard.pickupOrdersTitle")}>
        {box.pickupOrders.length === 0 ? (
          <span style={{ font: "var(--text-body)", color: "var(--fg-3)" }}>
            {t("pages.codeSearch.boxCard.pickupOrdersEmpty")}
          </span>
        ) : (
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
            {box.pickupOrders.map((order) => (
              <li key={order.orderId} style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                <Link to={`/pickup/${order.orderId}`}>{order.orderNo}</Link>
                <span style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
                  {t(`pages.pickup.status.${order.status}`)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
