import { DomainError } from "../errors.js";
import { LABEL_FIELDS, type LabelField, type LabelTemplateSpec } from "./model.js";
import { parseTsplLabel } from "./tspl-import.js";
import { parseZplLabel } from "./zpl-import.js";

export const MAX_LABEL_CODE_BYTES = 256 * 1024;
export const MAX_LABEL_CODE_COMMANDS = 2_000;
export const MAX_LABEL_CODE_ELEMENTS = 1_000;

export type LabelCodeLanguage = "zpl" | "tspl";
/**
 * What the import dialog offers: the two printer languages, parsed from
 * code, plus `json` -- the label model itself (`labelTemplateSpecSchema`),
 * pasted as the same document `POST /label-templates` accepts.
 */
export type LabelImportFormat = LabelCodeLanguage | "json";
export type LabelImportWarningCode =
  /** ZPL/TSPL: a line the parser does not understand; replacing drops it. */
  | "UNSUPPORTED_COMMAND"
  /** JSON: a property outside the label model; the schema strips it. */
  | "UNKNOWN_PROPERTY"
  /** JSON: the wrapper's `purpose` differs from the template being edited. */
  | "PURPOSE_MISMATCH";

export interface LabelImportWarning {
  code: LabelImportWarningCode;
  message: string;
  /**
   * 1-based source line for ZPL/TSPL. `null` for JSON, which has no line
   * bookkeeping after `JSON.parse`; there `source` is the dotted property
   * path (`elements.3.maxlines`) or `purpose: "pallet"`.
   */
  line: number | null;
  source: string;
}

export interface LabelImportResult {
  spec: LabelTemplateSpec;
  warnings: LabelImportWarning[];
  sourceLineByElementId: Record<string, number>;
}

export interface ParseLabelCodeOptions {
  language: LabelCodeLanguage;
  dpi: 203 | 300;
}

const knownFields = new Set<string>(LABEL_FIELDS);

function isLabelField(value: string): value is LabelField {
  return knownFields.has(value);
}

export function assertImportInputLimits(input: string): void {
  if (new TextEncoder().encode(input).byteLength > MAX_LABEL_CODE_BYTES) {
    throw new DomainError(
      "LABEL_CODE_TOO_LARGE",
      `label code exceeds ${MAX_LABEL_CODE_BYTES} bytes`,
    );
  }
}

export function importedElementId(language: LabelCodeLanguage, ordinal: number): string {
  return `import-${language}-${ordinal}`;
}

function invalidPayload(value: string, line: number, message: string): never {
  throw new DomainError("LABEL_CODE_INVALID", message, {
    cause: { line, source: value },
  });
}

export function parseTemplatePayload(
  value: string,
  line: number,
): { kind: "field"; field: LabelField } | { kind: "literal"; value: string } {
  const match = /^\{\{([^{}]+)\}\}$/.exec(value);
  if (match) {
    const candidate = match[1];
    if (candidate !== undefined && isLabelField(candidate)) {
      return { kind: "field", field: candidate };
    }
    invalidPayload(value, line, `unknown label field placeholder "${candidate}"`);
  }

  if (value.includes("{{") || value.includes("}}")) {
    invalidPayload(value, line, "mixed or malformed label field placeholder");
  }

  return { kind: "literal", value };
}

export function parseLabelCode(input: string, options: ParseLabelCodeOptions): LabelImportResult {
  assertImportInputLimits(input);
  return options.language === "zpl"
    ? parseZplLabel(input, options.dpi)
    : parseTsplLabel(input, options.dpi);
}

// Concrete language parsers are added in the following implementation tasks.
export type { LabelField, LabelTemplateSpec } from "./model.js";
