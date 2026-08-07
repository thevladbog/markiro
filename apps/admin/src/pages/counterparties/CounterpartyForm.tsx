import { zodResolver } from "@hookform/resolvers/zod";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { hasValidCheckDigit } from "@markiro/domain";
import { Alert, Button, Input, SidePanel, Spinner } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { errorProp } from "../../lib/form-error.js";
import { toast } from "../../lib/toast.js";
import {
  useCounterpartySscc,
  useUpdateCounterpartySscc,
  type CreateCounterpartyInput,
} from "./api.js";

const counterpartyFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "pages.counterparties.form.errors.nameRequired")
    .max(200, "pages.counterparties.form.errors.nameTooLong"),
  gln: z
    .string()
    .trim()
    .regex(/^\d{13}$/, "pages.counterparties.form.errors.glnFormat")
    .refine((value) => hasValidCheckDigit(value), "pages.counterparties.form.errors.glnCheckDigit"),
  inn: z.string().trim().optional(),
  gs1Prefixes: z
    .string()
    .trim()
    .optional()
    .refine(
      (value) => !value || value.split(",").every((entry) => /^\d{4,12}$/.test(entry.trim())),
      "pages.counterparties.form.errors.gs1PrefixesFormat",
    ),
  notes: z.string().trim().optional(),
});

export type CounterpartyFormValues = z.infer<typeof counterpartyFormSchema>;

export interface CounterpartyFormProps {
  mode: "create" | "edit";
  initialValues?: CounterpartyFormValues;
  counterpartyId?: string;
  submitting?: boolean;
  submissionError?: string | null;
  onSubmit: (input: CreateCounterpartyInput) => void | Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
}

const BOX_EXTENSION_DIGIT = 0;
const GLN_PATTERN = /^\d{13}$/;
const FORM_ID = "counterparty-form";
const EMPTY_VALUES: CounterpartyFormValues = {
  name: "",
  gln: "",
  inn: "",
  gs1Prefixes: "",
  notes: "",
};

const ssccFormSchema = z.object({
  nextSerial: z
    .string()
    .trim()
    .refine(
      (value) => /^\d+$/.test(value),
      "pages.counterparties.form.sscc.errors.nextSerialInvalid",
    )
    .refine(
      (value) => Number(value) <= 9_999_999,
      "pages.counterparties.form.sscc.errors.nextSerialInvalid",
    ),
});
type SsccFormValues = z.infer<typeof ssccFormSchema>;

function derivePrefix(gln: string | undefined): string | null {
  if (!gln || !GLN_PATTERN.test(gln)) return null;
  return gln.slice(0, 9);
}

function translateFieldError(t: TFunction, message: string | undefined): string | undefined {
  return message ? t(message) : undefined;
}

