import { useTranslation } from "react-i18next";

import { EmptyState, PageHeader } from "@markiro/ui";

/** Shifts ("Смены") route stub -- full screens land in plan-03 Task 13. */
export function ShiftsPage() {
  const { t } = useTranslation();

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader title={t("pages.shifts.title")} />
      <EmptyState title={t("pages.shifts.emptyTitle")} hint={t("pages.shifts.emptyHint")} />
    </div>
  );
}
