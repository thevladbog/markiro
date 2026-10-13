import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Checkbox, DatePicker, Input, Select } from "@markiro/ui";

import type { OfficeShift, ShiftCreate, ShiftUpdate } from "../../host/protocol.js";
import { shiftCreate, shiftUpdate } from "../../host/requests.js";
import { suggestBoxTemplate, suggestPalletTemplate } from "../../lib/box-template-choice.js";
import { civilToday, isKnownTimeZone } from "../../lib/civil-date.js";
import { useTemplateDefaults, useTemplates } from "../catalog-queries.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { PageLoading, StaleAlert, WriteFailureAlert } from "../page-state.js";
import { activeFirstByName } from "../records.js";
import { templateOptions } from "../template-options.js";
import {
  newShiftFields,
  SHIFT_CONFLICTS,
  SHIFT_FIELD_ORDER,
  SHIFT_FIELDS,
  shiftFields,
  shiftFieldsSchema,
  shiftWriteFailure,
  toShiftChange,
  toShiftInput,
  type ShiftFields,
} from "./shift-form.js";
import { openBlocker, recordLabel } from "./shift-list.js";
import { useRereadShiftsOnLostAnswer } from "./shift-reread.js";
import { defaultSheetFor } from "../sheet-choice.js";
import { sheetOptions } from "./sheet-options.js";
import { datePickerTexts } from "./shift-text.js";

export interface ShiftDialogProps {
  /** `null` plans a new shift; a planned shift is changed. */
  shift: OfficeShift | null;
  onClose: () => void;
  onSaved: (shift: OfficeShift) => void;
  /** The shift changed on the host: close and load the list again. */
  onReload: () => void;
  /** The shift was opened, closed or deleted meanwhile: the page reads the list again. */
  onOutdated: () => void;
}

/**
 * Plans a shift, or changes a planned one (stage 2a spec §5.6), with pallets
 * or without (plan О-Ф: their capacity from the product, their template by
 * decision 7 for the purpose `pallet`, both changeable). A new shift's
 * production date starts as today in the organization's time zone, so the
 * dialog waits for the organization's profile; when the profile does not
 * load, or names a zone this PC does not know, it starts as this PC's date
 * and says so. A changed shift needs no "today": it starts on its own values.
 */
export function ShiftDialog(props: ShiftDialogProps) {
  const { t } = useTranslation();
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token), {
    enabled: props.shift === null,
  });
  if (props.shift !== null) {
    return <ShiftForm {...props} today={props.shift.productionDate} dateNote={null} />;
  }
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

