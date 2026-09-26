import { useTranslation } from "react-i18next";

import { Card, PageHeader } from "@markiro/ui";

import { useOfficeSession } from "./office-session.js";

export function OfficeOverview() {
  const { t } = useTranslation();
  const { user } = useOfficeSession();
  return (
    <>
      <PageHeader title={t("office.overview.title")} />
      <Card>
        <p>{t("office.overview.greeting", { name: user.name })}</p>
        <p>{t("office.overview.role", { role: t(`office.roles.${user.role}`) })}</p>
      </Card>
    </>
  );
}
