import { useTranslation } from "react-i18next";

import { EmptyState, PageHeader } from "@markiro/ui";

/** Catalog ("Каталог") route stub -- full screens land in plan-03 Task 12. */
export function CatalogPage() {
  const { t } = useTranslation();

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader title={t("pages.catalog.title")} />
      <EmptyState title={t("pages.catalog.emptyTitle")} hint={t("pages.catalog.emptyHint")} />
    </div>
  );
}
