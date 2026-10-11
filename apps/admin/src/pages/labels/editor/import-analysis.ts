/**
 * The import dialog's "Проверить код" step as a pure function: source text
 * plus format in, a fitted spec (or a structured error) out. No DOM and no
 * i18n -- the dialog maps `ImportAnalysisError` to copy -- so the three
 * formats' contracts are unit-tested without rendering anything.
 */
import {
  DomainError,
  parseLabelCode,
  parseLabelJson,
  parseStoredLabelTemplate,
  isPalletSheetSpec,
  MAX_LABEL_CODE_BYTES,
  type LabelImportFormat,
  type LabelImportResult,
  type LabelTemplatePurpose,
  type PrinterDpi,
} from "@markiro/domain";

import { fitSpecElements } from "../geometry.js";
import { labelPreviewData, labelRenderOptions } from "../preview-data.js";

export interface ImportAnalysisIssue {
  path: string;
  message: string;
}

export type ImportAnalysisError =
  /** An element is larger than the label itself (`fitSpecElements`). */
  | { kind: "elementTooLarge" }
  | { kind: "sheetEditor" }
  /** One blocking message: a parser error, a JSON syntax error, a limit. */
  | { kind: "message"; message: string }
  /** The spec failed the model schema: every issue with its dotted path. */
  | { kind: "issues"; issues: ImportAnalysisIssue[] };

export interface ImportAnalysis {
  result: LabelImportResult;
  adjustedIds: string[];
  /** Wrapper `name` of a JSON import; absent for ZPL/TSPL and for a bare spec. */
  name?: string;
}

export interface AnalyzeImportInput {
  source: string;
  format: LabelImportFormat;
  /** Import DPI for ZPL/TSPL; ignored for JSON, which carries its own. */
  dpi: PrinterDpi;
  purpose: LabelTemplatePurpose;
}

export type AnalyzeImportOutcome =
  { ok: true; analysis: ImportAnalysis } | { ok: false; error: ImportAnalysisError };

/** `parseLabelTemplate` puts `Array<{ path, message }>` into `DomainError.cause`. */
function isIssueList(cause: unknown): cause is ImportAnalysisIssue[] {
  return (
    Array.isArray(cause) &&
    cause.every(
      (issue: unknown) =>
        typeof issue === "object" &&
        issue !== null &&
        typeof (issue as { path?: unknown }).path === "string" &&
        typeof (issue as { message?: unknown }).message === "string",
    )
  );
}

export function analyzeImport(input: AnalyzeImportInput): AnalyzeImportOutcome {
  let parsed: LabelImportResult & { name?: string };
  try {
    if (input.format === "json") {
      if (new TextEncoder().encode(input.source).byteLength > MAX_LABEL_CODE_BYTES)
        throw new DomainError("LABEL_CODE_TOO_LARGE", "Template JSON exceeds 256 KiB");
      let root: unknown;
      try {
        root = JSON.parse(input.source);
      } catch (error) {
        throw new DomainError(
          "LABEL_CODE_INVALID",
          `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const candidate =
        root && typeof root === "object" && "spec" in root ? Reflect.get(root, "spec") : root;
      const stored = parseStoredLabelTemplate(candidate);
      if (isPalletSheetSpec(stored)) return { ok: false, error: { kind: "sheetEditor" } };
      parsed = parseLabelJson(input.source, { purpose: input.purpose });
    } else parsed = parseLabelCode(input.source, { language: input.format, dpi: input.dpi });
  } catch (caught) {
    if (
      caught instanceof DomainError &&
      caught.code === "LABEL_INVALID" &&
      isIssueList(caught.cause)
    ) {
      return { ok: false, error: { kind: "issues", issues: caught.cause } };
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    return { ok: false, error: { kind: "message", message } };
  }

  const fitted = fitSpecElements(
    parsed.spec,
    labelPreviewData(input.purpose),
    labelRenderOptions(input.purpose),
  );
  if (!fitted.ok) return { ok: false, error: { kind: "elementTooLarge" } };

  const { name, ...result } = parsed;
  return {
    ok: true,
    analysis: {
      result: { ...result, spec: fitted.spec },
      adjustedIds: fitted.adjustedIds,
      ...(name === undefined ? {} : { name }),
    },
  };
}
