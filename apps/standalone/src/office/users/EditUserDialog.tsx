import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Alert, Button, Checkbox, Input, Modal } from "@markiro/ui";

import type { OfficeUserRecord } from "../../host/protocol.js";
import { errorProp } from "../../lib/form-error.js";
import { writeFailure } from "../form-errors.js";
import { useOfficeMutation } from "../office-query.js";
import { StaleAlert } from "../page-state.js";
import { RoleRadios } from "./RoleRadios.js";
import { userEditSchema, type UserEditValues } from "./user-forms.js";

const EDIT_FIELDS = { name: "name", role: "role", active: "active" } as const;

export interface EditUserDialogProps {
  user: OfficeUserRecord;
  /** The signed-in administrator's own record: only the name can change. */
  own: boolean;
  onClose: () => void;
  onSaved: (user: OfficeUserRecord) => void;
  /** The record changed on the host: close and load the users again. */
  onReload: () => void;
}

export function EditUserDialog({ user, own, onClose, onSaved, onReload }: EditUserDialogProps) {
  const { t } = useTranslation();
  const formId = useId();
  const [failure, setFailure] = useState<
    { kind: "stale" } | { kind: "alert"; message: string } | null
  >(null);
  const update = useOfficeMutation((api, token, values: UserEditValues) =>
    api.updateUser(token, user.id, {
      name: values.name,
      role: values.role,
      active: values.active,
      expectedRev: user.rev,
    }),
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<UserEditValues>({
    resolver: zodResolver(userEditSchema),
    defaultValues: { name: user.name, role: user.role, active: user.active },
  });
  const fieldError = (message: string | undefined) =>
    errorProp(message === undefined ? undefined : t(message));

  const close = () => {
    if (!isSubmitting) onClose();
  };

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      onSaved(await update.mutateAsync(values));
    } catch (error) {
      const outcome = writeFailure(error, EDIT_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
    }
  });

  return (
    <Modal
      open
      title={t("office.users.editTitle", { login: user.login })}
      onClose={close}
      closeLabel={t("office.common.close")}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={isSubmitting}>
            {t("office.common.cancel")}
          </Button>
          <Button type="submit" form={formId} loading={isSubmitting} disabled={!isDirty}>
            {t("office.common.save")}
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
        {failure?.kind === "stale" && <StaleAlert onReload={onReload} />}
        {failure?.kind === "alert" && <Alert tone="error">{t(failure.message)}</Alert>}
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
              disabled={own}
              hint={own ? t("office.users.ownHint") : null}
            />
          )}
        />
        <Controller
          control={control}
          name="active"
          render={({ field }) => (
            <Checkbox
              label={t("office.users.fields.active")}
              checked={field.value}
              onCheckedChange={field.onChange}
              disabled={own}
            />
          )}
        />
      </form>
    </Modal>
  );
}
