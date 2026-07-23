import { zodResolver } from "@hookform/resolvers/zod";
import type { TFunction } from "i18next";
import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Button, Input, Modal, Select } from "@markiro/ui";
import type { SelectOption } from "@markiro/ui";

import { errorProp } from "../../lib/form-error.js";
import type { CounterpartyDto } from "../counterparties/api.js";
import type { ProductDto } from "../catalog/api.js";
import type { CreateShiftInput, LineDto, UpdateShiftInput } from "./api.js";

const SHIFT_MODES = ["validation", "aggregation"] as const;

/**
 * Client-side mirror of the server's zod schema
 * (apps/api/src/modules/shifts/dto.ts): productId required (only meaningful
 * on create -- the product can't change once a shift exists, since
 * `updateShiftSchema` has no `productId` field at all), mode is one of the
 * two enum values, plannedQty/boxCapacity/palletCapacity are optional
 * positive integers entered as text (kept as strings in form state, parsed
 * to number|null on submit by `toPayload`), plannedDate is a native
 * `<input type="date">` value (already `YYYY-MM-DD`, matching the server's
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
  lineId: z.string().trim().optional(),
  counterpartyId: z.string().trim().optional(),
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

export interface ShiftFormProps {
  open: boolean;
  mode: "create" | "edit";
  initialValues?: ShiftFormValues;
  /** All products (both draft and active) -- draft ones render disabled with a hint. */
  products: ProductDto[];
  lines: LineDto[];
  counterparties: CounterpartyDto[];
  submitting?: boolean;
  onSubmit: (input: CreateShiftInput | UpdateShiftInput) => void | Promise<void>;
  onClose: () => void;
}

