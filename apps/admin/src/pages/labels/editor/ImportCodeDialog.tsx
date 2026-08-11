import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  LABEL_FIELDS,
  parseLabelCode,
  type LabelCodeLanguage,
  type LabelField,
  type LabelImportResult,
} from "@markiro/domain";
import { Button, Checkbox, Modal, Select, Textarea } from "@markiro/ui";

import { fitSpecElements } from "./geometry.js";

export interface ImportCodeDialogProps {
  open: boolean;
  initialLanguage: LabelCodeLanguage;
  initialDpi: 203 | 300;
  currentDirty: boolean;
  onClose: () => void;
  onReplace: (result: LabelImportResult) => void;
}

interface Analysis {
  result: LabelImportResult;
  adjustedIds: string[];
}

const FIELD_COPY_KEYS: Record<LabelField, string> = {
  "product.name": "product.name",
  "product.gtin": "product.gtin",
  "km.code": "km.code",
  sscc: "sscc",
  "shift.no": "shift.no",
  date: "date",
  qty: "qty",
  operator: "operator",
  "counterparty.name": "counterparty.name",
};

export function ImportCodeDialog({
  open,
  initialLanguage,
  initialDpi,
  currentDirty,
  onClose,
  onReplace,
}: ImportCodeDialogProps) {
  const { t } = useTranslation();
  const [language, setLanguage] = useState<LabelCodeLanguage>(initialLanguage);
  const [dpi, setDpi] = useState<203 | 300>(initialDpi);
  const [source, setSource] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acknowledgedUnsupported, setAcknowledgedUnsupported] = useState(false);
  const [copiedField, setCopiedField] = useState<LabelField | null>(null);
  const [copyError, setCopyError] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLanguage(initialLanguage);
    setDpi(initialDpi);
    setSource("");
    setAnalysis(null);
    setError(null);
    setAcknowledgedUnsupported(false);
    setCopiedField(null);
    setCopyError(false);
  }, [initialDpi, initialLanguage, open]);

  const codeLabel = t("pages.labels.editor.import.codeLabel", {
    format: language === "zpl" ? "ZPL" : "TSPL",
  });
  const unsupportedCount = analysis?.result.warnings.length ?? 0;
  const canReplace =
    analysis !== null && (unsupportedCount === 0 || acknowledgedUnsupported) && error === null;

  const fieldRows = useMemo(
    () =>
      LABEL_FIELDS.map((field) => ({
        field,
        placeholder: `{{${FIELD_COPY_KEYS[field]}}}`,
        label: t(`pages.labels.editor.fields.${field}`),
      })),
    [t],
  );

  function invalidate(): void {
    setAnalysis(null);
    setError(null);
    setAcknowledgedUnsupported(false);
  }

  function handleCheck(): void {
    setAnalysis(null);
    setError(null);
    setAcknowledgedUnsupported(false);
    try {
      const parsed = parseLabelCode(source, { language, dpi });
      const fitted = fitSpecElements(parsed.spec);
      if (!fitted.ok) {
        setError(t("pages.labels.editor.import.elementTooLarge"));
        return;
      }
      setAnalysis({ result: { ...parsed, spec: fitted.spec }, adjustedIds: fitted.adjustedIds });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function handleCopy(field: LabelField, placeholder: string): Promise<void> {
    setCopyError(false);
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(placeholder);
      setCopiedField(field);
    } catch {
      setCopyError(true);
    }
  }

  function handleReplace(): void {
    if (!analysis || !canReplace) return;
    onReplace(analysis.result);
  }

  return (
    <Modal
      open={open}
      title={t("pages.labels.editor.import.title")}
      width="min(1120px, calc(100vw - 32px))"
      className="label-editor__import-dialog"
      closeLabel={t("common.close")}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("pages.labels.editor.import.cancel")}
          </Button>
          <Button type="button" variant="secondary" onClick={handleCheck} disabled={!source.trim()}>
            {t("pages.labels.editor.import.check")}
          </Button>
          <Button type="button" onClick={handleReplace} disabled={!canReplace}>
            {t("pages.labels.editor.import.replace")}
          </Button>
        </>
      }
    >
      <div className="label-editor__import-layout">
        <div className="label-editor__import-source">
          <div className="label-editor__import-options">
            <Select
              aria-label={t("pages.labels.editor.import.formatLabel")}
              options={[
                { value: "zpl", label: "ZPL" },
                { value: "tspl", label: "TSPL (TSC)" },
              ]}
              value={language}
              onValueChange={(value) => {
                setLanguage(value);
                invalidate();
              }}
            />
            <Select
              aria-label={t("pages.labels.editor.import.dpiLabel")}
              options={[{ value: "203", label: "203 DPI" }, { value: "300", label: "300 DPI" }]}
              value={String(dpi)}
              onValueChange={(value) => {
                setDpi(value === "300" ? 300 : 203);
                invalidate();
              }}
            />
          </div>
          <label className="label-editor__import-code-label" htmlFor="label-editor-import-code">
            {codeLabel}
          </label>
          <Textarea
            id="label-editor-import-code"
            aria-label={codeLabel}
            className="label-editor__import-code"
            spellCheck={false}
            value={source}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
              setSource(event.target.value);
              invalidate();
            }}
          />
          {currentDirty && (
            <p className="label-editor__import-note">{t("pages.labels.editor.import.dirtyNote")}</p>
          )}
          {error && (
            <div className="label-editor__import-error" role="alert">
              {error}
            </div>
          )}
          {analysis && (
            <div className="label-editor__import-analysis" aria-live="polite">
              <strong>
                {t("pages.labels.editor.import.summary", {
                  count: analysis.result.spec.elements.length,
                  width: analysis.result.spec.widthMm.toFixed(1),
                  height: analysis.result.spec.heightMm.toFixed(1),
                })}
              </strong>
              {analysis.result.warnings.length > 0 && (
                <div className="label-editor__import-warnings">
                  <p>{t("pages.labels.editor.import.unsupportedTitle", { count: analysis.result.warnings.length })}</p>
                  {analysis.result.warnings.map((warning) => (
                    <div key={`${warning.line}-${warning.source}`}>
                      <span>{warning.line}: </span>
                      <code>{warning.source}</code>
                    </div>
                  ))}
                  <Checkbox
                    label={t("pages.labels.editor.import.acknowledge", { count: analysis.result.warnings.length })}
                    checked={acknowledgedUnsupported}
                    onCheckedChange={setAcknowledgedUnsupported}
                  />
                </div>
              )}
              {analysis.adjustedIds.length > 0 && (
                <p>{t("pages.labels.editor.import.adjusted", { count: analysis.adjustedIds.length })}</p>
              )}
            </div>
          )}
        </div>
        <aside className="label-editor__import-fields" aria-label={t("pages.labels.editor.import.fieldsTitle")}>
          <div className="label-editor__eyebrow">{t("pages.labels.editor.import.fieldsTitle")}</div>
          <p>{t("pages.labels.editor.import.fieldsHint")}</p>
          {fieldRows.map(({ field, label, placeholder }) => (
            <div className="label-editor__import-field" key={field}>
              <div>
                <strong>{label}</strong>
                <code>{placeholder}</code>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="compact"
                aria-label={t("pages.labels.editor.import.copy", { placeholder })}
                onClick={() => void handleCopy(field, placeholder)}
              >
                {t("pages.labels.editor.import.copyShort")}
              </Button>
            </div>
          ))}
          {copiedField && <div role="status">{t("pages.labels.editor.import.copied")}</div>}
          {copyError && <div role="alert">{t("pages.labels.editor.import.copyError")}</div>}
        </aside>
      </div>
    </Modal>
  );
}
