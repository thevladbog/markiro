import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { OfficeProduct } from "../../host/protocol.js";
import { productUpdate } from "../../host/requests.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { productFields, toProductInput } from "./product-form.js";

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
      productUpdate(toProductInput(productFields(product)), archiving, product.rev),
    ),
  );

  const submit = async () => {
    setFailure(null);
    let saved: OfficeProduct;
    try {
      saved = await write.mutateAsync();
    } catch (error) {
      setFailure(alertFailure(error));
      return;
    }
    onDone(saved);
  };

  return (
    <FormDialog
      title={t(archiving ? "office.products.archiveTitle" : "office.products.restoreTitle")}
      submitLabel={t(archiving ? "office.products.archiveSubmit" : "office.products.restoreSubmit")}
      submitVariant={archiving ? "destructive" : "primary"}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <p>
        {t(archiving ? "office.products.archiveBody" : "office.products.restoreBody", {
          name: product.name,
        })}
      </p>
    </FormDialog>
  );
}