const EMPTY_VALUES: ShiftFormValues = {
  productId: "",
  mode: "validation",
  plannedQty: "",
  plannedDate: "",
  lineId: "",
  counterpartyId: "",
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
  open,
  mode: formMode,
  initialValues,
  products,
  lines,
  counterparties,
  submitting = false,
  onSubmit,
  onClose,
}: ShiftFormProps) {
  const { t } = useTranslation();
  const lastPrefilledProductRef = useRef<string | null>(null);
  // Tracks whether the user has ever directly changed the counterparty select
  // during this modal session -- deliberately NOT react-hook-form's own
  // `dirtyFields` (which compares the *final* value to the default, so
  // touching the field and landing back on the same value it started with
  // reads as "not dirty"). See `toPayload`'s comment for why this matters.
  const counterpartyTouchedRef = useRef(false);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<ShiftFormValues>({
    resolver: zodResolver(shiftFormSchema),
    defaultValues: initialValues ?? EMPTY_VALUES,
  });

  const productId = watch("productId");
  const shiftMode = watch("mode");
  const lineId = watch("lineId");
  const counterpartyId = watch("counterpartyId");
  const palletsEnabled = watch("palletsEnabled");

  // Re-seed the form whenever the modal opens (covers both the create ->
  // create and edit A -> edit B cases, since defaultValues is only read once
  // by react-hook-form on mount) -- same convention as
  // `../catalog/ProductForm.tsx`. The prefill guard ref is reset too, so a
  // fresh "create" open can prefill again for whichever product is picked
  // first.
  useEffect(() => {
    if (open) {
      const seeded = initialValues ?? EMPTY_VALUES;
      reset(seeded);
      lastPrefilledProductRef.current = formMode === "create" ? null : seeded.productId || null;
      counterpartyTouchedRef.current = false;
    }
  }, [open, initialValues, reset, formMode]);

  // Product-change prefill (create mode only -- the product can't change once
  // a shift exists, and the product select is disabled while editing): seeds
  // the counterparty select and the capacity inputs' *displayed* values from
  // the newly-picked product.
  //
  // This is a plain `setValue` call, not a user interaction, so it does NOT
  // set `counterpartyTouchedRef` -- the counterparty field stays "untouched"
  // for payload purposes even though it now visibly displays the product's
  // default (see `toPayload`'s comment for the full contract). boxCapacity/
  // palletCapacity don't need that distinction (their payload rule doesn't
  // look at touched-ness at all -- see below), but they're seeded the same
  // way for consistency.
  useEffect(() => {
    if (!open || formMode !== "create") return;
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
  }, [open, formMode, productId, products, setValue]);

  const submit = handleSubmit(async (values) => {
    await onSubmit(toPayload(values, formMode, counterpartyTouchedRef.current));
  });

  const productOptions: SelectOption[] = [
    { value: "", label: t("pages.shifts.form.productPlaceholder"), disabled: true },
    ...products.map((product) => ({
      value: product.id,
      label:
        product.status === "draft"
          ? `${product.name} (${t("pages.shifts.form.draftHint")})`
          : product.name,
      disabled: product.status === "draft",
    })),
  ];

  const lineOptions: SelectOption[] = [
    { value: "", label: t("pages.shifts.form.noLine") },
    ...lines.map((line) => ({ value: line.id, label: line.name })),
  ];

  const counterpartyOptions: SelectOption[] = [
    { value: "", label: t("pages.shifts.form.noCounterparty") },
    ...counterparties.map((counterparty) => ({
      value: counterparty.id,
      label: counterparty.name,
    })),
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeLabel={t("common.close")}
      title={
        formMode === "create"
          ? t("pages.shifts.form.createTitle")
          : t("pages.shifts.form.editTitle")
      }
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
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
      <form
        id={FORM_ID}
        onSubmit={(event) => void submit(event)}
        noValidate
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        <Select
          label={t("pages.shifts.form.productLabel")}
          options={productOptions}
          value={productId}
          disabled={formMode === "edit"}
          {...errorProp(translateFieldError(t, errors.productId?.message))}
          onChange={(value) =>
            setValue("productId", value, { shouldDirty: true, shouldValidate: true })
          }
        />

        <fieldset
          style={{
            border: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <legend style={{ font: "var(--text-caption)", color: "var(--fg-2)", padding: 0 }}>
            {t("pages.shifts.form.modeLabel")}
          </legend>
          <label
            style={{ display: "flex", alignItems: "center", gap: 8, font: "var(--text-body)" }}
          >
            <input type="radio" value="validation" {...register("mode")} />
            {t("pages.shifts.form.modeValidation")}
          </label>
          <label
            style={{ display: "flex", alignItems: "center", gap: 8, font: "var(--text-body)" }}
          >
            <input type="radio" value="aggregation" {...register("mode")} />
            {t("pages.shifts.form.modeAggregation")}
          </label>
        </fieldset>

        <Input
          label={t("pages.shifts.form.plannedQtyLabel")}
          mono
          inputMode="numeric"
          {...errorProp(translateFieldError(t, errors.plannedQty?.message))}
          {...register("plannedQty")}
        />

        <Input
          label={t("pages.shifts.form.plannedDateLabel")}
          type="date"
          {...register("plannedDate")}
        />

        <Select
          label={t("pages.shifts.form.lineLabel")}
          options={lineOptions}
          value={lineId ?? ""}
          {...(lines.length === 0 ? { hint: t("pages.shifts.form.noLinesHint") } : {})}
          onChange={(value) => setValue("lineId", value, { shouldDirty: true })}
        />

        <Select
          label={t("pages.shifts.form.counterpartyLabel")}
          options={counterpartyOptions}
          value={counterpartyId ?? ""}
          onChange={(value) => {
            counterpartyTouchedRef.current = true;
            setValue("counterpartyId", value, { shouldDirty: true, shouldValidate: true });
          }}
        />

        {shiftMode === "aggregation" && (
          <>
            <Input
              label={t("pages.shifts.form.boxCapacityLabel")}
              mono
              inputMode="numeric"
              {...errorProp(translateFieldError(t, errors.boxCapacity?.message))}
              {...register("boxCapacity")}
            />
            <label
              style={{ display: "flex", alignItems: "center", gap: 8, font: "var(--text-body)" }}
            >
              <input type="checkbox" {...register("palletsEnabled")} />
              {t("pages.shifts.form.palletsEnabledLabel")}
            </label>
            {palletsEnabled && (
              <Input
                label={t("pages.shifts.form.palletCapacityLabel")}
                mono
                inputMode="numeric"
                {...errorProp(translateFieldError(t, errors.palletCapacity?.message))}
                {...register("palletCapacity")}
              />
            )}
          </>
        )}
      </form>
    </Modal>
  );
}

/**
 * Normalizes raw form values into the API's create/update payload shape.
 *
 * Payload semantics (plan-03 Task 13 brief, chosen + documented here since
 * the brief poses this as an open question):
 *
 * - `counterpartyId`: omitted entirely unless the user actually touched the
 *   select (`counterpartyTouched`, sourced from a plain ref the select's own
 *   `onChange` sets -- deliberately not react-hook-form's `dirtyFields`,
 *   which compares the *final* value to the default and would read "not
 *   dirty" if the user picks a different option and then picks the original
 *   one back). This lets the server's own create-time prefill-from-product
 *   run when the field is left alone, while an explicit user selection
 *   (including clearing it back to "None") always sends `null`/the chosen
 *   id. On edit, "untouched" maps onto the same `undefined`-means-"no
 *   change" contract `updateShiftSchema` already uses.
 * - `boxCapacity`/`palletCapacity`: the opposite rule -- once the aggregation
 *   fields are visible, whatever value is *shown* is always sent (never
 *   omitted, touched or not), because the user can see a concrete number in
 *   the input and expects that exact value to be saved. They're omitted only
 *   when hidden (`mode === "validation"`), where they're not applicable.
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
  counterpartyTouched: boolean,
): CreateShiftInput | UpdateShiftInput {
  const plannedQty = values.plannedQty?.trim();
  const plannedDate = values.plannedDate?.trim();
  const lineId = values.lineId?.trim();
  const counterpartyId = values.counterpartyId?.trim();
  const boxCapacity = values.boxCapacity?.trim();
  const palletCapacity = values.palletCapacity?.trim();

  const payload: UpdateShiftInput = {
    mode: values.mode,
    lineId: lineId ? lineId : null,
    plannedQty: plannedQty ? Number(plannedQty) : null,
    plannedDate: plannedDate ? plannedDate : null,
  };

  if (counterpartyTouched) {
    payload.counterpartyId = counterpartyId ? counterpartyId : null;
  }

  if (values.mode === "aggregation") {
    payload.boxCapacity = boxCapacity ? Number(boxCapacity) : null;
    payload.palletsEnabled = values.palletsEnabled;
    if (values.palletsEnabled) {
      payload.palletCapacity = palletCapacity ? Number(palletCapacity) : null;
    }
  }

  if (formMode === "create") {
    return { ...payload, productId: values.productId.trim() };
  }
  return payload;
}
