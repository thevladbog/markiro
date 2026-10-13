import { useTranslation } from "react-i18next";

import { Card } from "@markiro/ui";

/**
 * «Лицензия». Licensing is not connected yet: the card says so and nothing
 * more. This is the place the licensing work extends (the state, the key,
 * the expiry); the support text names the same state
 * (`office.about.license.notConnected`).
 */
export function LicenseSection() {
  const { t } = useTranslation();
  return (
    <Card title={t("office.about.license.title")} titleAs="h2">
      <p className="office-note">{t("office.about.license.notConnected")}</p>
    </Card>
  );
}
