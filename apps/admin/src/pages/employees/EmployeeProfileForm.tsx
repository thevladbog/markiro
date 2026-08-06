import { zodResolver } from "@hookform/resolvers/zod";
import type { TFunction } from "i18next";
import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Alert, Input } from "@markiro/ui";

import { errorProp } from "../../lib/form-error.js";
import type { CreateEmployeeInput } from "./api.js";

const employeeFormSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(1, "pages.employees.form.errors.fullNameRequired")
    .max(200, "pages.employees.form.errors.fullNameTooLong"),
  role: z.string().trim().max(120, "pages.employees.form.errors.roleTooLong").optional(),
});

export type EmployeeFormValues = z.infer<typeof employeeFormSchema>;

export const EMPLOYEE_PROFILE_FORM_ID = "employee-profile-form";

export interface EmployeeProfileFormProps {
  mode: "create" | "edit";
  initialValues?: EmployeeFormValues;
  submitting: boolean;
  submissionError: string | null;
  onSubmit: (input: CreateEmployeeInput) => void | Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}

const EMPTY_VALUES: EmployeeFormValues = { fullName: "", role: "" };

function translateFieldError(t: TFunction, message: string | undefined): string | undefined {
  return message ? t(message) : undefined;
}

function toCreateInput(values: EmployeeFormValues): CreateEmployeeInput {
  const role = values.role?.trim();
  return {
    fullName: values.fullName.trim(),
    role: role ? role : null,
  };
}

export function EmployeeProfileForm({
  initialValues,
  submitting,
  submissionError,
  onSubmit,
  onDirtyChange,
}: EmployeeProfileFormProps) {
  const { t } = useTranslation();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<EmployeeFormValues>({
    resolver: zodResolver(employeeFormSchema),
    defaultValues: initialValues ?? EMPTY_VALUES,
  });
  const isDirtyRef = useRef(false);

  useEffect(() => {
    isDirtyRef.current = isDirty;
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    if (isDirtyRef.current) return;
    reset(initialValues ?? EMPTY_VALUES);
  }, [initialValues, reset]);

  const submit = handleSubmit(async (values) => {
    await onSubmit(toCreateInput(values));
  });

  return (
    <form
      id={EMPLOYEE_PROFILE_FORM_ID}
      className="mk-employee-profile-form"
      onSubmit={(event) => void submit(event)}
      noValidate
      aria-busy={submitting || undefined}
    >
      {submissionError ? <Alert tone="error">{submissionError}</Alert> : null}
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
  );
}
