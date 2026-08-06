import { useTranslation } from "react-i18next";

import { Button, Modal } from "@markiro/ui";

import { type CreateEmployeeInput, type EmployeeDto } from "./api.js";
import { EmployeeBadgesSection } from "./EmployeeBadgesSection.js";
import {
  EMPLOYEE_PROFILE_FORM_ID,
  EmployeeProfileForm,
  type EmployeeFormValues,
} from "./EmployeeProfileForm.js";
import { EmployeeStationAccessSection } from "./EmployeeStationAccessSection.js";

export type { EmployeeFormValues } from "./EmployeeProfileForm.js";

export interface EmployeeFormProps {
  open: boolean;
  mode: "create" | "edit";
  /** The employee being edited -- only set in edit mode. Drives the badges sub-panel (id + badges list) below the fields. */
  employee?: EmployeeDto;
  initialValues?: EmployeeFormValues;
  submitting?: boolean;
  onSubmit: (input: CreateEmployeeInput) => void | Promise<void>;
  onClose: () => void;
}

const NOOP_SECTION_REPORTER = () => undefined;

export function EmployeeForm({
  open,
  mode,
  employee,
  initialValues,
  submitting = false,
  onSubmit,
  onClose,
}: EmployeeFormProps) {
  const { t } = useTranslation();

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeLabel={t("common.close")}
      title={
        mode === "create"
          ? t("pages.employees.form.createTitle")
          : t("pages.employees.form.editTitle")
      }
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("pages.employees.cancel")}
          </Button>
          <Button type="submit" form={EMPLOYEE_PROFILE_FORM_ID} loading={submitting}>
            {mode === "create"
              ? t("pages.employees.form.submitCreate")
              : t("pages.employees.form.submitUpdate")}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <EmployeeProfileForm
          mode={mode}
          {...(initialValues ? { initialValues } : {})}
          submitting={submitting}
          submissionError={null}
          onSubmit={onSubmit}
          onDirtyChange={NOOP_SECTION_REPORTER}
        />

        {mode === "edit" && employee ? (
          <EmployeeBadgesSection
            employee={employee}
            onDirtyChange={NOOP_SECTION_REPORTER}
            onBusyChange={NOOP_SECTION_REPORTER}
            onErrorChange={NOOP_SECTION_REPORTER}
          />
        ) : null}

        {mode === "edit" && employee ? (
          <EmployeeStationAccessSection
            employee={employee}
            onDirtyChange={NOOP_SECTION_REPORTER}
            onBusyChange={NOOP_SECTION_REPORTER}
            onErrorChange={NOOP_SECTION_REPORTER}
            onStatusChange={NOOP_SECTION_REPORTER}
          />
        ) : null}
      </div>
    </Modal>
  );
}
