import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Select } from "@markiro/ui";

import type { EmployeeRecord, OfficeOperator } from "../../host/protocol.js";
import { employeeUpdate } from "../../host/requests.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { searchableSelect } from "../select-search.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { operatorLabel, operatorStateLabel } from "./employee-records.js";

/** The choice that opens the operator form instead of linking an existing operator. */
export const NEW_OPERATOR = "new";

/** A refused link, under the choice. */
const LINK_FIELDS = {
  operatorId: { field: "choice", message: "office.employees.errors.operatorGone" },
} as const;
const LINK_CONFLICTS = {
  operator: { field: "choice", message: "office.employees.errors.operatorTaken" },
} as const;

export interface EmployeeOperatorDialogProps {
  employee: EmployeeRecord;
  /** The operator the employee is linked to: the dialog then offers to unlink. */
  linked: OfficeOperator | null;
  /** The operators no employee holds. */
  free: readonly OfficeOperator[];
  onClose: () => void;
  /** The link or the unlink was written. */
  onSaved: (employee: EmployeeRecord) => void;
  /** «Новый оператор…» was chosen: open the operator form for this employee. */
  onNewOperator: () => void;
  /** The employee changed on the host: close and load the list again. */
  onReload: () => void;
}

/**
 * Links an employee to an operator, or unlinks the one it has. The link
 * says which person an operator is; it grants nothing, so the operator's
 * personnel number, PIN, badges and access stay as they are, and the
 * stations' copies do not change. A new operator for the employee is made
 * with the operator form, prefilled with the employee's name and role.
 */
export function EmployeeOperatorDialog({
  employee,
  linked,
  free,
  onClose,
  onSaved,
  onNewOperator,
  onReload,
}: EmployeeOperatorDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [choice, setChoice] = useState("");
  const [choiceError, setChoiceError] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const save = useOfficeMutation((api, token, operatorId: string | null) =>
    api.updateEmployee(
      token,
      employee.id,
      employeeUpdate(employee, {
        name: employee.name,
        role: employee.role,
        operatorId,
        archived: employee.archived,
      }),
    ),
  );

  const write = async (operatorId: string | null) => {
    setFailure(null);
    setChoiceError(undefined);
    let saved: EmployeeRecord;
    try {
      saved = await save.mutateAsync(operatorId);
    } catch (error) {
      const outcome = writeFailure(error, LINK_FIELDS, LINK_CONFLICTS);
      if (outcome.kind === "field") setChoiceError(outcome.message);
      else setFailure(outcome);
      return;
    }
    onSaved(saved);
  };

  if (employee.operatorId !== null) {
    return (
      <FormDialog
        title={t("office.employees.unlink.title")}
        submitLabel={t("office.employees.unlink.submit")}
        submitVariant="destructive"
        onSubmit={() => write(null)}
        onClose={onClose}
        alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
      >
        <p>
          {t("office.employees.unlink.body", {
            name: employee.name,
            operator: linked === null ? t("office.common.none") : operatorLabel(linked),
          })}
        </p>
      </FormDialog>
    );
  }

  const submit = async () => {
    if (choice === NEW_OPERATOR) {
      onNewOperator();
      return;
    }
    if (choice === "") {
      setChoiceError("office.employees.errors.chooseOne");
      return;
    }
    await write(choice);
  };

  return (
    <FormDialog
      title={t("office.employees.link.title", { name: employee.name })}
      submitLabel={t(
        choice === NEW_OPERATOR
          ? "office.employees.link.submitNew"
          : "office.employees.link.submit",
      )}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <Select
        {...searchableSelect(t)}
        label={t("office.employees.link.field")}
        hint={t(free.length === 0 ? "office.employees.link.none" : "office.employees.link.hint")}
        options={[
          { value: "", label: t("office.employees.link.choose") },
          { value: NEW_OPERATOR, label: t("office.employees.link.newOperator") },
          ...free.map((operator) => ({
            value: operator.id,
            label: operatorStateLabel(operator, t),
          })),
        ]}
        value={choice}
        onValueChange={(value) => {
          setChoice(value);
          setChoiceError(undefined);
        }}
        {...fieldError(choiceError)}
      />
    </FormDialog>
  );
}
