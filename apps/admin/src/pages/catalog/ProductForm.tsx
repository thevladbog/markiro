import { zodResolver } from "@hookform/resolvers/zod";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { CABINET_CAPABILITY, isValidGtin } from "@markiro/domain";
import { Alert, Button, Input, Modal, Select } from "@markiro/ui";
import type { SelectOption } from "@markiro/ui";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { errorProp } from "../../lib/form-error.js";
import { toast } from "../../lib/toast.js";
import type { CounterpartyDto } from "../counterparties/api.js";
import type { LabelTemplateSummaryDto } from "../labels/api.js";
import {
  useGtinCheck,
  useUnlinkProduct,
  type CreateProductInput,
  type GtinCheckResult,
  type ProductStatus,
} from "./api.js";

/**
 * Client-side mirror of the server's zod schema
 * (apps/api/src/modules/products/dto.ts): gtin non-empty (checksum-validated
 * here via `isValidGtin` -- the server does the authoritative normalize/
 * validate and reports GTIN_INVALID on mismatch), name 1..200,
 * boxCapacity/palletCapacity optional positive integers entered as text
 * (kept as strings in form state, parsed to number|null on submit by
 * `toCreateInput`). Error messages are i18n keys (resolved through `t()` at
 * render time) -- same convention as `../counterparties/CounterpartyForm.tsx`.
 */
const productFormSchema = z.object({
  gtin: z
    .string()
    .trim()
    .min(1, "pages.catalog.form.errors.gtinRequired")
    .refine((v) => isValidGtin(v), "pages.catalog.form.errors.gtinInvalid"),
  name: z
    .string()
    .trim()
    .min(1, "pages.catalog.form.errors.nameRequired")
    .max(200, "pages.catalog.form.errors.nameTooLong"),
  productGroup: z
    .string()
    .trim()
    .max(200, "pages.catalog.form.errors.productGroupTooLong")
    .optional(),
  boxCapacity: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^[1-9]\d*$/.test(v), "pages.catalog.form.errors.capacityInvalid"),
  palletCapacity: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^[1-9]\d*$/.test(v), "pages.catalog.form.errors.capacityInvalid"),
  unitPrice: z
    .string()
    .trim()
    .optional()
    .refine(
      (v) => !v || /^\d+([.,]\d{1,2})?$/.test(v),
      "pages.catalog.form.errors.unitPriceInvalid",
    ),
  egaisCode: z.string().trim().optional(),
  defaultCounterpartyId: z.string().trim().optional(),
  defaultLabelTemplateId: z.string().trim().optional(),
});

export type ProductFormValues = z.infer<typeof productFormSchema>;

export interface ProductFormProps {
  open: boolean;
  mode: "create" | "edit";
  initialValues?: ProductFormValues;
  /** Only meaningful in edit mode -- drives the draft banner. */
  productStatus?: ProductStatus;
  /** Only meaningful in edit mode -- the id the unlink action (below) targets. */
  productId?: string;
  /**
   * Only meaningful in edit mode -- the product's current link to its 1С
   * counterpart (`ProductDto.externalRef`), or `null`/absent if never
   * linked. Brief 08 (Task 14): "a linked product shows its link on its own
   * card in the Catalogue section, with the external name and an unlink
   * action" -- this is that section, with a known, accepted gap from the
   * brief's own wording: it shows the external REF (1С's `<Ид>` GUID,
   * `linkedText` below), not the external NAME the brief describes.
   * `products` carries no column for the 1С item's name at the time it was
   * linked -- only `externalRef` -- so there is nothing to show but the
   * GUID today.
   */
  externalRef?: string | null;
  counterparties: CounterpartyDto[];
  labelTemplates: LabelTemplateSummaryDto[];
  submitting?: boolean;
  onSubmit: (input: CreateProductInput) => void | Promise<void>;
  onClose: () => void;
}

const EMPTY_VALUES: ProductFormValues = {
  gtin: "",
  name: "",
  productGroup: "",
  boxCapacity: "",
  palletCapacity: "",
  unitPrice: "",
  egaisCode: "",
  defaultCounterpartyId: "",
  defaultLabelTemplateId: "",
};

const FORM_ID = "product-form";

/** Converts a possibly-undefined zod issue message (an i18n key) into translated text. */
function translateFieldError(t: TFunction, message: string | undefined): string | undefined {
  return message ? t(message) : undefined;
}

function AuthorizedUnlinkProductAction({
  productId,
  onUnlinked,
}: {
  productId: string;
  onUnlinked: () => void;
}) {
  const { t } = useTranslation();
  const unlinkMutation = useUnlinkProduct();

  const handleUnlink = async () => {
    try {
      await unlinkMutation.mutateAsync(productId);
      onUnlinked();
      toast("ok", t("pages.catalog.form.externalLink.unlinkSuccess"));
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.catalog.form.externalLink.unlinkError"),
      );
    }
  };

  return (
    <Button
      type="button"
      size="compact"
      variant="secondary"
      loading={unlinkMutation.isPending}
      onClick={() => void handleUnlink()}
    >
      {t("pages.catalog.form.externalLink.unlinkAction")}
    </Button>
  );
}

