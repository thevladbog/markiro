import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Input } from "@markiro/ui";

import type { OfficeUserRecord } from "../../host/protocol.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { RoleRadios } from "./RoleRadios.js";
import { newUserSchema, type NewUserValues } from "./user-forms.js";

const CREATE_FIELDS = { login: "login", name: "name", role: "role", password: "password" } as const;
const CREATE_CONFLICTS = {
  login: { field: "login", message: "office.users.errors.loginTaken" },
} as const;

export interface CreateUserDialogProps {
  onClose: () => void;
  onCreated: (user: OfficeUserRecord) => void;
}

export function CreateUserDialog({ onClose, onCreated }: CreateUserDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const create = useOfficeMutation((api, token, values: NewUserValues) =>
    api.createUser(token, {
      login: values.login,
      name: values.name,
      role: values.role,
      password: values.password,
    }),
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<NewUserValues>({
    resolver: zodResolver(newUserSchema),
    defaultValues: { login: "", name: "", role: "technologist", password: "", confirm: "" },
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      onCreated(await create.mutateAsync(values));
    } catch (error) {
      const outcome = writeFailure(error, CREATE_FIELDS, CREATE_CONFLICTS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
    }
  });

  return (
    <FormDialog
      title={t("office.users.createTitle")}
      submitLabel={t("office.users.create")}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <Input
        label={t("office.users.fields.login")}
        hint={t("office.users.fields.loginHint")}
        autoComplete="off"
        mono
        {...fieldError(errors.login?.message)}
        {...register("login")}
      />
      <Input
        label={t("office.users.fields.name")}
        {...fieldError(errors.name?.message)}
        {...register("name")}
      />
      <Controller
        control={control}
        name="role"
        render={({ field }) => (
          <RoleRadios value={field.value} onChange={field.onChange} disabled={false} hint={null} />
        )}
      />
      <Input
        type="password"
        autoComplete="new-password"
        label={t("office.users.fields.password")}
        hint={t("office.users.fields.passwordHint")}
        {...fieldError(errors.password?.message)}
        {...register("password")}
      />
      <Input
        type="password"
        autoComplete="new-password"
        label={t("office.users.fields.confirm")}
        {...fieldError(errors.confirm?.message)}
        {...register("confirm")}
      />
    </FormDialog>
  );
}
