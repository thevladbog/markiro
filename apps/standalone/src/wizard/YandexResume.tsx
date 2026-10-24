import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button } from "@markiro/ui";
import { yandexNative } from "../host/yandex-native.js";
export function YandexResume() {
  const { t } = useTranslation();
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let active = true;
    void yandexNative.recoveryAvailable().then(
      (value) => {
        if (active) setAvailable(value);
      },
      () => {
        if (active) setAvailable(false);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!available) return null;
  return (
    <>
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void yandexNative.resume().then(
            () => window.location.reload(),
            (reason: unknown) => {
              setBusy(false);
              setError(typeof reason === "string" ? reason : "restore_failed");
            },
          );
        }}
      >
        {t("yandex.resume")}
      </Button>
      {busy && <p role="status">{t("yandex.working")}</p>}
      {error && (
        <Alert tone="warn">
          {t(`yandex.errors.${error}`, { defaultValue: t("yandex.errors.restore_failed") })}
        </Alert>
      )}
    </>
  );
}
