import { zodResolver } from "@hookform/resolvers/zod";
import type { TFunction } from "i18next";
import { useEffect, useRef } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import {
  Alert,
  Button,
  Checkbox,
  Combobox,
  DatePicker,
  Input,
  RadioGroup,
  Select,
  SidePanel,
} from "@markiro/ui";
import type { ComboboxOption, SelectOption } from "@markiro/ui";

import { errorProp } from "../../lib/form-error.js";
import type { CounterpartyDto } from "../counterparties/api.js";
import type { ProductDto } from "../catalog/api.js";
import type { LabelTemplateSummaryDto } from "../labels/api.js";
import type { CreateShiftInput, LineDto, ShiftStatus, UpdateShiftInput } from "./api.js";

const SHIFT_MODES = ["validation", "aggregation"] as const;

/**
 * Client-side mirror of the server's zod schema
 * (apps/api/src/modules/shifts/dto.ts): productId required (only meaningful
 * on create -- the product can't change once a shift exists, since
 * `updateShiftSchema` has no `productId` field at all), mode is one of the
 * two enum values, plannedQty/boxCapacity/palletCapacity are optional
 * positive integers entered as text (kept as strings in form state, parsed
 * to number|null on submit by `toPayload`), plannedDate keeps its ISO
 * `YYYY-MM-DD` value (matching the server's
 * regex, so no extra format validation is needed client-side). Error
 * messages are i18n keys (resolved through `t()` at render time) -- same
 * convention as `../catalog/ProductForm.tsx`.
 */
const shiftFormSchema = z.object({
  productId: z.string().trim().min(1, "pages.shifts.form.errors.productRequired"),
  mode: z.enum(SHIFT_MODES),
  plannedQty: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^[1-9]\d*$/.test(v), "pages.shifts.form.errors.qtyInvalid"),
  plannedDate: z.string().trim().optional(),
  productionDate: z.string().trim().optional(),
  lineId: z.string().trim().optional(),
  counterpartyId: z.string().trim().optional(),
  ssccIssuerCounterpartyId: z.string().trim().optional(),
  boxLabelTemplateSelection: z.string(),
  boxCapacity: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^[1-9]\d*$/.test(v), "pages.shifts.form.errors.capacityInvalid"),
  palletCapacity: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^[1-9]\d*$/.test(v), "pages.shifts.form.errors.capacityInvalid"),
  palletsEnabled: z.boolean(),
});

export type ShiftFormValues = z.infer<typeof shiftFormSchema>;

export interface ShiftFormContext {
  defaultBoxLabelTemplateId: string | null;
  labelTemplates: LabelTemplateSummaryDto[];
}

export interface ShiftFormProps {
  mode: "create" | "edit";
  editStatus?: ShiftStatus;
  /** Overrides the default create/edit title, e.g. to append the shift's number in edit mode. */
  title?: string;
  initialValues?: ShiftFormValues;
  /** All products (both draft and active) -- draft ones render disabled with a hint. */
  products: ProductDto[];
  lines: LineDto[];
  counterparties: CounterpartyDto[];
  formContext: ShiftFormContext;
  submitting?: boolean;
  submissionError?: string | null;
  onSubmit: (input: CreateShiftInput | UpdateShiftInput) => void | Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onClose: () => void;
}

export const BOX_TEMPLATE_SELECTION = {
  organization: "organization",
  none: "none",
} as const;

const EMPTY_VALUES: ShiftFormValues = {
  productId: "",
  mode: "validation",
  plannedQty: "",
  plannedDate: "",
  productionDate: "",
  lineId: "",
  counterpartyId: "",
  ssccIssuerCounterpartyId: "",
  boxLabelTemplateSelection: BOX_TEMPLATE_SELECTION.organization,
  boxCapacity: "",
  palletCapacity: "",
  palletsEnabled: false,
};

const FORM_ID = "shift-form";

/** Converts a possibly-undefined zod issue message (an i18n key) into translated text. */
function translateFieldError(t: TFunction, message: string | undefined): string | undefined {
  return message ? t(message) : undefined;
}