export function ProductForm({
  open,
  mode,
  initialValues,
  productStatus,
  productId,
  externalRef,
  counterparties,
  labelTemplates,
  submitting = false,
  onSubmit,
  onClose,
}: ProductFormProps) {
  const { t } = useTranslation();
  const canUnlinkIntegrations = useCan(CABINET_CAPABILITY.INTEGRATIONS_WRITE);
  const gtinCheckMutation = useGtinCheck();
  const [ownerHint, setOwnerHint] = useState<GtinCheckResult | null>(null);
  const lastCheckedGtinRef = useRef<string | null>(null);
  // Local mirror of `externalRef`, not read from it directly: a successful
  // unlink clears this immediately so the section disappears from the
  // still-open modal, without waiting for `editingProduct` (a snapshot
  // captured when the row's "Изменить" was clicked, per `CatalogPage`) to
  // catch up with the invalidated query on its own.
  const [linkedExternalRef, setLinkedExternalRef] = useState<string | null>(externalRef ?? null);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    getValues,
    formState: { errors },
  } = useForm<ProductFormValues>({
    resolver: zodResolver(productFormSchema),
    defaultValues: initialValues ?? EMPTY_VALUES,
  });

  const gtinValue = watch("gtin");
  const defaultCounterpartyId = watch("defaultCounterpartyId");
  const defaultLabelTemplateId = watch("defaultLabelTemplateId");

  // Re-seed the form (and the owner-hint state) whenever the modal opens --
  // covers both the create -> create and edit A -> edit B cases, since
  // defaultValues is only read once by react-hook-form on mount. The
  // already-known GTIN (if any) is marked as "checked" so opening an edit
  // modal doesn't immediately re-fire the hint lookup for an unchanged value.
  useEffect(() => {
    if (open) {
      const seeded = initialValues ?? EMPTY_VALUES;
      reset(seeded);
      setOwnerHint(null);
      lastCheckedGtinRef.current = seeded.gtin.trim() || null;
      setLinkedExternalRef(externalRef ?? null);
    }
  }, [open, initialValues, externalRef, reset]);

  // GTIN owner hint (design brief 03): only ever calls the check for a
  // checksum-valid GTIN (`isValidGtin`, client-side, before any network
  // call) so an in-progress/garbage value never triggers a noisy request.
  useEffect(() => {
    if (!open) return;
    const trimmed = (gtinValue ?? "").trim();
    if (!trimmed || !isValidGtin(trimmed)) {
      setOwnerHint(null);
      return;
    }
    if (lastCheckedGtinRef.current === trimmed) return;
    lastCheckedGtinRef.current = trimmed;
    gtinCheckMutation.mutate(trimmed, {
      // `checkedGtin` is the mutation's variables (the value passed to
      // `.mutate` above), threaded through by TanStack Query as onSuccess's
      // 2nd arg -- not the trimmed `gtinValue` closed over here, which may be
      // stale by the time this resolves. Comparing it against the field's
      // *current* value (via `getValues`, not `gtinValue`, for the same
      // staleness reason) drops the response if the user has since changed
      // the GTIN to something else while the request was in flight, so a
      // slow response for an old value never paints a hint for the wrong one.
      onSuccess: (result, checkedGtin) => {
        if (getValues("gtin").trim() !== checkedGtin) return;
        setOwnerHint(result);
      },
    });
    // gtinCheckMutation is a fresh object every render (per TanStack Query) --
    // deliberately left out of the deps array so only gtinValue/open
    // re-trigger this effect (mutate is called via the latest closure).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above; `getValues` is a stable react-hook-form reference, and depending on the mutation object would re-fire the lookup every render.
  }, [gtinValue, open]);

  const submit = handleSubmit(async (values) => {
    await onSubmit(toCreateInput(values));
  });

  const counterpartyOptions: SelectOption[] = [
    { value: "", label: t("pages.catalog.form.noCounterparty") },
    ...counterparties.map((c) => ({ value: c.id, label: c.name })),
  ];

  const labelTemplateOptions: SelectOption[] = [
    { value: "", label: t("pages.catalog.form.noLabelTemplate") },
    ...labelTemplates.map((tpl) => ({ value: tpl.id, label: tpl.name })),
  ];

  const applyCounterpartyHint = () => {
    if (ownerHint?.counterpartyId) {
      setValue("defaultCounterpartyId", ownerHint.counterpartyId, {
        shouldDirty: true,
        shouldValidate: true,
      });
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeLabel={t("common.close")}
      title={
        mode === "create" ? t("pages.catalog.form.createTitle") : t("pages.catalog.form.editTitle")
      }
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("pages.catalog.cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} loading={submitting}>
            {mode === "create"
              ? t("pages.catalog.form.submitCreate")
              : t("pages.catalog.form.submitUpdate")}
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
        {mode === "edit" && productStatus === "draft" && (
          <Alert tone="warn">{t("pages.catalog.form.draftBanner")}</Alert>
        )}

        {mode === "edit" && linkedExternalRef && (
          <Alert
            tone="info"
            {...(canUnlinkIntegrations && productId
              ? {
                  action: (
                    <AuthorizedUnlinkProductAction
                      productId={productId}
                      onUnlinked={() => setLinkedExternalRef(null)}
                    />
                  ),
                }
              : {})}
          >
            {t("pages.catalog.form.externalLink.linkedText", { ref: linkedExternalRef })}
          </Alert>
        )}

        <Input
          label={t("pages.catalog.form.gtinLabel")}
          mono
          {...errorProp(translateFieldError(t, errors.gtin?.message))}
          {...register("gtin")}
        />

        {ownerHint?.owner === "counterparty" && (
          <Alert
            tone="info"
            action={
              <Button
                type="button"
                size="compact"
                variant="secondary"
                onClick={applyCounterpartyHint}
              >
                {t("pages.catalog.form.applyCounterparty")}
              </Button>
            }
          >
            {t("pages.catalog.form.gtinOwnerHint", { name: ownerHint.counterpartyName })}
          </Alert>
        )}
        {ownerHint?.owner === "unknown" && (
          <Alert tone="warn">{t("pages.catalog.form.gtinOwnerUnknown")}</Alert>
        )}

        <Input
          label={t("pages.catalog.form.nameLabel")}
          {...errorProp(translateFieldError(t, errors.name?.message))}
          {...register("name")}
        />
        <Input
          label={t("pages.catalog.form.productGroupLabel")}
          {...errorProp(translateFieldError(t, errors.productGroup?.message))}
          {...register("productGroup")}
        />
        <Input
          label={t("pages.catalog.form.boxCapacityLabel")}
          mono
          inputMode="numeric"
          {...errorProp(translateFieldError(t, errors.boxCapacity?.message))}
          {...register("boxCapacity")}
        />
        <Input
          label={t("pages.catalog.form.palletCapacityLabel")}
          mono
          inputMode="numeric"
          {...errorProp(translateFieldError(t, errors.palletCapacity?.message))}
          {...register("palletCapacity")}
        />
        <Input
          label={t("pages.catalog.form.unitPriceLabel")}
          mono
          inputMode="decimal"
          {...errorProp(translateFieldError(t, errors.unitPrice?.message))}
          {...register("unitPrice")}
        />
        <Input
          label={t("pages.catalog.form.egaisCodeLabel")}
          {...errorProp(translateFieldError(t, errors.egaisCode?.message))}
          {...register("egaisCode")}
        />
        <Select
          label={t("pages.catalog.form.defaultCounterpartyLabel")}
          options={counterpartyOptions}
          value={defaultCounterpartyId ?? ""}
          onChange={(value) =>
            setValue("defaultCounterpartyId", value, { shouldDirty: true, shouldValidate: true })
          }
        />
        <Select
          label={t("pages.catalog.form.defaultLabelTemplateLabel")}
          options={labelTemplateOptions}
          value={defaultLabelTemplateId ?? ""}
          onChange={(value) =>
            setValue("defaultLabelTemplateId", value, { shouldDirty: true, shouldValidate: true })
          }
        />
      </form>
    </Modal>
  );
}

/** Normalizes raw form values into the API's create/update payload shape. */
function toCreateInput(values: ProductFormValues): CreateProductInput {
  const productGroup = values.productGroup?.trim();
  const boxCapacity = values.boxCapacity?.trim();
  const palletCapacity = values.palletCapacity?.trim();
  const unitPrice = values.unitPrice?.trim();
  const egaisCode = values.egaisCode?.trim();
  const defaultCounterpartyId = values.defaultCounterpartyId?.trim();
  const defaultLabelTemplateId = values.defaultLabelTemplateId?.trim();
  return {
    gtin: values.gtin.trim(),
    name: values.name.trim(),
    productGroup: productGroup ? productGroup : null,
    boxCapacity: boxCapacity ? Number(boxCapacity) : null,
    palletCapacity: palletCapacity ? Number(palletCapacity) : null,
    unitPrice: unitPrice ? unitPrice.replace(",", ".") : null,
    egaisCode: egaisCode ? egaisCode : null,
    defaultCounterpartyId: defaultCounterpartyId ? defaultCounterpartyId : null,
    defaultLabelTemplateId: defaultLabelTemplateId ? defaultLabelTemplateId : null,
  };
}
