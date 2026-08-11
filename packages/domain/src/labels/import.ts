import { DomainError } from "../errors.js";
import { LABEL_FIELDS, type LabelField, type LabelTemplateSpec } from "./model.js";

export const MAX_LABEL_CODE_BYTES = 256 * 1024;
export const MAX_LABEL_CODE_COMMANDS = 2_000;
export const MAX_LABEL_CODE_ELEMENTS = 1_000;

export type LabelCodeLanguage = "zpl" | "tspl";
export type LabelImportWarningCode = "UNSUPPORTED_COMMAND";

export interface LabelImportWarning {
  line: number;
  source: string;
  code: LabelImportWarningCode;
  message: string;
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
    const candidate = match[1]!;
    if (knownFields.has(candidate)) {
      return { kind: "field", field: candidate as LabelField };
    }
    invalidPayload(value, line, `unknown label field placeholder "${candidate}"`);
  }

  if (value.includes("{{") || value.includes("}}")) {
    invalidPayload(value, line, "mixed or malformed label field placeholder");
  }

  return { kind: "literal", value };
}

// Concrete language parsers are added in the following implementation tasks.
export type { LabelField, LabelTemplateSpec } from "./model.js";
