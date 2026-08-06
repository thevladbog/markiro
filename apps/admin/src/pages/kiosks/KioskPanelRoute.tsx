import { Alert, Button, ConfirmDialog, SidePanel, Spinner } from "@markiro/ui";
import { useCallback, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useOutletContext } from "react-router";
import type { Location, NavigateFunction } from "react-router";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useRoutePanelGuard } from "../../lib/useRoutePanelGuard.js";
import { useCreateKiosk, type KioskDto } from "./api.js";
import { KIOSK_PROFILE_FORM_ID, KioskProfileForm } from "./KioskProfileForm.js";

export interface KiosksPanelContext {
  kiosks: KioskDto[];
  kiosksPending: boolean;
  kiosksError: boolean;
  kiosksResolved: boolean;
  retryPanelData: () => Promise<void>;
}

export type KiosksPanelLocationState = { kiosksBackground: true };

export function closeKioskPanel(location: Location, navigate: NavigateFunction) {
  if ((location.state as KiosksPanelLocationState | null)?.kiosksBackground === true) {
    void navigate(-1);
  } else {
    void navigate("/kiosks", { replace: true });
  }
}

function usePanelContext() {
  const context = useOutletContext<KiosksPanelContext>();
  const location = useLocation();
  const navigate = useNavigate();
  const close = useCallback(() => closeKioskPanel(location, navigate), [location, navigate]);
  return { context, close };
}

function PanelSkeleton() {
  const { t } = useTranslation();

  return (
    <div className="mk-kiosk-panel-skeleton">
      <Spinner label={t("common.loading")} />
      <div className="mk-kiosk-panel-skeleton__shape" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function PanelState() {
  const { t } = useTranslation();
  const { context, close } = usePanelContext();

  return (
    <SidePanel
      open
      size="standard"
      title={t("pages.kiosks.form.createTitle")}
      closeLabel={t("common.close")}
      onClose={close}
    >
      {context.kiosksPending ? (
        <PanelSkeleton />
      ) : (
        <div className="mk-kiosks-section-state">
          <Alert tone="error">{t("pages.kiosks.form.loadError")}</Alert>
          <div>
            <Button type="button" variant="secondary" onClick={() => void context.retryPanelData()}>
              {t("pages.kiosks.form.retry")}
            </Button>
          </div>
        </div>
      )}
    </SidePanel>
  );
}

function DiscardDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();

  return (
    <ConfirmDialog
      open={open}
      title={t("pages.kiosks.form.discardTitle")}
      description={t("pages.kiosks.form.discardBody")}
      cancelLabel={t("pages.kiosks.form.continueEditing")}
      confirmLabel={t("pages.kiosks.form.discardAction")}
      tone="destructive"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

export function KioskCreatePanelRoute(): ReactElement {
  const { t } = useTranslation();
  const { context, close } = usePanelContext();
  const mutation = useCreateKiosk();
  const [error, setError] = useState<string | null>(null);
  const guard = useRoutePanelGuard(close, mutation.isPending);

  if (context.kiosksPending || (context.kiosksError && !context.kiosksResolved)) {
    return <PanelState />;
  }

  return (
    <>
      <SidePanel
        open
        size="standard"
        busy={mutation.isPending}
        title={t("pages.kiosks.form.createTitle")}
        closeLabel={t("common.close")}
        onClose={guard.requestClose}
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={mutation.isPending}
              onClick={guard.requestClose}
            >
              {t("pages.kiosks.cancel")}
            </Button>
            <Button type="submit" form={KIOSK_PROFILE_FORM_ID} loading={mutation.isPending}>
              {t("pages.kiosks.form.submitCreate")}
            </Button>
          </>
        }
      >
        <KioskProfileForm
          submitting={mutation.isPending}
          submissionError={error}
          onDirtyChange={guard.setDirty}
          onSubmit={async (input) => {
            try {
              setError(null);
              await mutation.mutateAsync(input);
              toast("ok", t("pages.kiosks.toasts.createSuccess"));
              guard.finish();
            } catch (cause) {
              setError(
                cause instanceof ApiRequestError
                  ? cause.message
                  : t("pages.kiosks.form.createError"),
              );
            }
          }}
        />
      </SidePanel>
      <DiscardDialog
        open={guard.confirmOpen}
        onCancel={guard.cancelDiscard}
        onConfirm={guard.confirmDiscard}
      />
    </>
  );
}
