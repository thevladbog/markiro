import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, ConfirmDialog, Input, StatusChip } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import type { EmployeeDto } from "./api.js";
import {
  useGrantStationAccess,
  useOperators,
  useRevokeStationAccess,
  useResetStationAccessPin,
  useUpdateStationAccess,
} from "./station-access-api.js";

export type EmployeeAccessSectionStatus = "loading" | "error" | "none" | "active" | "disabled";

export interface EmployeeStationAccessSectionProps {
  employee: EmployeeDto;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onErrorChange: (hasError: boolean) => void;
  onStatusChange: (status: EmployeeAccessSectionStatus) => void;
}

function accessError(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback;
}

/**
 * Owns line-station credentials independently from the employee profile and
 * badge resources. Login and PIN stay transient; only the established
 * operators hooks cross the API boundary.
 */
export function EmployeeStationAccessSection({
  employee,
  onDirtyChange,
  onBusyChange,
  onErrorChange,
  onStatusChange,
}: EmployeeStationAccessSectionProps) {
  const { t } = useTranslation();
  const query = useOperators();
  const grantMutation = useGrantStationAccess();
  const resetPinMutation = useResetStationAccessPin();
  const updateMutation = useUpdateStationAccess();
  const revokeMutation = useRevokeStationAccess();
  const [login, setLogin] = useState("");
  const [pin, setPin] = useState("");
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [draftConflict, setDraftConflict] = useState(false);
  const previousAccessPresenceRef = useRef<boolean | null>(null);

  const access = query.data?.find((item) => item.employeeId === employee.id);
  const status: EmployeeAccessSectionStatus = query.isPending
    ? "loading"
    : query.isError
      ? "error"
      : !access
        ? "none"
        : access.active
          ? "active"
          : "disabled";
  const dirty = login.trim().length > 0 || pin.trim().length > 0;
  const busy =
    grantMutation.isPending ||
    resetPinMutation.isPending ||
    updateMutation.isPending ||
    revokeMutation.isPending;
  const hasError = query.isError || mutationError !== null || revokeError !== null;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
  useEffect(() => onErrorChange(hasError), [hasError, onErrorChange]);
  useEffect(() => onStatusChange(status), [onStatusChange, status]);
  useEffect(() => {
    if (query.data === undefined) return;

    const hasAccess = access !== undefined;
    const previousAccessPresence = previousAccessPresenceRef.current;
    if (previousAccessPresence === false && hasAccess && dirty) setDraftConflict(true);
    if (!dirty) setDraftConflict(false);
    previousAccessPresenceRef.current = hasAccess;
  }, [access, dirty, query.data]);

  async function runAccess(action: () => Promise<unknown>): Promise<boolean> {
    try {
      setMutationError(null);
      await action();
      toast("ok", t("pages.employees.toasts.stationAccessSuccess"));
      return true;
    } catch (cause) {
      setMutationError(accessError(cause, t("pages.employees.toasts.stationAccessError")));
      return false;
    }
  }

  const grantAccess = async () => {
    if (busy) return;
    const nextLogin = login.trim();
    const nextPin = pin.trim();
    if (!nextLogin || !nextPin) return;

    const succeeded = await runAccess(() =>
      grantMutation.grant({
        employeeId: employee.id,
        input: { login: nextLogin, pin: nextPin },
      }),
    );
    if (succeeded) {
      setLogin("");
      setPin("");
    }
  };

  const resetPin = async () => {
    if (busy) return;
    const nextPin = pin.trim();
    if (!nextPin) return;

    const succeeded = await runAccess(() =>
      resetPinMutation.resetPin({ employeeId: employee.id, pin: nextPin }),
    );
    if (succeeded) setPin("");
  };

  const toggleAccess = async () => {
    if (busy || !access) return;
    await runAccess(() =>
      updateMutation.mutateAsync({
        employeeId: employee.id,
        input: { active: !access.active },
      }),
    );
  };

  const openRevokeConfirmation = () => {
    if (busy) return;
    setRevokeError(null);
    setRevokeOpen(true);
  };

  const closeRevokeConfirmation = () => {
    if (revokeMutation.isPending) return;
    setRevokeOpen(false);
    setRevokeError(null);
  };

  const discardAccessDraft = () => {
    setLogin("");
    setPin("");
    setDraftConflict(false);
  };

  const revokeAccess = async () => {
    if (busy) return;
    try {
      setRevokeError(null);
      await revokeMutation.mutateAsync(employee.id);
      toast("ok", t("pages.employees.toasts.stationAccessSuccess"));
      setRevokeOpen(false);
    } catch (cause) {
      setRevokeError(accessError(cause, t("pages.employees.stationAccess.revokeError")));
    }
  };

  return (
    <>
      <section
        className="mk-employee-station-access-section"
        role="region"
        aria-label={t("pages.employees.stationAccess.title")}
      >
        <h3 className="mk-employee-station-access-section__title" tabIndex={-1}>
          {t("pages.employees.stationAccess.title")}
        </h3>

        {mutationError ? <Alert tone="error">{mutationError}</Alert> : null}
        {access && draftConflict && dirty ? (
          <div className="mk-employee-station-access-section__draft-conflict">
            <Alert tone="warn">{t("pages.employees.stationAccess.draftConflict")}</Alert>
            <Button
              type="button"
              size="compact"
              variant="secondary"
              disabled={busy}
              onClick={discardAccessDraft}
            >
              {t("pages.employees.stationAccess.discardDraftAction")}
            </Button>
          </div>
        ) : null}

        {status === "loading" ? (
          <div className="mk-employee-station-access-section__skeleton">
            <span className="mk-employee-station-access-section__skeleton-line" />
            <span className="mk-employee-station-access-section__loading-label" role="status">
              {t("pages.employees.stationAccess.loading")}
            </span>
          </div>
        ) : status === "error" ? (
          <div className="mk-employee-station-access-section__error-state">
            <Alert tone="error">{t("pages.employees.stationAccess.loadError")}</Alert>
            <Button
              type="button"
              size="compact"
              variant="secondary"
              disabled={busy}
              onClick={() => void query.refetch()}
            >
              {t("pages.employees.stationAccess.retryAction")}
            </Button>
          </div>
        ) : access ? (
          <>
            <div className="mk-employee-station-access-section__identity">
              <span className="mk-employee-station-access-section__current">
                {t("pages.employees.stationAccess.current", { login: access.login })}
              </span>
              <div className="mk-employee-station-access-section__actions">
                <StatusChip
                  status={access.active ? "ok" : "neutral"}
                  label={
                    access.active
                      ? t("pages.employees.stationAccess.activeBadge")
                      : t("pages.employees.stationAccess.disabledBadge")
                  }
                />
                <Button
                  type="button"
                  size="compact"
                  variant="secondary"
                  disabled={busy}
                  loading={updateMutation.isPending}
                  onClick={() => void toggleAccess()}
                >
                  {access.active
                    ? t("pages.employees.stationAccess.disableAction")
                    : t("pages.employees.stationAccess.enableAction")}
                </Button>
                <Button
                  type="button"
                  size="compact"
                  variant="destructive"
                  disabled={busy}
                  onClick={openRevokeConfirmation}
                >
                  {t("pages.employees.stationAccess.revokeAction")}
                </Button>
              </div>
            </div>

            <div className="mk-employee-station-access-section__form-row">
              <Input
                label={t("pages.employees.stationAccess.pinLabel")}
                mono
                inputMode="numeric"
                type="password"
                value={pin}
                disabled={busy}
                onChange={(event) => setPin(event.target.value)}
              />
              <Button
                type="button"
                size="compact"
                disabled={busy || pin.trim().length === 0}
                loading={resetPinMutation.isPending}
                onClick={() => void resetPin()}
              >
                {t("pages.employees.stationAccess.resetAction")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="mk-employee-station-access-section__empty">
              {t("pages.employees.stationAccess.emptyHint")}
            </p>
            <div className="mk-employee-station-access-section__form-row">
              <Input
                label={t("pages.employees.stationAccess.loginLabel")}
                mono
                inputMode="numeric"
                value={login}
                disabled={busy}
                onChange={(event) => setLogin(event.target.value)}
              />
              <Input
                label={t("pages.employees.stationAccess.pinLabel")}
                mono
                inputMode="numeric"
                type="password"
                value={pin}
                disabled={busy}
                onChange={(event) => setPin(event.target.value)}
              />
              <Button
                type="button"
                size="compact"
                disabled={busy || login.trim().length === 0 || pin.trim().length === 0}
                loading={grantMutation.isPending}
                onClick={() => void grantAccess()}
              >
                {t("pages.employees.stationAccess.grantAction")}
              </Button>
            </div>
          </>
        )}
      </section>

      <ConfirmDialog
        open={revokeOpen}
        title={t("pages.employees.stationAccess.revokeTitle")}
        description={t("pages.employees.stationAccess.revokeBody")}
        entity={employee.fullName}
        error={revokeError ?? undefined}
        confirmLabel={t("pages.employees.stationAccess.revokeConfirmAction")}
        cancelLabel={t("pages.employees.cancel")}
        tone="destructive"
        busy={busy}
        onConfirm={() => void revokeAccess()}
        onCancel={closeRevokeConfirmation}
      />
    </>
  );
}
