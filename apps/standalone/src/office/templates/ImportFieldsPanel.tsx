import { useState } from "react";
import { useTranslation } from "react-i18next";

import { LABEL_FIELDS, type LabelField } from "@markiro/domain";
import { Button } from "@markiro/ui";

/** The i18n key of each field a layout can print, under `office.labelFields`. */
export const LABEL_FIELD_KEYS: Record<LabelField, string> = {
  "product.name": "office.labelFields.productName",
  "product.printName": "office.labelFields.productPrintName",
  "product.gtin": "office.labelFields.productGtin",
  "product.egais": "office.labelFields.productEgais",
  "km.code": "office.labelFields.kmCode",
  sscc: "office.labelFields.sscc",
  "shift.no": "office.labelFields.shiftNo",
  date: "office.labelFields.date",
  expiry: "office.labelFields.expiry",
  qty: "office.labelFields.qty",
  "qty.boxes": "office.labelFields.qtyBoxes",
  operator: "office.labelFields.operator",
  "counterparty.name": "office.labelFields.counterpartyName",
};

export interface ImportFieldsPanelProps {
  /**
   * `placeholder`: `{{field}}`, which ZPL or TSPL must hold whole to become a
   * field; `json`: the bare field, the value of a text's `field` or a
   * barcode's `data`.
   */
  syntax: "placeholder" | "json";
}

/**
 * The fields a layout can print, each with its token and «Копировать», after
 * the cloud's `ImportFieldsPanel`. A failed copy says so, and the token stays
 * selectable for copying by hand.
 */
export function ImportFieldsPanel({ syntax }: ImportFieldsPanelProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const copy = async (token: string) => {
    setCopied(false);
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(token);
    } catch {
      setCopyFailed(true);
      return;
    }
    setCopied(true);
  };

  return (
    <section
      className="template-import__fields"
      aria-label={t("office.templateImport.fieldsTitle")}
    >
      <h3>{t("office.templateImport.fieldsTitle")}</h3>
      <p className="office-note">
        {t(
          syntax === "json"
            ? "office.templateImport.fieldsHintJson"
            : "office.templateImport.fieldsHint",
        )}
      </p>
      {LABEL_FIELDS.map((field) => {
        const token = syntax === "json" ? field : `{{${field}}}`;
        return (
          <div className="template-import__field" key={field}>
            <span>
              <strong>{t(LABEL_FIELD_KEYS[field])}</strong>
              <code>{token}</code>
            </span>
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.templateImport.copy", { token })}
              onClick={() => void copy(token)}
            >
              {t("office.templateImport.copyShort")}
            </Button>
          </div>
        );
      })}
      <p className="office-note" aria-live="polite">
        {copied && t("office.templateImport.copied")}
        {copyFailed && t("office.templateImport.copyError")}
      </p>
    </section>
  );
}
