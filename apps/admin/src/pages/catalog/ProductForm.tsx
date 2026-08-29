import { zodResolver } from "@hookform/resolvers/zod";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { CABINET_CAPABILITY, isValidGtin } from "@markiro/domain";
import { Alert, Button, Checkbox, FileDropZone, Input, Select, SidePanel } from "@markiro/ui";
import type { OverlayDismissReason, SelectOption } from "@markiro/ui";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { errorProp } from "../../lib/form-error.js";
import { toast } from "../../lib/toast.js";
import type { CounterpartyDto } from "../counterparties/api.js";
import {
  useChzProductGroups,
  useGtinCheck,
  useUnlinkProduct,
  type CreateProductInput,
  type GtinCheckResult,
  type ProductStatus,
  type ProductImageDescriptor,
} from "./api.js";
import { productImageUrl } from "./api.js";

/**
 * Client-side mirror of the server's zod schema
 * (apps/api/src/modules/products/dto.ts): gtin non-empty (checksum-validated
 * here via `isValidGtin` -- the server does the authoritative normalize/
 * validate and reports GTIN_INVALID on mismatch), name 1..200,
 * boxCapacity/palletCapacity optional positive integers entered as text
 * (kept as strings in form state, parsed to number|null on submit by
 * `toCreateInput`). shelfLifeDays is also an optional positive integer, but
 * unlike box/pallet capacity the API bounds it (`z.number().int().min(1).
 * max(3650)`), so its client check enforces that same 1..3650 range. Error
 * messages are i18n keys (resolved through `t()` at render time) -- same
 * convention as `../counterparties/CounterpartyForm.tsx`.
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
  printName: z.string().trim().max(200, "pages.catalog.form.errors.printNameTooLong").optional(),
  chzProductGroupCode: z.string().trim().optional(),
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
  shelfLifeDays: z
    .string()
    .trim()
    .optional()
    .refine(
      (v) => !v || (/^[1-9]\d*$/.test(v) && Number(v) <= 3650),
      "pages.catalog.form.errors.shelfLifeInvalid",
    ),
  defaultCounterpartyId: z.string().trim().optional(),
  archived: z.boolean(),
});

export type ProductFormValues = z.infer<typeof productFormSchema>;

export interface ProductFormProps {
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
  image?: ProductImageDescriptor | null;
  imageAltName?: string;
  imageBusy?: boolean;
  onDeleteImage?: () => void | Promise<void>;
  counterparties: CounterpartyDto[];
  submitting?: boolean;
  submissionError?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  onSubmit: (input: CreateProductInput, image?: File | null) => void | Promise<void>;
  onClose: (reason: OverlayDismissReason) => void;
}

const EMPTY_VALUES: ProductFormValues = {
  gtin: "",
  name: "",
  printName: "",
  chzProductGroupCode: "",
  boxCapacity: "",
  palletCapacity: "",
  unitPrice: "",
  egaisCode: "",
  shelfLifeDays: "",
  defaultCounterpartyId: "",
  archived: false,
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
  mode,
  initialValues,
  productStatus,
  productId,
  externalRef,
  image,
  imageAltName,
  imageBusy = false,
  onDeleteImage,
  counterparties,
  submitting = false,
  submissionError,
  onDirtyChange = () => {},
  onSubmit,
  onClose,
}: ProductFormProps) {
  const { t } = useTranslation();
  const canUnlinkIntegrations = useCan(CABINET_CAPABILITY.INTEGRATIONS_WRITE);
  const {
    data: productGroups = [],
    isPending: productGroupsPending,
    isError: productGroupsError,
  } = useChzProductGroups();
  const gtinCheckMutation = useGtinCheck();
  const [ownerHint, setOwnerHint] = useState<GtinCheckResult | null>(null);
  const lastCheckedGtinRef = useRef<string | null>(null);
  const isDirtyRef = useRef(false);
  // Local mirror of `externalRef`, not read from it directly: a successful
  // unlink clears this immediately so the section disappears from the
  // still-open modal, without waiting for `editingProduct` (a snapshot
  // captured when the row's "Изменить" was clicked, per `CatalogPage`) to
  // catch up with the invalidated query on its own.
  const [linkedExternalRef, setLinkedExternalRef] = useState<string | null>(externalRef ?? null);
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [imageLoadFailed, setImageLoadFailed] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    getValues,
    formState: { errors, isDirty },
  } = useForm<ProductFormValues>({
    resolver: zodResolver(productFormSchema),
    defaultValues: initialValues ?? EMPTY_VALUES,
  });

  const gtinValue = watch("gtin");
  const defaultCounterpartyId = watch("defaultCounterpartyId");
  const chzProductGroupCode = watch("chzProductGroupCode");
  const archivedValue = watch("archived");

  // Re-seed clean forms when their server values change. A background refetch
  // must never overwrite unsaved operator input, so dirty forms retain their
  // current values until they are saved or discarded.
  useEffect(() => {
    if (isDirtyRef.current) return;
    const seeded = initialValues ?? EMPTY_VALUES;
    reset(seeded);
    setOwnerHint(null);
    lastCheckedGtinRef.current = seeded.gtin.trim() || null;
  }, [initialValues, reset]);

  useEffect(() => {
    setLinkedExternalRef(externalRef ?? null);
  }, [externalRef]);

  useEffect(() => {
    if (!selectedImage) return;
    let cancelled = false;
    setImageLoadFailed(false);
    void createImageBitmap(selectedImage)
      .then((bitmap) => {
        if (cancelled) {
          bitmap.close();
          return;
        }
        const canvas = previewCanvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) {
          bitmap.close();
          setImageLoadFailed(true);
          return;
        }
        const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
      })
      .catch(() => {
        if (!cancelled) setImageLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedImage]);

  useEffect(() => {
    setImageLoadFailed(false);
  }, [image]);

  useEffect(() => {
    isDirtyRef.current = isDirty;
    onDirtyChange(isDirty || Boolean(selectedImage));
  }, [isDirty, onDirtyChange, selectedImage]);

  // GTIN owner hint (design brief 03): only ever calls the check for a
  // checksum-valid GTIN (`isValidGtin`, client-side, before any network
  // call) so an in-progress/garbage value never triggers a noisy request.
  useEffect(() => {
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
    // deliberately left out of the deps array so only gtinValue re-triggers
    // this effect (mutate is called via the latest closure).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above; `getValues` is a stable react-hook-form reference, and depending on the mutation object would re-fire the lookup every render.
  }, [gtinValue]);

  const submit = handleSubmit(async (values) => {
    await onSubmit(toCreateInput(values, mode), selectedImage);
  });

  const counterpartyOptions: SelectOption[] = [
    { value: "", label: t("pages.catalog.form.noCounterparty") },
    ...counterparties.map((c) => ({ value: c.id, label: c.name })),
  ];

  // While the dictionary is loading, the empty option's label doubles as the
  // Select's placeholder (see packages/ui/src/components/Select.tsx), so it
  // must not claim "no group" until we actually know that -- otherwise a
  // product whose code just hasn't loaded yet reads as unset.
  const productGroupOptions: SelectOption[] = [
    {
      value: "",
      label: productGroupsPending
        ? t("pages.catalog.form.productGroupLoading")
        : t("pages.catalog.form.noProductGroup"),
    },
    ...productGroups.map((group) => ({ value: String(group.code), label: group.name })),
  ];
  // A code the form already holds but that isn't in the loaded (or not-yet-
  // loaded, or permanently failed) dictionary must still be shown -- as the
  // raw code -- rather than silently falling back to the "no group"
  // placeholder, which would misrepresent a set value as unset.
  const trimmedProductGroupCode = (chzProductGroupCode ?? "").trim();
  if (
    trimmedProductGroupCode &&
    !productGroups.some((group) => String(group.code) === trimmedProductGroupCode)
  ) {
    productGroupOptions.push({
      value: trimmedProductGroupCode,
      label: t("pages.catalog.form.productGroupUnknownCode", { code: trimmedProductGroupCode }),
    });
  }

  const applyCounterpartyHint = () => {
    if (ownerHint?.counterpartyId) {
      setValue("defaultCounterpartyId", ownerHint.counterpartyId, {
        shouldDirty: true,
        shouldValidate: true,
      });
    }
  };

  return (
    <SidePanel
      open
      size="standard"
      busy={submitting}
      onClose={onClose}
      closeLabel={t("common.close")}
      title={
        mode === "create" ? t("pages.catalog.form.createTitle") : t("pages.catalog.form.editTitle")
      }
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            disabled={submitting}
            onClick={() => onClose("close-button")}
          >
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
        {submissionError ? <Alert tone="error">{submissionError}</Alert> : null}
        <section className="mk-catalog-panel-section" aria-labelledby="product-form-basic">
          <h3 id="product-form-basic">{t("pages.catalog.form.sections.basic")}</h3>
          {mode === "edit" && productStatus === "draft" && (
            <Alert tone="warn">{t("pages.catalog.form.draftBanner")}</Alert>
          )}

          {mode === "edit" && (
            <Checkbox
              label={t("pages.catalog.form.archivedLabel")}
              hint={t("pages.catalog.form.archivedHint")}
              checked={archivedValue}
              onCheckedChange={(checked) =>
                setValue("archived", checked, { shouldDirty: true, shouldValidate: true })
              }
            />
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
            label={t("pages.catalog.form.printNameLabel")}
            hint={t("pages.catalog.form.printNameHint")}
            {...errorProp(translateFieldError(t, errors.printName?.message))}
            {...register("printName")}
          />
          <Select
            label={t("pages.catalog.form.productGroupLabel")}
            options={productGroupOptions}
            value={chzProductGroupCode ?? ""}
            disabled={productGroupsPending}
            searchable
            searchLabel={t("pages.catalog.form.productGroupSearchLabel")}
            {...errorProp(
              productGroupsError ? t("pages.catalog.form.productGroupLoadError") : undefined,
            )}
            onValueChange={(value) =>
              setValue("chzProductGroupCode", value, { shouldDirty: true, shouldValidate: true })
            }
          />
        </section>
        <section className="mk-catalog-panel-section" aria-labelledby="product-form-aggregation">
          <h3 id="product-form-aggregation">{t("pages.catalog.form.sections.aggregation")}</h3>
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
          <Input
            label={t("pages.catalog.form.shelfLifeDaysLabel")}
            mono
            inputMode="numeric"
            {...errorProp(translateFieldError(t, errors.shelfLifeDays?.message))}
            {...register("shelfLifeDays")}
          />
        </section>
        <section className="mk-catalog-panel-section" aria-labelledby="product-form-image">
          <h3 id="product-form-image">{t("pages.catalog.form.sections.image")}</h3>
          <div className="mk-product-image-control">
            {selectedImage && !imageLoadFailed ? (
              <canvas
                ref={previewCanvasRef}
                role="img"
                aria-label={imageAltName ?? t("pages.catalog.form.imageAlt")}
                className="mk-product-image-control__preview"
              />
            ) : mode === "edit" && productId && image && !imageLoadFailed ? (
              <img
                src={productImageUrl({ id: productId, image }) ?? undefined}
                alt={imageAltName ?? t("pages.catalog.form.imageAlt")}
                onError={() => setImageLoadFailed(true)}
                className="mk-product-image-control__preview"
              />
            ) : (
              <div className="mk-product-image-control__empty">
                {t("pages.catalog.form.imageEmpty")}
              </div>
            )}
            <FileDropZone
              accept="image/jpeg,image/png,image/webp"
              label={t("pages.catalog.form.dropLabel")}
              ariaLabel={t("pages.catalog.form.imageLabel")}
              disabled={submitting || imageBusy}
              onFile={(file) => setSelectedImage(file)}
            />
            {mode === "edit" && image && onDeleteImage ? (
              <Button
                type="button"
                size="compact"
                variant="secondary"
                loading={imageBusy}
                disabled={submitting}
                onClick={() => void onDeleteImage()}
              >
                {t("pages.catalog.form.imageRemove")}
              </Button>
            ) : null}
            <p className="mk-product-image-control__hint">{t("pages.catalog.form.imageHint")}</p>
          </div>
        </section>
        <section className="mk-catalog-panel-section" aria-labelledby="product-form-defaults">
          <h3 id="product-form-defaults">{t("pages.catalog.form.sections.defaults")}</h3>
          <Select
            label={t("pages.catalog.form.defaultCounterpartyLabel")}
            options={counterpartyOptions}
            value={defaultCounterpartyId ?? ""}
            onValueChange={(value) =>
              setValue("defaultCounterpartyId", value, { shouldDirty: true, shouldValidate: true })
            }
          />
        </section>
      </form>
    </SidePanel>
  );
}

/**
 * Normalizes raw form values into the API's create/update payload shape.
 * `archived` travels only from the edit form — the create form has no
 * "do not use" control, so create payloads stay free of the field.
 */
