import { isValidGtin } from "../../gs1/gtin.js";
import {
  validateProductDescription,
  type ProductDescriptionInput,
  type ProductDescriptionIssue,
} from "./description.js";

export interface ProductDescriptionSnapshot {
  snapshotVersion: 1;
  sourceProductId: string;
  productName: string;
  brandName: string | null;
  commodity: string | null;
  variety: string | null;
  packagingSize: { value: string; uom: string } | null;
  packagingStyle: string | null;
  gtin: string | null;
}
export type ProductSnapshotIssue = ProductDescriptionIssue | { field: "gtin"; code: "format" };

/** Caller validates the source product UUID and tenant scope; no live objects are retained. */
export function buildProductSnapshot(
  product: { id: string; gtin14: string | null },
  description: ProductDescriptionInput,
):
  | { ok: true; snapshot: ProductDescriptionSnapshot }
  | { ok: false; issues: ProductSnapshotIssue[] } {
  const issues: ProductSnapshotIssue[] = validateProductDescription(description);
  if (product.gtin14 !== null && (!/^\d{14}$/.test(product.gtin14) || !isValidGtin(product.gtin14)))
    issues.push({ field: "gtin", code: "format" });
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    snapshot: {
      snapshotVersion: 1,
      sourceProductId: product.id,
      productName: description.productName.trim(),
      brandName: description.brandName?.trim() ?? null,
      commodity: description.commodity?.trim() ?? null,
      variety: description.variety?.trim() ?? null,
      packagingSize:
        description.packagingSizeValue !== null && description.packagingSizeUom !== null
          ? { value: description.packagingSizeValue, uom: description.packagingSizeUom }
          : null,
      packagingStyle: description.packagingStyle?.trim() ?? null,
      gtin: product.gtin14,
    },
  };
}
