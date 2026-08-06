import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Checkbox, Modal } from "@markiro/ui";

import type { ProductDto } from "../catalog/api.js";
import type { CreateKioskInput, KioskDto, UpdateKioskInput } from "./api.js";
import {
  KIOSK_PROFILE_FORM_ID,
  KioskProfileForm,
  type KioskFormValues,
} from "./KioskProfileForm.js";

export type { KioskFormValues } from "./KioskProfileForm.js";

export interface KioskFormProps {
  open: boolean;
  mode: "create" | "edit";
  initialValues?: KioskFormValues;
  kiosk?: KioskDto;
  products: ProductDto[];
  submitting?: boolean;
  savingProducts?: boolean;
  onSubmit: (input: CreateKioskInput | UpdateKioskInput) => void | Promise<void>;
  onSaveProducts?: (productIds: string[]) => void | Promise<void>;
  onClose: () => void;
}

/**
 * The edit-only legacy modal. Create now uses KioskProfileForm inside its
 * route-backed panel; retaining this wrapper keeps edit and allowlist behavior
 * unchanged until their panel migration.
 */
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
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(
    () => new Set(kiosk?.productIds ?? []),
  );

  const toggleProduct = (productId: string) => {
    setSelectedProductIds((previous) => {
      const next = new Set(previous);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
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
          <Button type="submit" form={KIOSK_PROFILE_FORM_ID} loading={submitting}>
            {mode === "create"
              ? t("pages.kiosks.form.submitCreate")
              : t("pages.kiosks.form.submitUpdate")}
          </Button>
        </>
      }
    >
      <KioskProfileForm
        {...(initialValues ? { initialValues } : {})}
        submitting={submitting}
        submissionError={null}
        onSubmit={onSubmit}
        onDirtyChange={() => undefined}
      />
      {mode === "edit" && kiosk ? (
        <div className="mk-kiosk-products-editor">
          <fieldset>
            <legend>{t("pages.kiosks.form.productsLabel")}</legend>
            <div>
              {products.map((product) => (
                <Checkbox
                  key={product.id}
                  label={product.name}
                  checked={selectedProductIds.has(product.id)}
                  onCheckedChange={() => toggleProduct(product.id)}
                />
              ))}
            </div>
          </fieldset>
          <Button
            type="button"
            variant="secondary"
            loading={savingProducts}
            onClick={() => void onSaveProducts?.(Array.from(selectedProductIds))}
          >
            {t("pages.kiosks.form.saveProductsAction")}
          </Button>
        </div>
      ) : null}
    </Modal>
  );
}
