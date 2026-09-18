import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { LABEL_FIELDS, type LabelField } from "@markiro/domain";
import { Button } from "@markiro/ui";

export interface ImportFieldsPanelProps {
  /**
   * `placeholder`: `{{field}}` -- the token a ZPL/TSPL payload must contain
   * in full to become a field. `json`: the bare field id -- the value of a
   * text element's `field` or a barcode's `data`.
   */
  syntax: "placeholder" | "json";
}

function fieldToken(field: LabelField, syntax: ImportFieldsPanelProps["syntax"]): string {
  return syntax === "json" ? field : `{{${field}}}`;
}

/**
 * The import dialog's reference of bindable fields with a Copy action. Copy
 * failure stays visible and the token stays selectable for manual copying.
 */
export function ImportFieldsPanel({ syntax }: ImportFieldsPanelProps) {
  const { t } = useTranslation();
  const [copiedField, setCopiedField] = useState<LabelField | null>(null);
  const [copyError, setCopyError] = useState(false);

  const rows = useMemo(
    () =>
      LABEL_FIELDS.map((field) => ({
        field,
        token: fieldToken(field, syntax),
        label: t(`pages.labels.editor.fields.${field}`),
      })),
    [syntax, t],
  );

  async function handleCopy(field: LabelField, token: string): Promise<void> {
    setCopyError(false);
    setCopiedField(null);
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(token);
      setCopiedField(field);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <aside
      className="label-editor__import-fields"
      aria-label={t("pages.labels.editor.import.fieldsTitle")}
    >
      <div className="label-editor__eyebrow">{t("pages.labels.editor.import.fieldsTitle")}</div>
      <p>
        {t(
          syntax === "json"
            ? "pages.labels.editor.import.fieldsHintJson"
            : "pages.labels.editor.import.fieldsHint",
        )}
      </p>
      {rows.map(({ field, label, token }) => (
        <div className="label-editor__import-field" key={field}>
          <div>
            <strong>{label}</strong>
            <code>{token}</code>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="compact"
            aria-label={t("pages.labels.editor.import.copy", { placeholder: token })}
            onClick={() => void handleCopy(field, token)}
          >
            {t("pages.labels.editor.import.copyShort")}
          </Button>
        </div>
      ))}
      {copiedField && <div role="status">{t("pages.labels.editor.import.copied")}</div>}
      {copyError && <div role="alert">{t("pages.labels.editor.import.copyError")}</div>}
    </aside>
  );
}
