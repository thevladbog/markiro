import {
  DomainError,
  LOT_NUMBER_LABEL_FIELD,
  palletSheetUsesLotNumber,
  rasterizeLabelLotNumber,
  withPrinterDpi,
  type LabelFieldElement,
  type LabelTemplateSpec,
  type PalletSheetSpecV2,
} from "@markiro/domain";

import type { LabelPrinter } from "../floor/print/label-render.js";
import { rasterizeDriverText, rasterizeText } from "./rasterizer.js";
import { renderSheetRaster, sampleSheetContext } from "./sheet-render.js";

export type LotTemplateIssue = "missing" | "overflow" | "unavailable";

export async function checkThermalLotNumber(
  spec: LabelTemplateSpec,
  lotNumber: string,
  printer?: Pick<LabelPrinter, "dpi" | "mode">,
): Promise<LotTemplateIssue | null> {
  const target = printer === undefined ? spec : withPrinterDpi(spec, printer.dpi);
  const fields = target.elements.filter(
    (element): element is LabelFieldElement =>
      element.kind === "field" && element.field === LOT_NUMBER_LABEL_FIELD,
  );
  if (fields.length === 0) return "missing";
  const rasterize = printer?.mode === "windows_driver" ? rasterizeDriverText : rasterizeText;
  try {
    await Promise.all(
      fields.map((field) => rasterizeLabelLotNumber(field, target, lotNumber, rasterize)),
    );
    return null;
  } catch (error) {
    return lotTemplateIssue(error);
  }
}

export async function checkSheetLotNumber(
  spec: PalletSheetSpecV2,
  lotNumber: string,
): Promise<LotTemplateIssue | null> {
  if (!palletSheetUsesLotNumber(spec)) return "missing";
  const sample = sampleSheetContext(
    { name: "Маркиро", inn: null },
    {
      width: 1,
      height: 1,
      stride: 1,
      pixels: Uint8Array.of(0),
      digest: "lot-preview",
      source: "markiro",
    },
  );
  try {
    await renderSheetRaster(spec, { ...sample, lotNumber });
    return null;
  } catch (error) {
    return lotTemplateIssue(error);
  }
}

function lotTemplateIssue(error: unknown): LotTemplateIssue {
  return error instanceof DomainError && error.code === "LABEL_LOT_NUMBER_OVERFLOW"
    ? "overflow"
    : "unavailable";
}