export function ShiftForm({
  mode: formMode,
  editStatus,
  title: titleOverride,
  initialValues,
  products,
  lines,
  counterparties,
  formContext,
  submitting = false,
  submissionError,
  onSubmit,
  onDirtyChange,
  onClose,
}: ShiftFormProps) {
  const { t, i18n } = useTranslation();
  const lastPrefilledProductRef = useRef<string | null>(null);
  // Tracks whether the user has ever directly changed the counterparty select
  // during this modal session -- deliberately NOT react-hook-form's own
  // `dirtyFields` (which compares the *final* value to the default, so
  // touching the field and landing back on the same value it started with
  // reads as "not dirty"). See `toPayload`'s comment for why this matters.
  const counterpartyTouchedRef = useRef(false);
  // Same contract as `counterpartyTouchedRef`, for the SSCC issuer select.
  const ssccIssuerTouchedRef = useRef(false);
  // Same contract, for the line select -- gates the single-line auto-select.
  const lineTouchedRef = useRef(false);

  const {
    control,
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    setError,
    clearErrors,
    formState: { errors, isDirty, dirtyFields },
  } = useForm<ShiftFormValues>({
    resolver: zodResolver(shiftFormSchema),
    defaultValues: initialValues ?? EMPTY_VALUES,
  });

  const productId = watch("productId");
  const shiftMode = watch("mode");
  const lineId = watch("lineId");
  const counterpartyId = watch("counterpartyId");
  const ssccIssuerCounterpartyId = watch("ssccIssuerCounterpartyId");
  const boxLabelTemplateSelection = watch("boxLabelTemplateSelection");
  const palletsEnabled = watch("palletsEnabled");
  const activeEdit = formMode === "edit" && editStatus === "active";

  const isDirtyRef = useRef(false);

  useEffect(() => {
    isDirtyRef.current = isDirty;
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  // Re-seed clean forms only. Background dependency refetches must not erase
  // operator input from a still-open route panel.
  useEffect(() => {
    if (isDirtyRef.current) return;
    const seeded = initialValues ?? EMPTY_VALUES;
    reset(seeded);
    lastPrefilledProductRef.current = formMode === "create" ? null : seeded.productId || null;
    counterpartyTouchedRef.current = false;
    ssccIssuerTouchedRef.current = false;
    lineTouchedRef.current = false;
  }, [initialValues, reset, formMode]);

  // Product-change prefill (create mode only -- the product can't change once
  // a shift exists, and the product select is disabled while editing): applies
  // the counterparty and capacities from the newly-picked product.
  //
  // This remains a programmatic prefill: touched refs preserve whether the
  // operator had previously changed these fields for payload purposes, while
  // the actual values always follow the latest product selection.
  useEffect(() => {
    if (formMode !== "create") return;
    if (!productId || lastPrefilledProductRef.current === productId) return;
    lastPrefilledProductRef.current = productId;
    const product = products.find((p) => p.id === productId);
    if (!product) return;
    setValue("counterpartyId", product.defaultCounterpartyId ?? "");
    setValue("boxCapacity", product.boxCapacity !== null ? String(product.boxCapacity) : "");
    setValue(
      "palletCapacity",
      product.palletCapacity !== null ? String(product.palletCapacity) : "",
    );
  }, [formMode, productId, products, setValue]);

  // A Radix select needs its matching item before it can safely represent a
  // product default. Reconcile it while the field is still untouched so a late
  // option-list response cannot turn an unknown value into a false user clear.
  useEffect(() => {
    if (formMode !== "create" || !productId) return;
    const product = products.find((item) => item.id === productId);
    if (!product) return;

    if (!counterpartyTouchedRef.current) {
      const defaultCounterpartyId = product.defaultCounterpartyId;
      setValue(
        "counterpartyId",
        defaultCounterpartyId && counterparties.some((item) => item.id === defaultCounterpartyId)
          ? defaultCounterpartyId
          : "",
      );
    }
  }, [formMode, productId, products, counterparties, setValue]);

  // With a single production line there is nothing to choose -- preselect it
  // on create so the operator doesn't have to open the select at all. Guarded
  // by the touched ref (not `dirtyFields`, same reasoning as the counterparty
  // refs above) so an operator who explicitly cleared the line back to "none"
  // isn't overridden by a background lines refetch.
  useEffect(() => {
    if (formMode !== "create" || lines.length !== 1) return;
    if (lineTouchedRef.current) return;
    const onlyLine = lines[0];
    if (!onlyLine) return;
    setValue("lineId", onlyLine.id);
  }, [formMode, lines, setValue]);

  const submit = handleSubmit(async (values) => {
    const resolvedBoxLabelTemplateId = resolveBoxLabelTemplateId(
      values.boxLabelTemplateSelection,
      formContext.defaultBoxLabelTemplateId,
    );
    if (values.mode === "aggregation" && resolvedBoxLabelTemplateId === null) {
      setError("boxLabelTemplateSelection", {
        type: "manual",
        message: "pages.shifts.form.errors.boxLabelTemplateRequired",
      });
      return;
    }
    clearErrors("boxLabelTemplateSelection");
    await onSubmit(
      toPayload(
        values,
        formMode,
        {
          counterparty: counterpartyTouchedRef.current,
          ssccIssuer: ssccIssuerTouchedRef.current,
        },
        resolvedBoxLabelTemplateId,
        editStatus,
        {
          lineId: dirtyFields.lineId === true,
          plannedQty: dirtyFields.plannedQty === true,
          plannedDate: dirtyFields.plannedDate === true,
          productionDate: dirtyFields.productionDate === true,
          boxLabelTemplate: dirtyFields.boxLabelTemplateSelection === true,
        },
      ),
    );
  });

  const productOptions: ComboboxOption[] = products.map((product) => ({
    value: product.id,
    label:
      product.status === "draft"
        ? `${product.name} (${t("pages.shifts.form.draftHint")})`
        : product.name,
    disabled: product.status === "draft",
  }));

  const lineOptions: SelectOption[] = [
    { value: "", label: t("pages.shifts.form.noLine") },
    ...lines.map((line) => ({ value: line.id, label: line.name })),
  ];

  const counterpartyOptions: ComboboxOption[] = [
    { value: "", label: t("pages.shifts.form.noCounterparty") },
    ...counterparties.map((counterparty) => ({
      value: counterparty.id,
      label: counterparty.name,
    })),
  ];

  // Default option reads "our own organization", not "none selected" -- the
  // issuer always resolves to *something* (the tenant itself when unset),
  // unlike the counterparty select above where "none" is a genuine absence.
  const ssccIssuerOptions: SelectOption[] = [
    { value: "", label: t("pages.shifts.form.ssccIssuerOurOrganization") },
    ...counterparties.map((counterparty) => ({
      value: counterparty.id,
      label: counterparty.name,
    })),
  ];

  const currentDefaultTemplate = formContext.labelTemplates.find(
    (template) => template.id === formContext.defaultBoxLabelTemplateId,
  );
  const organizationDefaultName =
    formContext.defaultBoxLabelTemplateId === null
      ? t("pages.shifts.form.boxLabelTemplateNotConfigured")
      : (currentDefaultTemplate?.name ?? t("pages.shifts.form.boxLabelTemplateUnavailable"));
  const boxLabelTemplateOptions: SelectOption[] = [
    {
      value: BOX_TEMPLATE_SELECTION.organization,
      label: t("pages.shifts.form.boxLabelTemplateOrganization", {
        name: organizationDefaultName,
      }),
    },
    ...(formMode === "edit"
      ? [
          {
            value: BOX_TEMPLATE_SELECTION.none,
            label: t("pages.shifts.form.noBoxLabelTemplate"),
          },
        ]
      : []),
    ...formContext.labelTemplates.map((template) => ({
      value: template.id,
      label: template.name,
    })),
    ...(boxLabelTemplateSelection !== BOX_TEMPLATE_SELECTION.organization &&
    boxLabelTemplateSelection !== BOX_TEMPLATE_SELECTION.none &&
    !formContext.labelTemplates.some((template) => template.id === boxLabelTemplateSelection)
      ? [
          {
            value: boxLabelTemplateSelection,
            label: t("pages.shifts.form.boxLabelTemplateUnavailable"),
          },
        ]
      : []),
  ];

  return (
    <SidePanel
      open
      size="complex"
      busy={submitting}
      onClose={onClose}
      closeLabel={t("common.close")}
      title={
        titleOverride ??
        (formMode === "create"
          ? t("pages.shifts.form.createTitle")
          : t("pages.shifts.form.editTitle"))
      }
      footer={
        <>
          <Button type="button" variant="secondary" disabled={submitting} onClick={onClose}>
            {t("pages.shifts.cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} loading={submitting}>
            {formMode === "create"
              ? t("pages.shifts.form.submitCreate")
              : t("pages.shifts.form.submitUpdate")}
          </Button>
        </>
      }
    >
      {submissionError ? <Alert tone="error">{submissionError}</Alert> : null}
      <form
        id={FORM_ID}
        className="mk-shift-form"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <section className="mk-shift-form__section">
          <h3>{t("pages.shifts.sections.product")}</h3>
          <div className="mk-shift-form__grid">
            <Combobox
              label={t("pages.shifts.form.productLabel")}
              options={productOptions}
              value={productId}
              disabled={formMode === "edit"}
              placeholder={t("pages.shifts.form.productPlaceholder")}
              searchPlaceholder={t("pages.shifts.form.productSearchPlaceholder")}
              emptyText={t("pages.shifts.form.productEmpty")}
              loadingText={t("common.loading")}
              {...errorProp(translateFieldError(t, errors.productId?.message))}
              onValueChange={(value) =>
                setValue("productId", value, { shouldDirty: true, shouldValidate: true })
              }
            />
            <Controller
              control={control}
              name="mode"
              render={({ field }) => (
                <RadioGroup
                  label={t("pages.shifts.form.modeLabel")}
                  options={[
                    { value: "validation", label: t("pages.shifts.form.modeValidation") },
                    { value: "aggregation", label: t("pages.shifts.form.modeAggregation") },
                  ]}
                  value={field.value}
                  disabled={activeEdit}
                  onValueChange={(value) => {
                    field.onChange(value);
                    if (value === "validation") clearErrors("boxLabelTemplateSelection");
                  }}
                />
              )}
            />
          </div>
        </section>

        <section className="mk-shift-form__section">
          <h3>{t("pages.shifts.sections.planning")}</h3>
          <div className="mk-shift-form__grid">
            <Input
              label={t("pages.shifts.form.plannedQtyLabel")}
              mono
              inputMode="numeric"
              {...errorProp(translateFieldError(t, errors.plannedQty?.message))}
              {...register("plannedQty")}
            />
            <Controller
              control={control}
              name="plannedDate"
              render={({ field }) => (
                <DatePicker
                  label={t("pages.shifts.form.plannedDateLabel")}
                  placeholder={t("common.datePicker.placeholder")}
                  clearLabel={t("common.datePicker.clear")}
                  calendarLabel={t("common.datePicker.calendar")}
                  previousMonthLabel={t("common.datePicker.previousMonth")}
                  nextMonthLabel={t("common.datePicker.nextMonth")}
                  locale={i18n.language}
                  {...(field.value ? { value: field.value } : {})}
                  onValueChange={(value) => field.onChange(value ?? "")}
                />
              )}
            />
            <Controller
              control={control}
              name="productionDate"
              render={({ field }) => (
                <DatePicker
                  label={t("pages.shifts.form.productionDateLabel")}
                  hint={t("pages.shifts.form.productionDateHint")}
                  placeholder={t("common.datePicker.placeholder")}
                  clearLabel={t("common.datePicker.clear")}
                  calendarLabel={t("common.datePicker.calendar")}
                  previousMonthLabel={t("common.datePicker.previousMonth")}
                  nextMonthLabel={t("common.datePicker.nextMonth")}
                  locale={i18n.language}
                  {...(field.value ? { value: field.value } : {})}
                  onValueChange={(value) => field.onChange(value ?? "")}
                />
              )}
            />
          </div>
        </section>

        <section className="mk-shift-form__section">
          <h3>{t("pages.shifts.sections.assignment")}</h3>
          <div className="mk-shift-form__grid">
            <Select
              label={t("pages.shifts.form.lineLabel")}
              options={lineOptions}
              value={lineId ?? ""}
              {...(lines.length === 0 ? { hint: t("pages.shifts.form.noLinesHint") } : {})}
              onValueChange={(value) => {
                lineTouchedRef.current = true;
                setValue("lineId", value, { shouldDirty: true });
              }}
            />
            <Combobox
              label={t("pages.shifts.form.counterpartyLabel")}
              options={counterpartyOptions}
              value={counterpartyId ?? ""}
              disabled={activeEdit}
              placeholder={t("pages.shifts.form.noCounterparty")}
              searchPlaceholder={t("pages.shifts.form.counterpartySearchPlaceholder")}
              emptyText={t("pages.shifts.form.counterpartyEmpty")}
              loadingText={t("common.loading")}
              onValueChange={(value) => {
                counterpartyTouchedRef.current = true;
                setValue("counterpartyId", value, { shouldDirty: true, shouldValidate: true });
              }}
            />
            <div className="mk-shift-form__wide">
              <Select
                label={t("pages.shifts.form.ssccIssuerLabel")}
                options={ssccIssuerOptions}
                value={ssccIssuerCounterpartyId ?? ""}
                disabled={activeEdit}
                hint={t("pages.shifts.form.ssccIssuerHint")}
                onValueChange={(value) => {
                  ssccIssuerTouchedRef.current = true;
                  setValue("ssccIssuerCounterpartyId", value, {
                    shouldDirty: true,
                    shouldValidate: true,
                  });
                }}
              />
            </div>
          </div>
        </section>

        <section className="mk-shift-form__section">
          <h3>{t("pages.shifts.sections.templates")}</h3>
          <div className="mk-shift-form__grid">
            <Select
              label={t("pages.shifts.form.boxLabelTemplateLabel")}
              options={boxLabelTemplateOptions}
              value={boxLabelTemplateSelection}
              {...errorProp(translateFieldError(t, errors.boxLabelTemplateSelection?.message))}
              onValueChange={(value) => {
                clearErrors("boxLabelTemplateSelection");
                setValue("boxLabelTemplateSelection", value, {
                  shouldDirty: true,
                  shouldValidate: true,
                });
              }}
            />
          </div>
        </section>

        {shiftMode === "aggregation" && (
          <section className="mk-shift-form__section">
            <h3>{t("pages.shifts.sections.aggregation")}</h3>
            <div className="mk-shift-form__grid">
              <Input
                label={t("pages.shifts.form.boxCapacityLabel")}
                mono
                inputMode="numeric"
                {...errorProp(translateFieldError(t, errors.boxCapacity?.message))}
                disabled={activeEdit}
                {...register("boxCapacity")}
              />
              <Controller
                control={control}
                name="palletsEnabled"
                render={({ field }) => (
                  <Checkbox
                    label={t("pages.shifts.form.palletsEnabledLabel")}
                    checked={field.value}
                    disabled={activeEdit}
                    onCheckedChange={field.onChange}
                  />
                )}
              />
              {palletsEnabled ? (
                <Input
                  label={t("pages.shifts.form.palletCapacityLabel")}
                  mono
                  inputMode="numeric"
                  {...errorProp(translateFieldError(t, errors.palletCapacity?.message))}
                  disabled={activeEdit}
                  {...register("palletCapacity")}
                />
              ) : null}
            </div>
          </section>
        )}
      </form>
    </SidePanel>
  );
}

/**
 * Normalizes raw form values into the API's create/update payload shape.
 *
 * Payload semantics (plan-03 Task 13 brief, chosen + documented here since
 * the brief poses this as an open question):
 *
 * - `counterpartyId`/`ssccIssuerCounterpartyId`: omitted entirely unless the
 *   user actually touched the respective select (`touched.counterparty`/
 *   `touched.ssccIssuer`, each sourced from its own plain ref the select's
 *   `onChange` sets -- deliberately not
 *   react-hook-form's `dirtyFields`, which compares the *final* value to the
 *   default and would read "not dirty" if the user picks a different option
 *   and then picks the original one back). This lets the server's own
 *   create-time prefill-from-product run when `counterpartyId` is left alone,
 *   while an explicit user selection (including clearing it back to "None")
 *   always sends `null`/the chosen id. On edit, "untouched" maps onto the same
 *   `undefined`-means-"no change" contract `updateShiftSchema` already uses.
 * - `boxLabelTemplateId` is resolved before this function: the form's
 *   organisation-selection token becomes the current organisation UUID (or
 *   null when unset), while a concrete template selection stays a concrete
 *   UUID. Create omits a missing value so validation shifts may use the API's
 *   absence semantics; edit always sends the selected snapshot, including an
 *   explicit null snapshot.
 * - `boxCapacity`/`palletCapacity`: once the aggregation
 *   fields are visible, whatever value is *shown* is always sent (never
 *   omitted, touched or not), because the user can see a concrete number in
 *   the input and expects that exact value to be saved. They're omitted only
 *   when hidden (`mode === "validation"`), where they're not applicable.
 * - Active-shift edits send `lineId`, `plannedQty`, `plannedDate`, and
 *   `productionDate` only when their final value differs from the form
 *   default. This prevents a stale edit panel from overwriting a concurrent
 *   correction.
 * - Every other field (`mode`, `lineId`, `plannedQty`, `plannedDate`,
 *   `palletsEnabled`) is always sent as shown, matching the simpler
 *   full-form-resend convention `ProductForm`/`CounterpartyForm` already use.
 * - `productId` is included only on create -- `updateShiftSchema` has no such
 *   field (the product select is disabled while editing), so it's left out
 *   of the update payload entirely rather than sending a value the server
 *   would just ignore.
 */
function toPayload(
  values: ShiftFormValues,
  formMode: "create" | "edit",
  touched: {
    counterparty: boolean;
    ssccIssuer: boolean;
  },
  resolvedBoxLabelTemplateId: string | null,
  editStatus?: ShiftStatus,
  changed: {
    lineId: boolean;
    plannedQty: boolean;
    plannedDate: boolean;
    productionDate: boolean;
    boxLabelTemplate: boolean;
  } = {
    lineId: true,
    plannedQty: true,
    plannedDate: true,
    productionDate: true,
    boxLabelTemplate: true,
  },
): CreateShiftInput | UpdateShiftInput {
  const plannedQty = values.plannedQty?.trim();
  const plannedDate = values.plannedDate?.trim();
  const productionDate = values.productionDate?.trim();
  const lineId = values.lineId?.trim();
  const counterpartyId = values.counterpartyId?.trim();
  const ssccIssuerCounterpartyId = values.ssccIssuerCounterpartyId?.trim();
  const boxCapacity = values.boxCapacity?.trim();
  const palletCapacity = values.palletCapacity?.trim();

  const payload: UpdateShiftInput = {
    mode: values.mode,
    lineId: lineId ? lineId : null,
    plannedQty: plannedQty ? Number(plannedQty) : null,
    plannedDate: plannedDate ? plannedDate : null,
  };

  if (formMode === "edit" && editStatus === "active") {
    const activePayload: UpdateShiftInput = {};
    if (changed.lineId) activePayload.lineId = lineId ? lineId : null;
    if (changed.plannedQty) activePayload.plannedQty = plannedQty ? Number(plannedQty) : null;
    if (changed.plannedDate) activePayload.plannedDate = plannedDate ? plannedDate : null;
    if (changed.productionDate) {
      activePayload.productionDate = productionDate ? productionDate : null;
    }
    if (changed.boxLabelTemplate) {
      activePayload.boxLabelTemplateId = resolvedBoxLabelTemplateId;
    }
    return activePayload;
  }

  if (touched.counterparty) {
    payload.counterpartyId = counterpartyId ? counterpartyId : null;
  }

  if (touched.ssccIssuer) {
    payload.ssccIssuerCounterpartyId = ssccIssuerCounterpartyId ? ssccIssuerCounterpartyId : null;
  }

  if (values.mode === "aggregation") {
    payload.boxCapacity = boxCapacity ? Number(boxCapacity) : null;
    payload.palletsEnabled = values.palletsEnabled;
    if (values.palletsEnabled) {
      payload.palletCapacity = palletCapacity ? Number(palletCapacity) : null;
    }
  }

  if (formMode === "create") {
    return {
      ...payload,
      productId: values.productId.trim(),
      ...(productionDate ? { productionDate } : {}),
      ...(resolvedBoxLabelTemplateId === null
        ? {}
        : { boxLabelTemplateId: resolvedBoxLabelTemplateId }),
    };
  }
  payload.productionDate = productionDate ? productionDate : null;
  payload.boxLabelTemplateId = resolvedBoxLabelTemplateId;
  return payload;
}

function resolveBoxLabelTemplateId(
  selection: string,
  defaultBoxLabelTemplateId: string | null,
): string | null {
  if (selection === BOX_TEMPLATE_SELECTION.organization) return defaultBoxLabelTemplateId;
  if (selection === BOX_TEMPLATE_SELECTION.none) return null;
  return selection;
}
