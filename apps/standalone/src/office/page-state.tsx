import { useTranslation } from "react-i18next";

import { Alert, Button, Spinner } from "@markiro/ui";

import { errorMessageKey } from "../host/errors.js";
import { failureMessage, failureValues, type AlertFailure } from "./form-errors.js";

/** An office page while its data loads. */
export function PageLoading() {
  const { t } = useTranslation();
  return <Spinner label={t("office.common.loading")} />;
}

export interface LoadErrorProps {
  error: unknown;
  onRetry: () => void;
}

/** An office page whose data did not load. */
export function LoadError({ error, onRetry }: LoadErrorProps) {
  const { t } = useTranslation();
  return (
    <Alert
      tone="error"
      action={
        <Button variant="secondary" size="compact" onClick={onRetry}>
          {t("office.common.retry")}
        </Button>
      }
    >
      {t(errorMessageKey(error))}
    </Alert>
  );
}

export interface StaleAlertProps {
  onReload: () => void;
  /** The i18n key of the text, when the form knows what else moves its revision. */
  message?: string;
}

/** A write the host refused as stale: reloading shows the new data and drops this form's edits. */
export function StaleAlert({ onReload, message = "errors.api.stale_revision" }: StaleAlertProps) {
  const { t } = useTranslation();
  return (
    <Alert
      tone="warn"
      action={
        <Button variant="secondary" size="compact" onClick={onReload}>
          {t("office.common.reload")}
        </Button>
      }
    >
      {t(message)}
    </Alert>
  );
}

export interface WriteFailureAlertProps {
  /** `null` shows nothing. */
  failure: AlertFailure | null;
  /** Loads the data again after a stale write; without it a stale write is only explained. */
  onReload?: () => void;
  /** The i18n key of the reload's text (`StaleAlert`'s `message`); the general one without it. */
  staleMessage?: string;
}

/** A failed write above a form: a stale one offers to reload when the form can, the rest are explained. */
export function WriteFailureAlert({ failure, onReload, staleMessage }: WriteFailureAlertProps) {
  const { t } = useTranslation();
  if (failure === null) return null;
  if (failure.kind === "stale" && onReload !== undefined) {
    return (
      <StaleAlert
        onReload={onReload}
        {...(staleMessage === undefined ? {} : { message: staleMessage })}
      />
    );
  }
  return <Alert tone="error">{t(failureMessage(failure), failureValues(failure) ?? {})}</Alert>;
}
