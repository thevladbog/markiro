import { useCallback, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router";

import { Alert, Button, SidePanel, Spinner } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useRoutePanelGuard } from "../../lib/useRoutePanelGuard.js";
import { issueKioskPairingCode } from "./api.js";
import {
  closeKioskPanel,
  type KiosksPanelContext,
  type KiosksPanelLocationState,
} from "./KioskPanelRoute.js";
import { PairingCodeReveal } from "./PairingCodeReveal.js";

type PairingReveal = { code: string; expiresAt: string } | null;

export function KioskPairingPanelRoute(): ReactElement {
  const { kioskId } = useParams();
  return <KioskPairingPanelContent key={kioskId ?? "missing"} kioskId={kioskId} />;
}

function KioskPairingPanelContent({ kioskId }: { kioskId: string | undefined }): ReactElement {
  const { t } = useTranslation();
  const context = useOutletContext<KiosksPanelContext>();
  const location = useLocation();
  const navigate = useNavigate();
  const [reveal, setReveal] = useState<PairingReveal>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const issuingRef = useRef(false);
  const kiosk = context.kiosks.find((item) => item.id === kioskId);
  const fromList = (location.state as KiosksPanelLocationState | null)?.kiosksBackground === true;

  const close = useCallback(() => {
    setReveal(null);
    closeKioskPanel(location, navigate);
  }, [location, navigate]);
  const guard = useRoutePanelGuard(close, busy);

  const issue = async (regenerating: boolean) => {
    if (!kiosk || issuingRef.current) return;
    issuingRef.current = true;
    if (regenerating) setReveal(null);
    setExpired(false);
    setBusy(true);
    setError(null);
    try {
      const next = await issueKioskPairingCode(kiosk.id);
      setReveal(next);
      toast("ok", t("pages.kiosks.toasts.pairingSuccess"));
    } catch (cause) {
      setReveal(null);
      setError(
        cause instanceof ApiRequestError ? cause.message : t("pages.kiosks.pairing.issueError"),
      );
    } finally {
      issuingRef.current = false;
      setBusy(false);
    }
  };

  const handleExpired = useCallback(() => {
    setReveal(null);
    setExpired(true);
  }, []);

  const dismissAction = (
    <Button type="button" variant="secondary" disabled={busy} onClick={guard.requestClose}>
      {fromList ? t("pages.kiosks.pairing.backAction") : t("common.close")}
    </Button>
  );

  if (context.kiosksPending || (context.kiosksError && !context.kiosksResolved)) {
    return (
      <SidePanel
        open
        busy={busy}
        size="standard"
        title={t("pages.kiosks.pairing.panelTitle")}
        closeLabel={t("common.close")}
        onClose={guard.requestClose}
        footer={dismissAction}
      >
        {context.kiosksPending ? (
          <div className="mk-kiosk-pairing-panel__loading">
            <Spinner label={t("common.loading")} />
          </div>
        ) : (
          <div className="mk-kiosks-section-state">
            <Alert tone="error">{t("pages.kiosks.form.loadError")}</Alert>
            <div>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void context.retryPanelData()}
              >
                {t("pages.kiosks.form.retry")}
              </Button>
            </div>
          </div>
        )}
      </SidePanel>
    );
  }

  if (!kiosk || kiosk.status === "archived") {
    return (
      <SidePanel
        open
        size="standard"
        title={t("pages.kiosks.pairing.panelTitle")}
        closeLabel={t("common.close")}
        onClose={guard.requestClose}
        footer={dismissAction}
      >
        <Alert tone={kiosk ? "warn" : "error"}>
          {kiosk ? t("pages.kiosks.pairing.unavailable") : t("pages.kiosks.form.notFound")}
        </Alert>
      </SidePanel>
    );
  }

  return (
    <SidePanel
      open
      busy={busy}
      size="standard"
      title={t("pages.kiosks.pairing.panelTitle")}
      description={kiosk.name}
      closeLabel={t("common.close")}
      className="mk-kiosk-pairing-panel"
      onClose={guard.requestClose}
      footer={
        reveal ? (
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              setReveal(null);
              guard.finish();
            }}
          >
            {t("pages.kiosks.pairing.doneAction")}
          </Button>
        ) : (
          <>
            {dismissAction}
            <Button type="button" loading={busy} onClick={() => void issue(false)}>
              {expired
                ? t("pages.kiosks.pairing.regenerateAction")
                : t("pages.kiosks.pairing.issueAction")}
            </Button>
          </>
        )
      }
    >
      <div className="mk-kiosk-pairing-panel__content">
        {error ? (
          <Alert tone="error" role="status" aria-live="polite" aria-atomic="true">
            {error}
          </Alert>
        ) : null}
        {expired ? (
          <Alert tone="warn" role="status" aria-live="polite" aria-atomic="true">
            {t("pages.kiosks.pairing.expired")}
          </Alert>
        ) : null}
        {reveal ? (
          <>
            <p className="mk-kiosk-pairing-panel__hint">
              {t("pages.kiosks.pairing.revealHint", { name: kiosk.name })}
            </p>
            <PairingCodeReveal
              code={reveal.code}
              expiresAt={reveal.expiresAt}
              regenerating={busy}
              onRegenerate={() => void issue(true)}
              onExpired={handleExpired}
            />
          </>
        ) : (
          <div className="mk-kiosk-pairing-panel__safe-entry">
            <p className="mk-kiosk-pairing-panel__hint">
              {t("pages.kiosks.pairing.safeHint", { name: kiosk.name })}
            </p>
            {!expired && !error ? (
              <Alert tone="warn">{t("pages.kiosks.pairing.invalidationWarning")}</Alert>
            ) : null}
          </div>
        )}
      </div>
    </SidePanel>
  );
}
