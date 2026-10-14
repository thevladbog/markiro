import { useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  LabelCodeLanguage,
  LabelImportFormat,
  LabelImportWarning,
  PrinterDpi,
} from "@markiro/domain";
import { Alert, Button, Checkbox, Select, Textarea } from "@markiro/ui";

import type { TemplatePurpose } from "../../host/protocol.js";
import { FormDialog } from "../FormDialog.js";
import { DPI_CHOICES, toDpi } from "./editor-model.js";
import { analyzeImport, type ImportAnalysis, type ImportError } from "./import-analysis.js";
import { ImportFieldsPanel } from "./ImportFieldsPanel.js";

const FORMATS: readonly LabelImportFormat[] = ["zpl", "tspl", "json"];

function toFormat(value: string): LabelImportFormat {
  return value === "tspl" || value === "json" ? value : "zpl";
}

/** Millimetres as the office writes them: «58», «58,04». */
const MM = new Intl.NumberFormat("ru", { maximumFractionDigits: 2 });

export interface ImportCodeDialogProps {
  purpose: TemplatePurpose;
  /** The format the dialog opens on: the layout's language. */
  initialFormat: LabelCodeLanguage;
  /** The resolution the dialog opens on: the layout's. */
  initialDpi: PrinterDpi;
  /** The editor holds unsaved changes, which the import replaces. */
  unsaved: boolean;
  onClose: () => void;
  /** Replaces the layout; the dialog closes. */
  onReplace: (analysis: ImportAnalysis) => void;
}

/**
 * The only way to put content on a label, after the cloud's
 * `ImportCodeDialog`: paste ZPL or TSPL code or the model's own JSON, check
 * it (`analyzeImport`), acknowledge what is dropped, replace the layout. Any
 * change of the code, the format or the resolution drops the check, so a
 * stale result is never confirmed. «Заменить макет» is the dialog's submit.
 */
