import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Alert, Checkbox, Input } from "@markiro/ui";

import type { EmployeeRecord, OfficeOperator } from "../../host/protocol.js";
import { employeeCreate, employeeUpdate } from "../../host/requests.js";
import { operatorRoleRule, personNameRule, toOptionalText } from "../../lib/rules.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { operatorLabel } from "./employee-records.js";

const employeeFieldsSchema = z.object({
  name: personNameRule,
  role: operatorRoleRule,
  archived: z.boolean(),
});
type EmployeeFields = z.input<typeof employeeFieldsSchema>;

/** The host names an employee's fields as the form does. */
const EMPLOYEE_FIELDS = { name: "name", role: "role" } as const;

export interface EmployeeDialogProps {
  /** `null` adds an employee. */
  employee: EmployeeRecord | null;
  /** The operator the employee is linked to, when there is one. */
  operator: OfficeOperator | null;
  onClose: () => void;
  onSaved: (employee: EmployeeRecord) => void;
  /** The employee changed on the host: close and load the list again. */
  onReload: () => void;
}

/**
 * Adds an employee, or changes one: the host takes the whole record with the
 * loaded revision. Archiving is the `archived` flag (no delete), and an
 * archived employee is linked to no operator, so archiving a linked one
 * unlinks it in the same write; the operator keeps signing in, which the
 * dialog says before the write.
 */
export function EmployeeDialog({
  employee,
  operator,
  onClose,
  onSaved,
  onReload,
}: EmployeeDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const save = useOfficeMutation((api, token, values: EmployeeFields) => {
    const input = {
      name: values.name.trim(),
      role: toOptionalText(values.role),
      operatorId: employee?.operatorId ?? null,
    };
    return employee === null
      ? api.createEmployee(token, employeeCreate(input))
      : api.updateEmployee(
          token,
          employee.id,
          employeeUpdate(employee, { ...input, archived: values.archived }),
        );
  });
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<EmployeeFields>({
    resolver: zodResolver(employeeFieldsSchema),
    defaultValues: {
      name: employee?.name ?? "",
      role: employee?.role ?? "",
      archived: employee?.archived ?? false,
    },
  });
  const archiving = useWatch({ control, name: "archived" }) && employee?.archived === false;

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    let saved: EmployeeRecord;
    try {
      saved = await save.mutateAsync(values);
    } catch (error) {
      const outcome = writeFailure(error, EMPLOYEE_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
      return;
    }
    onSaved(saved);
  });

  return (
    <FormDialog
      title={
        employee === null
          ? t("office.employees.createTitle")
          : t("office.employees.editTitle", { name: employee.name })
      }
      submitLabel={employee === null ? t("office.employees.create") : t("office.common.save")}
      submitDisabled={employee !== null && !isDirty}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <Input
        label={t("office.employees.fields.name")}
        {...fieldError(errors.name?.message)}
        {...register("name")}
      />
      <Input
        label={t("office.employees.fields.role")}
        hint={t("office.employees.fields.roleHint")}
        {...fieldError(errors.role?.message)}
        {...register("role")}
      />
      {employee !== null && (
        <Controller
          control={control}
          name="archived"
          render={({ field }) => (
            <Checkbox
              label={t("office.employees.fields.archived")}
              checked={field.value}
              onCheckedChange={field.onChange}
            />
          )}
        />
      )}
      {archiving && operator !== null && (
        <Alert tone="warn">
          {t("office.employees.archiveUnlinks", { operator: operatorLabel(operator) })}
        </Alert>
      )}
    </FormDialog>
  );
}
