import { useTranslation } from "react-i18next";

import { EmptyState, PageHeader } from "@markiro/ui";

/** Counterparties ("Контрагенты") route stub -- full screens land in plan-03 Task 11. */
export function CounterpartiesPage() {
  const { t } = useTranslation();

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader title={t("pages.counterparties.title")} />
      <EmptyState
        title={t("pages.counterparties.emptyTitle")}
        hint={t("pages.counterparties.emptyHint")}
      />
    </div>
  );
}
