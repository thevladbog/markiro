import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { OfficeProduct } from "../../host/protocol.js";
import { productUpdate } from "../../host/requests.js";
import { writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { gtinRule } from "../../lib/rules.js";
import {
  PRODUCT_CONFLICTS,
  PRODUCT_FIELDS,
  productFields,
  toProductInput,
} from "./product-form.js";

export interface ArchiveProductDialogProps {
  product: OfficeProduct;
  /** `archive` takes the product out of use; `restore` brings it back. */
  mode: "archive" | "restore";
  onClose: () => void;
  onDone: (product: OfficeProduct) => void;
  /** The product changed on the host: close and load the list again. */
  onReload: () => void;
}

/**
 * The destructive-action confirm of the list: asks before a product goes to the archive (it can no
 * longer be chosen for a new shift; its history stays), and brings it back the same way. The
 * write is the form's own, with only `archived` changed and the loaded revision as the guard.
 */
export function ArchiveProductDialog({
  product,
  mode,
  onClose,
  onDone,
  onReload,
}: ArchiveProductDialogProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const archiving = mode === "archive";
  const write = useOfficeMutation((api, token, _variables: void) =>
    api.updateProduct(
      token,
      product.id,
      // The GTIN goes as stored: an archived product is not checked for it, and the one
      // that comes back is checked here before the write (`gtinFails`) and by the host.
      productUpdate(
        toProductInput({ ...productFields(product), archived: archiving }),
        archiving,
        product.rev,
      ),
    ),
  );
  // A card comes back only with a GTIN that passes the whole check.
  const gtinFails = !archiving && !gtinRule.safeParse(product.gtin14).success;

  const submit = async () => {
    setFailure(null);
    let saved: OfficeProduct;
    try {
      saved = await write.mutateAsync();
    } catch (error) {
      const outcome = writeFailure(error, PRODUCT_FIELDS, PRODUCT_CONFLICTS);
      // The GTIN is taken: the dialog has no field, so it says so above.
      setFailure(
        outcome.kind === "field"
          ? { kind: "alert", message: "office.products.restoreGtinTaken" }
          : outcome,
      );
      return;
    }
    onDone(saved);
  };

  return (
    <FormDialog
      title={t(archiving ? "office.products.archiveTitle" : "office.products.restoreTitle")}
      submitLabel={t(archiving ? "office.products.archiveSubmit" : "office.products.restoreSubmit")}
      submitVariant={archiving ? "destructive" : "primary"}
      submitDisabled={gtinFails}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <p>
        {t(archiving ? "office.products.archiveBody" : "office.products.restoreBody", {
          name: product.name,
        })}
      </p>
      {gtinFails && <p role="alert">{t("office.products.restoreGtinInvalid")}</p>}
    </FormDialog>
  );
}