function ShiftForm({
  shift,
  onClose,
  onSaved,
  onReload,
  onOutdated,
  today: todayAtOpen,
  dateNote: dateNoteAtOpen,
}: ShiftFormProps) {
  const { t } = useTranslation();
  // The date the form started on and the note about where it came from are fixed when the
  // dialog opens: the profile read again later (failing, or arriving after a failure)
  // must not put a note under, or take one from, a date that did not change.
  const [{ today, dateNote }] = useState(() => ({ today: todayAtOpen, dateNote: dateNoteAtOpen }));
  const ids = useId();
  const rereadIfLost = useRereadShiftsOnLostAnswer();
  const fieldId = (name: (typeof SHIFT_FIELD_ORDER)[number]) => `${ids}-${name}`;
  // The refused field, focused once the form is on again after a submit.
  const focusAfterRender = useRef<(typeof SHIFT_FIELD_ORDER)[number] | null>(null);
  // The counterparty a chosen product offered (plan ТОВ), while the person has not changed it:
  // it follows the product as the capacity does; one the person chose stays.
  const offeredCounterparty = useRef<string | null>(null);
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  // The key of the text that says the shift was opened, closed or deleted meanwhile: a
  // resend would be refused the same way, so «Сохранить» stays off and the alert offers
  // to load the list again, as a stale save does.
  const [outdatedMessage, setOutdatedMessage] = useState<string | null>(null);
  const products = useOfficeQuery(officeKeys.products, (api, token) => api.listProducts(token));
  const lines = useOfficeQuery(officeKeys.lines, (api, token) => api.listLines(token));
  const counterparties = useOfficeQuery(officeKeys.counterparties, (api, token) =>
    api.listCounterparties(token),
  );
  const templates = useTemplates();
  const defaults = useTemplateDefaults();
  const save = useOfficeMutation(
    (api, token, request: { create: ShiftCreate } | { id: string; update: ShiftUpdate }) =>
      "create" in request
        ? api.createShift(token, request.create)
        : api.updateShift(token, request.id, request.update),
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    clearErrors,
    watch,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<ShiftFields>({
    resolver: zodResolver(shiftFieldsSchema),
    defaultValues: shift === null ? newShiftFields(today) : shiftFields(shift),
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
  const lineId = watch("lineId");
  const counterpartyId = watch("counterpartyId");
  const palletsEnabled = watch("palletsEnabled");
  // The A4 sheets matter only with pallets; they are read when the pallets are on.
  const palletSheets = useOfficeQuery(
    officeKeys.palletSheets,
    (api, token) => api.listPalletSheets(token),
    { enabled: palletsEnabled },
  );
  const product = products.data?.find((each) => each.id === productId);
  // Pallets need the product's pallet capacity, as the cloud's switch does.
  const palletsPossible = product !== undefined && product.palletBoxCapacity !== null;
  // A changed shift of an archived or draft product will not open, whatever is changed.
  const productBlocker = shift === null ? null : openBlocker(shift, products.data, undefined);

  // How a product the form holds is named when it is no longer one in use: a draft or an archived one.
  const productMarkedLabel = (id: string): string => {
    const record = products.data?.find((each) => each.id === id);
    return record !== undefined && !record.archived && record.status !== "active"
      ? t("office.shifts.draftName", { name: record.name })
      : recordLabel("product", products.data, id, t);
  };
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
  // The form's own choices stay offered, marked when the record is archived (or a draft) or
  // missing from the list: a changed shift's own line and counterparty (the host keeps one that
  // does not change), and a record the host refused after the person chose it. A select whose
  // value matches no option shows another record, which the person could not pick again.
  const keep = (
    options: { value: string; label: string }[],
    ids: string[],
    label: (id: string) => string,
  ) => {
    for (const id of ids) {
      if (id !== "" && !options.some((option) => option.value === id)) {
        options.push({ value: id, label: label(id) });
      }
    }
  };
  if (shift === null) {
    keep(productOptions, [productId], productMarkedLabel);
  }
  keep(lineOptions, [shift?.lineId ?? "", lineId], (id) => recordLabel("line", lines.data, id, t));
  keep(counterpartyOptions, [shift?.counterpartyId ?? "", counterpartyId], (id) =>
    recordLabel("counterparty", counterparties.data, id, t),
  );

  // Without the product's record (its list did not load) a changed shift can name only its
  // own template, and cannot say whether it fits.
  const ownTemplate =
    shift === null
      ? []
      : [
          {
            value: shift.boxTemplateId,
            label:
              templates.data?.find((each) => each.id === shift.boxTemplateId)?.name ??
              t("office.templateChoice.id", { id: shift.boxTemplateId.slice(0, 8) }),
          },
        ];

  /** The pallets' capacity and template from `chosen`, as a new choice of pallets takes them. */
  const palletsFrom = (chosen: NonNullable<typeof product>) => {
    setValue(
      "palletBoxCapacity",
      chosen.palletBoxCapacity === null ? "" : String(chosen.palletBoxCapacity),
      { shouldDirty: true },
    );
    const suggested = suggestPalletTemplate(chosen, templates.data ?? [], defaults.data ?? null);
    setValue("palletTemplateId", suggested ?? "", { shouldDirty: true });
    clearErrors(["palletBoxCapacity", "palletTemplateId"]);
  };

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
    // The product's default counterparty, when it is in use, fills an empty choice or
    // replaces one an earlier product offered; a choice of the person's own stays.
    const current = watch("counterpartyId");
    if (current === "" || current === offeredCounterparty.current) {
      const offer = counterparties.data?.find(
        (each) => each.id === chosen.defaultCounterpartyId && !each.archived,
      );
      const next = offer?.id ?? "";
      offeredCounterparty.current = offer === undefined ? null : offer.id;
      if (next !== current) {
        setValue("counterpartyId", next, { shouldDirty: true });
        clearErrors("counterpartyId");
      }
    }
    // So do the pallets', when they are on; a product without a pallet capacity turns them off.
    if (palletsEnabled && chosen.palletBoxCapacity === null) {
      setValue("palletsEnabled", false, { shouldDirty: true });
    } else if (palletsEnabled) {
      palletsFrom(chosen);
    }
  };

  const choosePallets = (on: boolean, onChange: (on: boolean) => void) => {
    onChange(on);
    if (on && product !== undefined) palletsFrom(product);
    if (!on) clearErrors(["palletBoxCapacity", "palletTemplateId", "palletSheetTemplateId"]);
  };

  const submit = handleSubmit(
    async (values) => {
      setFailure(null);
      const update = shift === null ? null : shiftUpdate(shift, toShiftChange(values));
      // The form is changed but the shift is not (blanks typed, a value written as it was):
      // there is nothing to send, and nothing was saved.
      if (update !== null && Object.keys(update).length === 1) {
        onClose();
        return;
      }
      let saved: OfficeShift;
      try {
        saved = await save.mutateAsync(
          shift === null || update === null
            ? { create: shiftCreate(toShiftInput(values)) }
            : { id: shift.id, update },
        );
      } catch (error) {
        // A shift opened, closed or deleted meanwhile is a change's refusal only; a new
        // shift's `not_found` (the host is not set up) is not "the shift is gone".
        const { failure: outcome, outdated } =
          shift === null
            ? { failure: writeFailure(error, SHIFT_FIELDS, SHIFT_CONFLICTS), outdated: false }
            : shiftWriteFailure(error, SHIFT_FIELDS, SHIFT_CONFLICTS);
        if (outcome.kind === "field" && shift !== null && outcome.field === "productId") {
          // A changed shift has no product control to put the refusal under: the host
          // refused it because the shift's product is no longer in use.
          setFailure({ kind: "alert", message: outcome.message });
          void products.refetch();
        } else if (outcome.kind === "field") {
          setError(outcome.field, { type: "server", message: outcome.message });
          focusAfterRender.current = outcome.field;
          // A record the host refused (archived, switched off or narrowed meanwhile) is
          // no longer offered, or shows as marked, once its list is read again.
          if (outcome.field === "productId") void products.refetch();
          if (outcome.field === "lineId") void lines.refetch();
          if (outcome.field === "boxTemplateId" || outcome.field === "palletTemplateId") {
            void templates.refetch();
          }
          if (outcome.field === "palletSheetTemplateId") void palletSheets.refetch();
          if (outcome.field === "counterpartyId") void counterparties.refetch();
        } else if (outdated && outcome.kind === "alert") {
          setOutdatedMessage(outcome.message);
        } else {
          setFailure(outcome);
          // A lost answer: the host may have planned or changed the shift (a create has no
          // request id to make it repeatable), so the list behind shows whether it did.
          rereadIfLost(error);
        }
        if (outdated) onOutdated();
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
      title={
        shift === null
          ? t("office.shifts.createTitle")
          : t("office.shifts.editTitle", { number: shift.number })
      }
      submitLabel={shift === null ? t("office.shifts.create") : t("office.common.save")}
      submitDisabled={shift !== null && (!isDirty || outdatedMessage !== null)}
      width={560}
      onSubmit={submit}
      onClose={onClose}
      alert={
        outdatedMessage !== null ? (
          <StaleAlert onReload={onReload} message={outdatedMessage} />
        ) : (
          <WriteFailureAlert failure={failure} onReload={onReload} />
        )
      }
    >
      {shift !== null ? (
        // The product never changes: a changed shift names it.
        <>
          <p>
            {t("office.shifts.fields.productFixed", {
              name: recordLabel("product", products.data, shift.productId, t),
            })}
          </p>
          {productBlocker !== null && <p>{t(`office.shifts.blockers.${productBlocker}`)}</p>}
        </>
      ) : (
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
              // The template follows the product, so the product waits for the templates and the
              // defaults; and so does its default counterparty (plan ТОВ), for the counterparties.
              id={fieldId("productId")}
              disabled={
                locked ||
                !products.isSuccess ||
                templates.isPending ||
                defaults.isPending ||
                counterparties.isPending
              }
              {...(products.isError ? { hint: t("office.shifts.fields.productsUnavailable") } : {})}
              {...fieldError(errors.productId?.message)}
            />
          )}
        />
      )}
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
              product === undefined && shift === null
                ? "office.shifts.fields.templateAfterProduct"
                : "office.shifts.fields.templatePlaceholder",
            )}
            // «Не выбран» is no choice here: a shift prints with a template. Before a
            // product is chosen there is nothing to fit; a changed shift's own template
            // stays a choice, marked when it no longer fits (the host keeps it unchanged).
            options={
              product === undefined
                ? ownTemplate
                : templateOptions(
                    templates.data,
                    "box",
                    product.chzProductGroupCode,
                    [shift?.boxTemplateId ?? "", field.value],
                    t,
                  ).filter((option) => option.value !== "")
            }
            value={field.value}
            onValueChange={field.onChange}
            id={fieldId("boxTemplateId")}
            disabled={locked || !templates.isSuccess || product === undefined}
            {...(templates.isError
              ? { hint: t("office.shifts.fields.templatesUnavailable") }
              : shift !== null && product === undefined && products.isError
                ? { hint: t("office.shifts.fields.productsUnavailable") }
                : shift === null && defaults.isError
                  ? { hint: t("office.shifts.fields.defaultsUnavailable") }
                  : {})}
            {...fieldError(errors.boxTemplateId?.message)}
          />
        )}
      />
      <Controller
        control={control}
        name="palletsEnabled"
        render={({ field }) => (
          <Checkbox
            label={t("office.shifts.fields.pallets")}
            hint={t(
              product !== undefined && !palletsPossible
                ? "office.shifts.fields.palletsUnavailable"
                : "office.shifts.fields.palletsHint",
            )}
            checked={field.value}
            onCheckedChange={(on) => choosePallets(on, field.onChange)}
            id={fieldId("palletsEnabled")}
            // A changed shift's own pallets can always be turned off.
            disabled={locked || ((!palletsPossible || !templates.isSuccess) && !field.value)}
          />
        )}
      />
      {palletsEnabled && (
        <>
          <Input
            label={t("office.shifts.fields.palletBoxCapacity")}
            hint={t("office.shifts.fields.palletBoxCapacityHint")}
            inputMode="numeric"
            mono
            id={fieldId("palletBoxCapacity")}
            disabled={locked}
            {...fieldError(errors.palletBoxCapacity?.message)}
            {...register("palletBoxCapacity")}
          />
          <Controller
            control={control}
            name="palletTemplateId"
            render={({ field }) => (
              <Select
                native
                label={t("office.shifts.fields.palletTemplate")}
                placeholder={t("office.shifts.fields.templatePlaceholder")}
                options={templateOptions(
                  templates.data,
                  "pallet",
                  product?.chzProductGroupCode ?? null,
                  [shift?.palletTemplateId ?? "", field.value],
                  t,
                ).filter((option) => option.value !== "")}
                value={field.value}
                onValueChange={field.onChange}
                id={fieldId("palletTemplateId")}
                disabled={locked || !templates.isSuccess}
                {...(templates.isError
                  ? { hint: t("office.shifts.fields.templatesUnavailable") }
                  : {})}
                {...fieldError(errors.palletTemplateId?.message)}
              />
            )}
          />
          <Controller
            control={control}
            name="palletSheetTemplateId"
            render={({ field }) => (
              <Select
                native
                label={t("office.shifts.fields.palletSheet")}
                options={sheetOptions(
                  palletSheets.data,
                  shift?.palletSheetTemplateId ?? null,
                  field.value,
                  t,
                  defaultSheetFor(product, defaults.data, palletSheets.data),
                )}
                value={field.value}
                onValueChange={field.onChange}
                id={fieldId("palletSheetTemplateId")}
                disabled={locked}
                hint={t(
                  palletSheets.isError
                    ? "office.shifts.palletSheetsUnavailable"
                    : "office.shifts.fields.palletSheetHint",
                )}
                {...fieldError(errors.palletSheetTemplateId?.message)}
              />
            )}
          />
        </>
      )}
      <Controller
        control={control}
        name="counterpartyId"
        render={({ field }) => (
          <Select
            native
            label={t("office.shifts.fields.counterparty")}
            hint={t(
              counterparties.isError
                ? shift === null
                  ? "office.shifts.fields.counterpartiesUnavailable"
                  : "office.shifts.fields.counterpartiesUnavailableEdit"
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
