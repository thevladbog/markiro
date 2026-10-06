import { sampleLabelData, type LabelField } from "@markiro/domain";

import type { TemplatePurpose } from "../../host/protocol.js";

/** How a layout draws a product's code: natively, or as the shared GS1 raster. */
export interface LabelRenderOptions {
  kmDataMatrix?: "native" | "raster";
}

const BOX = sampleLabelData();

/**
 * The sample data the editor measures a layout with, after the cloud's
 * `labelPreviewData` (`apps/admin/src/pages/labels/preview-data.ts`): a
 * product duplicate carries a synthetic code and no SSCC, a pallet its own
 * SSCC and the units of every box on it. Synthetic, never a code taken from
 * production. One record per purpose, so a purpose added later cannot fall
 * through to the box's sample.
 */
const SAMPLES: Record<TemplatePurpose, Record<LabelField, string>> = {
  box: BOX,
  product_duplicate: {
    ...BOX,
    "km.code": "010460000000001521DEMO-LABEL-42\u001d93Abcd",
    "product.gtin": "04600000000015",
    "product.printName": "Кега · демонстрационная этикетка",
    qty: "1",
    sscc: "",
  },
  pallet: { ...BOX, sscc: "376006820000000021", qty: "240" },
};

/** A product duplicate draws its code as the raster the station prints; the rest natively. */
const RENDER_OPTIONS: Record<TemplatePurpose, LabelRenderOptions> = {
  box: {},
  product_duplicate: { kmDataMatrix: "raster" },
  pallet: {},
};

/** The sample data of a purpose. */
export function labelSampleData(purpose: TemplatePurpose): Record<LabelField, string> {
  return SAMPLES[purpose];
}

/** How a purpose draws a product's code. */
export function labelRenderOptions(purpose: TemplatePurpose): LabelRenderOptions {
  return RENDER_OPTIONS[purpose];
}
