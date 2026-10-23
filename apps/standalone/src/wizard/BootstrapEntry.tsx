import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@markiro/ui";
import { BootstrapWizard, type BootstrapWizardProps } from "./BootstrapWizard.js";
import { YandexRestoreWizard } from "./YandexRestoreWizard.js";
export function BootstrapEntry({
  recoveryAllowed = false,
  ...props
}: BootstrapWizardProps & { recoveryAllowed?: boolean }) {
  const { t } = useTranslation();
  const [restore, setRestore] = useState(false);
  return restore ? (
    <YandexRestoreWizard
      onBack={() => setRestore(false)}
      onRestored={() => window.location.reload()}
    />
  ) : (
    <>
      {recoveryAllowed && (
        <Button variant="secondary" onClick={() => setRestore(true)}>
          {t("yandex.restoreTitle")}
        </Button>
      )}
      <BootstrapWizard {...props} />
    </>
  );
}
