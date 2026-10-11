import {
  DomainError,
  isPalletSheetSpec,
  parseStoredLabelJson,
  type PalletSheetSpecV2,
} from "@markiro/domain";
export interface SheetImportValue {
  name: string;
  purpose: "pallet";
  spec: PalletSheetSpecV2;
}
export type SheetImportOutcome =
  | { ok: true; value: SheetImportValue }
  | { ok: false; issues: Array<{ path: string; message: string }> };
export function analyzeSheetImport(source: string): SheetImportOutcome {
  try {
    const value = parseStoredLabelJson(source, {
      nameForBareSpec: "Палета А4",
      purposeForBareSpec: "pallet",
    });
    if (!isPalletSheetSpec(value.spec))
      throw new DomainError(
        "LABEL_TEMPLATE_FORMAT_UNSUPPORTED",
        "Use the label editor for V1 JSON",
      );
    return { ok: true, value: { name: value.name, purpose: "pallet", spec: value.spec } };
  } catch (error) {
    const cause: unknown = error instanceof DomainError ? error.cause : undefined;
    const issues: Array<{ path: string; message: string }> = [];
    if (Array.isArray(cause))
      for (const issue of cause) {
        if (
          issue &&
          typeof issue === "object" &&
          typeof Reflect.get(issue, "path") === "string" &&
          typeof Reflect.get(issue, "message") === "string"
        )
          issues.push({
            path: String(Reflect.get(issue, "path")),
            message: String(Reflect.get(issue, "message")),
          });
      }
    return {
      ok: false,
      issues: issues.length
        ? issues
        : [{ path: "spec", message: error instanceof Error ? error.message : String(error) }],
    };
  }
}
