import { zodResolver } from "@hookform/resolvers/zod";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Button, Input, Modal } from "@markiro/ui";

import { errorProp } from "../../lib/form-error.js";
import type { ProductDto } from "../catalog/api.js";
import type { CreateKioskInput, KioskDto, UpdateKioskInput } from "./api.js";

/**
 * Client-side mirror of the server's zod schema
 * (apps/api/src/modules/kiosks/dto.ts): name 1..200, location free-text
 * optional, dayLimitPerEmployee a positive integer entered as text (kept as
 * a string in form state, parsed to a number on submit by `toKioskInput`) --
 * same convention as `../shifts/ShiftForm.tsx`'s `plannedQty`.
 * `showPrices` is a plain checkbox bound directly through
 * react-hook-form's `register` -- same convention as
 * `../shifts/ShiftForm.tsx`'s `palletsEnabled`.
 */
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

export interface KioskFormProps {
  open: boolean;
  mode: "create" | "edit";
  initialValues?: KioskFormValues;
  /**
   * The kiosk being edited -- only present in edit mode. Supplies the id the
   * product allowlist section saves against and seeds the checked set from
   * `kiosk.productIds`. The allowlist section is hidden entirely in create
   * mode (a not-yet-created kiosk has no id to attach products to).
   */
  kiosk?: KioskDto;
  /** Active catalog products -- the allowlist's candidate set. */
  products: ProductDto[];
  submitting?: boolean;
  savingProducts?: boolean;
  onSubmit: (input: CreateKioskInput | UpdateKioskInput) => void | Promise<void>;
  onSaveProducts?: (productIds: string[]) => void | Promise<void>;
  onClose: () => void;
}

const EMPTY_VALUES: KioskFormValues = {
  name: "",
  location: "",
  dayLimitPerEmployee: "5",
  showPrices: true,
};

const FORM_ID = "kiosk-form";

/** Converts a possibly-undefined zod issue message (an i18n key) into translated text. */
function translateFieldError(t: TFunction, message: string | undefined): string | undefined {
  return message ? t(message) : undefined;
}

export function KioskForm({
  open,
  mode,
  initialValues,
  kiosk,
  products,
  submitting = false,
  savingProducts = false,
  onSubmit,
  onSaveProducts,
  onClose,
}: KioskFormProps) {
  const { t } = useTranslation();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<KioskFormValues>({
    resolver: zodResolver(kioskFormSchema),
    defaultValues: initialValues ?? EMPTY_VALUES,
  });

  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set());

  // Re-seed the form (and the allowlist's checked set) whenever the modal
  // opens -- covers both the create -> create and edit A -> edit B cases,
  // since defaultValues/initial state are only read once on mount. Same
  // convention as `../counterparties/CounterpartyForm.tsx`.
  useEffect(() => {
    if (open) {
      reset(initialValues ?? EMPTY_VALUES);
      setSelectedProductIds(new Set(kiosk?.productIds ?? []));
    }
  }, [open, initialValues, reset, kiosk]);

  const submit = handleSubmit(async (values) => {
    await onSubmit(toKioskInput(values));
  });

  const toggleProduct = (productId: string) => {
    setSelectedProductIds((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) {
        next.delete(productId);
      } else {
        next.add(productId);
      }
      return next;
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeLabel={t("common.close")}
      title={
        mode === "create" ? t("pages.kiosks.form.createTitle") : t("pages.kiosks.form.editTitle")
      }
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("pages.kiosks.cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} loading={submitting}>
            {mode === "create"
              ? t("pages.kiosks.form.submitCreate")
              : t("pages.kiosks.form.submitUpdate")}
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
        <label style={{ display: "flex", alignItems: "center", gap: 8, font: "var(--text-body)" }}>
          <input type="checkbox" {...register("showPrices")} />
          {t("pages.kiosks.form.showPricesLabel")}
        </label>
      </form>

      {mode === "edit" && kiosk && (
        <div
          style={{
            marginTop: 20,
            paddingTop: 16,
            borderTop: "1px solid var(--line)",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <span style={{ font: "var(--text-caption)", color: "var(--fg-2)" }}>
            {t("pages.kiosks.form.productsLabel")}
          </span>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              maxHeight: 220,
              overflowY: "auto",
            }}
          >
            {products.map((product) => (
              <label
                key={product.id}
                style={{ display: "flex", alignItems: "center", gap: 8, font: "var(--text-body)" }}
              >
                <input
                  type="checkbox"
                  checked={selectedProductIds.has(product.id)}
                  onChange={() => toggleProduct(product.id)}
                />
                {product.name}
              </label>
            ))}
          </div>
          <Button
            type="button"
            variant="secondary"
            loading={savingProducts}
            onClick={() => void onSaveProducts?.(Array.from(selectedProductIds))}
          >
            {t("pages.kiosks.form.saveProductsAction")}
          </Button>
        </div>
      )}
    </Modal>
  );
}

/** Normalizes raw form values into the API's create/update payload shape. */
function toKioskInput(values: KioskFormValues): CreateKioskInput | UpdateKioskInput {
  const location = values.location?.trim();
  return {
    name: values.name.trim(),
    location: location ? location : null,
    dayLimitPerEmployee: Number(values.dayLimitPerEmployee),
    showPrices: values.showPrices,
  };
}
