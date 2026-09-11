import { useTranslation } from "react-i18next";
import { calculateDocumentTotals, normalizeMoneyInput } from "../documents/documentDraft.js";
import { formatVat } from "./CatalogVatField.js";

/** One catalog unit, with both established document rounding conventions made explicit. */
export function CatalogPayablePreview({
  price,
  vatRateBps,
  vatIncluded,
}: {
  price: string;
  vatRateBps: number | null;
  vatIncluded: boolean;
}) {
  const { t } = useTranslation();
  const normalized = normalizeMoneyInput(price);
  if (!/^\d{1,12}\.\d{2}$/.test(normalized)) return null;
  const lines = [{ quantity: 1, agreedUnitPrice: normalized, vatRateBps, vatIncluded }];
  const invoice = calculateDocumentTotals("invoice", lines);
  const offer = calculateDocumentTotals("offer", lines);
  const differs = invoice.total !== offer.total || invoice.vatTotal !== offer.vatTotal;
  const amounts = (totals: typeof invoice) => (
    <>
      {t("catalog.payable.vat")}: {totals.vatTotal} RUB · {t("catalog.payable.total")}:{" "}
      {totals.total} RUB
    </>
  );
  return (
    <div className="catalog-payable-preview">
      <p>
        {t("catalog.payable.price")}: {normalized} RUB ·{" "}
        {formatVat(vatRateBps, vatIncluded, (key, options) => t(key, options ?? {}))}
      </p>
      {differs ? (
        <>
          <p>
            {t("catalog.payable.invoice")}: {amounts(invoice)}
          </p>
          <p>
            {t("catalog.payable.offer")}: {amounts(offer)}
          </p>
        </>
      ) : (
        <p>{amounts(invoice)}</p>
      )}
    </div>
  );
}
