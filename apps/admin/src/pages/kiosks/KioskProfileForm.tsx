import { zodResolver } from "@hookform/resolvers/zod";
import type { TFunction } from "i18next";
import { useEffect, useRef } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Alert, Checkbox, Input } from "@markiro/ui";

import { errorProp } from "../../lib/form-error.js";
import type { CreateKioskInput } from "./api.js";

const kioskFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "pages.kiosks.form.errors.nameRequired")
    .max(200, "pages.kiosks.form.errors.nameTooLong"),
  location: z.string().trim().optional(),
  dayLimitPerEmployee: z
    .string()
    .trim()
    .regex(/^[1-9]\d*$/, "pages.kiosks.form.errors.dayLimitInvalid"),
  showPrices: z.boolean(),
});

export type KioskFormValues = z.infer<typeof kioskFormSchema>;

export const KIOSK_PROFILE_FORM_ID = "kiosk-profile-form";

export interface KioskProfileFormProps {
  initialValues?: KioskFormValues;
  submitting: boolean;
  submissionError: string | null;
  onSubmit: (input: CreateKioskInput) => void | Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}

const EMPTY_VALUES: KioskFormValues = {
  name: "",
  location: "",
  dayLimitPerEmployee: "5",
  showPrices: true,
};

function translateFieldError(t: TFunction, message: string | undefined): string | undefined {
  return message ? t(message) : undefined;
}

/** Normalizes raw form values into the API's create/update payload shape. */
export function toKioskInput(values: KioskFormValues): CreateKioskInput {
  const location = values.location?.trim();
  return {
    name: values.name.trim(),
    location: location ? location : null,
    dayLimitPerEmployee: Number(values.dayLimitPerEmployee),
    showPrices: values.showPrices,
  };
}

export function KioskProfileForm({
  initialValues,
  submitting,
  submissionError,
  onSubmit,
  onDirtyChange,
}: KioskProfileFormProps) {
  const { t } = useTranslation();
  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<KioskFormValues>({
    resolver: zodResolver(kioskFormSchema),
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
    await onSubmit(toKioskInput(values));
  });

  return (
    <form
      id={KIOSK_PROFILE_FORM_ID}
      className="mk-kiosk-profile-form"
      onSubmit={(event) => void submit(event)}
      noValidate
      aria-busy={submitting || undefined}
    >
      {submissionError ? <Alert tone="error">{submissionError}</Alert> : null}
      <Input
        label={t("pages.kiosks.form.nameLabel")}
        {...errorProp(translateFieldError(t, errors.name?.message))}
        {...register("name")}
      />
      <Input
        label={t("pages.kiosks.form.locationLabel")}
        {...errorProp(translateFieldError(t, errors.location?.message))}
        {...register("location")}
      />
      <Input
        label={t("pages.kiosks.form.dayLimitLabel")}
        mono
        inputMode="numeric"
        {...errorProp(translateFieldError(t, errors.dayLimitPerEmployee?.message))}
        {...register("dayLimitPerEmployee")}
      />
      <Controller
        control={control}
        name="showPrices"
        render={({ field }) => (
          <Checkbox
            label={t("pages.kiosks.form.showPricesLabel")}
            checked={field.value}
            onCheckedChange={field.onChange}
          />
        )}
      />
    </form>
  );
}
