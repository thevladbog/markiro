import { isTraceabilityUom } from "../uom.js";

export interface ProductDescriptionInput {
  productName: string;
  brandName: string | null;
  commodity: string | null;
  variety: string | null;
  packagingSizeValue: string | null;
  packagingSizeUom: string | null;
  packagingStyle: string | null;
  defaultQuantityUom: string | null;
}
export type ProductDescriptionIssue = {
  field: keyof ProductDescriptionInput;
  code: "required" | "format";
};

/** Input types/identity are validated at the boundary; this validates component values. */
export function validateProductDescription(
  input: ProductDescriptionInput,
): ProductDescriptionIssue[] {
  const issues: ProductDescriptionIssue[] = [];
  for (const field of [
    "productName",
    "brandName",
    "commodity",
    "variety",
    "packagingStyle",
  ] as const) {
    const value = input[field];
    if (value === null) continue;
    if (!value.trim())
      issues.push({ field, code: field === "productName" ? "required" : "format" });
    else if (value.trim().length > 200) issues.push({ field, code: "format" });
  }
  const value = input.packagingSizeValue;
  if (value !== null && (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/.test(value) || !/[1-9]/.test(value)))
    issues.push({ field: "packagingSizeValue", code: "format" });
  for (const field of ["packagingSizeUom", "defaultQuantityUom"] as const) {
    if (input[field] !== null && !isTraceabilityUom(input[field]))
      issues.push({ field, code: "format" });
  }
  if (value === null && input.packagingSizeUom !== null)
    issues.push({ field: "packagingSizeValue", code: "required" });
  if (value !== null && input.packagingSizeUom === null)
    issues.push({ field: "packagingSizeUom", code: "required" });
  return issues;
}