export function ImportCodeDialog({
  purpose,
  initialFormat,
  initialDpi,
  unsaved,
  onClose,
  onReplace,
}: ImportCodeDialogProps) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<LabelImportFormat>(initialFormat);
  const [dpi, setDpi] = useState<PrinterDpi>(initialDpi);
  const [source, setSource] = useState("");
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [error, setError] = useState<ImportError | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const isJson = format === "json";
  const warnings = analysis?.result.warnings ?? [];
  const canReplace = analysis !== null && (warnings.length === 0 || acknowledged);

  const forget = () => {
    setAnalysis(null);
    setError(null);
    setAcknowledged(false);
  };

  const check = () => {
    forget();
    const outcome = analyzeImport({ source, format, dpi, purpose });
    if (outcome.ok) setAnalysis(outcome.analysis);
    else setError(outcome.error);
  };

  // `FormDialog` waits on a promise; replacing the layout is immediate.
  const replace = () => {
    if (analysis !== null && canReplace) onReplace(analysis);
    return Promise.resolve();
  };

  return (
    <FormDialog
      title={t("office.templateImport.title")}
      submitLabel={t("office.templateImport.replace")}
      submitDisabled={!canReplace}
      width={1040}
      onSubmit={replace}
      onClose={onClose}
    >
      <div className="template-import">
        <div className="template-import__source">
          <div className="template-import__options">
            <Select
              label={t("office.templateImport.format")}
              options={FORMATS.map((value) => ({
                value,
                label: t(`office.templateImport.formats.${value}`),
              }))}
              value={format}
              onValueChange={(value) => {
                setFormat(toFormat(value));
                forget();
              }}
            />
            {/* JSON carries its own resolution; this one rescales code only. */}
            {!isJson && (
              <Select
                label={t("office.templateImport.dpi")}
                options={DPI_CHOICES.map((value) => ({
                  value: String(value),
                  label: t("office.templates.dpi", { dpi: value }),
                }))}
                value={String(dpi)}
                onValueChange={(value) => {
                  setDpi(toDpi(value));
                  forget();
                }}
              />
            )}
          </div>
          <Textarea
            label={
              isJson
                ? t("office.templateImport.json")
                : t("office.templateImport.code", {
                    format: t(`office.templateImport.formats.${format}`),
                  })
            }
            className="template-import__code"
            // The field's own `font` beats a class: it takes the code font here.
            style={{ font: "var(--text-code)" }}
            spellCheck={false}
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              forget();
            }}
          />
          {unsaved && <p className="office-note">{t("office.templateImport.unsaved")}</p>}
          <div>
            <Button variant="secondary" onClick={check} disabled={source.trim() === ""}>
              {t("office.templateImport.check")}
            </Button>
          </div>
          {error !== null && <ImportErrorAlert error={error} />}
          {/* Always on the page, so a screen reader hears the result when it is put in. */}
          <div className="template-import__analysis" aria-live="polite">
            {analysis !== null && (
              <>
                <strong>
                  {t("office.templateImport.summary", {
                    n: analysis.result.spec.elements.length,
                    width: MM.format(analysis.result.spec.widthMm),
                    height: MM.format(analysis.result.spec.heightMm),
                  })}
                </strong>
                {warnings.length > 0 && (
                  <>
                    <p>
                      {t(
                        isJson
                          ? "office.templateImport.warningsTitle"
                          : "office.templateImport.unsupportedTitle",
                        { n: warnings.length },
                      )}
                    </p>
                    <ul className="template-import__warnings">
                      {warnings.map((warning, index) => (
                        <WarningRow key={`${index}-${warning.source}`} warning={warning} />
                      ))}
                    </ul>
                    <Checkbox
                      label={t(
                        isJson
                          ? "office.templateImport.acknowledgeWarnings"
                          : "office.templateImport.acknowledge",
                        { n: warnings.length },
                      )}
                      checked={acknowledged}
                      onCheckedChange={setAcknowledged}
                    />
                  </>
                )}
                {analysis.adjustedIds.length > 0 && (
                  <p>{t("office.templateImport.adjusted", { n: analysis.adjustedIds.length })}</p>
                )}
              </>
            )}
          </div>
        </div>
        <ImportFieldsPanel syntax={isJson ? "json" : "placeholder"} />
      </div>
    </FormDialog>
  );
}

/** One warning: a dropped line of code, or a JSON property or purpose. */
function WarningRow({ warning }: { warning: LabelImportWarning }) {
  const { t } = useTranslation();
  switch (warning.code) {
    case "UNSUPPORTED_COMMAND":
      return (
        <li>
          {t("office.templateImport.line", { line: warning.line })} <code>{warning.source}</code>
        </li>
      );
    case "UNKNOWN_PROPERTY":
      return (
        <li>
          <code>{warning.source}</code> {t("office.templateImport.unknownProperty")}
        </li>
      );
    case "PURPOSE_MISMATCH":
      return (
        <li>
          <code>{warning.source}</code> {t("office.templateImport.purposeMismatch")}
        </li>
      );
  }
}

/** A check that cannot replace the layout: the parser's message, the schema's issues, or a too large element. */
function ImportErrorAlert({ error }: { error: ImportError }) {
  const { t } = useTranslation();
  if (error.kind === "issues") {
    return (
      <Alert tone="error">
        <p>{t("office.templateImport.issuesTitle", { n: error.issues.length })}</p>
        <ul className="template-import__issues">
          {error.issues.map((issue, index) => (
            <li key={`${index}-${issue.path}`}>
              <code>{issue.path === "" ? "spec" : issue.path}</code> {issue.message}
            </li>
          ))}
        </ul>
      </Alert>
    );
  }
  if (error.kind === "elementTooLarge") {
    return <Alert tone="error">{t("office.templateImport.elementTooLarge")}</Alert>;
  }
  return (
    <Alert tone="error">
      {t("office.templateImport.failed")} <code>{error.message}</code>
    </Alert>
  );
}
