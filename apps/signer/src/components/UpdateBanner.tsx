import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button } from "@markiro/ui";
import type { SignerUpdate } from "../lib/updates.js";

/** The window is where the operator consents to an update. The tray only tells
 *  them to open it: installing restarts the agent, and the agent is what keeps
 *  the tenant's token fresh, so nothing here happens without a press. */
export function UpdateBanner({
  update,
  onInstalled,
}: {
  update: SignerUpdate | null;
  onInstalled: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!update) return null;

  const install = async (): Promise<void> => {
    setPending(true);
    setFailed(false);
    try {
      await update.install();
      onInstalled();
    } catch {
      // The raw error carries a mirror URL and a stack; neither helps an
      // operator, and the banner has to stay usable so they can retry.
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="signer-update-banner" aria-label={t("updates.availableLabel")}>
      <div className="signer-update-banner__copy">
        <strong>{t("updates.available", { version: update.version })}</strong>
        {update.notes ? <p>{update.notes}</p> : null}
      </div>
      {failed ? <Alert tone="error">{t("updates.failed")}</Alert> : null}
      <Button disabled={pending} onClick={() => void install()}>
        {pending ? t("updates.installing") : t("updates.install")}
      </Button>
    </section>
  );
}
