import { useTranslation } from "react-i18next";

import { Alert } from "@markiro/ui";

import type { ReleaseErrorMessage } from "./errorMessages.js";

export function ReleaseError({ message }: { message: ReleaseErrorMessage }) {
  const { t } = useTranslation();
  return (
    <Alert tone="error" role="alert">
      <p className="releases-alert-line">{t(message.key, message.params ?? {})}</p>
      {message.filesRetained ? (
        <p className="releases-alert-line">{t("standaloneReleases.errors.filesRetained")}</p>
      ) : null}
    </Alert>
  );
}
