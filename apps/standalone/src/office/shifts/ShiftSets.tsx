import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Card, StatusChip, type TableColumn } from "@markiro/ui";

import type { OfficeShift, OfficeShiftSets, ScannedCode } from "../../host/protocol.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { OVERVIEW_POLL_MS } from "../overview/use-overview-data.js";
import { PagedTable } from "../paging/PagedTable.js";
import { LoadError, PageLoading } from "../page-state.js";

const count = new Intl.NumberFormat("ru");

function identificationCode({ gtin14, serial }: ScannedCode): string {
  return `01${gtin14}21${serial}`;
}

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
      render: ({ setCode }) => identificationCode(setCode),
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
          <ul>
            {items.map((item) => (
              <li key={item.codeHash}>
                <code>{identificationCode(item)}</code>
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
      render: ({ outcome }) => (
        <StatusChip
          phase={outcome === "accepted" ? "done" : "attention"}
          label={t(`office.shiftCard.sets.${outcome}`)}
        />
      ),
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
