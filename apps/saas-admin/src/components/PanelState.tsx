import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Spinner } from "@markiro/ui";

import { ApiRequestError, type ApiErrorKind } from "../api/client.js";

export function PanelState({
  loading,
  empty,
  error,
  onRetry,
  loadingText,
  emptyText,
  children,
}: {
  loading: boolean;
  empty: boolean;
  error: unknown;
  onRetry?: () => void;
  loadingText?: string;
  emptyText?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();

  if (loading) {
    const label = loadingText ?? t("panelState.loading");
    return (
      <div className="panel-state panel-state--loading">
        <Spinner label={label} />
        <span>{label}</span>
      </div>
    );
  }

  if (error) {
    const apiError = error instanceof ApiRequestError ? error : null;
    const kind: ApiErrorKind = apiError?.kind ?? "domain";
    const canRetry = kind !== "authorization" && onRetry !== undefined;
    const requestId = apiError?.requestId ?? null;
    const contractEndpoint = kind === "contract" ? apiError?.endpoint : null;
    return (
      <Alert title={t(`panelState.errors.${kind}.title`)} tone="error">
        <p>{t(`panelState.errors.${kind}.body`)}</p>
        {contractEndpoint ? (
          <p>{t("panelState.contractEndpoint", { endpoint: contractEndpoint })}</p>
        ) : null}
        {requestId ? (
          <p className="panel-state__request-id">
            <span>{t("panelState.requestId", { requestId })}</span>
            <Button
              variant="secondary"
              onClick={() => {
                try {
                  void navigator.clipboard?.writeText(requestId).catch(() => undefined);
                } catch {
                  // Clipboard permissions are optional; the visible request ID remains usable.
                }
              }}
            >
              {t("panelState.copyRequestId")}
            </Button>
          </p>
        ) : null}
        {canRetry ? (
          <Button variant="secondary" onClick={onRetry}>
            {t("panelState.retry")}
          </Button>
        ) : null}
      </Alert>
    );
  }

  if (empty) {
    return <p className="panel-state panel-state--empty">{emptyText ?? t("panelState.empty")}</p>;
  }

  return children;
}
