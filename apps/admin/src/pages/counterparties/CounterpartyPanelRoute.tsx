import { Alert, Button, ConfirmDialog, SidePanel, Spinner } from "@markiro/ui";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useRoutePanelGuard } from "../../lib/useRoutePanelGuard.js";
import {
  useCreateCounterparty,
  useUpdateCounterparty,
  type CounterpartyDto,
  type CreateCounterpartyInput,
} from "./api.js";
import { CounterpartyForm, type CounterpartyFormValues } from "./CounterpartyForm.js";

export interface CounterpartiesPanelContext {
  counterparties: CounterpartyDto[];
  counterpartiesPending: boolean;
  counterpartiesError: boolean;
  retryPanelData: () => Promise<void>;
}

export type CounterpartiesPanelLocationState = { counterpartiesBackground: true };

export function closeCounterpartyPanel(
  location: ReturnType<typeof useLocation>,
  navigate: ReturnType<typeof useNavigate>,
) {
  if (
    (location.state as CounterpartiesPanelLocationState | null)?.counterpartiesBackground === true
  ) {
    void navigate(-1);
  } else {
    void navigate("/counterparties", { replace: true });
  }
}

export function CounterpartyPanelRoute({ mode }: { mode: "create" | "edit" }) {
  return mode === "create" ? <CreateCounterpartyPanel /> : <EditCounterpartyPanel />;
}

function usePanelContext() {
  const context = useOutletContext<CounterpartiesPanelContext>();
  const location = useLocation();
  const navigate = useNavigate();
  const close = useCallback(() => closeCounterpartyPanel(location, navigate), [location, navigate]);
  return { context, close };
}

function PanelState({ mode }: { mode: "create" | "edit" }) {
  const { t } = useTranslation();
  const { context, close } = usePanelContext();
  const title =
    mode === "create"
      ? t("pages.counterparties.form.createTitle")
      : t("pages.counterparties.form.editTitle");
  if (context.counterpartiesPending) {
    return (
      <SidePanel open size="standard" title={title} closeLabel={t("common.close")} onClose={close}>
        <div className="mk-counterparty-panel-skeleton">
          <Spinner label={t("common.loading")} />
        </div>
      </SidePanel>
    );
  }
  if (context.counterpartiesError) {
    return (
      <SidePanel open size="standard" title={title} closeLabel={t("common.close")} onClose={close}>
        <Alert tone="error">{t("pages.counterparties.form.loadError")}</Alert>
        <Button type="button" variant="secondary" onClick={() => void context.retryPanelData()}>
          {t("pages.counterparties.form.retry")}
        </Button>
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
      title={t("pages.counterparties.form.discardTitle")}
      description={t("pages.counterparties.form.discardBody")}
      cancelLabel={t("pages.counterparties.form.continueEditing")}
      confirmLabel={t("pages.counterparties.form.discardAction")}
      tone="destructive"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  ) : null;
}

function CreateCounterpartyPanel() {
  const { t } = useTranslation();
  const { context, close } = usePanelContext();
  const mutation = useCreateCounterparty();
  const [error, setError] = useState<string | null>(null);
  const guard = useRoutePanelGuard(close, mutation.isPending);
  if (context.counterpartiesPending || context.counterpartiesError) {
    return <PanelState mode="create" />;
  }
  return (
    <>
      <CounterpartyForm
        mode="create"
        submitting={mutation.isPending}
        submissionError={error}
        onDirtyChange={guard.setDirty}
        onBusyChange={() => undefined}
        onClose={guard.requestClose}
        onSubmit={async (input) => {
          try {
            setError(null);
            await mutation.mutateAsync(input);
            toast("ok", t("pages.counterparties.toasts.createSuccess"));
            guard.finish();
          } catch (cause) {
            setError(
              cause instanceof ApiRequestError
                ? cause.message
                : t("pages.counterparties.toasts.createError"),
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

function EditCounterpartyPanel() {
  const { counterpartyId } = useParams();
  const { t } = useTranslation();
  const { context, close } = usePanelContext();
  const mutation = useUpdateCounterparty();
  const [ssccBusy, setSsccBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guard = useRoutePanelGuard(close, mutation.isPending || ssccBusy);
  const counterparty = context.counterparties.find((item) => item.id === counterpartyId);
  const gs1Prefixes = counterparty?.gs1Prefixes.join(", ");
  const initialValues = useMemo<CounterpartyFormValues | undefined>(
    () =>
      counterparty
        ? {
            name: counterparty.name,
            gln: counterparty.gln,
            inn: counterparty.inn ?? "",
            gs1Prefixes: gs1Prefixes ?? "",
            notes: counterparty.notes ?? "",
          }
        : undefined,
    // Primitive dependencies intentionally keep an unrelated list refetch from
    // replacing a dirty form's initial-value object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [counterparty?.gln, gs1Prefixes, counterparty?.inn, counterparty?.name, counterparty?.notes],
  );
  if (context.counterpartiesPending || context.counterpartiesError) {
    return <PanelState mode="edit" />;
  }
  if (!counterparty || !initialValues) {
    return (
      <SidePanel
        open
        size="standard"
        title={t("pages.counterparties.form.editTitle")}
        closeLabel={t("common.close")}
        onClose={close}
      >
        <Alert tone="warn">{t("pages.counterparties.form.notFound")}</Alert>
      </SidePanel>
    );
  }
  return (
    <>
      <CounterpartyForm
        mode="edit"
        initialValues={initialValues}
        counterpartyId={counterparty.id}
        submitting={mutation.isPending}
        submissionError={error}
        onDirtyChange={guard.setDirty}
        onBusyChange={setSsccBusy}
        onClose={guard.requestClose}
        onSubmit={async (input: CreateCounterpartyInput) => {
          try {
            setError(null);
            await mutation.mutateAsync({ id: counterparty.id, input });
            toast("ok", t("pages.counterparties.toasts.updateSuccess"));
            guard.finish();
          } catch (cause) {
            setError(
              cause instanceof ApiRequestError
                ? cause.message
                : t("pages.counterparties.toasts.updateError"),
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
