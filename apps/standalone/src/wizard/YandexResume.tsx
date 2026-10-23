import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button } from "@markiro/ui";
import { yandexNative } from "../host/yandex-native.js";
export function YandexResume() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(false);
          void yandexNative.resume().then(
            () => window.location.reload(),
            () => {
              setBusy(false);
              setError(true);
            },
          );
        }}
      >
        {t("yandex.resume")}
      </Button>
      {busy && <p role="status">{t("yandex.working")}</p>}
      {error && <Alert tone="warn">{t("yandex.errors.restore_failed")}</Alert>}
    </>
  );
}
