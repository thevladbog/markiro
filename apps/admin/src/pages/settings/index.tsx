import { useTranslation } from "react-i18next";

import { EmptyState, PageHeader } from "@markiro/ui";

/** Settings ("Настройки") route stub -- no dedicated task in plan-03 yet. */
export function SettingsPage() {
  const { t } = useTranslation();

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader title={t("pages.settings.title")} />
      <EmptyState title={t("pages.settings.emptyTitle")} hint={t("pages.settings.emptyHint")} />
    </div>
  );
}
