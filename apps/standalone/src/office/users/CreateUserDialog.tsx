import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Alert, Button, Input, Modal } from "@markiro/ui";

import { HostError } from "../../host/client.js";
import type { OfficeUserRecord } from "../../host/protocol.js";
import { errorProp } from "../../lib/form-error.js";
import { failureMessage, writeFailure } from "../form-errors.js";
import { useOfficeMutation } from "../office-query.js";
import { RoleRadios } from "./RoleRadios.js";
import { newUserSchema, type NewUserValues } from "./user-forms.js";

const CREATE_FIELDS = { login: "login", name: "name", role: "role", password: "password" } as const;

export interface CreateUserDialogProps {
  onClose: () => void;
  onCreated: (user: OfficeUserRecord) => void;
}

export function CreateUserDialog({ onClose, onCreated }: CreateUserDialogProps) {
  const { t } = useTranslation();
  const formId = useId();
  const [failure, setFailure] = useState<string | null>(null);
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
    formState: { errors, isSubmitting },
  } = useForm<NewUserValues>({
    resolver: zodResolver(newUserSchema),
    defaultValues: { login: "", name: "", role: "technologist", password: "", confirm: "" },
  });
  const fieldError = (message: string | undefined) =>
    errorProp(message === undefined ? undefined : t(message));

  const close = () => {
    if (!isSubmitting) onClose();
  };

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      onCreated(await create.mutateAsync(values));
    } catch (error) {
      if (
        error instanceof HostError &&
        error.code === "conflict" &&
        error.details.constraint === "login"
      ) {
        setError("login", { type: "server", message: "office.users.errors.loginTaken" });
        return;
      }
      const outcome = writeFailure(error, CREATE_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(failureMessage(outcome));
      }
    }
  });

  return (
    <Modal
      open
      title={t("office.users.createTitle")}
      onClose={close}
      closeLabel={t("office.common.close")}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={isSubmitting}>
            {t("office.common.cancel")}
          </Button>
          <Button type="submit" form={formId} loading={isSubmitting}>
            {t("office.users.create")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="standalone-form"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        {failure && <Alert tone="error">{t(failure)}</Alert>}
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
            <RoleRadios
              value={field.value}
              onChange={field.onChange}
              disabled={false}
              hint={null}
            />
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
      </form>
    </Modal>
  );
}
