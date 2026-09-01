import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button } from "@markiro/ui";
import type { UpdateCheckResult } from "../lib/updates.js";

export function UpdateControl({
  currentVersion,
  onCheck,
}: {
  currentVersion: string;
  onCheck: () => Promise<UpdateCheckResult>;
}): ReactElement {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);

  const check = async (): Promise<void> => {
    setChecking(true);
    setResult(null);
    try {
      setResult(await onCheck());
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="signer-update-control">
      <div className="signer-update-control__copy">
        <h2>{t("updates.title")}</h2>
        <p>{t("updates.installed", { version: currentVersion })}</p>
      </div>
      <Button
        size="compact"
        variant="secondary"
        loading={checking}
        disabled={checking}
        onClick={() => void check()}
      >
        {checking ? t("updates.checking") : t("updates.check")}
      </Button>
      <div className="signer-update-control__result" aria-live="polite">
        {result?.status === "current" ? <p>{t("updates.current")}</p> : null}
        {result?.status === "available" ? (
          <p>{t("updates.availableManual", { version: result.update.version })}</p>
        ) : null}
        {result?.status === "failed" ? (
          <Alert tone="error">{t("updates.checkFailed")}</Alert>
        ) : null}
      </div>
    </div>
  );
}
