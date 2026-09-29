import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Checkbox, Input } from "@markiro/ui";

import type { OfficeUserRecord } from "../../host/protocol.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
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
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
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
    formState: { errors, isDirty },
  } = useForm<UserEditValues>({
    resolver: zodResolver(userEditSchema),
    defaultValues: { name: user.name, role: user.role, active: user.active },
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    let saved: OfficeUserRecord;
    try {
      saved = await update.mutateAsync(values);
    } catch (error) {
      const outcome = writeFailure(error, EDIT_FIELDS);
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
      title={t("office.users.editTitle", { login: user.login })}
      submitLabel={t("office.common.save")}
      submitDisabled={!isDirty}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
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
            hint={own ? t("office.users.ownRoleHint") : null}
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
            {...(own ? { hint: t("office.users.ownAccessHint") } : {})}
          />
        )}
      />
    </FormDialog>
  );
}
