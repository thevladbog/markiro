import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Select } from "@markiro/ui";

import type { EmployeeRecord, OfficeOperator } from "../../host/protocol.js";
import { employeeCreate, employeeUpdate } from "../../host/requests.js";
import { operatorLabel } from "../employees/employee-records.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";

/** The choice that creates an employee from the operator's name and role. */
const NEW_EMPLOYEE = "new";

/** A refused link, under the choice. */
const LINK_FIELDS = {
  operatorId: { field: "choice", message: "office.employees.errors.operatorGone" },
  name: { field: "choice", message: "rules.rejected" },
  role: { field: "choice", message: "rules.rejected" },
} as const;
const LINK_CONFLICTS = {
  operator: { field: "choice", message: "office.employees.errors.operatorTaken" },
} as const;

type Write =
  | { kind: "link"; employee: EmployeeRecord }
  | { kind: "create" }
  | { kind: "unlink"; employee: EmployeeRecord };

export interface OperatorEmployeeDialogProps {
  operator: OfficeOperator;
  /** The employee linked to the operator: the dialog then offers to unlink. */
  linked: EmployeeRecord | null;
  /** The employees in use and linked to nobody. */
  free: readonly EmployeeRecord[];
  onClose: () => void;
  /** The employee the write changed or created, and how it ended. */
  onSaved: (employee: EmployeeRecord, outcome: Write["kind"]) => void;
  /** The employees changed on the host: close and load them again. */
  onReload: () => void;
}

/**
 * Links an operator to an employee, creates an employee from the operator
 * (its name and role, in one write), or unlinks the employee it has. The
 * link is the employee's: the operator record is never written, so its
 * personnel number, PIN, badges and the stations' copies stay as they are.
 */
export function OperatorEmployeeDialog({
  operator,
  linked,
  free,
  onClose,
  onSaved,
  onReload,
}: OperatorEmployeeDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [choice, setChoice] = useState("");
  const [choiceError, setChoiceError] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const save = useOfficeMutation((api, token, write: Write) => {
    if (write.kind === "create") {
      return api.createEmployee(
        token,
        employeeCreate({ name: operator.name, role: operator.role, operatorId: operator.id }),
      );
    }
    const { employee } = write;
    return api.updateEmployee(
      token,
      employee.id,
      employeeUpdate(employee, {
        name: employee.name,
        role: employee.role,
        operatorId: write.kind === "link" ? operator.id : null,
        archived: employee.archived,
      }),
    );
  });

  const send = async (write: Write) => {
    setFailure(null);
    setChoiceError(undefined);
    let saved: EmployeeRecord;
    try {
      saved = await save.mutateAsync(write);
    } catch (error) {
      const outcome = writeFailure(error, LINK_FIELDS, LINK_CONFLICTS);
      if (outcome.kind === "field") setChoiceError(outcome.message);
      else setFailure(outcome);
      return;
    }
    onSaved(saved, write.kind);
  };

  if (linked !== null) {
    return (
      <FormDialog
        title={t("office.employees.unlink.title")}
        submitLabel={t("office.employees.unlink.submit")}
        submitVariant="destructive"
        onSubmit={() => send({ kind: "unlink", employee: linked })}
        onClose={onClose}
        alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
      >
        <p>
          {t("office.operators.link.unlinkBody", {
            operator: operatorLabel(operator),
            employee: linked.name,
          })}
        </p>
      </FormDialog>
    );
  }

  const submit = async () => {
    if (choice === NEW_EMPLOYEE) {
      await send({ kind: "create" });
      return;
    }
    const employee = free.find((each) => each.id === choice);
    if (employee === undefined) {
      setChoiceError("office.employees.errors.chooseOne");
      return;
    }
    await send({ kind: "link", employee });
  };

  return (
    <FormDialog
      title={t("office.operators.link.title", { name: operator.name })}
      submitLabel={t(
        choice === NEW_EMPLOYEE
          ? "office.operators.link.submitNew"
          : "office.operators.link.submit",
      )}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <Select
        native
        label={t("office.operators.link.field")}
        hint={t("office.operators.link.hint")}
        options={[
          { value: "", label: t("office.operators.link.choose") },
          {
            value: NEW_EMPLOYEE,
            label: t("office.operators.link.newEmployee", { name: operator.name }),
          },
          ...free.map((employee) => ({ value: employee.id, label: employee.name })),
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
