import { ssccSerialCapacity } from "@markiro/domain";
import { useState, type FormEvent } from "react";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Combobox, IconButton, Input } from "@markiro/ui";

import { HostError } from "../host/client.js";
import { errorMessageKey } from "../host/errors.js";
import type { BootstrapRequest } from "../host/protocol.js";
import { errorProp } from "../lib/form-error.js";
import { issuerPrefix } from "../lib/rules.js";
import { TIME_ZONE_OPTIONS } from "../lib/time-zones.js";
import {
  defaultWizardValues,
  fieldFromHost,
  MAX_LINES,
  stepOf,
  toBootstrapRequest,
  validateStep,
  WIZARD_STEPS,
  type FieldIssue,
  type WizardStep,
  type WizardValues,
} from "./wizard-form.js";

export interface BootstrapWizardProps {
  /** Pairs this computer if needed and creates the site; rejects with a `HostError` or a `DeviceError`. */
  onSubmit: (request: BootstrapRequest) => Promise<void>;
}

export function BootstrapWizard({ onSubmit }: BootstrapWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<WizardStep>("admin");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    control,
    getValues,
    setError,
    clearErrors,
    watch,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<WizardValues>({
    defaultValues: defaultWizardValues(t("wizard.lines.defaultName")),
  });
  const lines = useFieldArray({ control, name: "lines" });
  const position = WIZARD_STEPS.indexOf(step);
  const gln = watch("gln").trim();
  const prefix = /^\d{13}$/.test(gln) ? issuerPrefix(gln) : null;

  const fieldError = (message: string | undefined) =>
    errorProp(message === undefined ? undefined : t(message));

  const show = (issues: readonly FieldIssue[]) => {
    for (const issue of issues) setError(issue.field, { type: "validate", message: issue.message });
  };

  const goNext = () => {
    setSubmitError(null);
    clearErrors();
    const issues = validateStep(step, getValues());
    if (issues.length > 0) {
      show(issues);
      return;
    }
    const following = WIZARD_STEPS[position + 1];
    if (following) setStep(following);
  };

  const goBack = () => {
    setSubmitError(null);
    clearErrors();
    const previous = WIZARD_STEPS[position - 1];
    if (previous) setStep(previous);
  };

  const create = handleSubmit(async (values) => {
    setSubmitError(null);
    clearErrors();
    const issues = validateStep("review", values);
    const first = issues[0];
    if (first) {
      setStep(stepOf(first.field));
      show(issues);
      return;
    }
    try {
      await onSubmit(toBootstrapRequest(values));
    } catch (error) {
      const field = error instanceof HostError && error.field ? fieldFromHost(error.field) : null;
      if (field) {
        setStep(stepOf(field));
        setError(field, { type: "server", message: "rules.rejected" });
        return;
      }
      setSubmitError(errorMessageKey(error));
    }
  });

  // Enter on a step moves on; only the review step creates the site.
  const submitForm = (event: FormEvent<HTMLFormElement>) => {
    if (step === "review") {
      void create(event);
      return;
    }
    event.preventDefault();
    goNext();
  };

  return (
    <Card className="standalone-card" title={t("wizard.title")} titleAs="h2">
      <form className="standalone-form" onSubmit={submitForm} noValidate>
        <p className="standalone-wizard__step">
          {t("wizard.stepOf", { current: position + 1, total: WIZARD_STEPS.length })}
          {" · "}
          {t(`wizard.steps.${step}`)}
        </p>
        {submitError && <Alert tone="error">{t(submitError)}</Alert>}

        {step === "admin" && (
          <>
            <p>{t("wizard.admin.intro")}</p>
            <Input
              label={t("wizard.admin.login")}
              hint={t("wizard.admin.loginHint")}
              autoComplete="username"
              {...fieldError(errors.login?.message)}
              {...register("login")}
            />
            <Input
              label={t("wizard.admin.name")}
              {...fieldError(errors.adminName?.message)}
              {...register("adminName")}
            />
            <Input
              type="password"
              autoComplete="new-password"
              label={t("wizard.admin.password")}
              hint={t("wizard.admin.passwordHint")}
              {...fieldError(errors.password?.message)}
              {...register("password")}
            />
            <Input
              type="password"
              autoComplete="new-password"
              label={t("wizard.admin.passwordConfirm")}
              {...fieldError(errors.passwordConfirm?.message)}
              {...register("passwordConfirm")}
            />
          </>
        )}

        {step === "org" && (
          <>
            <p>{t("wizard.org.intro")}</p>
            <Input
              label={t("org.name")}
              {...fieldError(errors.orgName?.message)}
              {...register("orgName")}
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
              label={t("org.gln")}
              hint={t("org.glnHint")}
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
            <Controller
              control={control}
              name="timeZone"
              render={({ field }) => (
                <Combobox
                  label={t("org.timeZone")}
                  options={TIME_ZONE_OPTIONS}
                  value={field.value}
                  onValueChange={field.onChange}
                  placeholder={t("org.timeZonePlaceholder")}
                  searchPlaceholder={t("org.timeZoneSearch")}
                  emptyText={t("org.timeZoneEmpty")}
                  loadingText={t("org.timeZoneLoading")}
                  {...fieldError(errors.timeZone?.message)}
                />
              )}
            />
          </>
        )}

        {step === "sscc" && (
          <>
            <p>{t("wizard.sscc.intro")}</p>
            <p className="standalone-wizard__note">
              {prefix
                ? t("wizard.sscc.prefix", { prefix, max: ssccSerialCapacity(prefix) - 1 })
                : t("wizard.sscc.prefixUnknown")}
            </p>
            <Input
              type="number"
              min={1}
              step={1}
              mono
              label={t("wizard.sscc.box")}
              {...fieldError(errors.boxNextSerial?.message)}
              {...register("boxNextSerial", { valueAsNumber: true })}
            />
            <Input
              type="number"
              min={0}
              step={1}
              mono
              label={t("wizard.sscc.pallet")}
              {...fieldError(errors.palletNextSerial?.message)}
              {...register("palletNextSerial", { valueAsNumber: true })}
            />
          </>
        )}

        {step === "lines" && (
          <>
            <p>{t("wizard.lines.intro")}</p>
            {lines.fields.map((line, index) => (
              <div className="standalone-wizard__line" key={line.id}>
                <Input
                  label={t("wizard.lines.name", { index: index + 1 })}
                  {...fieldError(errors.lines?.[index]?.name?.message)}
                  {...register(`lines.${index}.name`)}
                />
                {lines.fields.length > 1 && (
                  <IconButton
                    variant="secondary"
                    icon="✕"
                    aria-label={t("wizard.lines.remove", { index: index + 1 })}
                    onClick={() => lines.remove(index)}
                  />
                )}
              </div>
            ))}
            <Button
              variant="secondary"
              onClick={() => lines.append({ name: "" })}
              disabled={lines.fields.length >= MAX_LINES}
            >
              {t("wizard.lines.add")}
            </Button>
          </>
        )}

        {step === "review" && <WizardReview values={getValues()} />}

        <div className="standalone-form__actions">
          {position > 0 && (
            <Button variant="secondary" onClick={goBack} disabled={isSubmitting}>
              {t("wizard.back")}
            </Button>
          )}
          <Button type="submit" loading={isSubmitting}>
            {t(step === "review" ? "wizard.submit" : "wizard.next")}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function WizardReview({ values }: { values: WizardValues }) {
  const { t } = useTranslation();
  const request = toBootstrapRequest(values);
  const rows: [string, string][] = [
    [t("wizard.review.admin"), request.admin.login],
    [t("wizard.review.org"), request.org.name],
    [t("wizard.review.gln"), request.org.gln],
    [t("wizard.review.prefix"), issuerPrefix(request.org.gln)],
    [t("wizard.review.box"), String(request.sscc.boxNextSerial)],
    [t("wizard.review.pallet"), String(request.sscc.palletNextSerial)],
    [t("wizard.review.lines"), request.lines.join(", ")],
  ];
  return (
    <>
      <p>{t("wizard.review.intro")}</p>
      <dl className="standalone-wizard__review">
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
