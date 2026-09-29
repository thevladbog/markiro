import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Checkbox, Input } from "@markiro/ui";

import type { CounterpartyRecord } from "../../host/protocol.js";
import { counterpartyCreate, counterpartyUpdate } from "../../host/requests.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import {
  COUNTERPARTY_FIELDS,
  counterpartyFields,
  counterpartyFieldsSchema,
  toCompanyInput,
  type CounterpartyFields,
} from "./counterparty-form.js";

export interface CounterpartyDialogProps {
  /** `null` adds a counterparty. */
  counterparty: CounterpartyRecord | null;
  onClose: () => void;
  onSaved: (counterparty: CounterpartyRecord) => void;
  /** The counterparty changed on the host: close and load the list again. */
  onReload: () => void;
}

/**
 * Adds a counterparty, or changes one: the host takes the whole record with
 * the loaded revision, and archiving is its `archived` flag (no delete).
 */
export function CounterpartyDialog({
  counterparty,
  onClose,
  onSaved,
  onReload,
}: CounterpartyDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const save = useOfficeMutation((api, token, values: CounterpartyFields) => {
    const company = toCompanyInput(values);
    return counterparty === null
      ? api.createCounterparty(token, counterpartyCreate(company))
      : api.updateCounterparty(
          token,
          counterparty.id,
          counterpartyUpdate(company, values.archived, counterparty.rev),
        );
  });
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<CounterpartyFields>({
    resolver: zodResolver(counterpartyFieldsSchema),
    defaultValues: counterpartyFields(counterparty),
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      onSaved(await save.mutateAsync(values));
    } catch (error) {
      const outcome = writeFailure(error, COUNTERPARTY_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
    }
  });

  return (
    <FormDialog
      title={
        counterparty === null
          ? t("office.counterparties.createTitle")
          : t("office.counterparties.editTitle", { name: counterparty.name })
      }
      submitLabel={
        counterparty === null ? t("office.counterparties.create") : t("office.common.save")
      }
      submitDisabled={counterparty !== null && !isDirty}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <Input
        label={t("office.counterparties.fields.name")}
        {...fieldError(errors.name?.message)}
        {...register("name")}
      />
      <Input
        label={t("org.inn")}
        hint={t("org.innHint")}
        inputMode="numeric"
        mono
        {...fieldError(errors.inn?.message)}
        {...register("inn")}
      />
      <Input
        label={t("office.counterparties.fields.gln")}
        hint={t("office.counterparties.fields.glnHint")}
        inputMode="numeric"
        mono
        {...fieldError(errors.gln?.message)}
        {...register("gln")}
      />
      <Input
        label={t("org.gs1Prefixes")}
        hint={t("org.gs1PrefixesHint")}
        mono
        {...fieldError(errors.gs1Prefixes?.message)}
        {...register("gs1Prefixes")}
      />
      {counterparty !== null && (
        <Controller
          control={control}
          name="archived"
          render={({ field }) => (
            <Checkbox
              label={t("office.counterparties.fields.archived")}
              checked={field.value}
              onCheckedChange={field.onChange}
            />
          )}
        />
      )}
    </FormDialog>
  );
}
