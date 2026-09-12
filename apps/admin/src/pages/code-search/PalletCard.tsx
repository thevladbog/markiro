/**
 * Admin pallet card (06d) -- the read-only counterpart of `./BoxCard.tsx` one
 * aggregation level up, reached from a box card's «На паллете» link and from
 * the shift panel's pallet table. Shows the pallet's identity, its shift,
 * terminal and line, a COLLAPSED list of its member boxes (one row each,
 * linking on to that box's own card rather than inlining its codes -- a
 * pallet holds tens of boxes), and its own exception history.
 *
 * Deliberately the same PageHeader + DetailField grid + Table composition
 * `BoxCard` uses, down to the status-chip mapping, so the two cards read as
 * two levels of one thing rather than two screens.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { formatSsccHri } from "@markiro/domain";
import { Alert, Badge, Card, PageHeader, Spinner, StatusChip, Table } from "@markiro/ui";
import type { StatusChipStatus, TableColumn } from "@markiro/ui";

import { formatCreatedAt } from "../../lib/datetime.js";
import { usePalletCard, type PalletCardBoxDto, type PalletCardDto } from "./api.js";

// Identical mapping to the box card's: a pallet's three states mean the same
// three things -- still being stacked, closed and labelled, taken apart.
const STATUS_TO_CHIP: Record<PalletCardDto["status"], StatusChipStatus> = {
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

export function PalletCardPage() {
  const { t, i18n } = useTranslation();
  const { palletId } = useParams();

  const { data: pallet, isPending, isError } = usePalletCard(palletId);

  if (isPending) {
    return (
      <div style={{ padding: "28px 32px", display: "flex", justifyContent: "center" }}>
        <Spinner label={t("common.loading")} />
      </div>
    );
  }

  if (isError || !pallet) {
    return (
      <div style={{ padding: "28px 32px" }}>
        <Alert tone="error">{t("common.loadError")}</Alert>
      </div>
    );
  }

  const title = pallet.sscc ? formatSsccHri(pallet.sscc) : t("pages.codeSearch.palletCard.noSscc");

  const boxColumns: TableColumn<PalletCardBoxDto>[] = [
    {
      key: "sscc",
      title: t("pages.codeSearch.palletCard.table.sscc"),
      mono: true,
      render: (row) => (
        <Link to={`/codes/box/${row.id}`}>
          {row.sscc ? formatSsccHri(row.sscc) : t("pages.codeSearch.boxCard.noSscc")}
        </Link>
      ),
    },
    {
      key: "itemCount",
      title: t("pages.codeSearch.palletCard.table.itemCount"),
      align: "right",
      mono: true,
      render: (row) => new Intl.NumberFormat(i18n.language).format(row.itemCount),
    },
    {
      key: "closedAt",
      title: t("pages.codeSearch.palletCard.table.closedAt"),
      render: (row) => (row.closedAt ? formatCreatedAt(row.closedAt, i18n.language) : "—"),
    },
    {
      key: "state",
      title: t("pages.codeSearch.palletCard.table.state"),
      wrap: true,
      // A disassembled member box is kept on the list, never dropped: it is
      // the only evidence on screen that a closed, labelled pallet left the
      // line a box short. Badge text, not colour alone.
      render: (row) =>
        row.disassembledAt ? (
          <Badge tone="warn">{t("pages.codeSearch.palletCard.boxDisassembled")}</Badge>
        ) : null,
    },
  ];

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <Link
        to="/codes"
        style={{ font: "var(--text-body)", color: "var(--fg-3)", textDecoration: "none" }}
      >
        {t("pages.codeSearch.backAction")}
      </Link>

      <PageHeader
        title={title}
        actions={
          <StatusChip
            status={STATUS_TO_CHIP[pallet.status]}
            label={t(`pages.codeSearch.palletCard.status.${pallet.status}`)}
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
            label={t("pages.codeSearch.palletCard.productLabel")}
            value={pallet.productName ?? "—"}
          />
          <DetailField
            label={t("pages.codeSearch.palletCard.shiftLabel")}
            value={
              <Link to={`/shifts/${pallet.shiftId}`}>
                {pallet.shiftNumber ?? t("pages.codeSearch.palletCard.shiftLabel")}
              </Link>
            }
          />
          <DetailField
            label={t("pages.codeSearch.palletCard.lineLabel")}
            value={pallet.lineName ?? "—"}
          />
          <DetailField
            label={t("pages.codeSearch.palletCard.openedAtLabel")}
            value={formatCreatedAt(pallet.openedAt, i18n.language)}
          />
          <DetailField
            label={t("pages.codeSearch.palletCard.closedAtLabel")}
            value={pallet.closedAt ? formatCreatedAt(pallet.closedAt, i18n.language) : "—"}
          />
          <DetailField
            label={t("pages.codeSearch.palletCard.disassembledAtLabel")}
            value={
              pallet.disassembledAt ? formatCreatedAt(pallet.disassembledAt, i18n.language) : "—"
            }
          />
        </div>
      </Card>

      <Card title={t("pages.codeSearch.palletCard.boxesTitle")}>
        <Table
          columns={boxColumns}
          rows={pallet.boxes}
          getRowKey={(row) => row.id}
          empty={t("pages.codeSearch.palletCard.boxesEmpty")}
          scrollLabel={t("pages.codeSearch.palletCard.boxesTitle")}
        />
      </Card>

      <Card title={t("pages.codeSearch.palletCard.exceptionsTitle")}>
        {pallet.exceptions.length === 0 ? (
          <span style={{ font: "var(--text-body)", color: "var(--fg-3)" }}>
            {t("pages.codeSearch.palletCard.exceptionsEmpty")}
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
            {pallet.exceptions.map((exception, index) => (
              <li
                key={`${exception.kind}:${exception.occurredAt}:${index}`}
                style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}
              >
                <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
                  {formatCreatedAt(exception.occurredAt, i18n.language)}
                </span>
                <span style={{ font: "var(--text-body)", color: "var(--fg-1)" }}>
                  {t(`pages.codeSearch.palletCard.exceptionKind.${exception.kind}`)}
                </span>
                <span style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
                  {exception.reason}
                </span>
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
    </div>
  );
}
