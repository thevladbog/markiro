import { useEffect, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  type LabelCodeLanguage,
  type LabelImportFormat,
  type LabelImportWarning,
  type LabelTemplatePurpose,
  type PrinterDpi,
} from "@markiro/domain";
import { Button, Checkbox, Modal, Select, Textarea } from "@markiro/ui";

import { analyzeImport, type ImportAnalysis, type ImportAnalysisError } from "./import-analysis.js";
import { ImportFieldsPanel } from "./ImportFieldsPanel.js";

export interface ImportCodeDialogProps {
  open: boolean;
  initialLanguage: LabelCodeLanguage;
  initialDpi: PrinterDpi;
  currentDirty: boolean;
  purpose: LabelTemplatePurpose;
  onClose: () => void;
  onReplace: (analysis: ImportAnalysis) => void;
}

const FORMAT_OPTIONS: Array<{ value: LabelImportFormat; label: string }> = [
  { value: "zpl", label: "ZPL" },
  { value: "tspl", label: "TSPL (TSC)" },
  { value: "json", label: "JSON (Markiro)" },
];

/**
 * The only way to put content on a label: paste ZPL/TSPL code or the label
 * model's own JSON, check it, acknowledge what will be dropped, replace the
 * spec. Parsing and fitting live in `analyzeImport`; this component owns the
 * dialog state and maps outcomes to copy. Any edit to the source, format or
 * DPI invalidates the analysis so a stale result can never be confirmed.
 */
export function ImportCodeDialog({
  open,
  initialLanguage,
  initialDpi,
  currentDirty,
  purpose,
  onClose,
  onReplace,
}: ImportCodeDialogProps) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<LabelImportFormat>(initialLanguage);
  const [dpi, setDpi] = useState<PrinterDpi>(initialDpi);
  const [source, setSource] = useState("");
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [error, setError] = useState<ImportAnalysisError | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFormat(initialLanguage);
    setDpi(initialDpi);
    setSource("");
    setAnalysis(null);
    setError(null);
    setAcknowledged(false);
  }, [initialDpi, initialLanguage, open]);

  const isJson = format === "json";
  const codeLabel = isJson
    ? t("pages.labels.editor.import.jsonLabel")
    : t("pages.labels.editor.import.codeLabel", { format: format === "zpl" ? "ZPL" : "TSPL" });
  const warnings = analysis?.result.warnings ?? [];
  const canReplace = analysis !== null && (warnings.length === 0 || acknowledged) && error === null;

  function invalidate(): void {
    setAnalysis(null);
    setError(null);
    setAcknowledged(false);
  }

  function handleCheck(): void {
    invalidate();
    const outcome = analyzeImport({ source, format, dpi, purpose });
    if (outcome.ok) setAnalysis(outcome.analysis);
    else setError(outcome.error);
  }

  function handleReplace(): void {
    if (!analysis || !canReplace) return;
    onReplace(analysis);
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
              options={FORMAT_OPTIONS}
              value={format}
              onValueChange={(value) => {
                setFormat(value);
                invalidate();
              }}
            />
            {/* JSON carries its own `dpi`; the import DPI only rescales code. */}
            {!isJson && (
              <Select
                aria-label={t("pages.labels.editor.import.dpiLabel")}
                options={[
                  { value: "203", label: "203 DPI" },
                  { value: "300", label: "300 DPI" },
                ]}
                value={String(dpi)}
                onValueChange={(value) => {
                  setDpi(value === "300" ? 300 : 203);
                  invalidate();
                }}
              />
            )}
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
          {error && <ImportErrorBlock error={error} />}
          {analysis && (
            <div className="label-editor__import-analysis" aria-live="polite">
              <strong>
                {t("pages.labels.editor.import.summary", {
                  count: analysis.result.spec.elements.length,
                  width: analysis.result.spec.widthMm.toFixed(1),
                  height: analysis.result.spec.heightMm.toFixed(1),
                })}
              </strong>
              {warnings.length > 0 && (
                <div className="label-editor__import-warnings">
                  <p>
                    {t(
                      isJson
                        ? "pages.labels.editor.import.warningsTitle"
                        : "pages.labels.editor.import.unsupportedTitle",
                      { count: warnings.length },
                    )}
                  </p>
                  {warnings.map((warning) => (
                    <WarningRow
                      key={`${warning.line ?? "json"}-${warning.source}`}
                      warning={warning}
                    />
                  ))}
                  <Checkbox
                    label={t(
                      isJson
                        ? "pages.labels.editor.import.acknowledgeWarnings"
                        : "pages.labels.editor.import.acknowledge",
                      { count: warnings.length },
                    )}
                    checked={acknowledged}
                    onCheckedChange={setAcknowledged}
                  />
                </div>
              )}
              {analysis.adjustedIds.length > 0 && (
                <p>
                  {t("pages.labels.editor.import.adjusted", { count: analysis.adjustedIds.length })}
                </p>
              )}
            </div>
          )}
        </div>
        <ImportFieldsPanel syntax={isJson ? "json" : "placeholder"} />
      </div>
    </Modal>
  );
}

/** One warning line; the copy depends on what kind of thing is being dropped. */
function WarningRow({ warning }: { warning: LabelImportWarning }) {
  const { t } = useTranslation();
  switch (warning.code) {
    case "UNSUPPORTED_COMMAND":
      return (
        <div>
          <span>{warning.line}: </span>
          <code>{warning.source}</code>
        </div>
      );
    case "UNKNOWN_PROPERTY":
      return (
        <div>
          <code>{warning.source}</code> {t("pages.labels.editor.import.warningUnknownProperty")}
        </div>
      );
    case "PURPOSE_MISMATCH":
      return (
        <div>
          <code>{warning.source}</code> {t("pages.labels.editor.import.warningPurposeMismatch")}
        </div>
      );
  }
}

/** A blocking error: one message, or the schema's full issue list with paths. */
function ImportErrorBlock({ error }: { error: ImportAnalysisError }) {
  const { t } = useTranslation();
  if (error.kind === "issues") {
    return (
      <div className="label-editor__import-error" role="alert">
        <p>{t("pages.labels.editor.import.issuesTitle", { count: error.issues.length })}</p>
        <ul className="label-editor__import-issues">
          {error.issues.map((issue, index) => (
            <li key={`${index}-${issue.path}`}>
              <code>{issue.path || "spec"}</code> {issue.message}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="label-editor__import-error" role="alert">
      {error.kind === "elementTooLarge"
        ? t("pages.labels.editor.import.elementTooLarge")
        : error.message}
    </div>
  );
}