function toCreateInput(values: ProductFormValues, mode: "create" | "edit"): CreateProductInput {
  const printName = values.printName?.trim();
  const chzProductGroupCode = values.chzProductGroupCode?.trim();
  const boxCapacity = values.boxCapacity?.trim();
  const palletCapacity = values.palletCapacity?.trim();
  const unitPrice = values.unitPrice?.trim();
  const egaisCode = values.egaisCode?.trim();
  const shelfLifeDays = values.shelfLifeDays?.trim();
  const defaultCounterpartyId = values.defaultCounterpartyId?.trim();
  return {
    gtin: values.gtin.trim(),
    name: values.name.trim(),
    printName: printName ? printName : null,
    chzProductGroupCode: chzProductGroupCode ? Number(chzProductGroupCode) : null,
    boxCapacity: boxCapacity ? Number(boxCapacity) : null,
    palletCapacity: palletCapacity ? Number(palletCapacity) : null,
    unitPrice: unitPrice ? unitPrice.replace(",", ".") : null,
    egaisCode: egaisCode ? egaisCode : null,
    shelfLifeDays: shelfLifeDays ? Number(shelfLifeDays) : null,
    defaultCounterpartyId: defaultCounterpartyId ? defaultCounterpartyId : null,
    ...(mode === "edit" ? { archived: values.archived } : {}),
  };
}
