import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router";

import { Alert, Button, ConfirmDialog, SidePanel, Spinner } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useRoutePanelGuard } from "../../lib/useRoutePanelGuard.js";
import { useCreateLine, useUpdateLine, type CreateLineInput, type LineDto } from "../shifts/api.js";
import { LineForm } from "./LineForm.js";

export interface LinesPanelContext {
  lines: LineDto[];
  linesPending: boolean;
  linesError: boolean;
  retryPanelData: () => Promise<void>;
}

export type LinesPanelLocationState = { linesBackground: true };

export function closeLinePanel(
  location: ReturnType<typeof useLocation>,
  navigate: ReturnType<typeof useNavigate>,
) {
  if ((location.state as LinesPanelLocationState | null)?.linesBackground === true) {
    void navigate(-1);
  } else {
    void navigate("/lines", { replace: true });
  }
}

export function LinePanelRoute({ mode }: { mode: "create" | "edit" }) {
  return mode === "create" ? <CreateLinePanel /> : <EditLinePanel />;
}

function usePanelContext() {
  const context = useOutletContext<LinesPanelContext>();
  const location = useLocation();
  const navigate = useNavigate();
  const close = useCallback(() => closeLinePanel(location, navigate), [location, navigate]);
  return { context, close };
}

function PanelState({ mode }: { mode: "create" | "edit" }) {
  const { t } = useTranslation();
  const { context, close } = usePanelContext();
  const title =
    mode === "create" ? t("pages.lines.form.createTitle") : t("pages.lines.form.editTitle");

  if (context.linesPending) {
    return (
      <SidePanel open size="standard" title={title} closeLabel={t("common.close")} onClose={close}>
        <div className="mk-line-panel-skeleton">
          <Spinner label={t("common.loading")} />
        </div>
      </SidePanel>
    );
  }

  if (context.linesError) {
    return (
      <SidePanel open size="standard" title={title} closeLabel={t("common.close")} onClose={close}>
        <div className="mk-line-section-state">
          <Alert tone="error">{t("pages.lines.form.loadError")}</Alert>
          <Button type="button" variant="secondary" onClick={() => void context.retryPanelData()}>
            {t("pages.lines.form.retry")}
          </Button>
        </div>
      </SidePanel>
    );
  }

  return null;
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
  return open ? (
    <ConfirmDialog
      open
      title={t("pages.lines.form.discardTitle")}
      description={t("pages.lines.form.discardBody")}
      cancelLabel={t("pages.lines.form.continueEditing")}
      confirmLabel={t("pages.lines.form.discardAction")}
      tone="destructive"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  ) : null;
}

function requestError(cause: unknown, fallback: string, subscriptionLimitReached: string): string {
  if (cause instanceof ApiRequestError && cause.code === "subscription_limit_reached") {
    return subscriptionLimitReached;
  }

  return fallback;
}

function CreateLinePanel() {
  const { t } = useTranslation();
  const { context, close } = usePanelContext();
  const mutation = useCreateLine();
  const [error, setError] = useState<string | null>(null);
  const guard = useRoutePanelGuard(close, mutation.isPending);

  if (context.linesPending || context.linesError) return <PanelState mode="create" />;

  return (
    <>
      <LineForm
        mode="create"
        submitting={mutation.isPending}
        submissionError={error}
        onDirtyChange={guard.setDirty}
        onClose={guard.requestClose}
        onSubmit={async (input: CreateLineInput) => {
          try {
            setError(null);
            await mutation.mutateAsync(input);
            toast("ok", t("pages.lines.toasts.createSuccess"));
            guard.finish();
          } catch (cause) {
            setError(
              requestError(
                cause,
                t("pages.lines.toasts.createError"),
                t("pages.lines.form.errors.subscriptionLimitReached"),
              ),
            );
          }
        }}
      />
      <DiscardDialog
        open={guard.confirmOpen}
        onCancel={guard.cancelDiscard}
        onConfirm={guard.confirmDiscard}
      />
    </>
  );
}

function EditLinePanel() {
  const { lineId } = useParams();
  const { t } = useTranslation();
  const { context, close } = usePanelContext();
  const mutation = useUpdateLine();
  const [error, setError] = useState<string | null>(null);
  const guard = useRoutePanelGuard(close, mutation.isPending);
  const line = context.lines.find((item) => item.id === lineId);

  if (context.linesPending || context.linesError) return <PanelState mode="edit" />;

  if (!line) {
    return (
      <SidePanel
        open
        size="standard"
        title={t("pages.lines.form.editTitle")}
        closeLabel={t("common.close")}
        onClose={close}
      >
        <Alert tone="warn">{t("pages.lines.form.notFound")}</Alert>
      </SidePanel>
    );
  }

  return (
    <>
      <LineForm
        mode="edit"
        initialName={line.name}
        submitting={mutation.isPending}
        submissionError={error}
        onDirtyChange={guard.setDirty}
        onClose={guard.requestClose}
        onSubmit={async (input: CreateLineInput) => {
          try {
            setError(null);
            await mutation.mutateAsync({ id: line.id, input });
            toast("ok", t("pages.lines.toasts.updateSuccess"));
            guard.finish();
          } catch (cause) {
            setError(
              requestError(
                cause,
                t("pages.lines.toasts.updateError"),
                t("pages.lines.form.errors.subscriptionLimitReached"),
              ),
            );
          }
        }}
      />
      <DiscardDialog
        open={guard.confirmOpen}
        onCancel={guard.cancelDiscard}
        onConfirm={guard.confirmDiscard}
      />
    </>
  );
}