export function CounterpartyForm({
  mode,
  initialValues,
  counterpartyId,
  submitting = false,
  submissionError,
  onSubmit,
  onDirtyChange,
  onBusyChange,
  onClose,
}: CounterpartyFormProps) {
  const { t } = useTranslation();
  const [ssccDirty, setSsccDirty] = useState(false);
  const [ssccBusy, setSsccBusy] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<CounterpartyFormValues>({
    resolver: zodResolver(counterpartyFormSchema),
    defaultValues: initialValues ?? EMPTY_VALUES,
  });
  const previousInitialValuesRef = useRef(initialValues);

  useEffect(() => {
    if (previousInitialValuesRef.current === initialValues) return;
    previousInitialValuesRef.current = initialValues;
    reset(initialValues ?? EMPTY_VALUES);
  }, [initialValues, reset]);
  useEffect(() => onDirtyChange(isDirty || ssccDirty), [isDirty, onDirtyChange, ssccDirty]);
  useEffect(() => onBusyChange(submitting || ssccBusy), [onBusyChange, ssccBusy, submitting]);

  const submit = handleSubmit(async (values) => onSubmit(toCreateInput(values)));
  const title =
    mode === "create"
      ? t("pages.counterparties.form.createTitle")
      : t("pages.counterparties.form.editTitle");

  return (
    <SidePanel
      open
      size="standard"
      title={title}
      closeLabel={t("common.close")}
      busy={submitting || ssccBusy}
      onClose={onClose}
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            disabled={submitting || ssccBusy}
            onClick={onClose}
          >
            {t("pages.counterparties.cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} loading={submitting} disabled={ssccBusy}>
            {mode === "create"
              ? t("pages.counterparties.form.submitCreate")
              : t("pages.counterparties.form.submitUpdate")}
          </Button>
        </>
      }
    >
      <section className="mk-counterparty-panel-section">
        <h3>{t("pages.counterparties.sections.identity")}</h3>
        {submissionError ? <Alert tone="error">{submissionError}</Alert> : null}
        <form
          id={FORM_ID}
          className="mk-counterparty-profile-grid"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          <Input
            label={t("pages.counterparties.form.nameLabel")}
            {...errorProp(translateFieldError(t, errors.name?.message))}
            {...register("name")}
          />
          <Input
            label={t("pages.counterparties.form.glnLabel")}
            mono
            {...errorProp(translateFieldError(t, errors.gln?.message))}
            {...register("gln")}
          />
          <Input
            label={t("pages.counterparties.form.innLabel")}
            mono
            {...errorProp(translateFieldError(t, errors.inn?.message))}
            {...register("inn")}
          />
          <Input
            label={t("pages.counterparties.form.prefixesLabel")}
            hint={t("pages.counterparties.form.prefixesHint")}
            {...errorProp(translateFieldError(t, errors.gs1Prefixes?.message))}
            {...register("gs1Prefixes")}
          />
          <div className="mk-counterparty-profile-grid__wide">
            <Input
              label={t("pages.counterparties.form.notesLabel")}
              {...errorProp(translateFieldError(t, errors.notes?.message))}
              {...register("notes")}
            />
          </div>
        </form>
      </section>

      {mode === "edit" && counterpartyId ? (
        <CounterpartySsccSection
          counterpartyId={counterpartyId}
          gln={initialValues?.gln}
          onDirtyChange={setSsccDirty}
          onBusyChange={setSsccBusy}
        />
      ) : null}
    </SidePanel>
  );
}

function CounterpartySsccSection({
  counterpartyId,
  gln,
  onDirtyChange,
  onBusyChange,
}: {
  counterpartyId: string;
  gln: string | undefined;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const ssccQuery = useCounterpartySscc(counterpartyId);
  const updateSscc = useUpdateCounterpartySscc();
  const [saveError, setSaveError] = useState<string | null>(null);
  const derivedPrefix = derivePrefix(gln);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<SsccFormValues>({
    resolver: zodResolver(ssccFormSchema),
    defaultValues: { nextSerial: "0" },
  });

  useEffect(() => {
    if (ssccQuery.data && !isDirty) {
      reset({ nextSerial: String(ssccQuery.data.nextSerial) });
    }
  }, [isDirty, reset, ssccQuery.data]);
  useEffect(() => onDirtyChange(isDirty), [isDirty, onDirtyChange]);
  useEffect(() => onBusyChange(updateSscc.isPending), [onBusyChange, updateSscc.isPending]);

  const submit = handleSubmit(async (values) => {
    try {
      setSaveError(null);
      const saved = await updateSscc.mutateAsync({
        id: counterpartyId,
        input: { extensionDigit: BOX_EXTENSION_DIGIT, nextSerial: Number(values.nextSerial) },
      });
      reset({ nextSerial: String(saved.nextSerial) });
      toast("ok", t("pages.counterparties.form.sscc.toasts.updateSuccess"));
    } catch (error) {
      setSaveError(
        error instanceof ApiRequestError
          ? error.message
          : t("pages.counterparties.form.sscc.toasts.updateError"),
      );
    }
  });

  return (
    <section className="mk-counterparty-panel-section mk-counterparty-panel-section--sscc">
      <div>
        <h3>{t("pages.counterparties.sections.sscc")}</h3>
        <p>{t("pages.counterparties.form.sscc.description")}</p>
      </div>
      {ssccQuery.isPending ? (
        <div className="mk-counterparty-section-state">
          <Spinner label={t("common.loading")} />
        </div>
      ) : ssccQuery.isError ? (
        <div className="mk-counterparty-section-state">
          <Alert tone="error">{t("pages.counterparties.form.sscc.loadError")}</Alert>
          <Button type="button" variant="secondary" onClick={() => void ssccQuery.refetch()}>
            {t("pages.counterparties.form.sscc.retry")}
          </Button>
        </div>
      ) : (
        <div className="mk-counterparty-sscc-form">
          {saveError ? <Alert tone="error">{saveError}</Alert> : null}
          <Input
            label={t("pages.counterparties.form.sscc.prefixLabel")}
            mono
            readOnly
            disabled
            value={derivedPrefix ?? ""}
          />
          {!derivedPrefix ? (
            <Alert tone="warn">{t("pages.counterparties.form.sscc.prefixUnavailable")}</Alert>
          ) : null}
          <Input
            label={t("pages.counterparties.form.sscc.nextSerialLabel")}
            mono
            inputMode="numeric"
            {...errorProp(translateFieldError(t, errors.nextSerial?.message))}
            {...register("nextSerial")}
          />
          <div>
            <Button
              type="button"
              loading={updateSscc.isPending}
              disabled={!derivedPrefix}
              onClick={() => void submit()}
            >
              {t("pages.counterparties.form.sscc.save")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function toCreateInput(values: CounterpartyFormValues): CreateCounterpartyInput {
  const inn = values.inn?.trim();
  const notes = values.notes?.trim();
  return {
    name: values.name.trim(),
    gln: values.gln.trim(),
    inn: inn || null,
    gs1Prefixes: values.gs1Prefixes
      ? values.gs1Prefixes
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [],
    notes: notes || null,
  };
}
