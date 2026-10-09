import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { DatePicker, Input, Select } from "@markiro/ui";

import type { OfficeShift } from "../../host/protocol.js";
import { shiftCreate } from "../../host/requests.js";
import { suggestBoxTemplate } from "../../lib/box-template-choice.js";
import { civilToday, isKnownTimeZone } from "../../lib/civil-date.js";
import { useTemplateDefaults, useTemplates } from "../catalog-queries.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { PageLoading, WriteFailureAlert } from "../page-state.js";
import { activeFirstByName } from "../records.js";
import { templateOptions } from "../template-options.js";
import {
  newShiftFields,
  SHIFT_CONFLICTS,
  SHIFT_FIELD_ORDER,
  SHIFT_FIELDS,
  shiftFieldsSchema,
  toShiftInput,
  type ShiftFields,
} from "./shift-form.js";
import { datePickerTexts } from "./shift-text.js";

export interface ShiftDialogProps {
  onClose: () => void;
  onSaved: (shift: OfficeShift) => void;
}

/**
 * Plans a shift (stage 2a spec §5.6). The production date starts as today in
 * the organization's time zone, so the dialog waits for the organization's
 * profile; when the profile does not load, or names a zone this PC does not
 * know, it starts as this PC's date and says so.
 */
export function ShiftDialog(props: ShiftDialogProps) {
  const { t } = useTranslation();
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  if (org.isPending) {
    return (
      <FormDialog
        title={t("office.shifts.createTitle")}
        submitLabel={t("office.shifts.create")}
        submitDisabled
        onSubmit={() => Promise.resolve()}
        onClose={props.onClose}
      >
        <PageLoading />
      </FormDialog>
    );
  }
  const zone = org.isSuccess && isKnownTimeZone(org.data.timeZone) ? org.data.timeZone : null;
  return (
    <ShiftForm
      {...props}
      today={civilToday(zone)}
      dateNote={zone !== null ? null : org.isSuccess ? "localDateZone" : "localDate"}
    />
  );
}

/** An Escape the open calendar has handled closes the calendar only, not the dialog around it. */
function keepCalendarEscape(event: KeyboardEvent<HTMLElement>): void {
  if (event.key === "Escape" && event.defaultPrevented) event.stopPropagation();
}

interface ShiftFormProps extends ShiftDialogProps {
  today: string;
  /** Why `today` is this PC's date, not the organization's; `null` when it is the organization's. */
  dateNote: "localDate" | "localDateZone" | null;
}

