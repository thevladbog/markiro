import { DomainError } from "../errors.js";
import type { LabelTemplatePurpose } from "../product-labels/contracts.js";
import { parseLabelTemplate, type LabelTemplateSpec } from "./model.js";
import { parsePalletSheetSpec, type PalletSheetSpecV2 } from "./pallet-sheet-model.js";
import { MAX_LABEL_CODE_BYTES } from "./import.js";

export type StoredLabelTemplateSpec = LabelTemplateSpec | PalletSheetSpecV2;
export interface StoredTemplateJson {
  name: string;
  purpose: LabelTemplatePurpose;
  spec: StoredLabelTemplateSpec;
}
export interface StoredLabelJsonOptions {
  nameForBareSpec: string;
  purposeForBareSpec: LabelTemplatePurpose;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isPalletSheetSpec(spec: StoredLabelTemplateSpec): spec is PalletSheetSpecV2 {
  return "schemaVersion" in spec && spec.schemaVersion === 2;
}

/** Never feed a versioned document through the legacy unknown-key stripper. */
export function parseStoredLabelTemplate(value: unknown): StoredLabelTemplateSpec {
  if (isRecord(value) && ("schemaVersion" in value || "kind" in value)) {
    if (value.schemaVersion !== 2 || value.kind !== "pallet_sheet")
      throw new DomainError(
        "LABEL_TEMPLATE_VERSION_UNSUPPORTED",
        "Unsupported label template version or kind",
      );
    return parsePalletSheetSpec(value);
  }
  return parseLabelTemplate(value);
}
function validatePayload(name: unknown, purpose: unknown, value: unknown): StoredTemplateJson {
  if (typeof name !== "string" || !name.trim() || name.length > 200)
    throw new DomainError(
      "LABEL_CODE_INVALID",
      "name must be a non-empty string of at most 200 characters",
    );
  if (purpose !== "box" && purpose !== "pallet" && purpose !== "product_duplicate")
    throw new DomainError("LABEL_CODE_INVALID", "Unsupported template purpose");
  const spec = parseStoredLabelTemplate(value);
  if (isPalletSheetSpec(spec) && purpose !== "pallet")
    throw new DomainError("LABEL_CODE_INVALID", "Pallet sheet purpose must be pallet");
  return { name, purpose, spec };
}
export function parseStoredLabelJson(
  source: string,
  options?: StoredLabelJsonOptions,
): StoredTemplateJson {
  if (new TextEncoder().encode(source).byteLength > MAX_LABEL_CODE_BYTES)
    throw new DomainError("LABEL_CODE_LIMIT", "Template JSON exceeds 256 KiB UTF-8");
  let root: unknown;
  try {
    root = JSON.parse(source);
  } catch {
    throw new DomainError("LABEL_CODE_INVALID", "Invalid template JSON");
  }
  if (!isRecord(root))
    throw new DomainError("LABEL_CODE_INVALID", "Expected a label template object");
  if ("spec" in root) return validatePayload(root.name, root.purpose, root.spec);
  if (!options)
    throw new DomainError(
      "LABEL_CODE_INVALID",
      "Bare spec requires explicit editor name and purpose",
    );
  return validatePayload(options.nameForBareSpec, options.purposeForBareSpec, root);
}

/** Export only the portable wrapper: resolved tenant resources and IDs stay local. */
export function serializeStoredLabelJson(payload: StoredTemplateJson): string {
  const validated = validatePayload(payload.name, payload.purpose, payload.spec);
  const source = `${JSON.stringify(validated, null, 2)}\n`;
  if (new TextEncoder().encode(source).byteLength > MAX_LABEL_CODE_BYTES)
    throw new DomainError("LABEL_CODE_LIMIT", "Template JSON exceeds 256 KiB UTF-8");
  return source;
}
