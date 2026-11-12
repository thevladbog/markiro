import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Card, StatusChip, type TableColumn } from "@markiro/ui";

import type { OfficeShift, OfficeShiftSets } from "../../host/protocol.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { OVERVIEW_POLL_MS } from "../overview/use-overview-data.js";
import { PagedTable } from "../paging/PagedTable.js";
import { LoadError, PageLoading } from "../page-state.js";
import { groupSetContents, setIdentificationCode } from "./set-contents.js";
import "./set-contents.css";

const count = new Intl.NumberFormat("ru");

export function ShiftSets({ shift, at }: { shift: OfficeShift; at: (instant: string) => string }) {
  const { t } = useTranslation();
  const titleId = useId();
  const sets = useOfficeQuery(
    officeKeys.shiftSets(shift.id),
    (api, token) => api.listShiftSets(token, shift.id),
    { refetchInterval: () => (shift.status === "active" ? OVERVIEW_POLL_MS : false) },
  );
  const columns: TableColumn<OfficeShiftSets[number]>[] = [
    {
      key: "code",
      title: t("office.shiftCard.sets.code"),
      mono: true,
      wrap: true,
      render: ({ setCode }) => setIdentificationCode(setCode),
    },
    {
      key: "items",
      title: t("office.shiftCard.sets.contents"),
      wrap: true,
      render: ({ items }) => (
        <details>
          <summary>
            {t("office.shiftCard.sets.items", { count: count.format(items.length) })}
          </summary>
          <ul className="set-history__groups">
            {groupSetContents(items, shift.setItems).map(({ gtin14, productName, codes }) => (
              <li key={gtin14}>
                <div className="shift-cell">
                  <strong>{productName ?? t("office.shiftCard.sets.unnamedProduct")}</strong>
                  <span className="shift-cell__quiet">
                    <span>{t("office.shiftCard.sets.gtin", { gtin14 })}</span>
                    {" · "}
                    <span>
                      {t("office.shiftCard.sets.quantity", { count: count.format(codes.length) })}
                    </span>
                  </span>
                </div>
                <ul>
                  {codes.map((code) => (
                    <li key={code.codeHash}>
                      <code>{setIdentificationCode(code)}</code>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      ),
    },
    {
      key: "at",
      title: t("office.shiftCard.sets.at"),
      wrap: true,
      minWidth: 130,
      render: ({ assembledAt }) => at(assembledAt),
    },
    {
      key: "status",
      title: t("office.shiftCard.sets.status"),
      render: ({ outcome, disassembledAt, disaggregationDocumentId }) => {
        if (disassembledAt != null) {
          return (
            <div className="shift-cell">
              <StatusChip phase="dismantled" label={t("office.shiftCard.sets.disassembled")} />
              <span className="shift-cell__quiet">{at(disassembledAt)}</span>
              {disaggregationDocumentId != null && (
                <Link to={`/disaggregation/${disaggregationDocumentId}`}>
                  {t("office.shiftCard.sets.disaggregationDocument")}
                </Link>
              )}
            </div>
          );
        }
        return (
          <StatusChip
            phase={outcome === "accepted" ? "done" : "attention"}
            label={t(`office.shiftCard.sets.${outcome}`)}
          />
        );
      },
    },
  ];

  return (
    <section className="shift-card__section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("office.shiftCard.tabs.sets")}</h2>
      <Card>
        {sets.isPending ? (
          <PageLoading />
        ) : sets.isError ? (
          <LoadError error={sets.error} onRetry={() => void sets.refetch()} />
        ) : (
          <PagedTable
            tableId="shift-sets"
            columns={columns}
            rows={sets.data}
            getRowKey={(set) => set.id}
            empty={t("office.shiftCard.sets.empty")}
            scrollLabel={t("office.shiftCard.sets.table")}
          />
        )}
      </Card>
    </section>
  );
}