function ShiftForm({ onClose, onSaved, today, dateNote }: ShiftFormProps) {
  const { t } = useTranslation();
  const ids = useId();
  const fieldId = (name: (typeof SHIFT_FIELD_ORDER)[number]) => `${ids}-${name}`;
  // The refused field, focused once the form is on again after a submit.
  const focusAfterRender = useRef<(typeof SHIFT_FIELD_ORDER)[number] | null>(null);
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const products = useOfficeQuery(officeKeys.products, (api, token) => api.listProducts(token));
  const lines = useOfficeQuery(officeKeys.lines, (api, token) => api.listLines(token));
  const counterparties = useOfficeQuery(officeKeys.counterparties, (api, token) =>
    api.listCounterparties(token),
  );
  const templates = useTemplates();
  const defaults = useTemplateDefaults();
  const save = useOfficeMutation((api, token, values: ShiftFields) =>
    api.createShift(token, shiftCreate(toShiftInput(values))),
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    clearErrors,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ShiftFields>({
    resolver: zodResolver(shiftFieldsSchema),
    defaultValues: newShiftFields(today),
    // The first refused field in the form's order takes the focus, selects and the date included.
    shouldFocusError: false,
  });
  // The controls wait while a write is on its way: a product chosen meanwhile
  // would move the capacity and the template under the request.
  const locked = isSubmitting;
  useEffect(() => {
    const target = focusAfterRender.current;
    if (target === null || isSubmitting) return;
    focusAfterRender.current = null;
    document.getElementById(fieldId(target))?.focus();
  });
  const productId = watch("productId");
  const product = products.data?.find((each) => each.id === productId);

  // A product in use: active and not archived, by name, its GTIN beside it.
  const productOptions = activeFirstByName(products.data ?? [])
    .filter((each) => !each.archived && each.status === "active")
    .map((each) => ({
      value: each.id,
      label: t("office.shifts.productOption", { name: each.name, gtin: each.gtin14 }),
    }));
  const lineOptions = activeFirstByName(lines.data ?? [])
    .filter((line) => !line.archived)
    .map((line) => ({ value: line.id, label: line.name }));
  const counterpartyOptions = [
    { value: "", label: t("office.shifts.fields.noCounterparty") },
    ...activeFirstByName(counterparties.data ?? [])
      .filter((each) => !each.archived)
      .map((each) => ({ value: each.id, label: each.name })),
  ];

  const chooseProduct = (id: string, onChange: (id: string) => void) => {
    onChange(id);
    const chosen = products.data?.find((each) => each.id === id);
    if (chosen === undefined) return;
    // The capacity and the template follow the product whenever it changes.
    setValue("boxCapacity", chosen.boxCapacity === null ? "" : String(chosen.boxCapacity), {
      shouldDirty: true,
    });
    const suggested = suggestBoxTemplate(chosen, templates.data ?? [], defaults.data ?? null);
    setValue("boxTemplateId", suggested ?? "", { shouldDirty: true });
    // A refusal of the earlier values does not outlive them.
    clearErrors(["boxCapacity", "boxTemplateId"]);
  };

  const submit = handleSubmit(
    async (values) => {
      setFailure(null);
      let saved: OfficeShift;
      try {
        saved = await save.mutateAsync(values);
      } catch (error) {
        const outcome = writeFailure(error, SHIFT_FIELDS, SHIFT_CONFLICTS);
        if (outcome.kind === "field") {
          setError(outcome.field, { type: "server", message: outcome.message });
          focusAfterRender.current = outcome.field;
          // A template switched off or narrowed meanwhile shows as marked once read again.
          if (outcome.field === "boxTemplateId") void templates.refetch();
        } else {
          setFailure(outcome);
        }
        return;
      }
      onSaved(saved);
    },
    (invalid) => {
      focusAfterRender.current =
        SHIFT_FIELD_ORDER.find((name) => invalid[name] !== undefined) ?? null;
    },
  );

  return (
    <FormDialog
      title={t("office.shifts.createTitle")}
      submitLabel={t("office.shifts.create")}
      width={560}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <Controller
        control={control}
        name="productId"
        render={({ field }) => (
          <Select
            native
            label={t("office.shifts.fields.product")}
            placeholder={t("office.shifts.fields.productPlaceholder")}
            options={productOptions}
            value={field.value}
            onValueChange={(id) => chooseProduct(id, field.onChange)}
            // The template follows the product, so the product waits for the templates and the defaults.
            id={fieldId("productId")}
            disabled={locked || !products.isSuccess || templates.isPending || defaults.isPending}
            {...(products.isError ? { hint: t("office.shifts.fields.productsUnavailable") } : {})}
            {...fieldError(errors.productId?.message)}
          />
        )}
      />
      <Controller
        control={control}
        name="lineId"
        render={({ field }) => (
          <Select
            native
            label={t("office.shifts.fields.line")}
            placeholder={t("office.shifts.fields.linePlaceholder")}
            options={lineOptions}
            value={field.value}
            onValueChange={field.onChange}
            id={fieldId("lineId")}
            disabled={locked || !lines.isSuccess}
            {...(lines.isError ? { hint: t("office.shifts.fields.linesUnavailable") } : {})}
            {...fieldError(errors.lineId?.message)}
          />
        )}
      />
      <Controller
        control={control}
        name="productionDate"
        render={({ field }) => (
          // The calendar is portalled out of the dialog, but React still bubbles its keys
          // through the dialog, whose `Modal` closes on any Escape that reaches it. The
          // popover has already used (and `preventDefault`ed) the Escape that closes the
          // calendar, so only that one is held back here.
          <div onKeyDown={keepCalendarEscape}>
            <DatePicker
              label={t("office.shifts.fields.productionDate")}
              {...datePickerTexts(t)}
              {...(field.value === "" ? {} : { value: field.value })}
              onValueChange={(value) => field.onChange(value ?? "")}
              id={fieldId("productionDate")}
              disabled={locked}
              {...(dateNote === null ? {} : { hint: t(`office.shifts.fields.${dateNote}`) })}
              {...fieldError(errors.productionDate?.message)}
            />
          </div>
        )}
      />
      <Input
        label={t("office.shifts.fields.plannedQty")}
        hint={t("office.shifts.fields.optional")}
        inputMode="numeric"
        mono
        id={fieldId("plannedQty")}
        disabled={locked}
        {...fieldError(errors.plannedQty?.message)}
        {...register("plannedQty")}
      />
      <Input
        label={t("office.shifts.fields.boxCapacity")}
        hint={t("office.shifts.fields.boxCapacityHint")}
        inputMode="numeric"
        mono
        id={fieldId("boxCapacity")}
        disabled={locked}
        {...fieldError(errors.boxCapacity?.message)}
        {...register("boxCapacity")}
      />
      <Controller
        control={control}
        name="boxTemplateId"
        render={({ field }) => (
          <Select
            native
            label={t("office.shifts.fields.boxTemplate")}
            placeholder={t(
              product === undefined
                ? "office.shifts.fields.templateAfterProduct"
                : "office.shifts.fields.templatePlaceholder",
            )}
            // «Не выбран» is no choice here: a shift prints with a template. Before a
            // product is chosen there is nothing to fit.
            options={
              product === undefined
                ? []
                : templateOptions(
                    templates.data,
                    "box",
                    product.chzProductGroupCode,
                    [field.value],
                    t,
                  ).filter((option) => option.value !== "")
            }
            value={field.value}
            onValueChange={field.onChange}
            id={fieldId("boxTemplateId")}
            disabled={locked || !templates.isSuccess || product === undefined}
            {...(templates.isError ? { hint: t("office.shifts.fields.templatesUnavailable") } : {})}
            {...fieldError(errors.boxTemplateId?.message)}
          />
        )}
      />
      <Controller
        control={control}
        name="counterpartyId"
        render={({ field }) => (
          <Select
            native
            label={t("office.shifts.fields.counterparty")}
            hint={t(
              counterparties.isError
                ? "office.shifts.fields.counterpartiesUnavailable"
                : "office.shifts.fields.counterpartyHint",
            )}
            options={counterpartyOptions}
            value={field.value}
            onValueChange={field.onChange}
            id={fieldId("counterpartyId")}
            disabled={locked || !counterparties.isSuccess}
            {...fieldError(errors.counterpartyId?.message)}
          />
        )}
      />
    </FormDialog>
  );
}
