import {
  DomainError,
  parseLabelCode,
  parseLabelJson,
  type LabelImportFormat,
  type LabelImportResult,
  type PrinterDpi,
} from "@markiro/domain";

import type { TemplatePurpose } from "../../host/protocol.js";
import { fitSpecElements } from "./label-geometry.js";
import { labelRenderOptions, labelSampleData } from "./label-samples.js";

/** One schema issue of an imported layout, with its dotted path. */
export interface ImportIssue {
  path: string;
  message: string;
}

/** Why an import cannot replace the layout. */
export type ImportError =
  /** An element is larger than the label (`fitSpecElements`). */
  | { kind: "elementTooLarge" }
  /** One blocking message of the parser: a syntax error, a limit. */
  | { kind: "message"; message: string }
  /** The layout failed the domain's schema: every issue with its path. */
  | { kind: "issues"; issues: ImportIssue[] };

/** An import that can replace the layout. */
export interface ImportAnalysis {
  result: LabelImportResult;
  /** The elements moved back inside the label. */
  adjustedIds: string[];
  /** The `name` of a JSON `{ name, purpose, spec }`; absent for code and a bare layout. */
  name?: string;
}

export interface ImportInput {
  source: string;
  format: LabelImportFormat;
  /** The resolution ZPL or TSPL was written for; JSON carries its own. */
  dpi: PrinterDpi;
  purpose: TemplatePurpose;
}

export type ImportOutcome =
  { ok: true; analysis: ImportAnalysis } | { ok: false; error: ImportError };

/** Whether a `DomainError`'s cause is `parseLabelTemplate`'s issue list. */
function isIssueList(cause: unknown): cause is ImportIssue[] {
  return (
    Array.isArray(cause) &&
    cause.every(
      (issue: unknown) =>
        typeof issue === "object" &&
        issue !== null &&
        "path" in issue &&
        typeof issue.path === "string" &&
        "message" in issue &&
        typeof issue.message === "string",
    )
  );
}

/**
 * The import dialog's «Проверить код» as a function, after the cloud's
 * `analyzeImport` (`apps/admin/src/pages/labels/editor/import-analysis.ts`):
 * the source parsed by the domain (`parseLabelCode` for ZPL and TSPL at the
 * chosen resolution, `parseLabelJson` for the model itself), then every
 * element moved inside the label (`fitSpecElements`, measured with the
 * purpose's sample data). No DOM and no texts: the dialog words the outcome.
 */
export function analyzeImport(input: ImportInput): ImportOutcome {
  let parsed: LabelImportResult & { name?: string };
  try {
    parsed =
      input.format === "json"
        ? parseLabelJson(input.source, { purpose: input.purpose })
        : parseLabelCode(input.source, { language: input.format, dpi: input.dpi });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    if (error.code === "LABEL_INVALID" && isIssueList(error.cause)) {
      return { ok: false, error: { kind: "issues", issues: error.cause } };
    }
    return { ok: false, error: { kind: "message", message: error.message } };
  }
  const fitted = fitSpecElements(
    parsed.spec,
    labelSampleData(input.purpose),
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
