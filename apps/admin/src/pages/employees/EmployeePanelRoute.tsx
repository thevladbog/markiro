import { Alert, Button, ConfirmDialog, SidePanel, Spinner } from "@markiro/ui";
import { useCallback, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useOutletContext } from "react-router";
import type { Location, NavigateFunction } from "react-router";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useRoutePanelGuard } from "../../lib/useRoutePanelGuard.js";
import { useCreateEmployee, type EmployeeDto } from "./api.js";
import { EMPLOYEE_PROFILE_FORM_ID, EmployeeProfileForm } from "./EmployeeProfileForm.js";

export interface EmployeesPanelContext {
  employees: EmployeeDto[];
  employeesPending: boolean;
  employeesError: boolean;
  retryPanelData: () => Promise<void>;
}

export type EmployeesPanelLocationState = { employeesBackground: true };

export function closeEmployeePanel(location: Location, navigate: NavigateFunction) {
  if ((location.state as EmployeesPanelLocationState | null)?.employeesBackground === true) {
    void navigate(-1);
  } else {
    void navigate("/employees", { replace: true });
  }
}

function usePanelContext() {
  const context = useOutletContext<EmployeesPanelContext>();
  const location = useLocation();
  const navigate = useNavigate();
  const close = useCallback(() => closeEmployeePanel(location, navigate), [location, navigate]);
  return { context, close };
}

function PanelState() {
  const { t } = useTranslation();
  const { context, close } = usePanelContext();
  const title = t("pages.employees.form.createTitle");

  return (
    <SidePanel open size="standard" title={title} closeLabel={t("common.close")} onClose={close}>
      {context.employeesPending ? (
        <div className="mk-employee-panel-skeleton">
          <Spinner label={t("common.loading")} />
        </div>
      ) : (
        <div className="mk-employees-section-state">
          <Alert tone="error">{t("pages.employees.form.loadError")}</Alert>
          <div>
            <Button type="button" variant="secondary" onClick={() => void context.retryPanelData()}>
              {t("pages.employees.form.retry")}
            </Button>
          </div>
        </div>
      )}
    </SidePanel>
  );
}

export function EmployeeCreatePanelRoute(): ReactElement {
  const { t } = useTranslation();
  const { context, close } = usePanelContext();
  const mutation = useCreateEmployee();
  const [error, setError] = useState<string | null>(null);
  const guard = useRoutePanelGuard(close, mutation.isPending);

  if (context.employeesPending || context.employeesError) return <PanelState />;

  return (
    <>
      <SidePanel
        open
        size="standard"
        busy={mutation.isPending}
        title={t("pages.employees.form.createTitle")}
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
              {t("pages.employees.cancel")}
            </Button>
            <Button type="submit" form={EMPLOYEE_PROFILE_FORM_ID} loading={mutation.isPending}>
              {t("pages.employees.form.submitCreate")}
            </Button>
          </>
        }
      >
        <EmployeeProfileForm
          mode="create"
          submitting={mutation.isPending}
          submissionError={error}
          onDirtyChange={guard.setDirty}
          onSubmit={async (input) => {
            try {
              setError(null);
              await mutation.mutateAsync(input);
              toast("ok", t("pages.employees.toasts.createSuccess"));
              guard.finish();
            } catch (cause) {
              setError(
                cause instanceof ApiRequestError
                  ? cause.message
                  : t("pages.employees.toasts.createError"),
              );
            }
          }}
        />
      </SidePanel>
      {guard.confirmOpen ? (
        <ConfirmDialog
          open
          title={t("pages.employees.form.discardTitle")}
          description={t("pages.employees.form.discardBody")}
          cancelLabel={t("pages.employees.form.continueEditing")}
          confirmLabel={t("pages.employees.form.discardAction")}
          tone="destructive"
          onCancel={guard.cancelDiscard}
          onConfirm={guard.confirmDiscard}
        />
      ) : null}
    </>
  );
}
