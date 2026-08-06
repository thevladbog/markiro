import { zodResolver } from "@hookform/resolvers/zod";
import type { TFunction } from "i18next";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Button, Input, Modal } from "@markiro/ui";

import { errorProp } from "../../lib/form-error.js";
import { type CreateEmployeeInput, type EmployeeDto } from "./api.js";
import { EmployeeBadgesSection } from "./EmployeeBadgesSection.js";
import { EmployeeStationAccessSection } from "./EmployeeStationAccessSection.js";

/**
 * Client-side mirror of the server's zod schema
 * (apps/api/src/modules/employees/dto.ts): fullName 1..200, role optional
 * (<=120). Error messages are i18n keys (resolved through `t()` at render
 * time) -- same convention as `pages/counterparties/CounterpartyForm.tsx`.
 */
const employeeFormSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(1, "pages.employees.form.errors.fullNameRequired")
    .max(200, "pages.employees.form.errors.fullNameTooLong"),
  role: z.string().trim().max(120, "pages.employees.form.errors.roleTooLong").optional(),
});

export type EmployeeFormValues = z.infer<typeof employeeFormSchema>;

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

const EMPTY_VALUES: EmployeeFormValues = { fullName: "", role: "" };

const FORM_ID = "employee-form";
const NOOP_SECTION_REPORTER = () => undefined;

/** Converts a possibly-undefined zod issue message (an i18n key) into translated text. */
function translateFieldError(t: TFunction, message: string | undefined): string | undefined {
  return message ? t(message) : undefined;
}

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

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<EmployeeFormValues>({
    resolver: zodResolver(employeeFormSchema),
    defaultValues: initialValues ?? EMPTY_VALUES,
  });

  // Re-seed the form whenever the modal opens -- see
  // CounterpartyForm.tsx's identical effect for the rationale (`reset` is a
  // stable react-hook-form reference, intentionally left out of the deps).
  useEffect(() => {
    if (open) {
      reset(initialValues ?? EMPTY_VALUES);
    }
  }, [open, initialValues, reset]);

  const submit = handleSubmit(async (values) => {
    await onSubmit(toCreateInput(values));
  });

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
          <Button type="submit" form={FORM_ID} loading={submitting}>
            {mode === "create"
              ? t("pages.employees.form.submitCreate")
              : t("pages.employees.form.submitUpdate")}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <form
          id={FORM_ID}
          onSubmit={(event) => void submit(event)}
          noValidate
          style={{ display: "flex", flexDirection: "column", gap: 16 }}
        >
          <Input
            label={t("pages.employees.form.fullNameLabel")}
            {...errorProp(translateFieldError(t, errors.fullName?.message))}
            {...register("fullName")}
          />
          <Input
            label={t("pages.employees.form.roleLabel")}
            {...errorProp(translateFieldError(t, errors.role?.message))}
            {...register("role")}
          />
        </form>

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

/** Normalizes raw form values into the API's create/update payload shape. */
function toCreateInput(values: EmployeeFormValues): CreateEmployeeInput {
  const role = values.role?.trim();
  return {
    fullName: values.fullName.trim(),
    role: role ? role : null,
  };
}
