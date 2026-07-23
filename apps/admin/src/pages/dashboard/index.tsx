import { useTranslation } from "react-i18next";

import { EmptyState, PageHeader } from "@markiro/ui";

/** Dashboard ("Обзор") route stub -- real content is out of this plan's scope. */
export function DashboardPage() {
  const { t } = useTranslation();

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader title={t("pages.dashboard.title")} />
      <EmptyState title={t("pages.dashboard.emptyTitle")} hint={t("pages.dashboard.emptyHint")} />
    </div>
  );
}
