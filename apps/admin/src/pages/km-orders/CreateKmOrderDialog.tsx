import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Input, Modal, Select } from "@markiro/ui";

import { useProducts } from "../catalog/api.js";
import { kmOrderPreflightCodes, useCreateKmOrder } from "./api.js";
import { KM_ORDER_MAX_QUANTITY, type KmOrderPreflightCode } from "./schemas.js";

const FORM_ID = "km-order-create-form";
const PRODUCT_FIELD_ID = "km-order-product-field";
const QUANTITY_FIELD_ID = "km-order-quantity-field";
const DEFAULT_QUANTITY = "1000";

/**
 * «Заказать коды» -- the only way an order is placed. The server refuses with
 * a 422 listing every unmet condition at once (СУЗ settings, paired agent,
 * token, product), so this dialog shows the whole list rather than one reason
 * at a time: an administrator fixes them in one pass instead of rediscovering
 * the next one after each attempt.
 *
 * Quantity and product are validated here as well as on the server, because a
 * client-side refusal keeps the operator's typed numbers on screen; the
 * server's answer is still the one that decides.
 */
export function CreateKmOrderDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  // The server's default already hides archived products; the GTIN filter is
  // the other half of what the create endpoint's preflight enforces.
  const products = useProducts({});
  const create = useCreateKmOrder();
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState(DEFAULT_QUANTITY);
  const [contactPerson, setContactPerson] = useState("");
  const [productError, setProductError] = useState<string | null>(null);
  const [quantityError, setQuantityError] = useState<string | null>(null);
  const [blockedBy, setBlockedBy] = useState<KmOrderPreflightCode[] | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const number = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const eligible = useMemo(
    () => (products.data ?? []).filter((product) => product.gtin14 && !product.archived),
    [products.data],
  );
  const selected = eligible.find((product) => product.id === productId);
  const parsedQuantity = /^\d+$/.test(quantity.trim()) ? Number(quantity.trim()) : Number.NaN;
  const quantityInRange = parsedQuantity >= 1 && parsedQuantity <= KM_ORDER_MAX_QUANTITY;

  const productHint = products.isError
    ? t("pages.kmOrders.create.productLoadError")
    : !products.isPending && eligible.length === 0
      ? t("pages.kmOrders.create.productEmpty")
      : null;

  const close = () => {
    setProductError(null);
    setQuantityError(null);
    setBlockedBy(null);
    setSubmitError(null);
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBlockedBy(null);
    setSubmitError(null);
    const missingProduct = productId === "" ? t("pages.kmOrders.create.productRequired") : null;
    const badQuantity = quantityInRange
      ? null
      : t("pages.kmOrders.create.quantityRange", {
          min: number.format(1),
          max: number.format(KM_ORDER_MAX_QUANTITY),
        });
    setProductError(missingProduct);
    setQuantityError(badQuantity);
    if (missingProduct !== null || badQuantity !== null) {
      // Announce nothing and the office re-clicks the same disabled-looking
      // button: move focus to the first invalid control, in form order, the
      // same way the browser's own validation would.
      const firstInvalidFieldId = missingProduct !== null ? PRODUCT_FIELD_ID : QUANTITY_FIELD_ID;
      document.getElementById(firstInvalidFieldId)?.focus();
      return;
    }

    const trimmedContact = contactPerson.trim();
    try {
      await create.mutateAsync({
        productId,
        quantity: parsedQuantity,
        ...(trimmedContact ? { contactPerson: trimmedContact } : {}),
      });
      // No resets here: the parent mounts this dialog only while `dialogOpen`
      // is true (see km-orders/index.tsx), so `close()` unmounts the whole
      // component and any state set after it would never be observed.
      close();
    } catch (caught) {
      const codes = kmOrderPreflightCodes(caught);
      if (codes !== null && codes.length > 0) {
        setBlockedBy(codes);
        return;
      }
      setSubmitError(t("pages.kmOrders.create.genericError"));
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      closeLabel={t("common.close")}
      title={t("pages.kmOrders.create.title")}
      width={520}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} loading={create.isPending}>
            {t("pages.kmOrders.create.submit")}
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        className="mk-km-order-create-form"
        // Every refusal is reported through the fields' own `error` text, in
        // the cabinet's language; the browser's untranslated bubbles would
        // fire first and say something else.
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        {blockedBy !== null ? (
          <Alert tone="error" role="alert" title={t("pages.kmOrders.create.blockedTitle")}>
            <ul className="mk-km-orders-blockers">
              {blockedBy.map((code) => (
                <li key={code}>{t(`pages.kmOrders.preflight.${code}`)}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        {submitError !== null ? (
          <Alert tone="error" role="alert">
            {submitError}
          </Alert>
        ) : null}
        <Select
          id={PRODUCT_FIELD_ID}
          label={t("pages.kmOrders.create.product")}
          value={productId}
          onValueChange={setProductId}
          searchable
          searchLabel={t("pages.kmOrders.create.productSearch")}
          searchPlaceholder={t("pages.kmOrders.create.productSearch")}
          placeholder={t("pages.kmOrders.create.productPlaceholder")}
          disabled={products.isPending || products.isError}
          options={eligible.map((product) => ({
            value: product.id,
            label: `${product.name} — ${product.gtin14}`,
          }))}
          {...(productError !== null ? { error: productError } : {})}
          {...(productHint !== null ? { hint: productHint } : {})}
        />
        <Input
          id={QUANTITY_FIELD_ID}
          type="number"
          inputMode="numeric"
          min={1}
          max={KM_ORDER_MAX_QUANTITY}
          mono
          label={t("pages.kmOrders.create.quantity")}
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          {...(quantityError !== null
            ? { error: quantityError }
            : { hint: t("pages.kmOrders.create.quantityHint") })}
        />
        <Input
          label={t("pages.kmOrders.create.contactPerson")}
          value={contactPerson}
          maxLength={128}
          onChange={(event) => setContactPerson(event.target.value)}
          hint={t("pages.kmOrders.create.contactPersonHint")}
        />
        <p className="mk-km-orders-summary">
          {selected !== undefined && quantityInRange
            ? t("pages.kmOrders.create.summary", {
                quantity: number.format(parsedQuantity),
                product: selected.name,
                gtin: selected.gtin14,
              })
            : t("pages.kmOrders.create.summaryPlaceholder")}
        </p>
      </form>
    </Modal>
  );
}
