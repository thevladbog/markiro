import { zodResolver } from "@hookform/resolvers/zod";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Alert, Input, RadioGroup, Select } from "@markiro/ui";

import { errorProp } from "../../lib/form-error.js";
import type { CreateEmployeeInput, LinkableMemberDto } from "./api.js";

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

type EmployeeSource = "manual" | "member";

export interface EmployeeProfileFormProps {
  mode: "create" | "edit";
  initialValues?: EmployeeFormValues;
  submitting: boolean;
  submissionError: string | null;
  /** Create mode only: candidates for the "pick a registered user" source. */
  linkableMembers?: LinkableMemberDto[];
  linkableMembersPending?: boolean;
  linkableMembersError?: boolean;
  onSubmit: (input: CreateEmployeeInput) => void | Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onErrorChange?: (hasError: boolean) => void;
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

/** ФИО for the picker: "фамилия имя отчество", falling back to the login email. */
export function linkableMemberFullName(member: LinkableMemberDto): string {
  const name = [member.lastName, member.firstName, member.middleName].filter(Boolean).join(" ");
  return name || member.email;
}

export function EmployeeProfileForm({
  mode,
  initialValues,
  submitting,
  submissionError,
  linkableMembers,
  linkableMembersPending,
  linkableMembersError,
  onSubmit,
  onDirtyChange,
  onErrorChange,
}: EmployeeProfileFormProps) {
  const { t } = useTranslation();
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    formState: { errors, isDirty },
  } = useForm<EmployeeFormValues>({
    resolver: zodResolver(employeeFormSchema),
    defaultValues: initialValues ?? EMPTY_VALUES,
  });
  const isDirtyRef = useRef(false);
  const [source, setSource] = useState<EmployeeSource>("manual");
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [memberMissing, setMemberMissing] = useState(false);

  useEffect(() => {
    isDirtyRef.current = isDirty;
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    onErrorChange?.(errors.fullName !== undefined || errors.role !== undefined);
  }, [errors.fullName, errors.role, onErrorChange]);

  useEffect(() => {
    if (isDirtyRef.current) return;
    reset(initialValues ?? EMPTY_VALUES);
  }, [initialValues, reset]);

  const submit = handleSubmit(async (values) => {
    if (source === "member" && !selectedMemberId) {
      setMemberMissing(true);
      return;
    }
    await onSubmit({
      ...toCreateInput(values),
      ...(source === "member" ? { memberId: selectedMemberId } : {}),
    });
  });

  const members = linkableMembers ?? [];
  const memberOptions = members.map((member) => {
    const name = linkableMemberFullName(member);
    return {
      value: member.memberId,
      label: member.position ? `${name} — ${member.position}` : name,
    };
  });

  const selectMember = (memberId: string) => {
    setSelectedMemberId(memberId);
    setMemberMissing(false);
    const member = members.find((item) => item.memberId === memberId);
    if (!member) return;
    setValue("fullName", linkableMemberFullName(member), {
      shouldDirty: true,
      shouldValidate: true,
    });
    setValue("role", member.position ?? "", { shouldDirty: true });
  };

  const sourcePicker =
    mode === "create" ? (
      <>
        <RadioGroup
          label={t("pages.employees.form.sourceLabel")}
          options={[
            { value: "manual", label: t("pages.employees.form.sourceManual") },
            { value: "member", label: t("pages.employees.form.sourceMember") },
          ]}
          value={source}
          onValueChange={(value) => {
            setSource(value as EmployeeSource);
            setMemberMissing(false);
          }}
        />
        {source === "member" ? (
          linkableMembersError ? (
            <Alert tone="error">{t("pages.employees.form.membersLoadError")}</Alert>
          ) : (
            <Select
              label={t("pages.employees.form.memberLabel")}
              placeholder={t("pages.employees.form.memberPlaceholder")}
              options={memberOptions}
              value={selectedMemberId}
              disabled={linkableMembersPending || memberOptions.length === 0}
              searchable
              searchLabel={t("pages.employees.form.memberSearchLabel")}
              searchPlaceholder={t("pages.employees.form.memberSearchPlaceholder")}
              {...(memberMissing
                ? { error: t("pages.employees.form.errors.memberRequired") }
                : !linkableMembersPending && memberOptions.length === 0
                  ? { hint: t("pages.employees.form.membersEmpty") }
                  : {})}
              onValueChange={selectMember}
            />
          )
        ) : null}
      </>
    ) : null;

  return (
    <form
      id={EMPLOYEE_PROFILE_FORM_ID}
      className="mk-employee-profile-form"
      onSubmit={(event) => void submit(event)}
      noValidate
      aria-busy={submitting || undefined}
    >
      {submissionError ? <Alert tone="error">{submissionError}</Alert> : null}
      {sourcePicker}
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
